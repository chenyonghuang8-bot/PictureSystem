/* Owned deterministic derived temp.
 * Included once from storage_native.c after derived_inventory.h.
 * Creates only derived/.tmp/<job>/e<epoch>/{thumbnail,preview}.part.
 * No seal, chmod-to-immutable, publish, rename, glob, or recursive delete.
 */
#ifndef FAMILY_ALBUM_DERIVED_STORE_H
#define FAMILY_ALBUM_DERIVED_STORE_H

#define DERIVED_STORE_MAGIC UINT64_C(0x4453544f52453131)
#define DERIVED_WRITER_MAGIC UINT64_C(0x4457524954455231)
#define DERIVED_TEMP_OPEN 1
#define DERIVED_TEMP_DURABLE 2
#define DERIVED_TEMP_FAILED 3
#define DERIVED_TEMP_CLEANED 4
#define DERIVED_LIVE_WRITERS 16
#define DERIVED_THUMBNAIL_CAP (512U * 1024U)
#define DERIVED_PREVIEW_CAP (4U * 1024U * 1024U)

typedef struct derived_store derived_store_t;
typedef struct derived_writer derived_writer_t;

struct derived_writer {
  uint64_t magic;
  derived_store_t *store;
  int file_fd;
  int epoch_fd;
  int job_fd;
  int tmp_fd;
  int state;
  int registered;
  char leaf[16];
  char job[32];
  char epoch[32];
  char kind[12];
  dev_t device;
  ino_t inode;
  off_t size;
  mode_t mode;
  nlink_t nlink;
  uid_t uid;
  gid_t gid;
  struct timespec mtime;
  struct timespec ctime;
  dev_t epoch_device;
  ino_t epoch_inode;
  ino_t job_inode;
  ino_t tmp_inode;
  dev_t derived_device;
  ino_t derived_inode;
  unsigned char sha[CC_SHA256_DIGEST_LENGTH];
  int sha_ready;
};

#define DERIVED_SEALED_MAGIC UINT64_C(0x445345414c454431)
#define DERIVED_TEMP_SEALED 5

typedef struct derived_sealed {
  uint64_t magic;
  derived_writer_t *writer;
  int read_fd;
  int consumed;
} derived_sealed_t;

struct derived_store {
  uint64_t magic;
  int root_fd;
  int derived_fd;
  int lock_fd;
  dev_t device;
  ino_t root_inode;
  ino_t derived_inode;
  ino_t lock_inode;
  int fail_next_fsync;
  int fail_next_seal_fsync;
  int fail_next_seal_close;
  int fail_next_verify_post;
  char marker[33];
  pthread_mutex_t mutex;
  derived_writer_t *live[DERIVED_LIVE_WRITERS];
};

static void derived_close_fd(int *fd) {
  if (fd != NULL && *fd >= 0) {
    close(*fd);
    *fd = -1;
  }
}

static int process_is_production(void) {
  const char *node_env = getenv("NODE_ENV");
  return node_env != NULL && strcmp(node_env, "production") == 0;
}

static int derived_digest_hex(const unsigned char digest[CC_SHA256_DIGEST_LENGTH],
                              char out[65]) {
  static const char hex[] = "0123456789abcdef";
  for (int index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    out[index * 2] = hex[digest[index] >> 4];
    out[index * 2 + 1] = hex[digest[index] & 0x0f];
  }
  out[64] = '\0';
  return 0;
}

static int derived_parse_sha256(const char *text, unsigned char out[CC_SHA256_DIGEST_LENGTH]) {
  if (text == NULL || strlen(text) != 64) return -1;
  for (int index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    int high = -1;
    int low = -1;
    char left = text[index * 2];
    char right = text[index * 2 + 1];
    if (left >= '0' && left <= '9') high = left - '0';
    else if (left >= 'a' && left <= 'f') high = left - 'a' + 10;
    if (right >= '0' && right <= '9') low = right - '0';
    else if (right >= 'a' && right <= 'f') low = right - 'a' + 10;
    if (high < 0 || low < 0) return -1;
    out[index] = (unsigned char)((high << 4) | low);
  }
  return 0;
}

static void derived_throw(napi_env env, const char *code, const char *message) {
  throw_code(env, code, message);
}

static int derived_require_root(derived_store_t *store) {
  struct stat root_status, derived_status;
  char marker[33];
  if (fstat(store->root_fd, &root_status) != 0 ||
      root_status.st_dev != store->device ||
      root_status.st_ino != store->root_inode ||
      fstat(store->derived_fd, &derived_status) != 0 ||
      derived_status.st_dev != store->device ||
      derived_status.st_ino != store->derived_inode ||
      !S_ISDIR(derived_status.st_mode) ||
      !owned_by_caller(&derived_status) ||
      (derived_status.st_mode & 0777) != 0700 ||
      read_marker(store->root_fd, marker, sizeof(marker), 0) != 0 ||
      strcmp(marker, store->marker) != 0) {
    errno = EPERM;
    return -1;
  }
  return 0;
}

static int derived_ensure_directory(int parent, const char *name, dev_t device,
                                    struct stat *out) {
  struct stat named;
  int created = 0;
  if (fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno != ENOENT) return -1;
    if (mkdirat(parent, name, 0700) != 0) {
      if (errno != EEXIST) return -1;
    } else {
      created = 1;
      if (sync_directory_fd(parent) != 0) return -1;
    }
  } else if (!S_ISDIR(named.st_mode)) {
    errno = EPERM;
    return -1;
  }
  int fd = open_private_directory(parent, name, device, out);
  if (fd < 0) return -1;
  int failure = 0;
  if (created && fchmod(fd, 0700) != 0) failure = errno == 0 ? EPERM : errno;
  struct stat opened;
  if (failure == 0 &&
      (fstat(fd, &opened) != 0 || !S_ISDIR(opened.st_mode) ||
       !owned_by_caller(&opened) || opened.st_dev != device ||
       opened.st_ino != out->st_ino || (opened.st_mode & 0777) != 0700)) {
    failure = errno == 0 ? EPERM : errno;
  }
  if (failure == 0 && sync_directory_fd(fd) != 0) failure = errno;
  if (failure != 0) {
    close(fd);
    if (created) {
      (void)unlinkat(parent, name, AT_REMOVEDIR);
      (void)sync_directory_fd(parent);
    }
    errno = failure;
    return -1;
  }
  *out = opened;
  return fd;
}

static int derived_leaf_name(const char *kind, char *leaf, size_t leaf_cap,
                             uint32_t *cap) {
  const char *name = NULL;
  if (strcmp(kind, "THUMBNAIL") == 0) {
    name = "thumbnail.part";
    *cap = DERIVED_THUMBNAIL_CAP;
  } else if (strcmp(kind, "PREVIEW") == 0) {
    name = "preview.part";
    *cap = DERIVED_PREVIEW_CAP;
  } else {
    return -1;
  }
  return derived_copy_text(leaf, leaf_cap, name);
}

static int derived_live_index(derived_store_t *store, const char *job,
                              const char *epoch, const char *kind) {
  for (int index = 0; index < DERIVED_LIVE_WRITERS; index += 1) {
    derived_writer_t *writer = store->live[index];
    if (writer != NULL && strcmp(writer->job, job) == 0 &&
        strcmp(writer->epoch, epoch) == 0 && strcmp(writer->kind, kind) == 0) {
      return index;
    }
  }
  return -1;
}

static int derived_register(derived_store_t *store, derived_writer_t *writer) {
  if (derived_live_index(store, writer->job, writer->epoch, writer->kind) >= 0) {
    errno = EEXIST;
    return -1;
  }
  for (int index = 0; index < DERIVED_LIVE_WRITERS; index += 1) {
    if (store->live[index] == NULL) {
      store->live[index] = writer;
      writer->registered = 1;
      return 0;
    }
  }
  errno = EAGAIN;
  return -1;
}

static void derived_unregister(derived_store_t *store, derived_writer_t *writer) {
  if (store == NULL || writer == NULL || !writer->registered) return;
  for (int index = 0; index < DERIVED_LIVE_WRITERS; index += 1) {
    if (store->live[index] == writer) store->live[index] = NULL;
  }
  writer->registered = 0;
}

static void derived_prune_empty_chain(int derived_fd, int tmp_fd, int job_fd,
                                      int epoch_fd, dev_t device, ino_t tmp_inode,
                                      ino_t job_inode, ino_t epoch_inode,
                                      const char *job, const char *epoch_name);

static int derived_unlink_exact(derived_writer_t *writer) {
  struct stat named;
  if (writer->epoch_fd < 0) {
    errno = EPERM;
    return -1;
  }
  if (fstatat(writer->epoch_fd, writer->leaf, &named, AT_SYMLINK_NOFOLLOW) != 0) {
    return -1;
  }
  if (!S_ISREG(named.st_mode) || named.st_dev != writer->device ||
      named.st_ino != writer->inode || named.st_nlink != 1 ||
      !owned_by_caller(&named) || !private_file_mode(named.st_mode, 1)) {
    errno = EPERM;
    return -1;
  }
  if (unlinkat(writer->epoch_fd, writer->leaf, 0) != 0) return -1;
  if (fstatat(writer->epoch_fd, writer->leaf, &named, AT_SYMLINK_NOFOLLOW) == 0) {
    errno = EPERM;
    return -1;
  }
  if (errno != ENOENT) return -1;
  if (sync_directory_fd(writer->epoch_fd) != 0) return -1;
  if (writer->store != NULL) {
    char epoch_name[40];
    if (snprintf(epoch_name, sizeof(epoch_name), "e%s", writer->epoch) <
        (int)sizeof(epoch_name)) {
      derived_prune_empty_chain(
          writer->store->derived_fd, writer->tmp_fd, writer->job_fd,
          writer->epoch_fd, writer->derived_device, writer->tmp_inode,
          writer->job_inode, writer->epoch_inode, writer->job, epoch_name);
    }
  }
  return 0;
}

static int derived_directory_empty(int dir_fd) {
  int fd = dup(dir_fd);
  if (fd < 0) return 0;
  DIR *directory = fdopendir(fd);
  if (directory == NULL) {
    close(fd);
    return 0;
  }
  struct dirent *entry;
  int empty = 1;
  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) {
      empty = 0;
      break;
    }
    errno = 0;
  }
  if (errno != 0) empty = 0;
  closedir(directory);
  return empty;
}

static void derived_remove_empty_directory(int parent, const char *name, int child,
                                           dev_t device, ino_t inode) {
  struct stat named;
  if (child < 0 || parent < 0 || !derived_directory_empty(child)) return;
  if (fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISDIR(named.st_mode) || named.st_dev != device || named.st_ino != inode ||
      !owned_by_caller(&named) || (named.st_mode & 0777) != 0700) {
    return;
  }
  if (unlinkat(parent, name, AT_REMOVEDIR) == 0) (void)sync_directory_fd(parent);
}

static void derived_prune_empty_chain(int derived_fd, int tmp_fd, int job_fd,
                                      int epoch_fd, dev_t device, ino_t tmp_inode,
                                      ino_t job_inode, ino_t epoch_inode,
                                      const char *job, const char *epoch_name) {
  derived_remove_empty_directory(job_fd, epoch_name, epoch_fd, device, epoch_inode);
  derived_remove_empty_directory(tmp_fd, job, job_fd, device, job_inode);
  derived_remove_empty_directory(derived_fd, ".tmp", tmp_fd, device, tmp_inode);
}

static void derived_release_writer_fds(derived_writer_t *writer) {
  derived_close_fd(&writer->file_fd);
  derived_close_fd(&writer->epoch_fd);
  derived_close_fd(&writer->job_fd);
  derived_close_fd(&writer->tmp_fd);
}

static int derived_classify_existing(int epoch_fd, const char *leaf, dev_t device) {
  struct stat named;
  if (fstatat(epoch_fd, leaf, &named, AT_SYMLINK_NOFOLLOW) != 0) return -1;
  if (!S_ISREG(named.st_mode) || named.st_nlink != 1 ||
      !owned_by_caller(&named) || named.st_dev != device ||
      !private_file_mode(named.st_mode, 1)) {
    errno = EPERM;
    return -1;
  }
  struct stat inspected;
  if (inspect_private_file(epoch_fd, leaf, device, &inspected, 1) != 0) {
    errno = EPERM;
    return -1;
  }
  errno = EEXIST;
  return -1;
}

static derived_store_t *derived_get_store(napi_env env, napi_value value) {
  derived_store_t *store = NULL;
  if (napi_get_value_external(env, value, (void **)&store) != napi_ok ||
      store == NULL || store->magic != DERIVED_STORE_MAGIC ||
      store->root_fd < 0 || store->derived_fd < 0 || store->lock_fd < 0) {
    derived_throw(env, "DERIVED_STORE_CLOSED", "Derived store is closed.");
    return NULL;
  }
  return store;
}

static derived_writer_t *derived_get_writer(napi_env env, napi_value value) {
  derived_writer_t *writer = NULL;
  if (napi_get_value_external(env, value, (void **)&writer) != napi_ok ||
      writer == NULL || writer->magic != DERIVED_WRITER_MAGIC ||
      writer->store == NULL || writer->store->magic != DERIVED_STORE_MAGIC) {
    derived_throw(env, "DERIVED_WRITER_CLOSED", "Derived writer is closed.");
    return NULL;
  }
  return writer;
}

static void finalize_derived_writer(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  derived_writer_t *writer = data;
  if (writer == NULL) return;
  derived_store_t *store = writer->store;
  if (store != NULL && store->magic == DERIVED_STORE_MAGIC) {
    pthread_mutex_lock(&store->mutex);
    if (writer->state == DERIVED_TEMP_OPEN) (void)derived_unlink_exact(writer);
    derived_unregister(store, writer);
    derived_release_writer_fds(writer);
    writer->store = NULL;
    pthread_mutex_unlock(&store->mutex);
  } else {
    derived_release_writer_fds(writer);
  }
  writer->magic = 0;
  free(writer);
}

static void finalize_derived_store(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  derived_store_t *store = data;
  if (store == NULL) return;
  if (store->magic == DERIVED_STORE_MAGIC) {
    pthread_mutex_lock(&store->mutex);
    for (int index = 0; index < DERIVED_LIVE_WRITERS; index += 1) {
      derived_writer_t *writer = store->live[index];
      if (writer == NULL) continue;
      if (writer->state == DERIVED_TEMP_OPEN) (void)derived_unlink_exact(writer);
      writer->store = NULL;
      writer->registered = 0;
      derived_release_writer_fds(writer);
      store->live[index] = NULL;
    }
    pthread_mutex_unlock(&store->mutex);
    pthread_mutex_destroy(&store->mutex);
  }
  derived_close_fd(&store->lock_fd);
  derived_close_fd(&store->derived_fd);
  derived_close_fd(&store->root_fd);
  store->magic = 0;
  free(store);
}

static int derived_validate_lock(int derived_fd, int lock_fd, dev_t device,
                                 ino_t *inode) {
  struct stat opened, named;
  if (fstat(lock_fd, &opened) != 0 ||
      fstatat(derived_fd, ".derived-writer.lock", &named, AT_SYMLINK_NOFOLLOW) !=
          0 ||
      !S_ISREG(opened.st_mode) || !S_ISREG(named.st_mode) ||
      opened.st_dev != device || named.st_dev != opened.st_dev ||
      opened.st_ino != named.st_ino || !owned_by_caller(&opened) ||
      opened.st_nlink != 1 || (opened.st_mode & 07777) != 0600 ||
      validate_no_extended_acl(lock_fd) != 0) {
    if (errno == 0) errno = EPERM;
    return -1;
  }
  *inode = opened.st_ino;
  return 0;
}

static napi_value provision_derived_writer_lock(napi_env env,
                                                napi_callback_info info) {
  size_t argc = 1;
  napi_value argument;
  napi_get_cb_info(env, info, &argc, &argument, NULL, NULL);
  storage_root_t *root = argc == 1 ? get_root(env, argument) : NULL;
  if (root == NULL) return NULL;
  struct stat derived_status;
  int derived_fd = open_private_directory(root->root_fd, "derived", root->device,
                                          &derived_status);
  if (derived_fd < 0 || (derived_status.st_mode & 0777) != 0700) {
    if (derived_fd >= 0) close(derived_fd);
    derived_throw(env, "DERIVED_ROOT_UNAVAILABLE",
                  "Derived directory is missing or unsafe.");
    return NULL;
  }
  int lock_fd = openat(derived_fd, ".derived-writer.lock",
                       O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (lock_fd < 0) {
    int saved = errno;
    close(derived_fd);
    errno = saved;
    throw_errno(env, "provision derived writer lock");
    return NULL;
  }
  ino_t inode = 0;
  int failure = 0;
  if (fchmod(lock_fd, 0600) != 0) failure = errno;
  if (failure == 0 &&
      derived_validate_lock(derived_fd, lock_fd, root->device, &inode) != 0) {
    failure = errno == 0 ? EPERM : errno;
  }
  if (failure == 0 && full_sync_file_fd(lock_fd) != 0) failure = errno;
  if (failure == 0 && sync_directory_fd(derived_fd) != 0) failure = errno;
  int saved = failure;
  if (close(lock_fd) != 0 && failure == 0) failure = errno;
  close(derived_fd);
  if (failure != 0) {
    errno = saved == 0 ? failure : saved;
    throw_errno(env, "validate derived writer lock");
    return NULL;
  }
  return undefined_value(env);
}

static napi_value open_derived_store(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  char path[PATH_MAX], expected[33];
  if (argc != 2 || get_string(env, args[0], path, sizeof(path)) != 0 ||
      get_string(env, args[1], expected, sizeof(expected)) != 0 ||
      strlen(expected) != 32) {
    derived_throw(env, "STORAGE_INVALID_ARGUMENT", "Invalid derived store identity.");
    return NULL;
  }
  int root_fd = open_absolute_directory(path, 0);
  if (root_fd < 0) {
    throw_errno(env, "open derived store root");
    return NULL;
  }
  struct stat root_status;
  char marker[33];
  if (validate_directory_fd(root_fd, &root_status) != 0 ||
      root_status.st_uid != geteuid() || (root_status.st_mode & 077) != 0 ||
      read_marker(root_fd, marker, sizeof(marker), 0) != 0 ||
      strcmp(marker, expected) != 0) {
    close(root_fd);
    derived_throw(env, "DERIVED_ROOT_INVALID", "Derived store root identity mismatch.");
    return NULL;
  }
  struct stat derived_status;
  int derived_fd = open_private_directory(root_fd, "derived", root_status.st_dev,
                                          &derived_status);
  if (derived_fd < 0 || (derived_status.st_mode & 0777) != 0700) {
    if (derived_fd >= 0) close(derived_fd);
    close(root_fd);
    derived_throw(env, "DERIVED_ROOT_UNAVAILABLE",
                  "Derived directory is missing or unsafe.");
    return NULL;
  }
  int lock_fd = openat(derived_fd, ".derived-writer.lock",
                       O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  ino_t lock_inode = 0;
  if (lock_fd < 0 ||
      derived_validate_lock(derived_fd, lock_fd, root_status.st_dev, &lock_inode) !=
          0 ||
      flock(lock_fd, LOCK_EX | LOCK_NB) != 0) {
    int saved = errno == 0 ? EPERM : errno;
    if (lock_fd >= 0) close(lock_fd);
    close(derived_fd);
    close(root_fd);
    errno = saved;
    if (saved == EWOULDBLOCK || saved == EAGAIN) {
      derived_throw(env, "DERIVED_WRITER_BUSY",
                    "Derived writer lock is already held.");
    } else {
      throw_errno(env, "acquire derived writer lock");
    }
    return NULL;
  }
  derived_store_t *store = calloc(1, sizeof(*store));
  if (store == NULL) {
    close(lock_fd);
    close(derived_fd);
    close(root_fd);
    derived_throw(env, "STORAGE_NATIVE_ERROR", "Derived store allocation failed.");
    return NULL;
  }
  store->magic = DERIVED_STORE_MAGIC;
  store->root_fd = root_fd;
  store->derived_fd = derived_fd;
  store->lock_fd = lock_fd;
  store->device = root_status.st_dev;
  store->root_inode = root_status.st_ino;
  store->derived_inode = derived_status.st_ino;
  store->lock_inode = lock_inode;
  memcpy(store->marker, marker, sizeof(store->marker));
  if (pthread_mutex_init(&store->mutex, NULL) != 0) {
    store->magic = 0;
    derived_close_fd(&store->lock_fd);
    derived_close_fd(&store->derived_fd);
    derived_close_fd(&store->root_fd);
    free(store);
    derived_throw(env, "STORAGE_NATIVE_ERROR", "Derived store lock init failed.");
    return NULL;
  }
  napi_value external;
  napi_create_external(env, store, finalize_derived_store, NULL, &external);
  return external;
}

static napi_value close_derived_store(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument;
  napi_get_cb_info(env, info, &argc, &argument, NULL, NULL);
  derived_store_t *store = derived_get_store(env, argument);
  if (store == NULL) return NULL;
  pthread_mutex_lock(&store->mutex);
  int busy = 0;
  for (int index = 0; index < DERIVED_LIVE_WRITERS; index += 1) {
    if (store->live[index] != NULL) busy = 1;
  }
  pthread_mutex_unlock(&store->mutex);
  if (busy) {
    derived_throw(env, "DERIVED_WRITER_LIVE",
                  "Cannot close a store with a live temp writer.");
    return NULL;
  }
  if (flock(store->lock_fd, LOCK_UN) != 0) {
    throw_errno(env, "release derived writer lock");
    return NULL;
  }
  derived_close_fd(&store->lock_fd);
  derived_close_fd(&store->derived_fd);
  derived_close_fd(&store->root_fd);
  return undefined_value(env);
}

static int derived_bind_created_file(derived_writer_t *writer) {
  struct stat opened, named, again;
  if (fstat(writer->file_fd, &opened) != 0 ||
      fstatat(writer->epoch_fd, writer->leaf, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(opened.st_mode) || !S_ISREG(named.st_mode) ||
      !owned_by_caller(&opened) || opened.st_nlink != 1 ||
      opened.st_dev != writer->derived_device || opened.st_ino != named.st_ino ||
      (opened.st_mode & 0777) != 0600 || validate_no_extended_acl(writer->file_fd) != 0 ||
      fstatat(writer->epoch_fd, writer->leaf, &again, AT_SYMLINK_NOFOLLOW) != 0 ||
      again.st_ino != opened.st_ino || again.st_dev != opened.st_dev) {
    errno = errno == 0 ? EPERM : errno;
    return -1;
  }
  writer->device = opened.st_dev;
  writer->inode = opened.st_ino;
  writer->size = opened.st_size;
  writer->mode = opened.st_mode & 0777;
  writer->nlink = opened.st_nlink;
  writer->uid = opened.st_uid;
  writer->gid = opened.st_gid;
  writer->mtime = opened.st_mtimespec;
  writer->ctime = opened.st_ctimespec;
  return 0;
}

static napi_value create_derived_temp(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  char job[32], epoch[32], kind[12], leaf[16], epoch_name[40];
  if (argc != 4 || get_string(env, args[1], job, sizeof(job)) != 0 ||
      get_string(env, args[2], epoch, sizeof(epoch)) != 0 ||
      get_string(env, args[3], kind, sizeof(kind)) != 0) {
    return NULL;
  }
  derived_store_t *store = derived_get_store(env, args[0]);
  if (store == NULL) return NULL;
  char canonical_job[32], canonical_epoch[32];
  uint32_t byte_cap = 0;
  if (canonical_u64(job, canonical_job, sizeof(canonical_job)) != 0 ||
      canonical_u64(epoch, canonical_epoch, sizeof(canonical_epoch)) != 0 ||
      derived_leaf_name(kind, leaf, sizeof(leaf), &byte_cap) != 0 ||
      snprintf(epoch_name, sizeof(epoch_name), "e%s", canonical_epoch) >=
          (int)sizeof(epoch_name)) {
    derived_throw(env, "DERIVED_TEMP_IDENTITY", "Derived temp identity is not canonical.");
    return NULL;
  }
  (void)byte_cap;
  pthread_mutex_lock(&store->mutex);
  if (derived_require_root(store) != 0) {
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, "DERIVED_PARENT_REPLACED", "Derived root identity changed.");
    return NULL;
  }
  if (derived_live_index(store, canonical_job, canonical_epoch, kind) >= 0) {
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, "DERIVED_TEMP_DUPLICATE",
                  "This temp slot already has a live writer.");
    return NULL;
  }
  struct stat tmp_status, job_status, epoch_status;
  int tmp_fd = derived_ensure_directory(store->derived_fd, ".tmp", store->device,
                                        &tmp_status);
  int job_fd = tmp_fd < 0
                   ? -1
                   : derived_ensure_directory(tmp_fd, canonical_job, store->device,
                                              &job_status);
  int epoch_fd = job_fd < 0 ? -1
                            : derived_ensure_directory(job_fd, epoch_name,
                                                       store->device, &epoch_status);
  if (epoch_fd < 0) {
    int saved = errno == 0 ? EPERM : errno;
    if (job_fd >= 0) close(job_fd);
    if (tmp_fd >= 0) close(tmp_fd);
    pthread_mutex_unlock(&store->mutex);
    errno = saved;
    derived_throw(env, "DERIVED_PARENT_REPLACED",
                  "Derived temp parent is missing or unsafe.");
    return NULL;
  }
  int file_fd = openat(epoch_fd, leaf,
                       O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC,
                       0600);
  if (file_fd < 0) {
    int saved = errno;
    const char *code = "DERIVED_TEMP_UNSAFE";
    if (saved == EEXIST) {
      if (derived_classify_existing(epoch_fd, leaf, store->device) != 0 &&
          errno == EEXIST) {
        code = "DERIVED_TEMP_RECOVERY_REQUIRED";
      }
    }
    close(epoch_fd);
    close(job_fd);
    close(tmp_fd);
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, code, "Derived temp leaf was not exclusively created.");
    return NULL;
  }
  int failure = 0;
  if (fchmod(file_fd, 0600) != 0) failure = errno == 0 ? EPERM : errno;
  if (failure == 0 && sync_directory_fd(epoch_fd) != 0) failure = errno;
  derived_writer_t *writer = failure == 0 ? calloc(1, sizeof(*writer)) : NULL;
  if (failure == 0 && writer == NULL) failure = ENOMEM;
  if (failure == 0) {
    writer->magic = DERIVED_WRITER_MAGIC;
    writer->store = store;
    writer->file_fd = file_fd;
    writer->epoch_fd = epoch_fd;
    writer->job_fd = job_fd;
    writer->tmp_fd = tmp_fd;
    writer->state = DERIVED_TEMP_OPEN;
    writer->derived_device = store->device;
    writer->derived_inode = store->derived_inode;
    writer->epoch_device = epoch_status.st_dev;
    writer->epoch_inode = epoch_status.st_ino;
    writer->job_inode = job_status.st_ino;
    writer->tmp_inode = tmp_status.st_ino;
    memcpy(writer->leaf, leaf, sizeof(writer->leaf));
    memcpy(writer->job, canonical_job, sizeof(writer->job));
    memcpy(writer->epoch, canonical_epoch, sizeof(writer->epoch));
    memcpy(writer->kind, kind, strlen(kind) + 1);
    if (derived_bind_created_file(writer) != 0) failure = errno == 0 ? EPERM : errno;
    if (failure == 0 && writer->size != 0) failure = EPERM;
    if (failure == 0 && derived_register(store, writer) != 0) {
      failure = errno == EEXIST ? EEXIST : EAGAIN;
    }
  }
  if (failure != 0) {
    if (writer != NULL) {
      writer->store = NULL;
      writer->magic = 0;
      free(writer);
    }
    struct stat opened_now, named_now;
    if (fstat(file_fd, &opened_now) == 0 &&
        fstatat(epoch_fd, leaf, &named_now, AT_SYMLINK_NOFOLLOW) == 0 &&
        S_ISREG(named_now.st_mode) && named_now.st_dev == opened_now.st_dev &&
        named_now.st_ino == opened_now.st_ino && named_now.st_nlink == 1) {
      (void)unlinkat(epoch_fd, leaf, 0);
      (void)sync_directory_fd(epoch_fd);
      char epoch_name[40];
      if (snprintf(epoch_name, sizeof(epoch_name), "e%s", canonical_epoch) <
          (int)sizeof(epoch_name)) {
        derived_prune_empty_chain(
            store->derived_fd, tmp_fd, job_fd, epoch_fd, store->device,
            tmp_status.st_ino, job_status.st_ino, epoch_status.st_ino,
            canonical_job, epoch_name);
      }
    }
    close(file_fd);
    close(epoch_fd);
    close(job_fd);
    close(tmp_fd);
    pthread_mutex_unlock(&store->mutex);
    if (failure == EEXIST) {
      derived_throw(env, "DERIVED_TEMP_DUPLICATE",
                    "This temp slot already has a live writer.");
    } else if (failure == EAGAIN) {
      derived_throw(env, "DERIVED_WRITER_BUSY", "Too many live derived writers.");
    } else {
      derived_throw(env, "DERIVED_TEMP_UNSAFE", "Created temp failed identity checks.");
    }
    return NULL;
  }
  pthread_mutex_unlock(&store->mutex);
  napi_value external;
  napi_create_external(env, writer, finalize_derived_writer, NULL, &external);
  return external;
}

static int derived_hash_fd(int fd, off_t size, unsigned char digest[CC_SHA256_DIGEST_LENGTH]) {
  CC_SHA256_CTX context;
  if (CC_SHA256_Init(&context) != 1) {
    errno = EIO;
    return -1;
  }
  unsigned char buffer[8192];
  off_t offset = 0;
  while (offset < size) {
    size_t chunk = sizeof(buffer);
    if ((off_t)chunk > size - offset) chunk = (size_t)(size - offset);
    ssize_t count = pread(fd, buffer, chunk, offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (count == 0) {
      errno = EIO;
      return -1;
    }
    if (CC_SHA256_Update(&context, buffer, (CC_LONG)count) != 1) {
      errno = EIO;
      return -1;
    }
    offset += count;
  }
  if (CC_SHA256_Final(digest, &context) != 1) {
    errno = EIO;
    return -1;
  }
  return 0;
}

static napi_value derived_snapshot_object(napi_env env, derived_writer_t *writer,
                                          const char *sha_hex) {
  napi_value object, job, epoch, kind, device, inode, size, mode, nlink, sha;
  napi_value epoch_device, epoch_inode, derived_device, derived_inode, durable;
  char device_text[32], inode_text[32], size_text[32], nlink_text[32];
  char epoch_device_text[32], epoch_inode_text[32];
  char derived_device_text[32], derived_inode_text[32];
  snprintf(device_text, sizeof(device_text), "%llu", (unsigned long long)writer->device);
  snprintf(inode_text, sizeof(inode_text), "%llu", (unsigned long long)writer->inode);
  snprintf(size_text, sizeof(size_text), "%lld", (long long)writer->size);
  snprintf(nlink_text, sizeof(nlink_text), "%llu", (unsigned long long)writer->nlink);
  snprintf(epoch_device_text, sizeof(epoch_device_text), "%llu",
           (unsigned long long)writer->epoch_device);
  snprintf(epoch_inode_text, sizeof(epoch_inode_text), "%llu",
           (unsigned long long)writer->epoch_inode);
  snprintf(derived_device_text, sizeof(derived_device_text), "%llu",
           (unsigned long long)writer->derived_device);
  snprintf(derived_inode_text, sizeof(derived_inode_text), "%llu",
           (unsigned long long)writer->derived_inode);
  napi_create_object(env, &object);
  napi_create_string_utf8(env, writer->job, NAPI_AUTO_LENGTH, &job);
  napi_create_string_utf8(env, writer->epoch, NAPI_AUTO_LENGTH, &epoch);
  napi_create_string_utf8(env, writer->kind, NAPI_AUTO_LENGTH, &kind);
  napi_create_string_utf8(env, device_text, NAPI_AUTO_LENGTH, &device);
  napi_create_string_utf8(env, inode_text, NAPI_AUTO_LENGTH, &inode);
  napi_create_string_utf8(env, size_text, NAPI_AUTO_LENGTH, &size);
  napi_create_uint32(env, (uint32_t)writer->mode, &mode);
  napi_create_string_utf8(env, nlink_text, NAPI_AUTO_LENGTH, &nlink);
  napi_create_string_utf8(env, sha_hex, NAPI_AUTO_LENGTH, &sha);
  napi_create_string_utf8(env, epoch_device_text, NAPI_AUTO_LENGTH, &epoch_device);
  napi_create_string_utf8(env, epoch_inode_text, NAPI_AUTO_LENGTH, &epoch_inode);
  napi_create_string_utf8(env, derived_device_text, NAPI_AUTO_LENGTH, &derived_device);
  napi_create_string_utf8(env, derived_inode_text, NAPI_AUTO_LENGTH, &derived_inode);
  napi_get_boolean(env, true, &durable);
  napi_set_named_property(env, object, "jobId", job);
  napi_set_named_property(env, object, "epoch", epoch);
  napi_set_named_property(env, object, "kind", kind);
  napi_set_named_property(env, object, "device", device);
  napi_set_named_property(env, object, "inode", inode);
  napi_set_named_property(env, object, "byteSize", size);
  napi_set_named_property(env, object, "mode", mode);
  napi_set_named_property(env, object, "linkCount", nlink);
  napi_set_named_property(env, object, "sha256Hex", sha);
  napi_set_named_property(env, object, "epochDevice", epoch_device);
  napi_set_named_property(env, object, "epochInode", epoch_inode);
  napi_set_named_property(env, object, "derivedDevice", derived_device);
  napi_set_named_property(env, object, "derivedInode", derived_inode);
  napi_set_named_property(env, object, "durable", durable);
  return object;
}

static napi_value write_derived_temp(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  derived_writer_t *writer = argc == 3 ? derived_get_writer(env, args[0]) : NULL;
  if (writer == NULL) return NULL;
  void *data = NULL;
  size_t length = 0;
  char expected_text[80];
  bool is_buffer = false;
  if (napi_is_buffer(env, args[1], &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, args[1], &data, &length) != napi_ok ||
      get_string(env, args[2], expected_text, sizeof(expected_text)) != 0) {
    return NULL;
  }
  unsigned char expected[CC_SHA256_DIGEST_LENGTH];
  uint32_t cap = 0;
  char leaf[16];
  if (derived_parse_sha256(expected_text, expected) != 0 ||
      derived_leaf_name(writer->kind, leaf, sizeof(leaf), &cap) != 0 ||
      length == 0 || length > cap) {
    derived_throw(env, "DERIVED_CANDIDATE_INVALID", "Derived candidate is not acceptable.");
    return NULL;
  }
  unsigned char *copy = malloc(length);
  if (copy == NULL) {
    derived_throw(env, "STORAGE_NATIVE_ERROR", "Derived candidate allocation failed.");
    return NULL;
  }
  memcpy(copy, data, length);
  unsigned char input_digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(copy, (CC_LONG)length, input_digest);
  if (memcmp(input_digest, expected, sizeof(expected)) != 0) {
    free(copy);
    derived_throw(env, "DERIVED_HASH_MISMATCH", "Candidate bytes do not match the declared SHA-256.");
    return NULL;
  }
  pthread_mutex_lock(&writer->store->mutex);
  if (writer->state != DERIVED_TEMP_OPEN || writer->file_fd < 0 ||
      derived_require_root(writer->store) != 0) {
    pthread_mutex_unlock(&writer->store->mutex);
    free(copy);
    derived_throw(env, "DERIVED_WRITER_CLOSED", "Derived writer cannot accept more bytes.");
    return NULL;
  }
  int failure = 0;
  if (write_all(writer->file_fd, copy, length) != 0) failure = errno == 0 ? EIO : errno;
  int fail_sync = writer->store->fail_next_fsync;
  writer->store->fail_next_fsync = 0;
  if (failure == 0 && fail_sync) failure = EIO;
  if (failure == 0 && full_sync_file_fd(writer->file_fd) != 0) failure = errno;
  unsigned char file_digest[CC_SHA256_DIGEST_LENGTH];
  if (failure == 0 && derived_hash_fd(writer->file_fd, (off_t)length, file_digest) != 0) {
    failure = errno == 0 ? EIO : errno;
  }
  if (failure == 0 && memcmp(file_digest, input_digest, sizeof(file_digest)) != 0) {
    failure = EILSEQ;
  }
  if (failure == 0 && derived_bind_created_file(writer) != 0) failure = errno == 0 ? EPERM : errno;
  if (failure == 0 && (writer->size != (off_t)length || writer->nlink != 1)) failure = EPERM;
  if (failure == 0 && sync_directory_fd(writer->epoch_fd) != 0) failure = errno;
  char sha_hex[65];
  if (failure == 0) {
    derived_digest_hex(file_digest, sha_hex);
    memcpy(writer->sha, file_digest, sizeof(writer->sha));
    writer->sha_ready = 1;
  }
  if (failure != 0) {
    derived_close_fd(&writer->file_fd);
    if (derived_unlink_exact(writer) == 0) writer->state = DERIVED_TEMP_CLEANED;
    else writer->state = DERIVED_TEMP_FAILED;
    derived_unregister(writer->store, writer);
    pthread_mutex_unlock(&writer->store->mutex);
    free(copy);
    if (failure == EILSEQ) {
      derived_throw(env, "DERIVED_HASH_MISMATCH", "Durable temp bytes do not match the candidate.");
    } else if (fail_sync || failure == EIO) {
      derived_throw(env, "DERIVED_FSYNC_FAILED", "Derived temp durability failed.");
    } else if (failure == EPERM) {
      derived_throw(env, "DERIVED_TEMP_UNSAFE", "Derived temp identity changed during write.");
    } else {
      derived_throw(env, "DERIVED_BYTE_MISMATCH", "Derived temp size does not match the candidate.");
    }
    return NULL;
  }
  derived_close_fd(&writer->file_fd);
  writer->state = DERIVED_TEMP_DURABLE;
  pthread_mutex_unlock(&writer->store->mutex);
  free(copy);
  return derived_snapshot_object(env, writer, sha_hex);
}

static void finalize_derived_sealed(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  derived_sealed_t *sealed = data;
  if (sealed == NULL) return;
  derived_close_fd(&sealed->read_fd);
  sealed->magic = 0;
  sealed->writer = NULL;
  free(sealed);
}

static derived_sealed_t *derived_get_sealed(napi_env env, napi_value value) {
  derived_sealed_t *sealed = NULL;
  if (napi_get_value_external(env, value, (void **)&sealed) != napi_ok ||
      sealed == NULL || sealed->magic != DERIVED_SEALED_MAGIC ||
      sealed->consumed || sealed->writer == NULL ||
      sealed->writer->magic != DERIVED_WRITER_MAGIC) {
    derived_throw(env, "DERIVED_SEALED_CLOSED", "Sealed derived output is closed.");
    return NULL;
  }
  return sealed;
}

static int derived_revalidate_parent(derived_writer_t *writer) {
  struct stat epoch_opened, epoch_named;
  char epoch_name[40];
  if (snprintf(epoch_name, sizeof(epoch_name), "e%s", writer->epoch) >=
      (int)sizeof(epoch_name)) {
    errno = EINVAL;
    return -1;
  }
  if (fstat(writer->epoch_fd, &epoch_opened) != 0 ||
      fstatat(writer->job_fd, epoch_name, &epoch_named, AT_SYMLINK_NOFOLLOW) !=
          0 ||
      !S_ISDIR(epoch_opened.st_mode) || !S_ISDIR(epoch_named.st_mode) ||
      epoch_opened.st_dev != writer->epoch_device ||
      epoch_opened.st_ino != writer->epoch_inode ||
      epoch_named.st_dev != epoch_opened.st_dev ||
      epoch_named.st_ino != epoch_opened.st_ino ||
      !owned_by_caller(&epoch_opened) ||
      (epoch_opened.st_mode & 0777) != 0700) {
    errno = EPERM;
    return -1;
  }
  return 0;
}

static napi_value seal_derived_temp(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument;
  napi_get_cb_info(env, info, &argc, &argument, NULL, NULL);
  derived_writer_t *writer = argc == 1 ? derived_get_writer(env, argument) : NULL;
  if (writer == NULL) return NULL;
  pthread_mutex_lock(&writer->store->mutex);
  if (writer->state == DERIVED_TEMP_SEALED) {
    pthread_mutex_unlock(&writer->store->mutex);
    derived_throw(env, "DERIVED_ALREADY_SEALED", "Derived temp is already sealed.");
    return NULL;
  }
  if (writer->state != DERIVED_TEMP_DURABLE || writer->file_fd >= 0 ||
      !writer->sha_ready) {
    pthread_mutex_unlock(&writer->store->mutex);
    derived_throw(env, "DERIVED_WRITER_CLOSED",
                  "Only a closed durable writer can be sealed.");
    return NULL;
  }
  if (derived_require_root(writer->store) != 0 ||
      derived_revalidate_parent(writer) != 0) {
    pthread_mutex_unlock(&writer->store->mutex);
    derived_throw(env, "DERIVED_PARENT_REPLACED",
                  "Derived parent identity changed before seal.");
    return NULL;
  }
  struct stat named;
  if (fstatat(writer->epoch_fd, writer->leaf, &named, AT_SYMLINK_NOFOLLOW) != 0) {
    pthread_mutex_unlock(&writer->store->mutex);
    derived_throw(env, "DERIVED_TEMP_RECOVERY_REQUIRED",
                  "Owned temp disappeared before seal.");
    return NULL;
  }
  if (!S_ISREG(named.st_mode) || named.st_dev != writer->device ||
      named.st_ino != writer->inode) {
    pthread_mutex_unlock(&writer->store->mutex);
    derived_throw(env, "DERIVED_TEMP_RECOVERY_REQUIRED",
                  "Temp inode or device changed before seal.");
    return NULL;
  }
  if (named.st_nlink != 1 || !owned_by_caller(&named) ||
      !private_file_mode(named.st_mode, 1) || named.st_size != writer->size) {
    pthread_mutex_unlock(&writer->store->mutex);
    derived_throw(env, "DERIVED_TEMP_RECOVERY_REQUIRED",
                  "Temp ownership or size changed before seal.");
    return NULL;
  }
  int read_fd = openat(writer->epoch_fd, writer->leaf,
                       O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  struct stat opened;
  int failure = read_fd < 0 ? errno : 0;
  if (failure == 0 &&
      (fstat(read_fd, &opened) != 0 || opened.st_dev != writer->device ||
       opened.st_ino != writer->inode || opened.st_nlink != 1 ||
       !owned_by_caller(&opened) || opened.st_size != writer->size ||
       !private_file_mode(opened.st_mode, 1) ||
       validate_no_extended_acl(read_fd) != 0)) {
    failure = errno == 0 ? EPERM : errno;
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (failure == 0 &&
      derived_hash_fd(read_fd, writer->size, digest) != 0) {
    failure = errno == 0 ? EIO : errno;
  }
  if (failure == 0 && memcmp(digest, writer->sha, sizeof(digest)) != 0) {
    failure = EILSEQ;
  }
  if (failure == 0 && (opened.st_mode & 0777) == 0600 &&
      fchmod(read_fd, 0400) != 0) {
    failure = errno == 0 ? EPERM : errno;
  }
  int fail_sync = writer->store->fail_next_seal_fsync;
  int fail_close = writer->store->fail_next_seal_close;
  writer->store->fail_next_seal_fsync = 0;
  writer->store->fail_next_seal_close = 0;
  if (failure == 0 && fail_sync) failure = EIO;
  if (failure == 0 && full_sync_file_fd(read_fd) != 0) failure = errno;
  if (failure == 0 &&
      (fstat(read_fd, &opened) != 0 || opened.st_dev != writer->device ||
       opened.st_ino != writer->inode || opened.st_nlink != 1 ||
       opened.st_size != writer->size || (opened.st_mode & 0777) != 0400 ||
       !owned_by_caller(&opened))) {
    failure = errno == 0 ? EPERM : errno;
  }
  struct stat again;
  if (failure == 0 &&
      (fstatat(writer->epoch_fd, writer->leaf, &again, AT_SYMLINK_NOFOLLOW) !=
           0 ||
       again.st_dev != opened.st_dev || again.st_ino != opened.st_ino ||
       again.st_size != opened.st_size || (again.st_mode & 0777) != 0400)) {
    failure = errno == 0 ? EPERM : errno;
  }
  if (failure == 0 && derived_revalidate_parent(writer) != 0) failure = EPERM;
  if (failure == 0 && fail_close) failure = EIO;
  if (failure != 0) {
    if (read_fd >= 0) close(read_fd);
    if (fstatat(writer->epoch_fd, writer->leaf, &again, AT_SYMLINK_NOFOLLOW) ==
            0 &&
        again.st_dev == writer->device && again.st_ino == writer->inode &&
        private_file_mode(again.st_mode, 1)) {
      writer->mode = again.st_mode & 0777;
    }
    pthread_mutex_unlock(&writer->store->mutex);
    if (failure == EILSEQ) {
      derived_throw(env, "DERIVED_HASH_MISMATCH",
                    "Temp bytes no longer match the candidate SHA-256.");
    } else if (fail_sync) {
      derived_throw(env, "DERIVED_FSYNC_FAILED", "Seal durability failed.");
    } else if (fail_close) {
      derived_throw(env, "DERIVED_CLOSE_FAILED", "Seal close failed.");
    } else {
      derived_throw(env, "DERIVED_TEMP_RECOVERY_REQUIRED",
                    "Temp identity changed and was retained.");
    }
    return NULL;
  }
  writer->mode = 0400;
  writer->mtime = opened.st_mtimespec;
  writer->ctime = opened.st_ctimespec;
  writer->state = DERIVED_TEMP_SEALED;
  derived_sealed_t *sealed = calloc(1, sizeof(*sealed));
  if (sealed == NULL) {
    close(read_fd);
    writer->state = DERIVED_TEMP_DURABLE;
    pthread_mutex_unlock(&writer->store->mutex);
    derived_throw(env, "STORAGE_NATIVE_ERROR", "Sealed output allocation failed.");
    return NULL;
  }
  sealed->magic = DERIVED_SEALED_MAGIC;
  sealed->writer = writer;
  sealed->read_fd = read_fd;
  char sha_hex[65];
  derived_digest_hex(writer->sha, sha_hex);
  napi_value snapshot = derived_snapshot_object(env, writer, sha_hex);
  napi_value external;
  napi_create_external(env, sealed, finalize_derived_sealed, NULL, &external);
  napi_set_named_property(env, snapshot, "handle", external);
  pthread_mutex_unlock(&writer->store->mutex);
  return snapshot;
}

static napi_value consume_sealed_output(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  derived_sealed_t *sealed = argc == 2 ? derived_get_sealed(env, args[0]) : NULL;
  derived_store_t *store = sealed == NULL ? NULL : derived_get_store(env, args[1]);
  if (sealed == NULL || store == NULL) return NULL;
  pthread_mutex_lock(&store->mutex);
  if (sealed->consumed || sealed->writer == NULL ||
      sealed->writer->store != store ||
      sealed->writer->state != DERIVED_TEMP_SEALED) {
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, "DERIVED_SEALED_CLOSED",
                  "Sealed output does not belong to this store.");
    return NULL;
  }
  derived_close_fd(&sealed->read_fd);
  sealed->consumed = 1;
  derived_unregister(store, sealed->writer);
  pthread_mutex_unlock(&store->mutex);
  return undefined_value(env);
}

static napi_value fail_next_seal_fault(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  derived_store_t *store = argc == 2 ? derived_get_store(env, args[0]) : NULL;
  char which[16];
  if (store == NULL || get_string(env, args[1], which, sizeof(which)) != 0) {
    return NULL;
  }
  if (process_is_production()) {
    derived_throw(env, "DERIVED_FAULT_DEV_ONLY", "Fault injection is dev-only.");
    return NULL;
  }
  pthread_mutex_lock(&store->mutex);
  if (strcmp(which, "fsync") == 0) store->fail_next_seal_fsync = 1;
  else if (strcmp(which, "close") == 0) store->fail_next_seal_close = 1;
  else {
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, "STORAGE_INVALID_ARGUMENT", "Unknown seal fault.");
    return NULL;
  }
  pthread_mutex_unlock(&store->mutex);
  return undefined_value(env);
}

static napi_value cleanup_derived_temp(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument;
  napi_get_cb_info(env, info, &argc, &argument, NULL, NULL);
  derived_writer_t *writer = argc == 1 ? derived_get_writer(env, argument) : NULL;
  if (writer == NULL) return NULL;
  pthread_mutex_lock(&writer->store->mutex);
  if (writer->state == DERIVED_TEMP_CLEANED) {
    struct stat named;
    int absent = fstatat(writer->epoch_fd, writer->leaf, &named, AT_SYMLINK_NOFOLLOW) != 0 &&
                 errno == ENOENT;
    pthread_mutex_unlock(&writer->store->mutex);
    if (!absent) {
      derived_throw(env, "DERIVED_CLEANUP_REFUSED",
                    "Cleaned temp name reappeared and was retained.");
      return NULL;
    }
    return undefined_value(env);
  }
  if (writer->state != DERIVED_TEMP_OPEN && writer->state != DERIVED_TEMP_DURABLE &&
      writer->state != DERIVED_TEMP_FAILED) {
    pthread_mutex_unlock(&writer->store->mutex);
    derived_throw(env, "DERIVED_CLEANUP_REFUSED", "Temp cleanup is not authorized.");
    return NULL;
  }
  derived_close_fd(&writer->file_fd);
  if (derived_require_root(writer->store) != 0 || derived_unlink_exact(writer) != 0) {
    writer->state = DERIVED_TEMP_FAILED;
    derived_unregister(writer->store, writer);
    pthread_mutex_unlock(&writer->store->mutex);
    derived_throw(env, "DERIVED_CLEANUP_REFUSED",
                  "Exact temp identity did not match; the entry was retained.");
    return NULL;
  }
  writer->state = DERIVED_TEMP_CLEANED;
  derived_unregister(writer->store, writer);
  pthread_mutex_unlock(&writer->store->mutex);
  return undefined_value(env);
}

static napi_value fail_next_derived_fsync(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument;
  napi_get_cb_info(env, info, &argc, &argument, NULL, NULL);
  derived_store_t *store = derived_get_store(env, argument);
  if (store == NULL) return NULL;
  if (process_is_production()) {
    derived_throw(env, "DERIVED_FAULT_DEV_ONLY", "Fault injection is dev-only.");
    return NULL;
  }
  pthread_mutex_lock(&store->mutex);
  store->fail_next_fsync = 1;
  pthread_mutex_unlock(&store->mutex);
  return undefined_value(env);
}

#endif
