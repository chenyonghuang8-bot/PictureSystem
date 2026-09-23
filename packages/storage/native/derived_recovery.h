/* Derived publish recovery facts and exact temp cleanup.
 * Included once from storage_native.c after derived_publish.h.
 * Reads protocol names only. Deletes one exact temp inode.
 * Never renames, never overwrites a final, never touches originals.
 */
#ifndef FAMILY_ALBUM_DERIVED_RECOVERY_H
#define FAMILY_ALBUM_DERIVED_RECOVERY_H

#define DERIVED_RECOVERY_PAGE 32

typedef struct {
  char family[32];
  char media[32];
  char generation[32];
  char recipe[8];
  char kind[12];
  char byte_size[32];
  char device[32];
  char inode[32];
  char mode[8];
  char nlink[8];
  char sha[65];
  char file_class[16];
} derived_final_fact_t;

static int recovery_kind_leaf(const char *kind, int final_name, char *out, size_t cap) {
  const char *name = NULL;
  if (strcmp(kind, "THUMBNAIL") == 0) {
    name = final_name ? "thumbnail.webp" : "thumbnail.part";
  } else if (strcmp(kind, "PREVIEW") == 0) {
    name = final_name ? "preview.webp" : "preview.part";
  } else {
    return -1;
  }
  return derived_copy_text(out, cap, name);
}

static int recovery_format_stat(const struct stat *status, char *bytes, size_t bytes_cap,
                                char *device, size_t device_cap, char *inode,
                                size_t inode_cap, char *mode, size_t mode_cap,
                                char *nlink, size_t nlink_cap) {
  int wrote_bytes = snprintf(bytes, bytes_cap, "%llu",
                             (unsigned long long)status->st_size);
  int wrote_device = snprintf(device, device_cap, "%llu",
                              (unsigned long long)status->st_dev);
  int wrote_inode = snprintf(inode, inode_cap, "%llu",
                             (unsigned long long)status->st_ino);
  int wrote_mode = snprintf(mode, mode_cap, "%o", status->st_mode & 0777);
  int wrote_nlink = snprintf(nlink, nlink_cap, "%llu",
                             (unsigned long long)status->st_nlink);
  if (wrote_bytes < 0 || (size_t)wrote_bytes >= bytes_cap || wrote_device < 0 ||
      (size_t)wrote_device >= device_cap || wrote_inode < 0 ||
      (size_t)wrote_inode >= inode_cap || wrote_mode < 0 ||
      (size_t)wrote_mode >= mode_cap || wrote_nlink < 0 ||
      (size_t)wrote_nlink >= nlink_cap) {
    return -1;
  }
  return 0;
}

static int recovery_hash_named(int parent, const char *name, const struct stat *status,
                               char sha_hex[65]) {
  if (!S_ISREG(status->st_mode) || status->st_size < 0) {
    sha_hex[0] = '\0';
    return 0;
  }
  int fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  int hashed = derived_hash_fd(fd, status->st_size, digest);
  int acl = hashed == 0 ? validate_no_extended_acl(fd) : -1;
  close(fd);
  if (hashed != 0 || acl != 0) return -1;
  derived_digest_hex(digest, sha_hex);
  return 0;
}

static void recovery_classify_leaf(int parent, const char *name, dev_t device,
                                   char *file_class, size_t class_cap, char *bytes,
                                   size_t bytes_cap, char *device_text,
                                   size_t device_cap, char *inode, size_t inode_cap,
                                   char *mode, size_t mode_cap, char *nlink,
                                   size_t nlink_cap, char sha_hex[65]) {
  struct stat named;
  sha_hex[0] = '\0';
  bytes[0] = device_text[0] = inode[0] = mode[0] = nlink[0] = '\0';
  if (fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0) {
    derived_copy_text(file_class, class_cap, errno == ENOENT ? "ABSENT" : "UNSAFE");
    return;
  }
  if (recovery_format_stat(&named, bytes, bytes_cap, device_text, device_cap, inode,
                           inode_cap, mode, mode_cap, nlink, nlink_cap) != 0) {
    derived_copy_text(file_class, class_cap, "UNSAFE");
    return;
  }
  if (S_ISLNK(named.st_mode)) {
    derived_copy_text(file_class, class_cap, "SYMLINK");
    return;
  }
  if (!S_ISREG(named.st_mode) || named.st_nlink != 1 || named.st_dev != device ||
      !owned_by_caller(&named) ||
      ((named.st_mode & 0777) != 0600 && (named.st_mode & 0777) != 0400)) {
    derived_copy_text(file_class, class_cap, "UNSAFE");
    return;
  }
  if (recovery_hash_named(parent, name, &named, sha_hex) != 0) {
    derived_copy_text(file_class, class_cap, "UNSAFE");
    return;
  }
  derived_copy_text(file_class, class_cap, "REGULAR");
}

static int recovery_open_derived(int root_fd, dev_t device, int *derived_fd) {
  struct stat status;
  int fd = open_private_directory(root_fd, "derived", device, &status);
  if (fd < 0) return -1;
  *derived_fd = fd;
  return 0;
}

static napi_value recovery_fact_object(napi_env env, const char *file_class,
                                       const char *byte_size, const char *device,
                                       const char *inode, const char *mode,
                                       const char *nlink, const char *sha) {
  napi_value object, value;
  napi_create_object(env, &object);
  napi_create_string_utf8(env, file_class, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, object, "fileClass", value);
  napi_create_string_utf8(env, byte_size, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, object, "byteSize", value);
  napi_create_string_utf8(env, device, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, object, "device", value);
  napi_create_string_utf8(env, inode, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, object, "inode", value);
  napi_create_string_utf8(env, mode, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, object, "mode", value);
  napi_create_string_utf8(env, nlink, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, object, "nlink", value);
  napi_create_string_utf8(env, sha, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, object, "sha256Hex", value);
  return object;
}

static napi_value describe_derived_temp(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  capacity_gate_t *gate = argc == 4 ? get_capacity_gate(env, args[0]) : NULL;
  char job[32], epoch[32], kind[12], leaf[16], epoch_name[40];
  if (argc != 4 || gate == NULL) return NULL;
  if (!gate->locked ||
      get_string(env, args[1], job, sizeof(job)) != 0 ||
      get_string(env, args[2], epoch, sizeof(epoch)) != 0 ||
      get_string(env, args[3], kind, sizeof(kind)) != 0) {
    if (gate != NULL && !gate->locked) {
      throw_code(env, "CAPACITY_LOCK_REQUIRED", "Derived recovery requires the lock.");
    }
    return NULL;
  }
  char canonical_job[32], canonical_epoch[32];
  if (canonical_u64(job, canonical_job, sizeof(canonical_job)) != 0 ||
      canonical_u64(epoch, canonical_epoch, sizeof(canonical_epoch)) != 0 ||
      recovery_kind_leaf(kind, 0, leaf, sizeof(leaf)) != 0 ||
      snprintf(epoch_name, sizeof(epoch_name), "e%s", canonical_epoch) >=
          (int)sizeof(epoch_name)) {
    throw_code(env, "DERIVED_RECOVERY_IDENTITY", "Temp identity is not canonical.");
    return NULL;
  }
  int derived_fd = -1;
  if (recovery_open_derived(gate->root_fd, gate->device, &derived_fd) != 0) {
    throw_code(env, "DERIVED_RECOVERY_IDENTITY", "Derived root is not pinned.");
    return NULL;
  }
  struct stat tmp_status, job_status, epoch_status;
  int tmp_fd = open_private_directory(derived_fd, ".tmp", gate->device, &tmp_status);
  int job_fd = tmp_fd < 0
                   ? -1
                   : open_private_directory(tmp_fd, canonical_job, gate->device,
                                            &job_status);
  int epoch_fd = job_fd < 0 ? -1
                            : open_private_directory(job_fd, epoch_name, gate->device,
                                                     &epoch_status);
  char file_class[16], bytes[32], device[32], inode[32], mode[8], nlink[8], sha[65];
  if (epoch_fd < 0) {
    derived_copy_text(file_class, sizeof(file_class), "ABSENT");
    bytes[0] = device[0] = inode[0] = mode[0] = nlink[0] = sha[0] = '\0';
  } else {
    recovery_classify_leaf(epoch_fd, leaf, gate->device, file_class,
                           sizeof(file_class), bytes, sizeof(bytes), device,
                           sizeof(device), inode, sizeof(inode), mode, sizeof(mode),
                           nlink, sizeof(nlink), sha);
  }
  napi_value result = recovery_fact_object(env, file_class, bytes, device, inode,
                                           mode, nlink, sha);
  if (epoch_fd >= 0) close(epoch_fd);
  if (job_fd >= 0) close(job_fd);
  if (tmp_fd >= 0) close(tmp_fd);
  close(derived_fd);
  return result;
}

static int recovery_open_final_parent(int derived_fd, dev_t device, const char *family,
                                      const char *media, const char *recipe,
                                      const char *generation, int *out_fd,
                                      char *missing_class, size_t class_cap) {
  struct stat status;
  int family_fd = open_private_directory(derived_fd, family, device, &status);
  int media_fd = family_fd < 0
                     ? -1
                     : open_private_directory(family_fd, media, device, &status);
  char recipe_name[16], generation_name[40];
  if (snprintf(recipe_name, sizeof(recipe_name), "r%s", recipe) >=
          (int)sizeof(recipe_name) ||
      snprintf(generation_name, sizeof(generation_name), "g%s", generation) >=
          (int)sizeof(generation_name)) {
    if (family_fd >= 0) close(family_fd);
    if (media_fd >= 0) close(media_fd);
    errno = EINVAL;
    return -1;
  }
  int recipe_fd = media_fd < 0
                      ? -1
                      : open_private_directory(media_fd, recipe_name, device, &status);
  int generation_fd =
      recipe_fd < 0 ? -1
                    : open_private_directory(recipe_fd, generation_name, device,
                                             &status);
  if (family_fd >= 0) close(family_fd);
  if (media_fd >= 0) close(media_fd);
  if (recipe_fd >= 0) close(recipe_fd);
  if (generation_fd < 0) {
    derived_copy_text(missing_class, class_cap,
                      errno == ENOENT || errno == ENOTDIR ? "ABSENT" : "UNSAFE");
    return -1;
  }
  *out_fd = generation_fd;
  return 0;
}

static napi_value inspect_derived_final(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value args[6];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  capacity_gate_t *gate = argc == 6 ? get_capacity_gate(env, args[0]) : NULL;
  char family[32], media[32], generation[32], recipe[32], kind[12], leaf[16];
  if (argc != 6 || gate == NULL) return NULL;
  if (!gate->locked ||
      get_string(env, args[1], family, sizeof(family)) != 0 ||
      get_string(env, args[2], media, sizeof(media)) != 0 ||
      get_string(env, args[3], generation, sizeof(generation)) != 0 ||
      get_string(env, args[4], recipe, sizeof(recipe)) != 0 ||
      get_string(env, args[5], kind, sizeof(kind)) != 0) {
    if (!gate->locked) {
      throw_code(env, "CAPACITY_LOCK_REQUIRED", "Derived recovery requires the lock.");
    }
    return NULL;
  }
  char canonical_family[32], canonical_media[32], canonical_generation[32];
  char canonical_recipe[32];
  if (canonical_u64(family, canonical_family, sizeof(canonical_family)) != 0 ||
      canonical_u64(media, canonical_media, sizeof(canonical_media)) != 0 ||
      canonical_u64(generation, canonical_generation, sizeof(canonical_generation)) !=
          0 ||
      canonical_u64(recipe, canonical_recipe, sizeof(canonical_recipe)) != 0 ||
      strcmp(canonical_recipe, "1") != 0 ||
      recovery_kind_leaf(kind, 1, leaf, sizeof(leaf)) != 0) {
    throw_code(env, "DERIVED_RECOVERY_IDENTITY", "Final identity is not canonical.");
    return NULL;
  }
  int derived_fd = -1;
  if (recovery_open_derived(gate->root_fd, gate->device, &derived_fd) != 0) {
    throw_code(env, "DERIVED_RECOVERY_IDENTITY", "Derived root is not pinned.");
    return NULL;
  }
  int parent = -1;
  char missing[16];
  char file_class[16], bytes[32], device[32], inode[32], mode[8], nlink[8], sha[65];
  if (recovery_open_final_parent(derived_fd, gate->device, canonical_family,
                                 canonical_media, canonical_recipe,
                                 canonical_generation, &parent, missing,
                                 sizeof(missing)) != 0) {
    derived_copy_text(file_class, sizeof(file_class), missing);
    bytes[0] = device[0] = inode[0] = mode[0] = nlink[0] = sha[0] = '\0';
  } else {
    recovery_classify_leaf(parent, leaf, gate->device, file_class, sizeof(file_class),
                           bytes, sizeof(bytes), device, sizeof(device), inode,
                           sizeof(inode), mode, sizeof(mode), nlink, sizeof(nlink),
                           sha);
    close(parent);
  }
  close(derived_fd);
  return recovery_fact_object(env, file_class, bytes, device, inode, mode, nlink, sha);
}

static int recovery_collect_finals(int derived_fd, dev_t device, const char *after,
                                   derived_final_fact_t *items, uint32_t cap,
                                   uint32_t *count, int *paused, char *pause_family,
                                   size_t pause_cap) {
  *count = 0;
  *paused = 0;
  pause_family[0] = '\0';
  char names[DERIVED_RECOVERY_PAGE + 1][NAME_MAX + 1];
  uint32_t selected = 0;
  if (select_later_names(derived_fd, after, DERIVED_RECOVERY_PAGE, names, &selected) !=
      0) {
    return DERIVED_SCAN_ERROR;
  }
  uint32_t returned =
      selected > DERIVED_RECOVERY_PAGE ? DERIVED_RECOVERY_PAGE : selected;
  for (uint32_t index = 0; index < returned; index += 1) {
    if (strcmp(names[index], ".tmp") == 0 ||
        strcmp(names[index], ".capacity.lock") == 0 ||
        strcmp(names[index], ".derived-writer.lock") == 0) {
      continue;
    }
    if (canonical_final_name(names[index], 0, ~0ULL) != 0 ||
        canonical_tree_ok_at(derived_fd, names[index], device) != 0) {
      return DERIVED_SCAN_INCOMPLETE;
    }
    if (*count >= cap) {
      *paused = 1;
      return derived_copy_text(pause_family, pause_cap,
                               index == 0 ? after : names[index - 1]) == 0
                 ? DERIVED_SCAN_CONTINUE
                 : DERIVED_SCAN_ERROR;
    }
    /* One canonical family is recorded by its files below the page cap.
     * A family that itself exceeds the page fails closed.
     */
    struct stat family_status;
    int family_fd =
        open_private_directory(derived_fd, names[index], device, &family_status);
    if (family_fd < 0) return DERIVED_SCAN_INCOMPLETE;
    char media_names[DERIVED_RECOVERY_PAGE + 1][NAME_MAX + 1];
    uint32_t media_count = 0;
    int media_status =
        select_later_names(family_fd, "", DERIVED_RECOVERY_PAGE, media_names,
                           &media_count);
    if (media_status != 0 || media_count > DERIVED_RECOVERY_PAGE) {
      close(family_fd);
      return DERIVED_SCAN_INCOMPLETE;
    }
    for (uint32_t media_index = 0; media_index < media_count; media_index += 1) {
      if (*count >= cap) {
        close(family_fd);
        return DERIVED_SCAN_INCOMPLETE;
      }
      struct stat media_stat, recipe_stat, generation_stat;
      int media_fd = open_private_directory(family_fd, media_names[media_index],
                                            device, &media_stat);
      int recipe_fd =
          media_fd < 0 ? -1
                       : open_private_directory(media_fd, "r1", device, &recipe_stat);
      char generation_names[DERIVED_RECOVERY_PAGE + 1][NAME_MAX + 1];
      uint32_t generation_count = 0;
      int generation_scan =
          recipe_fd < 0
              ? -1
              : select_later_names(recipe_fd, "", DERIVED_RECOVERY_PAGE,
                                   generation_names, &generation_count);
      if (media_fd < 0 || recipe_fd < 0 || generation_scan != 0 ||
          generation_count == 0 || generation_count > DERIVED_RECOVERY_PAGE) {
        if (recipe_fd >= 0) close(recipe_fd);
        if (media_fd >= 0) close(media_fd);
        close(family_fd);
        return DERIVED_SCAN_INCOMPLETE;
      }
      for (uint32_t generation_index = 0; generation_index < generation_count;
           generation_index += 1) {
        int generation_fd = open_private_directory(
            recipe_fd, generation_names[generation_index], device, &generation_stat);
        if (generation_fd < 0) {
          close(recipe_fd);
          close(media_fd);
          close(family_fd);
          return DERIVED_SCAN_INCOMPLETE;
        }
        const char *leaves[2] = {"thumbnail.webp", "preview.webp"};
        for (int leaf_index = 0; leaf_index < 2; leaf_index += 1) {
          struct stat named;
          if (fstatat(generation_fd, leaves[leaf_index], &named,
                      AT_SYMLINK_NOFOLLOW) != 0) {
            if (errno == ENOENT) continue;
            close(generation_fd);
            close(recipe_fd);
            close(media_fd);
            close(family_fd);
            return DERIVED_SCAN_INCOMPLETE;
          }
          if (*count >= cap) {
            close(generation_fd);
            close(recipe_fd);
            close(media_fd);
            close(family_fd);
            return DERIVED_SCAN_INCOMPLETE;
          }
          derived_final_fact_t *item = &items[*count];
          memset(item, 0, sizeof(*item));
          char epoch_decimal[32];
          if (canonical_u64(media_names[media_index], item->media, sizeof(item->media)) !=
                  0 ||
              canonical_final_name(generation_names[generation_index], 'g', ~0ULL) !=
                  0 ||
              canonical_u64(generation_names[generation_index] + 1, epoch_decimal,
                            sizeof(epoch_decimal)) != 0 ||
              derived_copy_text(item->family, sizeof(item->family), names[index]) !=
                  0 ||
              derived_copy_text(item->generation, sizeof(item->generation),
                                epoch_decimal) != 0 ||
              derived_copy_text(item->recipe, sizeof(item->recipe), "1") != 0) {
            close(generation_fd);
            close(recipe_fd);
            close(media_fd);
            close(family_fd);
            return DERIVED_SCAN_INCOMPLETE;
          }
          const char *kind = leaf_index == 0 ? "THUMBNAIL" : "PREVIEW";
          derived_copy_text(item->kind, sizeof(item->kind), kind);
          recovery_classify_leaf(generation_fd, leaves[leaf_index], device,
                                 item->file_class, sizeof(item->file_class),
                                 item->byte_size, sizeof(item->byte_size),
                                 item->device, sizeof(item->device), item->inode,
                                 sizeof(item->inode), item->mode, sizeof(item->mode),
                                 item->nlink, sizeof(item->nlink), item->sha);
          if (strcmp(item->file_class, "REGULAR") != 0 &&
              strcmp(item->file_class, "SYMLINK") != 0) {
            close(generation_fd);
            close(recipe_fd);
            close(media_fd);
            close(family_fd);
            return DERIVED_SCAN_INCOMPLETE;
          }
          *count += 1;
        }
        close(generation_fd);
      }
      close(recipe_fd);
      close(media_fd);
    }
    close(family_fd);
    if (index + 1 == returned && selected > DERIVED_RECOVERY_PAGE) {
      *paused = 1;
      if (derived_copy_text(pause_family, pause_cap, names[index]) != 0) {
        return DERIVED_SCAN_ERROR;
      }
    }
  }
  return *paused ? DERIVED_SCAN_CONTINUE : DERIVED_SCAN_COMPLETE;
}

static napi_value derived_final_inventory_page(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  capacity_gate_t *gate = argc == 2 ? get_capacity_gate(env, args[0]) : NULL;
  char cursor[DERIVED_CURSOR_CAP];
  size_t cursor_length = 0;
  if (argc != 2 || gate == NULL) return NULL;
  if (!gate->locked) {
    throw_code(env, "CAPACITY_LOCK_REQUIRED", "Derived recovery requires the lock.");
    return NULL;
  }
  if (napi_get_value_string_utf8(env, args[1], cursor, sizeof(cursor),
                                 &cursor_length) != napi_ok ||
      cursor_length >= sizeof(cursor)) {
    throw_code(env, "STORAGE_INVALID_ARGUMENT", "Invalid final inventory cursor.");
    return NULL;
  }
  if (cursor[0] != '\0' && canonical_u64(cursor, cursor, sizeof(cursor)) != 0) {
    throw_code(env, "STORAGE_INVALID_ARGUMENT", "Invalid final inventory cursor.");
    return NULL;
  }
  int derived_fd = -1;
  napi_value result, outcome_value, cursor_value, items;
  napi_create_object(env, &result);
  if (recovery_open_derived(gate->root_fd, gate->device, &derived_fd) != 0) {
    if (errno == ENOENT && cursor[0] == '\0') {
      napi_create_string_utf8(env, "complete", NAPI_AUTO_LENGTH, &outcome_value);
      napi_create_string_utf8(env, "", NAPI_AUTO_LENGTH, &cursor_value);
      napi_create_array_with_length(env, 0, &items);
      napi_set_named_property(env, result, "outcome", outcome_value);
      napi_set_named_property(env, result, "nextCursor", cursor_value);
      napi_set_named_property(env, result, "finals", items);
      return result;
    }
    throw_code(env, "DERIVED_RECOVERY_INCOMPLETE", "Derived final scan is incomplete.");
    return NULL;
  }
  derived_final_fact_t facts[DERIVED_RECOVERY_PAGE];
  uint32_t count = 0;
  int paused = 0;
  char pause_family[NAME_MAX + 1];
  int status = recovery_collect_finals(derived_fd, gate->device, cursor, facts,
                                       DERIVED_RECOVERY_PAGE, &count, &paused,
                                       pause_family, sizeof(pause_family));
  close(derived_fd);
  if (status != DERIVED_SCAN_COMPLETE && status != DERIVED_SCAN_CONTINUE) {
    throw_code(env, "DERIVED_RECOVERY_INCOMPLETE", "Derived final scan is incomplete.");
    return NULL;
  }
  const char *outcome = status == DERIVED_SCAN_CONTINUE ? "continue" : "complete";
  napi_create_string_utf8(env, outcome, NAPI_AUTO_LENGTH, &outcome_value);
  napi_create_string_utf8(env, pause_family, NAPI_AUTO_LENGTH, &cursor_value);
  napi_create_array_with_length(env, count, &items);
  for (uint32_t index = 0; index < count; index += 1) {
    napi_value item = recovery_fact_object(
        env, facts[index].file_class, facts[index].byte_size, facts[index].device,
        facts[index].inode, facts[index].mode, facts[index].nlink, facts[index].sha);
    napi_value value;
    napi_create_string_utf8(env, facts[index].family, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "familyId", value);
    napi_create_string_utf8(env, facts[index].media, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "mediaId", value);
    napi_create_string_utf8(env, facts[index].generation, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "generation", value);
    napi_create_string_utf8(env, facts[index].recipe, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "recipeId", value);
    napi_create_string_utf8(env, facts[index].kind, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "kind", value);
    napi_set_element(env, items, index, item);
  }
  napi_set_named_property(env, result, "outcome", outcome_value);
  napi_set_named_property(env, result, "nextCursor", cursor_value);
  napi_set_named_property(env, result, "finals", items);
  return result;
}

static napi_value cleanup_exact_derived_temp(napi_env env, napi_callback_info info) {
  size_t argc = 12;
  napi_value args[12];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  derived_store_t *store = argc == 12 ? derived_get_store(env, args[0]) : NULL;
  char job[32], epoch[32], kind[12], device[32], inode[32], byte_size[32], sha[80];
  char family[32], media[32], generation[32], recipe[32];
  if (store == NULL || get_string(env, args[1], job, sizeof(job)) != 0 ||
      get_string(env, args[2], epoch, sizeof(epoch)) != 0 ||
      get_string(env, args[3], kind, sizeof(kind)) != 0 ||
      get_string(env, args[4], device, sizeof(device)) != 0 ||
      get_string(env, args[5], inode, sizeof(inode)) != 0 ||
      get_string(env, args[6], byte_size, sizeof(byte_size)) != 0 ||
      get_string(env, args[7], sha, sizeof(sha)) != 0 ||
      get_string(env, args[8], family, sizeof(family)) != 0 ||
      get_string(env, args[9], media, sizeof(media)) != 0 ||
      get_string(env, args[10], generation, sizeof(generation)) != 0 ||
      get_string(env, args[11], recipe, sizeof(recipe)) != 0) {
    return NULL;
  }
  char canonical_job[32], canonical_epoch[32], canonical_family[32];
  char canonical_media[32], canonical_generation[32], canonical_recipe[32];
  char leaf[16], epoch_name[40];
  if (canonical_u64(job, canonical_job, sizeof(canonical_job)) != 0 ||
      canonical_u64(epoch, canonical_epoch, sizeof(canonical_epoch)) != 0 ||
      canonical_u64(family, canonical_family, sizeof(canonical_family)) != 0 ||
      canonical_u64(media, canonical_media, sizeof(canonical_media)) != 0 ||
      canonical_u64(generation, canonical_generation, sizeof(canonical_generation)) !=
          0 ||
      canonical_u64(recipe, canonical_recipe, sizeof(canonical_recipe)) != 0 ||
      strcmp(canonical_recipe, "1") != 0 ||
      recovery_kind_leaf(kind, 0, leaf, sizeof(leaf)) != 0 ||
      snprintf(epoch_name, sizeof(epoch_name), "e%s", canonical_epoch) >=
          (int)sizeof(epoch_name)) {
    throw_code(env, "DERIVED_RECOVERY_IDENTITY", "Cleanup identity is not canonical.");
    return NULL;
  }
  pthread_mutex_lock(&store->mutex);
  if (derived_live_index(store, canonical_job, canonical_epoch, kind) >= 0) {
    pthread_mutex_unlock(&store->mutex);
    throw_code(env, "DERIVED_RECOVERY_LIVE", "A live writer still owns this temp.");
    return NULL;
  }
  struct stat tmp_status, job_status, epoch_status;
  int tmp_fd = open_private_directory(store->derived_fd, ".tmp", store->device,
                                      &tmp_status);
  int job_fd = tmp_fd < 0 ? -1
                          : open_private_directory(tmp_fd, canonical_job, store->device,
                                                   &job_status);
  int epoch_fd = job_fd < 0
                     ? -1
                     : open_private_directory(job_fd, epoch_name, store->device,
                                              &epoch_status);
  char file_class[16], bytes[32], found_device[32], found_inode[32], mode[8];
  char nlink[8], found_sha[65];
  if (epoch_fd < 0) {
    if (tmp_fd >= 0) close(tmp_fd);
    if (job_fd >= 0) close(job_fd);
    pthread_mutex_unlock(&store->mutex);
    throw_code(env, "DERIVED_RECOVERY_IDENTITY", "Exact temp is not present.");
    return NULL;
  }
  recovery_classify_leaf(epoch_fd, leaf, store->device, file_class, sizeof(file_class),
                         bytes, sizeof(bytes), found_device, sizeof(found_device),
                         found_inode, sizeof(found_inode), mode, sizeof(mode), nlink,
                         sizeof(nlink), found_sha);
  if (strcmp(file_class, "REGULAR") != 0 || strcmp(mode, "600") != 0 ||
      strcmp(nlink, "1") != 0 || strcmp(found_device, device) != 0 ||
      strcmp(found_inode, inode) != 0 || strcmp(bytes, byte_size) != 0 ||
      strcmp(found_sha, sha) != 0) {
    close(epoch_fd);
    close(job_fd);
    close(tmp_fd);
    pthread_mutex_unlock(&store->mutex);
    throw_code(env, strcmp(file_class, "SYMLINK") == 0 ? "DERIVED_RECOVERY_UNSAFE"
                                                       : "DERIVED_RECOVERY_IDENTITY",
               "Temp identity changed before cleanup.");
    return NULL;
  }
  int final_parent = -1;
  char missing[16] = "ABSENT";
  char final_leaf[16];
  if (recovery_kind_leaf(kind, 1, final_leaf, sizeof(final_leaf)) != 0) {
    close(epoch_fd);
    close(job_fd);
    close(tmp_fd);
    pthread_mutex_unlock(&store->mutex);
    throw_code(env, "DERIVED_RECOVERY_IDENTITY", "Final kind is not canonical.");
    return NULL;
  }
  int final_open = recovery_open_final_parent(
      store->derived_fd, store->device, canonical_family, canonical_media,
      canonical_recipe, canonical_generation, &final_parent, missing, sizeof(missing));
  char final_class[16], final_bytes[32], final_device[32], final_inode[32];
  char final_mode[8], final_nlink[8], final_sha[65];
  if (final_open == 0) {
    recovery_classify_leaf(final_parent, final_leaf, store->device, final_class,
                           sizeof(final_class), final_bytes, sizeof(final_bytes),
                           final_device, sizeof(final_device), final_inode,
                           sizeof(final_inode), final_mode, sizeof(final_mode),
                           final_nlink, sizeof(final_nlink), final_sha);
    close(final_parent);
    if (strcmp(final_class, "ABSENT") != 0) {
      close(epoch_fd);
      close(job_fd);
      close(tmp_fd);
      pthread_mutex_unlock(&store->mutex);
      throw_code(env, "DERIVED_RECOVERY_FINAL_PRESENT",
                 "Exact cleanup cannot run while a final name exists.");
      return NULL;
    }
  } else if (strcmp(missing, "ABSENT") != 0) {
    close(epoch_fd);
    close(job_fd);
    close(tmp_fd);
    pthread_mutex_unlock(&store->mutex);
    throw_code(env, "DERIVED_RECOVERY_UNSAFE", "Final parent is not a private directory.");
    return NULL;
  }
  struct stat before;
  if (fstatat(epoch_fd, leaf, &before, AT_SYMLINK_NOFOLLOW) != 0 ||
      unlinkat(epoch_fd, leaf, 0) != 0) {
    close(epoch_fd);
    close(job_fd);
    close(tmp_fd);
    pthread_mutex_unlock(&store->mutex);
    throw_code(env, "DERIVED_RECOVERY_IDENTITY", "Exact temp unlink did not start.");
    return NULL;
  }
  struct stat after;
  int gone = fstatat(epoch_fd, leaf, &after, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
  int fail_sync = store->fail_next_fsync;
  store->fail_next_fsync = 0;
  int synced = gone && fail_sync == 0 && sync_directory_fd(epoch_fd) == 0;
  if (synced) {
    derived_prune_empty_chain(store->derived_fd, tmp_fd, job_fd, epoch_fd, store->device,
                              tmp_status.st_ino, job_status.st_ino, epoch_status.st_ino,
                              canonical_job, epoch_name);
  }
  close(epoch_fd);
  close(job_fd);
  close(tmp_fd);
  pthread_mutex_unlock(&store->mutex);
  if (!synced) {
    throw_code(env, "DERIVED_RECOVERY_DURABILITY_UNKNOWN",
               "Temp unlink may have completed without a confirmed sync.");
    return NULL;
  }
  napi_value durable;
  napi_get_boolean(env, true, &durable);
  return durable;
}

#endif
