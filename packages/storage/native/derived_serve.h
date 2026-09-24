/* Identity-scoped read of one sealed derived final.
 * Included once from storage_native.c after derived_recovery.h.
 * Opens only derived/<family>/<media>/r1/g<generation>/{thumbnail,preview}.webp
 * through the pinned directory fds. Never accepts a path, filename, or original.
 */
#ifndef FAMILY_ALBUM_DERIVED_SERVE_H
#define FAMILY_ALBUM_DERIVED_SERVE_H

static napi_value read_derived_final(napi_env env, napi_callback_info info) {
  size_t argc = 8;
  napi_value args[8];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  capacity_gate_t *gate = argc == 8 ? get_capacity_gate(env, args[0]) : NULL;
  char family[32], media[32], generation[32], recipe[32], kind[12];
  char expected_sha[80], expected_size[32];
  if (argc != 8 || gate == NULL) return NULL;
  if (!gate->locked ||
      get_string(env, args[1], family, sizeof(family)) != 0 ||
      get_string(env, args[2], media, sizeof(media)) != 0 ||
      get_string(env, args[3], generation, sizeof(generation)) != 0 ||
      get_string(env, args[4], recipe, sizeof(recipe)) != 0 ||
      get_string(env, args[5], kind, sizeof(kind)) != 0 ||
      get_string(env, args[6], expected_sha, sizeof(expected_sha)) != 0 ||
      get_string(env, args[7], expected_size, sizeof(expected_size)) != 0) {
    if (gate != NULL && !gate->locked) {
      throw_code(env, "CAPACITY_LOCK_REQUIRED", "Derived read requires the lock.");
    }
    return NULL;
  }

  char canonical_family[32], canonical_media[32], canonical_generation[32];
  char canonical_recipe[32], canonical_size[32], leaf[16];
  if (canonical_u64(family, canonical_family, sizeof(canonical_family)) != 0 ||
      canonical_u64(media, canonical_media, sizeof(canonical_media)) != 0 ||
      canonical_u64(generation, canonical_generation,
                     sizeof(canonical_generation)) != 0 ||
      canonical_u64(recipe, canonical_recipe, sizeof(canonical_recipe)) != 0 ||
      canonical_u64(expected_size, canonical_size, sizeof(canonical_size)) != 0 ||
      strcmp(canonical_recipe, "1") != 0 ||
      recovery_kind_leaf(kind, 1, leaf, sizeof(leaf)) != 0 ||
      strlen(expected_sha) != 64) {
    throw_code(env, "DERIVED_SERVE_IDENTITY", "Derived identity is not canonical.");
    return NULL;
  }
  unsigned long long cap =
      strcmp(kind, "THUMBNAIL") == 0 ? 524288ULL : 4194304ULL;
  int derived_fd = -1;
  if (recovery_open_derived(gate->root_fd, gate->device, &derived_fd) != 0) {
    throw_code(env, "DERIVED_SERVE_ABSENT", "Derived final is absent.");
    return NULL;
  }
  int parent = -1;
  char missing[16];
  if (recovery_open_final_parent(derived_fd, gate->device, canonical_family,
                                 canonical_media, canonical_recipe,
                                 canonical_generation, &parent, missing,
                                 sizeof(missing)) != 0) {
    close(derived_fd);
    throw_code(env, strcmp(missing, "ABSENT") == 0 ? "DERIVED_SERVE_ABSENT"
                                                   : "DERIVED_SERVE_MISMATCH",
               "Derived final is not readable.");
    return NULL;
  }

  struct stat named;
  int file_fd = -1;
  unsigned char *payload = NULL;
  napi_value result = NULL;
  const char *code = NULL;
  if (fstatat(parent, leaf, &named, AT_SYMLINK_NOFOLLOW) != 0) {
    code = errno == ENOENT ? "DERIVED_SERVE_ABSENT" : "DERIVED_SERVE_MISMATCH";
  } else {
    char actual_size[32];
    int wrote = snprintf(actual_size, sizeof(actual_size), "%llu",
                         (unsigned long long)named.st_size);
    if (!S_ISREG(named.st_mode) || named.st_nlink != 1 ||
        (named.st_mode & 0777) != 0400 || named.st_dev != gate->device ||
        !owned_by_caller(&named) || named.st_size <= 0 || wrote < 0 ||
        (size_t)wrote >= sizeof(actual_size) ||
        strcmp(actual_size, canonical_size) != 0 ||
        (unsigned long long)named.st_size > cap) {
      code = "DERIVED_SERVE_MISMATCH";
    }
  }
  if (code == NULL) {
    file_fd = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct stat opened;
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    char actual_sha[65];
    if (file_fd < 0 || fstat(file_fd, &opened) != 0 ||
        !S_ISREG(opened.st_mode) || opened.st_nlink != 1 ||
        (opened.st_mode & 0777) != 0400 || opened.st_dev != named.st_dev ||
        opened.st_ino != named.st_ino || opened.st_size != named.st_size ||
        !owned_by_caller(&opened) ||
        validate_no_extended_acl(file_fd) != 0 ||
        derived_hash_fd(file_fd, opened.st_size, digest) != 0 ||
        derived_digest_hex(digest, actual_sha) != 0 ||
        strcmp(actual_sha, expected_sha) != 0) {
      code = "DERIVED_SERVE_MISMATCH";
    } else {
      payload = malloc((size_t)opened.st_size);
      off_t offset = 0;
      if (payload == NULL) {
        code = "DERIVED_SERVE_UNAVAILABLE";
      }
      while (code == NULL && offset < opened.st_size) {
        size_t chunk = 8192;
        if ((off_t)chunk > opened.st_size - offset) {
          chunk = (size_t)(opened.st_size - offset);
        }
        ssize_t count = pread(file_fd, payload + offset, chunk, offset);
        if (count < 0) {
          if (errno == EINTR) continue;
          code = "DERIVED_SERVE_UNAVAILABLE";
          break;
        }
        if (count == 0) {
          code = "DERIVED_SERVE_MISMATCH";
          break;
        }
        offset += count;
      }
      struct stat again;
      if (code == NULL &&
          (fstat(file_fd, &again) != 0 || again.st_ino != opened.st_ino ||
           again.st_size != opened.st_size || again.st_nlink != 1)) {
        code = "DERIVED_SERVE_MISMATCH";
      }
      if (code == NULL &&
          napi_create_buffer_copy(env, (size_t)opened.st_size, payload, NULL,
                                  &result) != napi_ok) {
        code = "DERIVED_SERVE_UNAVAILABLE";
        result = NULL;
      }
    }
  }
  if (payload != NULL) free(payload);
  if (file_fd >= 0) close(file_fd);
  close(parent);
  close(derived_fd);
  if (code != NULL) {
    throw_code(env, code, "Derived final is not readable.");
    return NULL;
  }
  return result;
}

#endif
