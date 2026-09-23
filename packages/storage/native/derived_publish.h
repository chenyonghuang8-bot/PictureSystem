/* Exclusive derived publish.
 * Included once from storage_native.c after image_verifier_launch.h.
 * Renames one verified sealed inode into the fixed final namespace.
 * No caller path, fd, or buffer. No overwrite. No database update.
 */
#ifndef FAMILY_ALBUM_DERIVED_PUBLISH_H
#define FAMILY_ALBUM_DERIVED_PUBLISH_H

static int derived_final_leaf(const derived_writer_t *writer, char *out, size_t cap) {
  const char *name = NULL;
  if (strcmp(writer->kind, "THUMBNAIL") == 0) name = "thumbnail.webp";
  else if (strcmp(writer->kind, "PREVIEW") == 0) name = "preview.webp";
  else return -1;
  return derived_copy_text(out, cap, name);
}

static int derived_open_final_parent(derived_store_t *store, derived_writer_t *writer,
                                     int *out_fd) {
  char recipe[16], generation[40];
  struct stat family_status, media_status, recipe_status, generation_status;
  if (snprintf(recipe, sizeof(recipe), "r%s", writer->recipe) >= (int)sizeof(recipe) ||
      snprintf(generation, sizeof(generation), "g%s", writer->generation) >=
          (int)sizeof(generation)) {
    errno = EINVAL;
    return -1;
  }
  int family_fd = derived_ensure_directory(store->derived_fd, writer->family,
                                           store->device, &family_status);
  int media_fd = family_fd < 0
                     ? -1
                     : derived_ensure_directory(family_fd, writer->media,
                                                store->device, &media_status);
  int recipe_fd = media_fd < 0
                      ? -1
                      : derived_ensure_directory(media_fd, recipe, store->device,
                                                 &recipe_status);
  int generation_fd =
      recipe_fd < 0 ? -1
                    : derived_ensure_directory(recipe_fd, generation, store->device,
                                               &generation_status);
  if (family_fd >= 0) close(family_fd);
  if (media_fd >= 0) close(media_fd);
  if (recipe_fd >= 0) close(recipe_fd);
  if (generation_fd < 0) return -1;
  *out_fd = generation_fd;
  return 0;
}

/* 0 absent, 1 identical, 2 conflict, -1 unsafe. */
static int derived_classify_final(int parent, const char *name,
                                  derived_writer_t *writer) {
  struct stat named;
  if (fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0) {
    return errno == ENOENT ? 0 : -1;
  }
  if (!S_ISREG(named.st_mode) || named.st_nlink != 1 ||
      named.st_dev != writer->store->device || !owned_by_caller(&named) ||
      (named.st_mode & 0777) != 0400 || named.st_size != writer->size) {
    errno = S_ISREG(named.st_mode) ? EEXIST : EPERM;
    return S_ISREG(named.st_mode) ? 2 : -1;
  }
  int fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  int hashed = derived_hash_fd(fd, named.st_size, digest);
  int acl = hashed == 0 ? validate_no_extended_acl(fd) : -1;
  close(fd);
  if (hashed != 0 || acl != 0) return -1;
  if (memcmp(digest, writer->sha, sizeof(digest)) != 0) {
    errno = EEXIST;
    return 2;
  }
  return 1;
}

static napi_value derived_publish_result(napi_env env, const char *outcome,
                                        derived_writer_t *writer) {
  napi_value result;
  napi_value outcome_value;
  napi_value sha_value;
  napi_value size_value;
  napi_value inode_value;
  napi_value device_value;
  napi_value generation_value;
  napi_value kind_value;
  char sha_hex[65];
  char size_text[32];
  char inode_text[32];
  char device_text[32];
  derived_digest_hex(writer->sha, sha_hex);
  snprintf(size_text, sizeof(size_text), "%llu", (unsigned long long)writer->size);
  snprintf(inode_text, sizeof(inode_text), "%llu", (unsigned long long)writer->inode);
  snprintf(device_text, sizeof(device_text), "%llu",
           (unsigned long long)writer->device);
  napi_create_object(env, &result);
  napi_create_string_utf8(env, outcome, NAPI_AUTO_LENGTH, &outcome_value);
  napi_create_string_utf8(env, sha_hex, NAPI_AUTO_LENGTH, &sha_value);
  napi_create_string_utf8(env, size_text, NAPI_AUTO_LENGTH, &size_value);
  napi_create_string_utf8(env, inode_text, NAPI_AUTO_LENGTH, &inode_value);
  napi_create_string_utf8(env, device_text, NAPI_AUTO_LENGTH, &device_value);
  napi_create_string_utf8(env, writer->generation, NAPI_AUTO_LENGTH, &generation_value);
  napi_create_string_utf8(env, writer->kind, NAPI_AUTO_LENGTH, &kind_value);
  napi_set_named_property(env, result, "outcome", outcome_value);
  napi_set_named_property(env, result, "sha256Hex", sha_value);
  napi_set_named_property(env, result, "byteSize", size_value);
  napi_set_named_property(env, result, "inode", inode_value);
  napi_set_named_property(env, result, "device", device_value);
  napi_set_named_property(env, result, "generation", generation_value);
  napi_set_named_property(env, result, "kind", kind_value);
  return result;
}

static napi_value publish_sealed_output(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  derived_sealed_t *sealed = argc == 2 ? derived_get_sealed(env, args[0]) : NULL;
  derived_store_t *store = sealed == NULL ? NULL : derived_get_store(env, args[1]);
  if (sealed == NULL || store == NULL) return NULL;
  pthread_mutex_lock(&store->mutex);
  if (sealed->consumed || sealed->writer == NULL || sealed->writer->store != store ||
      sealed->writer->state != DERIVED_TEMP_SEALED || sealed->read_fd < 0) {
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, "DERIVED_SEALED_CLOSED",
                  "Sealed output does not belong to this store.");
    return NULL;
  }
  if (!sealed->writer->verified) {
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, "DERIVED_PUBLISH_UNVERIFIED",
                  "Sealed output has not passed isolated verification.");
    return NULL;
  }
  int identity = derived_verify_bound(sealed->writer, sealed->read_fd);
  int identity_errno = errno;
  if (identity != 0) {
    derived_consume_sealed(sealed);
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, identity_errno == EILSEQ ? "DERIVED_HASH_MISMATCH"
                                               : "DERIVED_PUBLISH_IDENTITY",
                  "Sealed identity did not match before publish.");
    return NULL;
  }
  char leaf[16];
  char epoch_name[40];
  int parent = -1;
  if (derived_final_leaf(sealed->writer, leaf, sizeof(leaf)) != 0 ||
      snprintf(epoch_name, sizeof(epoch_name), "e%s", sealed->writer->epoch) >=
          (int)sizeof(epoch_name) ||
      derived_open_final_parent(store, sealed->writer, &parent) != 0) {
    if (parent >= 0) close(parent);
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, "DERIVED_PUBLISH_IDENTITY",
                  "Final derived parent could not be pinned.");
    return NULL;
  }
  int existing = derived_classify_final(parent, leaf, sealed->writer);
  if (existing < 0) {
    close(parent);
    derived_consume_sealed(sealed);
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, "DERIVED_PUBLISH_UNSAFE",
                  "Final derived name is not a regular candidate.");
    return NULL;
  }
  if (existing == 2) {
    close(parent);
    derived_consume_sealed(sealed);
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, "DERIVED_PUBLISH_CONFLICT",
                  "Final derived asset already exists with different bytes.");
    return NULL;
  }
  if (existing == 1) {
    close(parent);
    napi_value identical = derived_publish_result(env, "IDENTICAL", sealed->writer);
    derived_consume_sealed(sealed);
    pthread_mutex_unlock(&store->mutex);
    return identical;
  }
  struct stat source;
  if (fstat(sealed->read_fd, &source) != 0 || source.st_dev != sealed->writer->device ||
      source.st_ino != sealed->writer->inode) {
    close(parent);
    derived_consume_sealed(sealed);
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, "DERIVED_PUBLISH_IDENTITY",
                  "Sealed inode changed before publish.");
    return NULL;
  }
  if (renameatx_np(sealed->writer->epoch_fd, sealed->writer->leaf, parent, leaf,
                   RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH) != 0) {
    int saved = errno;
    int raced = saved == EEXIST ? derived_classify_final(parent, leaf, sealed->writer) : -1;
    close(parent);
    derived_consume_sealed(sealed);
    pthread_mutex_unlock(&store->mutex);
    if (raced == 1) {
      derived_throw(env, "DERIVED_PUBLISH_CONFLICT",
                    "Final name appeared during publish and was left unchanged.");
      return NULL;
    }
    derived_throw(env, saved == EEXIST ? "DERIVED_PUBLISH_CONFLICT"
                                      : "DERIVED_PUBLISH_FAILED",
                  "Exclusive derived publish did not complete.");
    return NULL;
  }
  struct stat final_status;
  int durable = fstatat(parent, leaf, &final_status, AT_SYMLINK_NOFOLLOW) == 0 &&
                final_status.st_dev == source.st_dev &&
                final_status.st_ino == source.st_ino &&
                final_status.st_size == source.st_size &&
                (final_status.st_mode & 0777) == 0400 &&
                full_sync_file_fd(sealed->read_fd) == 0 &&
                sync_directory_fd(sealed->writer->epoch_fd) == 0 &&
                sync_directory_fd(parent) == 0;
  if (durable) {
    derived_prune_empty_chain(
        store->derived_fd, sealed->writer->tmp_fd, sealed->writer->job_fd,
        sealed->writer->epoch_fd, store->device, sealed->writer->tmp_inode,
        sealed->writer->job_inode, sealed->writer->epoch_inode,
        sealed->writer->job, epoch_name);
  }
  close(parent);
  napi_value published = durable ? derived_publish_result(env, "PUBLISHED", sealed->writer)
                                : NULL;
  derived_consume_sealed(sealed);
  pthread_mutex_unlock(&store->mutex);
  if (!durable) {
    derived_throw(env, "DERIVED_PUBLISH_DURABILITY_UNKNOWN",
                  "Derived rename may have completed without a confirmed sync.");
    return NULL;
  }
  return published;
}

#endif
