/* Read-only derived known-file inventory.
 * Recognizes only derived/.capacity.lock, derived/.derived-writer.lock, and
 * derived/.tmp/<job>/e<epoch>/{thumbnail,preview}.part.
 * This file must not create, rename, unlink, chmod, or truncate anything.
 */
#ifndef FAMILY_ALBUM_DERIVED_INVENTORY_H
#define FAMILY_ALBUM_DERIVED_INVENTORY_H

#define DERIVED_SCAN_COMPLETE 0
#define DERIVED_SCAN_CONTINUE 1
#define DERIVED_SCAN_INCOMPLETE 2
#define DERIVED_SCAN_ERROR (-1)
#define DERIVED_CURSOR_CAP 768
#define DERIVED_GENERATION_CAP 192
#define DERIVED_PAGE_JOBS 48
#define DERIVED_PAGE_EPOCHS 32
#define DERIVED_PAGE_OBSERVATIONS 96
#define DERIVED_OBSERVATION_LIMIT 16384U

typedef struct {
  char job_id[32];
  char epoch[32];
  char kind[12];
  char byte_size[32];
  char device[32];
  char inode[32];
} derived_observation_t;

static int derived_copy_text(char *destination, size_t capacity, const char *source) {
  size_t length = strlen(source);
  if (length >= capacity) return -1;
  memcpy(destination, source, length + 1);
  return 0;
}

static int canonical_u64(const char *text, char *out, size_t out_cap) {
  if (text == NULL || text[0] == '\0' || text[0] == '0') return -1;
  uint64_t value = 0;
  size_t length = 0;
  for (const char *cursor = text; *cursor != '\0'; cursor += 1) {
    if (*cursor < '0' || *cursor > '9') return -1;
    length += 1;
    if (length > 20 || length >= out_cap) return -1;
    uint64_t digit = (uint64_t)(*cursor - '0');
    if (value > (UINT64_MAX - digit) / 10) return -1;
    value = value * 10 + digit;
  }
  memcpy(out, text, length);
  out[length] = '\0';
  return 0;
}

static int canonical_epoch_name(const char *name, char *decimal, size_t decimal_cap) {
  if (name == NULL || name[0] != 'e') return -1;
  return canonical_u64(name + 1, decimal, decimal_cap);
}

static int derived_kind_name(const char *name, char *kind, size_t kind_cap) {
  const char *token = NULL;
  if (strcmp(name, "thumbnail.part") == 0) token = "THUMBNAIL";
  else if (strcmp(name, "preview.part") == 0) token = "PREVIEW";
  else return -1;
  return derived_copy_text(kind, kind_cap, token);
}

static int format_identity(const struct stat *status, char *out, size_t cap) {
  if (status->st_dev < 0 || status->st_size < 0) return -1;
  int written = snprintf(
      out, cap, "%llu:%llu:%lld:%ld:%lld:%ld",
      (unsigned long long)status->st_dev, (unsigned long long)status->st_ino,
      (long long)status->st_mtimespec.tv_sec, status->st_mtimespec.tv_nsec,
      (long long)status->st_ctimespec.tv_sec, status->st_ctimespec.tv_nsec);
  if (written < 0 || (size_t)written >= cap) return -1;
  return 0;
}

static int same_identity(const struct stat *before, const struct stat *after) {
  return before->st_dev == after->st_dev && before->st_ino == after->st_ino &&
         before->st_mtimespec.tv_sec == after->st_mtimespec.tv_sec &&
         before->st_mtimespec.tv_nsec == after->st_mtimespec.tv_nsec &&
         before->st_ctimespec.tv_sec == after->st_ctimespec.tv_sec &&
         before->st_ctimespec.tv_nsec == after->st_ctimespec.tv_nsec;
}

static int openat_restart(int parent, const char *name, int flags) {
  for (;;) {
    int fd = openat(parent, name, flags);
    if (fd >= 0 || errno != EINTR) return fd;
  }
}

static int derived_policy_errno(int error) {
  return error == EPERM || error == EACCES || error == ELOOP ||
         error == ENOTDIR || error == EINVAL || error == ENAMETOOLONG ||
         error == ENOENT || error == EMLINK;
}

static int owned_by_caller(const struct stat *status) {
  return status->st_uid == geteuid() && status->st_gid == getegid();
}

static int open_private_directory(int parent, const char *name, dev_t device,
                                  struct stat *out) {
  struct stat named;
  if (fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0) return -1;
  if (!S_ISDIR(named.st_mode) || !owned_by_caller(&named) ||
      named.st_dev != device || (named.st_mode & 077) != 0) {
    errno = EPERM;
    return -1;
  }
  int fd = openat_restart(parent, name,
                          O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat opened;
  int failure = 0;
  if (fstat(fd, &opened) != 0 || !same_identity(&named, &opened) ||
      !owned_by_caller(&opened) || validate_no_extended_acl(fd) != 0) {
    failure = errno == 0 ? EPERM : errno;
  }
  struct stat again;
  if (failure == 0 &&
      (fstatat(parent, name, &again, AT_SYMLINK_NOFOLLOW) != 0 ||
       !same_identity(&named, &again))) {
    failure = errno == 0 ? EPERM : errno;
  }
  if (failure != 0) {
    close(fd);
    errno = failure;
    return -1;
  }
  *out = named;
  return fd;
}

static int private_file_mode(mode_t mode, int sealed_part) {
  mode_t bits = mode & 0777;
  return bits == 0600 || (sealed_part && bits == 0400);
}

static int inspect_private_file(int parent, const char *name, dev_t device,
                                struct stat *out, int sealed_part) {
  struct stat named;
  if (fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0) return -1;
  if (!S_ISREG(named.st_mode) || named.st_nlink != 1 ||
      !owned_by_caller(&named) || named.st_dev != device ||
      named.st_size < 0 || !private_file_mode(named.st_mode, sealed_part)) {
    errno = EPERM;
    return -1;
  }
  int fd = openat_restart(parent, name,
                          O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat opened;
  int failure = 0;
  if (fstat(fd, &opened) != 0 || !S_ISREG(opened.st_mode) ||
      !owned_by_caller(&opened) || opened.st_nlink != 1 ||
      !private_file_mode(opened.st_mode, sealed_part) || opened.st_dev != named.st_dev ||
      opened.st_ino != named.st_ino || opened.st_size != named.st_size ||
      validate_no_extended_acl(fd) != 0) {
    failure = errno == 0 ? EPERM : errno;
  }
  int saved = failure;
  if (close(fd) != 0 && saved == 0) saved = errno;
  struct stat again;
  if (saved == 0 &&
      (fstatat(parent, name, &again, AT_SYMLINK_NOFOLLOW) != 0 ||
       !S_ISREG(again.st_mode) || !owned_by_caller(&again) ||
       again.st_dev != named.st_dev || again.st_ino != named.st_ino ||
       again.st_size != named.st_size ||        again.st_nlink != 1 ||
       !private_file_mode(again.st_mode, sealed_part))) {
    saved = errno == 0 ? EPERM : errno;
  }
  if (saved != 0) {
    errno = saved;
    return -1;
  }
  *out = named;
  return 0;
}

static int select_later_names(int dir_fd, const char *after, uint32_t limit,
                              char names[][NAME_MAX + 1], uint32_t *count) {
  int fd = dup(dir_fd);
  if (fd < 0) return -1;
  DIR *directory = fdopendir(fd);
  if (directory == NULL) {
    int saved = errno;
    close(fd);
    errno = saved;
    return -1;
  }
  *count = 0;
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
      errno = 0;
      continue;
    }
    size_t length = strlen(entry->d_name);
    if (length == 0 || length > NAME_MAX) {
      closedir(directory);
      errno = EPERM;
      return -1;
    }
    if (after[0] != '\0' && strcmp(entry->d_name, after) <= 0) {
      errno = 0;
      continue;
    }
    uint32_t index = 0;
    while (index < *count && strcmp(names[index], entry->d_name) < 0) index += 1;
    if (index >= limit + 1) {
      errno = 0;
      continue;
    }
    if (*count < limit + 1) *count += 1;
    for (uint32_t position = *count - 1; position > index; position -= 1) {
      memcpy(names[position], names[position - 1], NAME_MAX + 1);
    }
    memset(names[index], 0, NAME_MAX + 1);
    memcpy(names[index], entry->d_name, length + 1);
    errno = 0;
  }
  int read_error = errno;
  if (closedir(directory) != 0 && read_error == 0) read_error = errno;
  if (read_error != 0) {
    errno = read_error;
    return -1;
  }
  return 0;
}

static int inspect_derived_root(int derived_fd, dev_t device, int *has_tmp) {
  *has_tmp = 0;
  int fd = dup(derived_fd);
  if (fd < 0) return DERIVED_SCAN_ERROR;
  DIR *directory = fdopendir(fd);
  if (directory == NULL) {
    int saved = errno;
    close(fd);
    errno = saved;
    return DERIVED_SCAN_ERROR;
  }
  int saw_lock = 0;
  int saw_writer_lock = 0;
  int status = DERIVED_SCAN_COMPLETE;
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
      errno = 0;
      continue;
    }
    if (strcmp(entry->d_name, ".capacity.lock") == 0 ||
        strcmp(entry->d_name, ".derived-writer.lock") == 0) {
      int *seen = entry->d_name[1] == 'c' ? &saw_lock : &saw_writer_lock;
      struct stat file_status;
      if (*seen ||
          inspect_private_file(derived_fd, entry->d_name, device,
                               &file_status, 0) != 0) {
        status = derived_policy_errno(errno) || *seen ? DERIVED_SCAN_INCOMPLETE
                                                      : DERIVED_SCAN_ERROR;
        break;
      }
      *seen = 1;
      errno = 0;
      continue;
    }
    if (strcmp(entry->d_name, ".tmp") == 0) {
      if (*has_tmp) {
        status = DERIVED_SCAN_INCOMPLETE;
        break;
      }
      *has_tmp = 1;
      errno = 0;
      continue;
    }
    status = DERIVED_SCAN_INCOMPLETE;
    break;
  }
  if (status == DERIVED_SCAN_COMPLETE && errno != 0) status = DERIVED_SCAN_ERROR;
  if (closedir(directory) != 0 && status == DERIVED_SCAN_COMPLETE) {
    status = DERIVED_SCAN_ERROR;
  }
  return status;
}

static int push_observation(derived_observation_t *observations, uint32_t cap,
                            uint32_t *count, const char *job_id,
                            const char *epoch, const char *kind,
                            const struct stat *status) {
  if (*count >= cap) return -1;
  derived_observation_t *item = &observations[*count];
  memset(item, 0, sizeof(*item));
  if (derived_copy_text(item->job_id, sizeof(item->job_id), job_id) != 0 ||
      derived_copy_text(item->epoch, sizeof(item->epoch), epoch) != 0 ||
      derived_copy_text(item->kind, sizeof(item->kind), kind) != 0) {
    return -1;
  }
  int byte_written = snprintf(item->byte_size, sizeof(item->byte_size), "%llu",
                              (unsigned long long)status->st_size);
  int device_written = snprintf(item->device, sizeof(item->device), "%llu",
                                (unsigned long long)status->st_dev);
  int inode_written = snprintf(item->inode, sizeof(item->inode), "%llu",
                               (unsigned long long)status->st_ino);
  if (byte_written < 0 || (size_t)byte_written >= sizeof(item->byte_size) ||
      device_written < 0 || (size_t)device_written >= sizeof(item->device) ||
      inode_written < 0 || (size_t)inode_written >= sizeof(item->inode)) {
    return -1;
  }
  *count += 1;
  return 0;
}

static int scan_epoch_files(int epoch_fd, const struct stat *epoch_before,
                            dev_t device, const char *job_id, const char *epoch,
                            derived_observation_t *observations,
                            uint32_t observation_cap, uint32_t *observation_count) {
  int fd = dup(epoch_fd);
  if (fd < 0) return DERIVED_SCAN_ERROR;
  DIR *directory = fdopendir(fd);
  if (directory == NULL) {
    int saved = errno;
    close(fd);
    errno = saved;
    return DERIVED_SCAN_ERROR;
  }
  char found[2][NAME_MAX + 1];
  uint32_t seen = 0;
  int status = DERIVED_SCAN_COMPLETE;
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
      errno = 0;
      continue;
    }
    if (seen == 2 || strlen(entry->d_name) > NAME_MAX) {
      status = DERIVED_SCAN_INCOMPLETE;
      break;
    }
    memset(found[seen], 0, NAME_MAX + 1);
    memcpy(found[seen], entry->d_name, strlen(entry->d_name) + 1);
    seen += 1;
    errno = 0;
  }
  if (status == DERIVED_SCAN_COMPLETE && errno != 0) status = DERIVED_SCAN_ERROR;
  if (closedir(directory) != 0 && status == DERIVED_SCAN_COMPLETE) {
    status = DERIVED_SCAN_ERROR;
  }
  if (status != DERIVED_SCAN_COMPLETE) return status;
  if (seen == 0) return DERIVED_SCAN_INCOMPLETE;
  if (seen == 2 && strcmp(found[0], found[1]) > 0) {
    char swap[NAME_MAX + 1];
    memcpy(swap, found[0], sizeof(swap));
    memcpy(found[0], found[1], sizeof(found[0]));
    memcpy(found[1], swap, sizeof(found[1]));
  }
  for (uint32_t index = 0; index < seen; index += 1) {
    char kind[12];
    struct stat file_status;
    if (derived_kind_name(found[index], kind, sizeof(kind)) != 0) {
      return DERIVED_SCAN_INCOMPLETE;
    }
    if (inspect_private_file(epoch_fd, found[index], device, &file_status, 1) !=
        0) {
      return derived_policy_errno(errno) ? DERIVED_SCAN_INCOMPLETE
                                         : DERIVED_SCAN_ERROR;
    }
    if (push_observation(observations, observation_cap, observation_count,
                         job_id, epoch, kind, &file_status) != 0) {
      return DERIVED_SCAN_INCOMPLETE;
    }
  }
  struct stat epoch_after;
  if (fstat(epoch_fd, &epoch_after) != 0) return DERIVED_SCAN_ERROR;
  if (!same_identity(epoch_before, &epoch_after)) return DERIVED_SCAN_INCOMPLETE;
  return DERIVED_SCAN_COMPLETE;
}

static int scan_job(int tmp_fd, dev_t device, const char *job_name,
                    const char *after_epoch, derived_observation_t *observations,
                    uint32_t observation_cap, uint32_t *observation_count,
                    int *paused, char *pause_epoch, size_t pause_epoch_cap) {
  char job_id[32];
  *paused = 0;
  pause_epoch[0] = '\0';
  if (canonical_u64(job_name, job_id, sizeof(job_id)) != 0) {
    return DERIVED_SCAN_INCOMPLETE;
  }
  struct stat job_before;
  int job_fd = open_private_directory(tmp_fd, job_name, device, &job_before);
  if (job_fd < 0) {
    return derived_policy_errno(errno) ? DERIVED_SCAN_INCOMPLETE
                                       : DERIVED_SCAN_ERROR;
  }
  char names[DERIVED_PAGE_EPOCHS + 1][NAME_MAX + 1];
  uint32_t selected = 0;
  int status = DERIVED_SCAN_COMPLETE;
  if (select_later_names(job_fd, after_epoch, DERIVED_PAGE_EPOCHS, names,
                         &selected) != 0) {
    status = derived_policy_errno(errno) ? DERIVED_SCAN_INCOMPLETE
                                        : DERIVED_SCAN_ERROR;
  }
  uint32_t returned =
      selected > DERIVED_PAGE_EPOCHS ? DERIVED_PAGE_EPOCHS : selected;
  if (status == DERIVED_SCAN_COMPLETE && returned == 0 && after_epoch[0] == '\0') {
    status = DERIVED_SCAN_INCOMPLETE;
  }
  for (uint32_t index = 0; status == DERIVED_SCAN_COMPLETE && index < returned;
       index += 1) {
    if (*observation_count + 2 > observation_cap) {
      *paused = 1;
      if (derived_copy_text(pause_epoch, pause_epoch_cap,
                            index == 0 ? after_epoch : names[index - 1]) != 0) {
        status = DERIVED_SCAN_ERROR;
      }
      break;
    }
    char epoch[32];
    if (canonical_epoch_name(names[index], epoch, sizeof(epoch)) != 0) {
      status = DERIVED_SCAN_INCOMPLETE;
      break;
    }
    struct stat epoch_before;
    int epoch_fd =
        open_private_directory(job_fd, names[index], device, &epoch_before);
    if (epoch_fd < 0) {
      status = derived_policy_errno(errno) ? DERIVED_SCAN_INCOMPLETE
                                          : DERIVED_SCAN_ERROR;
      break;
    }
    status = scan_epoch_files(epoch_fd, &epoch_before, device, job_id, epoch,
                              observations, observation_cap, observation_count);
    if (close(epoch_fd) != 0 && status == DERIVED_SCAN_COMPLETE) {
      status = DERIVED_SCAN_ERROR;
    }
    if (status != DERIVED_SCAN_COMPLETE) break;
    if (index + 1 == returned && selected > DERIVED_PAGE_EPOCHS) {
      *paused = 1;
      if (derived_copy_text(pause_epoch, pause_epoch_cap, names[index]) != 0) {
        status = DERIVED_SCAN_ERROR;
      }
    }
  }
  struct stat job_after;
  if (status == DERIVED_SCAN_COMPLETE &&
      (fstat(job_fd, &job_after) != 0 || !same_identity(&job_before, &job_after))) {
    status = errno == 0 || derived_policy_errno(errno) ? DERIVED_SCAN_INCOMPLETE
                                                       : DERIVED_SCAN_ERROR;
  }
  if (close(job_fd) != 0 && status == DERIVED_SCAN_COMPLETE) {
    status = DERIVED_SCAN_ERROR;
  }
  return status;
}

static int build_derived_cursor(char *out, size_t cap, const char *derived_gen,
                                const char *tmp_gen, const char *after_job,
                                const char *resume_job, const char *after_epoch) {
  int written = snprintf(out, cap, "v1|%s|%s|%s|%s|%s", derived_gen, tmp_gen,
                         after_job, resume_job, after_epoch);
  if (written < 0 || (size_t)written >= cap) return -1;
  return 0;
}

static int parse_derived_cursor(const char *cursor, char *derived_gen,
                                size_t derived_cap, char *tmp_gen, size_t tmp_cap,
                                char *after_job, size_t after_cap, char *resume_job,
                                size_t resume_cap, char *after_epoch,
                                size_t epoch_cap) {
  derived_gen[0] = '\0';
  tmp_gen[0] = '\0';
  after_job[0] = '\0';
  resume_job[0] = '\0';
  after_epoch[0] = '\0';
  if (cursor[0] == '\0') return 0;
  char copy[DERIVED_CURSOR_CAP];
  if (derived_copy_text(copy, sizeof(copy), cursor) != 0) return -1;
  char *fields[6];
  uint32_t count = 0;
  fields[count++] = copy;
  for (char *pointer = copy; *pointer != '\0'; pointer += 1) {
    if (*pointer == '|') {
      if (count == 6) return -1;
      *pointer = '\0';
      fields[count++] = pointer + 1;
    }
  }
  if (count != 6 || strcmp(fields[0], "v1") != 0) return -1;
  if (fields[1][0] == '\0' || fields[2][0] == '\0') return -1;
  char checked[32];
  if (derived_copy_text(derived_gen, derived_cap, fields[1]) != 0 ||
      derived_copy_text(tmp_gen, tmp_cap, fields[2]) != 0 ||
      derived_copy_text(after_job, after_cap, fields[3]) != 0 ||
      derived_copy_text(resume_job, resume_cap, fields[4]) != 0 ||
      derived_copy_text(after_epoch, epoch_cap, fields[5]) != 0) {
    return -1;
  }
  if (after_job[0] != '\0' &&
      canonical_u64(after_job, checked, sizeof(checked)) != 0) {
    return -1;
  }
  if (resume_job[0] != '\0' &&
      canonical_u64(resume_job, checked, sizeof(checked)) != 0) {
    return -1;
  }
  if (after_epoch[0] != '\0' &&
      canonical_epoch_name(after_epoch, checked, sizeof(checked)) != 0) {
    return -1;
  }
  return 0;
}

static int derived_inventory_page(capacity_gate_t *gate, const char *cursor,
                                  char *next_cursor, size_t next_cursor_cap,
                                  char *generation, size_t generation_cap,
                                  derived_observation_t *observations,
                                  uint32_t observation_cap,
                                  uint32_t *observation_count) {
  next_cursor[0] = '\0';
  generation[0] = '\0';
  *observation_count = 0;
  char cursor_derived[DERIVED_GENERATION_CAP];
  char cursor_tmp[DERIVED_GENERATION_CAP];
  char after_job[NAME_MAX + 1];
  char resume_job[NAME_MAX + 1];
  char after_epoch[NAME_MAX + 1];
  if (parse_derived_cursor(cursor, cursor_derived, sizeof(cursor_derived),
                           cursor_tmp, sizeof(cursor_tmp), after_job,
                           sizeof(after_job), resume_job, sizeof(resume_job),
                           after_epoch, sizeof(after_epoch)) != 0) {
    return DERIVED_SCAN_INCOMPLETE;
  }
  struct stat derived_before;
  if (fstatat(gate->root_fd, "derived", &derived_before, AT_SYMLINK_NOFOLLOW) !=
      0) {
    if (errno == ENOENT && cursor[0] == '\0') {
      if (derived_copy_text(generation, generation_cap, "absent") != 0) {
        return DERIVED_SCAN_ERROR;
      }
      return DERIVED_SCAN_COMPLETE;
    }
    return errno == ENOENT ? DERIVED_SCAN_INCOMPLETE : DERIVED_SCAN_ERROR;
  }
  if (!S_ISDIR(derived_before.st_mode) || derived_before.st_dev != gate->device ||
      !owned_by_caller(&derived_before) || (derived_before.st_mode & 077) != 0) {
    return DERIVED_SCAN_INCOMPLETE;
  }
  int derived_fd = openat_restart(
      gate->root_fd, "derived", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (derived_fd < 0) {
    return derived_policy_errno(errno) ? DERIVED_SCAN_INCOMPLETE
                                       : DERIVED_SCAN_ERROR;
  }
  int status = DERIVED_SCAN_ERROR;
  int tmp_fd = -1;
  struct stat opened_derived;
  if (fstat(derived_fd, &opened_derived) != 0 ||
      !same_identity(&derived_before, &opened_derived) ||
      !owned_by_caller(&opened_derived) ||
      validate_no_extended_acl(derived_fd) != 0) {
    status = derived_policy_errno(errno) ? DERIVED_SCAN_INCOMPLETE
                                        : DERIVED_SCAN_ERROR;
    goto cleanup;
  }
  char derived_gen[DERIVED_GENERATION_CAP];
  if (format_identity(&derived_before, derived_gen, sizeof(derived_gen)) != 0) {
    status = DERIVED_SCAN_ERROR;
    goto cleanup;
  }
  int has_tmp = 0;
  status = inspect_derived_root(derived_fd, gate->device, &has_tmp);
  if (status != DERIVED_SCAN_COMPLETE) goto cleanup;
  if (!has_tmp) {
    if (cursor[0] != '\0') {
      status = DERIVED_SCAN_INCOMPLETE;
      goto cleanup;
    }
    struct stat derived_after;
    if (fstat(derived_fd, &derived_after) != 0) {
      status = DERIVED_SCAN_ERROR;
      goto cleanup;
    }
    if (!same_identity(&derived_before, &derived_after)) {
      status = DERIVED_SCAN_INCOMPLETE;
      goto cleanup;
    }
    int written = snprintf(generation, generation_cap, "%s|-", derived_gen);
    status = written < 0 || (size_t)written >= generation_cap
                 ? DERIVED_SCAN_ERROR
                 : DERIVED_SCAN_COMPLETE;
    goto cleanup;
  }
  struct stat tmp_before;
  tmp_fd = open_private_directory(derived_fd, ".tmp", gate->device, &tmp_before);
  if (tmp_fd < 0) {
    status = derived_policy_errno(errno) ? DERIVED_SCAN_INCOMPLETE
                                        : DERIVED_SCAN_ERROR;
    goto cleanup;
  }
  char tmp_gen[DERIVED_GENERATION_CAP];
  if (format_identity(&tmp_before, tmp_gen, sizeof(tmp_gen)) != 0) {
    status = DERIVED_SCAN_ERROR;
    goto cleanup;
  }
  if (cursor[0] != '\0' &&
      (strcmp(cursor_derived, derived_gen) != 0 ||
       strcmp(cursor_tmp, tmp_gen) != 0)) {
    status = DERIVED_SCAN_INCOMPLETE;
    goto cleanup;
  }
  int written = snprintf(generation, generation_cap, "%s|%s", derived_gen, tmp_gen);
  if (written < 0 || (size_t)written >= generation_cap) {
    status = DERIVED_SCAN_ERROR;
    goto cleanup;
  }
  char finished_after[NAME_MAX + 1];
  if (derived_copy_text(finished_after, sizeof(finished_after), after_job) != 0) {
    status = DERIVED_SCAN_ERROR;
    goto cleanup;
  }
  uint32_t jobs_budget = DERIVED_PAGE_JOBS;
  if (resume_job[0] != '\0') {
    int paused = 0;
    char pause_epoch[NAME_MAX + 1];
    status = scan_job(tmp_fd, gate->device, resume_job, after_epoch, observations,
                      observation_cap, observation_count, &paused, pause_epoch,
                      sizeof(pause_epoch));
    if (status != DERIVED_SCAN_COMPLETE) goto cleanup;
    if (paused) {
      if (build_derived_cursor(next_cursor, next_cursor_cap, derived_gen, tmp_gen,
                               finished_after, resume_job, pause_epoch) != 0) {
        status = DERIVED_SCAN_ERROR;
        goto cleanup;
      }
      status = DERIVED_SCAN_CONTINUE;
      goto cleanup;
    }
    if (derived_copy_text(finished_after, sizeof(finished_after), resume_job) != 0) {
      status = DERIVED_SCAN_ERROR;
      goto cleanup;
    }
    if (jobs_budget > 0) jobs_budget -= 1;
  }
  char job_names[DERIVED_PAGE_JOBS + 1][NAME_MAX + 1];
  uint32_t selected = 0;
  if (jobs_budget > 0 &&
      select_later_names(tmp_fd, finished_after, jobs_budget, job_names,
                         &selected) != 0) {
    status = derived_policy_errno(errno) ? DERIVED_SCAN_INCOMPLETE
                                        : DERIVED_SCAN_ERROR;
    goto cleanup;
  }
  uint32_t returned = selected > jobs_budget ? jobs_budget : selected;
  for (uint32_t index = 0; index < returned; index += 1) {
    if (*observation_count + 2 > observation_cap) {
      if (build_derived_cursor(next_cursor, next_cursor_cap, derived_gen, tmp_gen,
                               finished_after, "", "") != 0) {
        status = DERIVED_SCAN_ERROR;
        goto cleanup;
      }
      status = DERIVED_SCAN_CONTINUE;
      goto cleanup;
    }
    int paused = 0;
    char pause_epoch[NAME_MAX + 1];
    status = scan_job(tmp_fd, gate->device, job_names[index], "", observations,
                      observation_cap, observation_count, &paused, pause_epoch,
                      sizeof(pause_epoch));
    if (status != DERIVED_SCAN_COMPLETE) goto cleanup;
    if (paused) {
      if (build_derived_cursor(next_cursor, next_cursor_cap, derived_gen, tmp_gen,
                               finished_after, job_names[index], pause_epoch) !=
          0) {
        status = DERIVED_SCAN_ERROR;
        goto cleanup;
      }
      status = DERIVED_SCAN_CONTINUE;
      goto cleanup;
    }
    if (derived_copy_text(finished_after, sizeof(finished_after),
                          job_names[index]) != 0) {
      status = DERIVED_SCAN_ERROR;
      goto cleanup;
    }
  }
  if (selected > jobs_budget) {
    if (build_derived_cursor(next_cursor, next_cursor_cap, derived_gen, tmp_gen,
                             finished_after, "", "") != 0) {
      status = DERIVED_SCAN_ERROR;
      goto cleanup;
    }
    status = DERIVED_SCAN_CONTINUE;
    goto cleanup;
  }
  struct stat derived_after, tmp_after;
  if (fstat(derived_fd, &derived_after) != 0 || fstat(tmp_fd, &tmp_after) != 0) {
    status = DERIVED_SCAN_ERROR;
    goto cleanup;
  }
  if (!same_identity(&derived_before, &derived_after) ||
      !same_identity(&tmp_before, &tmp_after)) {
    status = DERIVED_SCAN_INCOMPLETE;
    goto cleanup;
  }
  status = DERIVED_SCAN_COMPLETE;

cleanup:
  if (status != DERIVED_SCAN_COMPLETE && status != DERIVED_SCAN_CONTINUE) {
    *observation_count = 0;
    next_cursor[0] = '\0';
  }
  if (tmp_fd >= 0) close(tmp_fd);
  if (derived_fd >= 0) close(derived_fd);
  return status;
}

static int collect_derived_observations(capacity_gate_t *gate,
                                        derived_observation_t **items,
                                        uint32_t *count) {
  *items = NULL;
  *count = 0;
  char cursor[DERIVED_CURSOR_CAP];
  cursor[0] = '\0';
  derived_observation_t *list = NULL;
  uint32_t used = 0;
  for (uint32_t page = 0; page < 100000U; page += 1) {
    derived_observation_t page_items[DERIVED_PAGE_OBSERVATIONS];
    uint32_t page_count = 0;
    char next_cursor[DERIVED_CURSOR_CAP];
    char generation[DERIVED_GENERATION_CAP * 2];
    int status = derived_inventory_page(
        gate, cursor, next_cursor, sizeof(next_cursor), generation,
        sizeof(generation), page_items, DERIVED_PAGE_OBSERVATIONS, &page_count);
    if (status == DERIVED_SCAN_ERROR) {
      free(list);
      return -1;
    }
    if (status == DERIVED_SCAN_INCOMPLETE ||
        used > DERIVED_OBSERVATION_LIMIT ||
        page_count > DERIVED_OBSERVATION_LIMIT - used) {
      free(list);
      errno = EPERM;
      return 1;
    }
    if (page_count > 0) {
      derived_observation_t *grown = realloc(
          list, (size_t)(used + page_count) * sizeof(*list));
      if (grown == NULL) {
        free(list);
        errno = ENOMEM;
        return -1;
      }
      list = grown;
      memcpy(list + used, page_items, page_count * sizeof(*list));
      used += page_count;
    }
    if (status == DERIVED_SCAN_COMPLETE) {
      *items = list;
      *count = used;
      return 0;
    }
    if (next_cursor[0] == '\0' || strcmp(next_cursor, cursor) == 0 ||
        derived_copy_text(cursor, sizeof(cursor), next_cursor) != 0) {
      free(list);
      errno = EPERM;
      return 1;
    }
  }
  free(list);
  errno = EPERM;
  return 1;
}

static int stable_derived_inventory(capacity_gate_t *gate,
                                    derived_observation_t **items,
                                    uint32_t *count) {
  derived_observation_t *first = NULL;
  derived_observation_t *second = NULL;
  uint32_t first_count = 0;
  uint32_t second_count = 0;
  int first_status = collect_derived_observations(gate, &first, &first_count);
  if (first_status != 0) {
    free(first);
    *items = NULL;
    *count = 0;
    return first_status;
  }
  int second_status = collect_derived_observations(gate, &second, &second_count);
  int mismatch = second_status != 0 || first_count != second_count ||
                 (first_count > 0 &&
                  memcmp(first, second, first_count * sizeof(*first)) != 0);
  free(second);
  if (mismatch) {
    free(first);
    *items = NULL;
    *count = 0;
    errno = EPERM;
    return 1;
  }
  *items = first;
  *count = first_count;
  return 0;
}

static napi_value derived_observations_array(napi_env env,
                                            const derived_observation_t *items,
                                            uint32_t count) {
  napi_value array;
  napi_create_array_with_length(env, count, &array);
  for (uint32_t index = 0; index < count; index += 1) {
    napi_value item, value;
    napi_create_object(env, &item);
    napi_create_string_utf8(env, items[index].job_id, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "jobId", value);
    napi_create_string_utf8(env, items[index].epoch, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "epoch", value);
    napi_create_string_utf8(env, items[index].kind, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "kind", value);
    napi_create_string_utf8(env, items[index].byte_size, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "byteSize", value);
    napi_create_string_utf8(env, items[index].device, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "device", value);
    napi_create_string_utf8(env, items[index].inode, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "inode", value);
    napi_set_element(env, array, index, item);
  }
  return array;
}

static const char *derived_page_outcome(int status) {
  if (status == DERIVED_SCAN_COMPLETE) return "complete";
  if (status == DERIVED_SCAN_CONTINUE) return "continue";
  return "incomplete";
}

static napi_value capacity_gate_derived_inventory_page(napi_env env,
                                                      napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  capacity_gate_t *gate = get_capacity_gate(env, args[0]);
  if (gate == NULL) return NULL;
  if (!gate->locked) {
    throw_code(env, "CAPACITY_LOCK_REQUIRED",
               "Derived inventory requires the capacity lock.");
    return NULL;
  }
  if (argc != 2) {
    throw_code(env, "STORAGE_INVALID_ARGUMENT",
               "Derived inventory page requires a cursor.");
    return NULL;
  }
  char cursor[DERIVED_CURSOR_CAP];
  size_t cursor_length = 0;
  if (napi_get_value_string_utf8(env, args[1], cursor, sizeof(cursor),
                                 &cursor_length) != napi_ok ||
      cursor_length >= sizeof(cursor)) {
    throw_code(env, "STORAGE_INVALID_ARGUMENT", "Invalid inventory cursor.");
    return NULL;
  }
  derived_observation_t observations[DERIVED_PAGE_OBSERVATIONS];
  uint32_t count = 0;
  char next_cursor[DERIVED_CURSOR_CAP];
  char generation[DERIVED_GENERATION_CAP * 2];
  int status = derived_inventory_page(
      gate, cursor, next_cursor, sizeof(next_cursor), generation,
      sizeof(generation), observations, DERIVED_PAGE_OBSERVATIONS, &count);
  if (status == DERIVED_SCAN_ERROR) {
    throw_errno(env, "read derived inventory");
    return NULL;
  }
  napi_value result, outcome_value, cursor_value, generation_value, items;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, derived_page_outcome(status), NAPI_AUTO_LENGTH,
                          &outcome_value);
  napi_set_named_property(env, result, "outcome", outcome_value);
  napi_create_string_utf8(env, status == DERIVED_SCAN_CONTINUE ? next_cursor : "",
                          NAPI_AUTO_LENGTH, &cursor_value);
  napi_set_named_property(env, result, "nextCursor", cursor_value);
  napi_create_string_utf8(env, generation, NAPI_AUTO_LENGTH, &generation_value);
  napi_set_named_property(env, result, "generation", generation_value);
  items = derived_observations_array(
      env, status == DERIVED_SCAN_INCOMPLETE ? NULL : observations,
      status == DERIVED_SCAN_INCOMPLETE ? 0 : count);
  napi_set_named_property(env, result, "observations", items);
  return result;
}

#endif
