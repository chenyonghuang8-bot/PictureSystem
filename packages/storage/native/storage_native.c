#define _DARWIN_C_SOURCE 1
#include <node_api.h>

#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sys/types.h>
#include <unistd.h>
#include <stdint.h>
#include <time.h>
#include <CommonCrypto/CommonDigest.h>

typedef struct {
  int root_fd;
  int lock_fd;
  dev_t device;
  ino_t inode;
  char canonical_path[PATH_MAX];
} storage_root_t;

#define CAPACITY_GATE_MAGIC UINT64_C(0x4341504741544531)
typedef struct {
  uint64_t magic;
  int root_fd;
  int lock_fd;
  dev_t device;
  ino_t root_inode;
  ino_t lock_inode;
  int locked;
  char marker[33];
  char canonical_path[PATH_MAX];
} capacity_gate_t;

#define ORIGINAL_READER_MAGIC UINT64_C(0x4f52454144455231)
#define ORIGINAL_HANDLE_MAGIC UINT64_C(0x4f48414e444c4531)

typedef struct {
  uint64_t magic;
  int root_fd;
  int originals_fd;
  dev_t device;
  ino_t root_inode;
  ino_t originals_inode;
  char marker[33];
  char canonical_path[PATH_MAX];
} original_reader_t;

typedef struct {
  uint64_t magic;
  int file_fd;
  int parent_fd;
  int consumed;
  dev_t device;
  ino_t inode;
  off_t size;
  mode_t mode;
  struct timespec mtime;
  char base[NAME_MAX + 1];
  char root_path[PATH_MAX];
} original_handle_t;

typedef struct {
  pthread_mutex_t mutex;
  pthread_cond_t condition;
  int ready;
  int go;
} race_gate_t;

typedef struct {
  race_gate_t *gate;
  int parent_fd;
  const char *base;
  const unsigned char *data;
  size_t length;
  int result;
  int error;
} create_race_t;

typedef struct {
  race_gate_t *gate;
  int source_parent_fd;
  int destination_parent_fd;
  const char *source_base;
  const char *destination_base;
  int result;
  int error;
} publish_race_t;

static napi_value undefined_value(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static void throw_code(napi_env env, const char *code, const char *message) {
  napi_value code_value;
  napi_value message_value;
  napi_value error;
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value);
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value);
  napi_create_error(env, code_value, message_value, &error);
  napi_throw(env, error);
}

static void throw_errno(napi_env env, const char *operation) {
  char message[256];
  (void)snprintf(message, sizeof(message), "%s failed (%d)", operation, errno);
  const char *code = "STORAGE_NATIVE_ERROR";
  if (errno == EEXIST)
    code = "STORAGE_ALREADY_EXISTS";
  else if (errno == EXDEV)
    code = "STORAGE_CROSS_DEVICE";
  else if (errno == EACCES || errno == EPERM || errno == EROFS)
    code = "STORAGE_NOT_WRITABLE";
  else if (errno == ENOSPC || errno == EDQUOT)
    code = "STORAGE_NO_SPACE";
  else if (errno == ENOENT)
    code = "STORAGE_NOT_FOUND";
  else if (errno == ETIMEDOUT)
    code = "STORAGE_TIMEOUT";
  else if (errno == ELOOP || errno == ENOTDIR)
    code = "STORAGE_PATH_UNSAFE";
  else if (errno == EINVAL || errno == ENAMETOOLONG)
    code = "STORAGE_INVALID_PATH";
  throw_code(env, code, message);
}

static int get_string(napi_env env, napi_value value, char *buffer,
                      size_t capacity) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, buffer, capacity, &length) !=
          napi_ok ||
      length == 0 || length >= capacity) {
    throw_code(env, "STORAGE_INVALID_ARGUMENT", "Invalid string argument.");
    return -1;
  }
  return 0;
}

static storage_root_t *get_root(napi_env env, napi_value value) {
  storage_root_t *root = NULL;
  if (napi_get_value_external(env, value, (void **)&root) != napi_ok ||
      root == NULL || root->root_fd < 0) {
    throw_code(env, "STORAGE_ROOT_CLOSED", "Storage root is closed.");
    return NULL;
  }
  return root;
}

static original_reader_t *get_original_reader(napi_env env, napi_value value) {
  original_reader_t *reader = NULL;
  if (napi_get_value_external(env, value, (void **)&reader) != napi_ok ||
      reader == NULL || reader->magic != ORIGINAL_READER_MAGIC ||
      reader->root_fd < 0 || reader->originals_fd < 0) {
    throw_code(env, "ORIGINAL_READER_CLOSED", "Original reader is closed.");
    return NULL;
  }
  return reader;
}

static original_handle_t *get_original_handle(napi_env env, napi_value value) {
  original_handle_t *handle = NULL;
  if (napi_get_value_external(env, value, (void **)&handle) != napi_ok ||
      handle == NULL || handle->magic != ORIGINAL_HANDLE_MAGIC ||
      handle->file_fd < 0 || handle->parent_fd < 0 || handle->consumed) {
    throw_code(env, "ORIGINAL_HANDLE_CLOSED", "Original handle is closed or consumed.");
    return NULL;
  }
  return handle;
}

static int validate_path_component(const char *component) {
  size_t length = strlen(component);
  if (length == 0 || length > NAME_MAX || strcmp(component, ".") == 0 ||
      strcmp(component, "..") == 0) {
    return -1;
  }
  return 0;
}

static int validate_internal_component(const char *component) {
  if (validate_path_component(component) != 0) return -1;
  size_t length = strlen(component);
  for (size_t i = 0; i < length; i += 1) {
    unsigned char c = (unsigned char)component[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' ||
          c == '_' || c == '-')) {
      return -1;
    }
  }
  return 0;
}

static int validate_directory_stat(const struct stat *status) {
  if (!S_ISDIR(status->st_mode) ||
      (status->st_uid != geteuid() && status->st_uid != 0) ||
      (status->st_mode & (S_IWGRP | S_IWOTH)) != 0) {
    errno = EPERM;
    return -1;
  }
  return 0;
}

static int validate_no_extended_acl(int fd) {
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (acl == NULL) return errno == ENOENT ? 0 : -1;
  acl_entry_t entry;
  errno = 0;
  int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  int saved = errno;
  acl_free(acl);
  if (result == 0) {
    errno = EPERM;
    return -1;
  }
  if (saved != EINVAL) {
    errno = saved == 0 ? EIO : saved;
    return -1;
  }
  return 0;
}

static int validate_directory_fd(int fd, struct stat *status) {
  if (fstat(fd, status) != 0 || validate_directory_stat(status) != 0 ||
      validate_no_extended_acl(fd) != 0)
    return -1;
  return 0;
}

static int sync_directory_fd(int fd) {
  if (fsync(fd) != 0) return -1;
  return 0;
}

static int full_sync_file_fd(int fd) {
  if (fsync(fd) != 0) return -1;
  if (fcntl(fd, F_FULLFSYNC, 0) != 0) return -1;
  return 0;
}

static int secure_open_child_directory(int parent_fd, const char *component,
                                       int create, int internal) {
  if ((internal ? validate_internal_component(component)
                : validate_path_component(component)) != 0) {
    errno = EINVAL;
    return -1;
  }
  struct stat link_status;
  if (fstatat(parent_fd, component, &link_status, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno != ENOENT || !create) return -1;
    if (mkdirat(parent_fd, component, 0700) != 0) return -1;
    if (sync_directory_fd(parent_fd) != 0) return -1;
  } else if (!S_ISDIR(link_status.st_mode)) {
    errno = ENOTDIR;
    return -1;
  }

  int fd = openat(parent_fd, component,
                  O_RDONLY | O_DIRECTORY | O_NOFOLLOW |
                      O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat status;
  if (validate_directory_fd(fd, &status) != 0) {
    int saved = errno;
    close(fd);
    errno = saved;
    return -1;
  }
  return fd;
}

static int open_absolute_directory(const char *path, int create) {
  if (path[0] != '/' || path[1] == '\0') {
    errno = EINVAL;
    return -1;
  }
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (current < 0) return -1;

  char copy[PATH_MAX];
  if (strlen(path) >= sizeof(copy)) {
    close(current);
    errno = ENAMETOOLONG;
    return -1;
  }
  strcpy(copy, path + 1);
  char *save = NULL;
  char *component = strtok_r(copy, "/", &save);
  while (component != NULL) {
    int next = secure_open_child_directory(current, component, create, 0);
    if (next < 0) {
      int saved = errno;
      close(current);
      errno = saved;
      return -1;
    }
    close(current);
    current = next;
    component = strtok_r(NULL, "/", &save);
  }
  return current;
}

static int open_relative_directory(storage_root_t *root, const char *path,
                                   int create) {
  int current = dup(root->root_fd);
  if (current < 0) return -1;
  if (path[0] == '\0') return current;
  if (path[0] == '/' || strlen(path) >= PATH_MAX) {
    close(current);
    errno = EINVAL;
    return -1;
  }
  char copy[PATH_MAX];
  strcpy(copy, path);
  char *save = NULL;
  char *component = strtok_r(copy, "/", &save);
  while (component != NULL) {
    int next = secure_open_child_directory(current, component, create, 1);
    if (next < 0) {
      int saved = errno;
      close(current);
      errno = saved;
      return -1;
    }
    close(current);
    current = next;
    component = strtok_r(NULL, "/", &save);
  }
  return current;
}

static int split_parent(const char *relative, char *parent, size_t parent_size,
                        char *base, size_t base_size) {
  if (relative[0] == '/' || relative[0] == '\0' ||
      strlen(relative) >= PATH_MAX) {
    errno = EINVAL;
    return -1;
  }
  const char *slash = strrchr(relative, '/');
  if (slash == NULL) {
    parent[0] = '\0';
    if (strlen(relative) >= base_size) return -1;
    strcpy(base, relative);
  } else {
    size_t parent_length = (size_t)(slash - relative);
    if (parent_length == 0 || parent_length >= parent_size ||
        strlen(slash + 1) >= base_size) {
      errno = EINVAL;
      return -1;
    }
    memcpy(parent, relative, parent_length);
    parent[parent_length] = '\0';
    strcpy(base, slash + 1);
  }
  if (validate_internal_component(base) != 0) {
    errno = EINVAL;
    return -1;
  }
  return 0;
}

static int write_all(int fd, const unsigned char *data, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(fd, data + offset, length - offset);
    if (written < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (written == 0) {
      errno = EIO;
      return -1;
    }
    offset += (size_t)written;
  }
  return 0;
}

static int parse_offset(const char *value, off_t *result) {
  if (value[0] == '\0' || (value[0] == '0' && value[1] != '\0')) {
    errno = EINVAL;
    return -1;
  }
  uint64_t parsed = 0;
  for (size_t i = 0; value[i] != '\0'; i += 1) {
    if (value[i] < '0' || value[i] > '9') {
      errno = EINVAL;
      return -1;
    }
    uint64_t digit = (uint64_t)(value[i] - '0');
    if (parsed > (UINT64_MAX - digit) / 10) {
      errno = EOVERFLOW;
      return -1;
    }
    parsed = parsed * 10 + digit;
  }
  off_t converted = (off_t)parsed;
  if (converted < 0 || (uint64_t)converted != parsed) {
    errno = EOVERFLOW;
    return -1;
  }
  *result = converted;
  return 0;
}

static int open_validated_regular(storage_root_t *root, int parent_fd,
                                  const char *base, int flags,
                                  struct stat *status) {
  int fd = openat(parent_fd, base, flags | O_NOFOLLOW | O_UNIQUE | O_CLOEXEC);
  if (fd < 0) return -1;
  if (fstat(fd, status) != 0 || !S_ISREG(status->st_mode) ||
      status->st_uid != geteuid() || status->st_nlink != 1 ||
      status->st_dev != root->device || (status->st_mode & 0777) != 0600 ||
      validate_no_extended_acl(fd) != 0) {
    int saved = errno == 0 ? EPERM : errno;
    close(fd);
    errno = saved;
    return -1;
  }
  return fd;
}

static int open_validated_readonly(storage_root_t *root, int parent_fd,
                                   const char *base, mode_t expected_mode,
                                   struct stat *status) {
  int fd = openat(parent_fd, base,
                  O_RDONLY | O_NOFOLLOW | O_UNIQUE | O_CLOEXEC);
  if (fd < 0) return -1;
  if (fstat(fd, status) != 0 || !S_ISREG(status->st_mode) ||
      status->st_uid != geteuid() || status->st_nlink != 1 ||
      status->st_dev != root->device ||
      (expected_mode == 0 ?
         ((status->st_mode & 0777) != 0400 &&
          (status->st_mode & 0777) != 0600) :
         (status->st_mode & 0777) != expected_mode) ||
      validate_no_extended_acl(fd) != 0) {
    int saved = errno == 0 ? EPERM : errno;
    close(fd);
    errno = saved;
    return -1;
  }
  return fd;
}

static int open_validated_original_reader(storage_root_t *root, int parent_fd,
                                          const char *base,
                                          struct stat *status) {
  int fd = openat(parent_fd, base,
                  O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_UNIQUE | O_CLOEXEC);
  if (fd < 0) return -1;
  if (fstat(fd, status) != 0 || !S_ISREG(status->st_mode) ||
      status->st_uid != geteuid() || status->st_nlink != 1 ||
      status->st_dev != root->device || (status->st_mode & 0777) != 0400 ||
      validate_no_extended_acl(fd) != 0) {
    int saved = errno == 0 ? EPERM : errno;
    close(fd);
    errno = saved;
    return -1;
  }
  return fd;
}

static int pwrite_all(int fd, const unsigned char *data, size_t length,
                      off_t start) {
  size_t written_total = 0;
  while (written_total < length) {
    ssize_t written = pwrite(fd, data + written_total, length - written_total,
                             start + (off_t)written_total);
    if (written < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (written == 0) {
      errno = EIO;
      return -1;
    }
    written_total += (size_t)written;
  }
  return 0;
}

static void wait_for_race(race_gate_t *gate) {
  pthread_mutex_lock(&gate->mutex);
  gate->ready += 1;
  /* The same condition is used for ready and go. Wake the coordinator as well
     as any worker that may already be waiting for go. */
  pthread_cond_broadcast(&gate->condition);
  while (!gate->go) pthread_cond_wait(&gate->condition, &gate->mutex);
  pthread_mutex_unlock(&gate->mutex);
}

static int start_race(race_gate_t *gate) {
  if (pthread_mutex_init(&gate->mutex, NULL) != 0) return -1;
  if (pthread_cond_init(&gate->condition, NULL) != 0) {
    pthread_mutex_destroy(&gate->mutex);
    return -1;
  }
  gate->ready = 0;
  gate->go = 0;
  return 0;
}

static void release_race(race_gate_t *gate) {
  pthread_mutex_lock(&gate->mutex);
  while (gate->ready < 2) pthread_cond_wait(&gate->condition, &gate->mutex);
  gate->go = 1;
  pthread_cond_broadcast(&gate->condition);
  pthread_mutex_unlock(&gate->mutex);
}

static void finish_race(race_gate_t *gate) {
  pthread_cond_destroy(&gate->condition);
  pthread_mutex_destroy(&gate->mutex);
}

static void cancel_race(race_gate_t *gate) {
  pthread_mutex_lock(&gate->mutex);
  gate->go = 1;
  pthread_cond_broadcast(&gate->condition);
  pthread_mutex_unlock(&gate->mutex);
}

static void *exclusive_create_worker(void *value) {
  create_race_t *race = (create_race_t *)value;
  wait_for_race(race->gate);
  int fd = openat(race->parent_fd, race->base,
                  O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) {
    race->result = -1;
    race->error = errno;
    return NULL;
  }
  int failure = 0;
  if (write_all(fd, race->data, race->length) != 0 || fsync(fd) != 0)
    failure = errno;
  if (close(fd) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    race->result = -1;
    race->error = failure;
    return NULL;
  }
  race->result = 0;
  return NULL;
}

static void *exclusive_publish_worker(void *value) {
  publish_race_t *race = (publish_race_t *)value;
  wait_for_race(race->gate);
  if (renameatx_np(race->source_parent_fd, race->source_base,
                   race->destination_parent_fd, race->destination_base,
                   RENAME_EXCL) != 0) {
    race->result = -1;
    race->error = errno;
    return NULL;
  }
  race->result = 0;
  return NULL;
}

static napi_value race_result(napi_env env, int successes, int already_exists) {
  napi_value object;
  napi_value success_value;
  napi_value exists_value;
  napi_create_object(env, &object);
  napi_create_int32(env, successes, &success_value);
  napi_create_int32(env, already_exists, &exists_value);
  napi_set_named_property(env, object, "successes", success_value);
  napi_set_named_property(env, object, "alreadyExists", exists_value);
  return object;
}

static int read_marker(int root_fd, char *identifier, size_t capacity,
                       int initialize) {
  int fd = openat(root_fd, ".storage-root",
                  O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 && errno == ENOENT && initialize) {
    fd = openat(root_fd, ".storage-root",
                O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW |
                    O_CLOEXEC,
                0600);
    if (fd < 0) return -1;
    unsigned char random_bytes[16];
    arc4random_buf(random_bytes, sizeof(random_bytes));
    char content[64];
    const char *prefix = "FAMILY_ALBUM_STORAGE_V1:";
    size_t prefix_length = strlen(prefix);
    memcpy(content, prefix, prefix_length);
    for (size_t i = 0; i < sizeof(random_bytes); i += 1) {
      (void)snprintf(content + prefix_length + i * 2, 3, "%02x",
                     random_bytes[i]);
    }
    size_t content_length = prefix_length + 32;
    content[content_length++] = '\n';
    if (write_all(fd, (const unsigned char *)content, content_length) != 0 ||
        fsync(fd) != 0) {
      int saved = errno;
      close(fd);
      errno = saved;
      return -1;
    }
    if (close(fd) != 0 || sync_directory_fd(root_fd) != 0) return -1;
    fd = openat(root_fd, ".storage-root",
                O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  }
  if (fd < 0) return -1;

  struct stat status;
  char content[64];
  ssize_t length = read(fd, content, sizeof(content) - 1);
  int failure = length < 0 ? errno : 0;
  if (failure == 0 && fstat(fd, &status) != 0) failure = errno;
  if (failure == 0 && validate_no_extended_acl(fd) != 0) failure = errno;
  if (close(fd) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    errno = failure;
    return -1;
  }
  content[length] = '\0';
  const char *prefix = "FAMILY_ALBUM_STORAGE_V1:";
  size_t prefix_length = strlen(prefix);
  if (!S_ISREG(status.st_mode) || status.st_uid != geteuid() ||
      status.st_nlink != 1 || (status.st_mode & 077) != 0 ||
      (size_t)length != prefix_length + 33 ||
      memcmp(content, prefix, prefix_length) != 0 ||
      content[prefix_length + 32] != '\n') {
    errno = EPERM;
    return -1;
  }
  for (size_t i = 0; i < 32; i += 1) {
    char c = content[prefix_length + i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
      errno = EPERM;
      return -1;
    }
  }
  if (capacity < 33) {
    errno = ENOSPC;
    return -1;
  }
  memcpy(identifier, content + prefix_length, 32);
  identifier[32] = '\0';
  return 0;
}

static int validate_capacity_lock(int root_fd, int lock_fd,
                                  dev_t root_device, ino_t *inode) {
  struct stat status, disk;
  if (fstat(lock_fd, &status) != 0 ||
      fstatat(root_fd, ".capacity.lock", &disk, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(status.st_mode) || !S_ISREG(disk.st_mode) ||
      status.st_dev != root_device || disk.st_dev != status.st_dev ||
      status.st_ino != disk.st_ino || status.st_uid != geteuid() ||
      status.st_gid != getegid() || status.st_nlink != 1 ||
      (status.st_mode & 07777) != 0600 ||
      validate_no_extended_acl(lock_fd) != 0) {
    if (errno == 0) errno = EPERM;
    return -1;
  }
  *inode = status.st_ino;
  return 0;
}

static napi_value provision_capacity_gate(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument;
  napi_get_cb_info(env, info, &argc, &argument, NULL, NULL);
  if (argc != 1) {
    throw_code(env, "STORAGE_INVALID_ARGUMENT", "Provision requires a root handle.");
    return NULL;
  }
  storage_root_t *root = get_root(env, argument);
  if (root == NULL || root->lock_fd < 0) return NULL;
  int fd = openat(root->root_fd, ".capacity.lock",
                  O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) {
    throw_errno(env, "provision capacity lock");
    return NULL;
  }
  ino_t inode;
  int failure = validate_capacity_lock(root->root_fd, fd, root->device, &inode);
  if (failure == 0 && fsync(fd) != 0) failure = -1;
  if (failure == 0 && sync_directory_fd(root->root_fd) != 0) failure = -1;
  int saved = errno;
  if (close(fd) != 0 && failure == 0) { failure = -1; saved = errno; }
  if (failure != 0) {
    errno = saved == 0 ? EPERM : saved;
    throw_errno(env, "validate provisioned capacity lock");
    return NULL;
  }
  return undefined_value(env);
}

static void finalize_capacity_gate(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  capacity_gate_t *gate = data;
  if (gate == NULL) return;
  if (gate->locked && gate->lock_fd >= 0) (void)flock(gate->lock_fd, LOCK_UN);
  if (gate->lock_fd >= 0) close(gate->lock_fd);
  if (gate->root_fd >= 0) close(gate->root_fd);
  gate->magic = 0;
  free(gate);
}

static capacity_gate_t *get_capacity_gate(napi_env env, napi_value value) {
  capacity_gate_t *gate = NULL;
  if (napi_get_value_external(env, value, (void **)&gate) != napi_ok ||
      gate == NULL || gate->magic != CAPACITY_GATE_MAGIC ||
      gate->root_fd < 0 || gate->lock_fd < 0) {
    throw_code(env, "CAPACITY_GATE_CLOSED", "Capacity gate is closed.");
    return NULL;
  }
  return gate;
}

static napi_value open_capacity_gate(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  char path[PATH_MAX], expected[33];
  if (argc != 2 || get_string(env, args[0], path, sizeof(path)) != 0 ||
      get_string(env, args[1], expected, sizeof(expected)) != 0 ||
      strlen(expected) != 32) {
    throw_code(env, "STORAGE_INVALID_ARGUMENT", "Invalid capacity gate identity.");
    return NULL;
  }
  int root_fd = open_absolute_directory(path, 0);
  if (root_fd < 0) { throw_errno(env, "open capacity root"); return NULL; }
  struct stat root_status;
  char marker[33];
  if (validate_directory_fd(root_fd, &root_status) != 0 ||
      root_status.st_uid != geteuid() || (root_status.st_mode & 077) != 0 ||
      read_marker(root_fd, marker, sizeof(marker), 0) != 0 ||
      strcmp(marker, expected) != 0) {
    close(root_fd);
    throw_code(env, "CAPACITY_ROOT_INVALID", "Capacity root identity mismatch.");
    return NULL;
  }
  int lock_fd = openat(root_fd, ".capacity.lock",
                       O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  ino_t lock_inode = 0;
  if (lock_fd < 0 || validate_capacity_lock(root_fd, lock_fd,
                                             root_status.st_dev, &lock_inode) != 0) {
    if (lock_fd >= 0) close(lock_fd);
    close(root_fd);
    throw_code(env, "CAPACITY_LOCK_INVALID", "Capacity lock is unavailable or unsafe.");
    return NULL;
  }
  capacity_gate_t *gate = calloc(1, sizeof(*gate));
  if (gate == NULL) {
    close(lock_fd); close(root_fd);
    throw_code(env, "STORAGE_NATIVE_ERROR", "Capacity gate allocation failed.");
    return NULL;
  }
  *gate = (capacity_gate_t){.magic = CAPACITY_GATE_MAGIC, .root_fd = root_fd,
      .lock_fd = lock_fd, .device = root_status.st_dev,
      .root_inode = root_status.st_ino, .lock_inode = lock_inode};
  strcpy(gate->marker, marker);
  if (fcntl(root_fd, F_GETPATH, gate->canonical_path) != 0) {
    finalize_capacity_gate(env, gate, NULL);
    throw_errno(env, "resolve capacity root");
    return NULL;
  }
  napi_value external;
  napi_create_external(env, gate, finalize_capacity_gate, NULL, &external);
  return external;
}

static napi_value try_acquire_capacity_gate(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  capacity_gate_t *gate = get_capacity_gate(env, arg);
  if (gate == NULL) return NULL;
  if (gate->locked) {
    throw_code(env, "CAPACITY_LOCK_REENTRANT", "Capacity lock is already held.");
    return NULL;
  }
  int locked = flock(gate->lock_fd, LOCK_EX | LOCK_NB);
  if (locked != 0) {
    if (errno != EWOULDBLOCK && errno != EAGAIN) {
      throw_errno(env, "acquire capacity lock"); return NULL;
    }
    napi_value no;
    napi_get_boolean(env, false, &no);
    return no;
  }
  struct stat root_status;
  char marker[33];
  ino_t lock_inode = 0;
  int fresh_root = open_absolute_directory(gate->canonical_path, 0);
  struct stat fresh_status;
  int fresh_valid = fresh_root >= 0 && fstat(fresh_root, &fresh_status) == 0 &&
      fresh_status.st_dev == gate->device &&
      fresh_status.st_ino == gate->root_inode;
  if (fresh_root >= 0) close(fresh_root);
  if (fstat(gate->root_fd, &root_status) != 0 ||
      !fresh_valid ||
      root_status.st_dev != gate->device ||
      root_status.st_ino != gate->root_inode ||
      validate_capacity_lock(gate->root_fd, gate->lock_fd,
                             gate->device, &lock_inode) != 0 ||
      lock_inode != gate->lock_inode ||
      read_marker(gate->root_fd, marker, sizeof(marker), 0) != 0 ||
      strcmp(marker, gate->marker) != 0) {
    (void)flock(gate->lock_fd, LOCK_UN);
    throw_code(env, "CAPACITY_ROOT_INVALID", "Capacity lock identity changed.");
    return NULL;
  }
  gate->locked = 1;
  napi_value yes;
  napi_get_boolean(env, true, &yes);
  return yes;
}

static napi_value release_capacity_gate(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  capacity_gate_t *gate = get_capacity_gate(env, arg);
  if (gate == NULL) return NULL;
  if (!gate->locked || flock(gate->lock_fd, LOCK_UN) != 0) {
    throw_code(env, "CAPACITY_RELEASE_FAILED", "Capacity lock release failed.");
    return NULL;
  }
  gate->locked = 0;
  return undefined_value(env);
}

static napi_value capacity_gate_snapshot(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  capacity_gate_t *gate = get_capacity_gate(env, arg);
  if (gate == NULL) return NULL;
  if (!gate->locked) {
    throw_code(env, "CAPACITY_LOCK_REQUIRED", "Capacity snapshot requires lock.");
    return NULL;
  }
  // D3b-0 has no derived filesystem writer yet. Absence or a verified empty
  // derived directory is complete inventory; any candidate/residue blocks
  // admission until the later exact derived-namespace scanner is installed.
  int derived_empty = 1;
  struct stat derived_before, derived_after;
  if (fstatat(gate->root_fd, "derived", &derived_before,
              AT_SYMLINK_NOFOLLOW) == 0) {
    if (!S_ISDIR(derived_before.st_mode) ||
        derived_before.st_dev != gate->device ||
        derived_before.st_uid != geteuid() ||
        (derived_before.st_mode & 077) != 0) {
      throw_code(env, "DERIVED_INVENTORY_UNSAFE",
                 "Derived namespace cannot be trusted.");
      return NULL;
    }
    int dir_fd = openat(gate->root_fd, "derived",
                        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (dir_fd < 0) {
      throw_errno(env, "open derived inventory");
      return NULL;
    }
    struct stat opened_derived;
    if (fstat(dir_fd, &opened_derived) != 0 ||
        opened_derived.st_dev != derived_before.st_dev ||
        opened_derived.st_ino != derived_before.st_ino ||
        validate_no_extended_acl(dir_fd) != 0) {
      close(dir_fd);
      throw_code(env, "DERIVED_INVENTORY_UNSAFE",
                 "Derived directory identity is unsafe.");
      return NULL;
    }
    DIR *directory = fdopendir(dir_fd);
    if (directory == NULL) {
      close(dir_fd);
      throw_errno(env, "open derived inventory stream");
      return NULL;
    }
    errno = 0;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
      if (strcmp(entry->d_name, ".") != 0 &&
          strcmp(entry->d_name, "..") != 0) {
        derived_empty = 0;
        break;
      }
    }
    int read_error = errno;
    int valid = fstatat(gate->root_fd, "derived", &derived_after,
                        AT_SYMLINK_NOFOLLOW) == 0 &&
                derived_before.st_dev == derived_after.st_dev &&
                derived_before.st_ino == derived_after.st_ino &&
                derived_before.st_mtimespec.tv_sec ==
                    derived_after.st_mtimespec.tv_sec &&
                derived_before.st_mtimespec.tv_nsec ==
                    derived_after.st_mtimespec.tv_nsec &&
                derived_before.st_ctimespec.tv_sec ==
                    derived_after.st_ctimespec.tv_sec &&
                derived_before.st_ctimespec.tv_nsec ==
                    derived_after.st_ctimespec.tv_nsec;
    closedir(directory);
    if (read_error != 0 || !valid) {
      throw_code(env, "DERIVED_INVENTORY_UNSAFE",
                 "Derived inventory changed during scan.");
      return NULL;
    }
  } else if (errno != ENOENT) {
    throw_errno(env, "inspect derived inventory");
    return NULL;
  }
  struct statfs disk;
  if (fstatfs(gate->root_fd, &disk) != 0 || disk.f_bsize <= 0 ||
      disk.f_blocks < 0 || disk.f_bavail < 0) {
    throw_errno(env, "read capacity snapshot");
    return NULL;
  }
  __uint128_t total = (__uint128_t)disk.f_blocks * (unsigned)disk.f_bsize;
  __uint128_t available = (__uint128_t)disk.f_bavail * (unsigned)disk.f_bsize;
  if (total > UINT64_MAX || available > UINT64_MAX) {
    throw_code(env, "CAPACITY_OVERFLOW", "Capacity snapshot overflow.");
    return NULL;
  }
  char total_text[32], available_text[32];
  snprintf(total_text, sizeof(total_text), "%llu", (unsigned long long)total);
  snprintf(available_text, sizeof(available_text), "%llu",
           (unsigned long long)available);
  napi_value object, total_value, available_value, complete_value;
  napi_create_object(env, &object);
  napi_create_string_utf8(env, total_text, NAPI_AUTO_LENGTH, &total_value);
  napi_create_string_utf8(env, available_text, NAPI_AUTO_LENGTH,
                          &available_value);
  napi_set_named_property(env, object, "totalBytes", total_value);
  napi_set_named_property(env, object, "availableBytes", available_value);
  napi_get_boolean(env, derived_empty, &complete_value);
  napi_set_named_property(env, object, "derivedInventoryComplete",
                          complete_value);
  return object;
}

static napi_value close_capacity_gate(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  capacity_gate_t *gate = get_capacity_gate(env, arg);
  if (gate == NULL) return NULL;
  if (gate->locked) {
    throw_code(env, "CAPACITY_LOCK_HELD", "Cannot close a held capacity gate.");
    return NULL;
  }
  close(gate->lock_fd); close(gate->root_fd);
  gate->lock_fd = gate->root_fd = -1;
  return undefined_value(env);
}

static int probe_writable_root(int root_fd) {
  unsigned char random_bytes[8];
  arc4random_buf(random_bytes, sizeof(random_bytes));
  char name[64];
  strcpy(name, ".capability-");
  for (size_t i = 0; i < sizeof(random_bytes); i += 1) {
    (void)snprintf(name + 12 + i * 2, 3, "%02x", random_bytes[i]);
  }
  int fd = openat(root_fd, name,
                  O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return -1;
  int failure = 0;
  if (fsync(fd) != 0) failure = errno;
  if (close(fd) != 0 && failure == 0) failure = errno;
  if (unlinkat(root_fd, name, 0) != 0 && failure == 0) failure = errno;
  if (sync_directory_fd(root_fd) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    errno = failure;
    return -1;
  }
  return 0;
}

static void finalize_root(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  storage_root_t *root = (storage_root_t *)data;
  if (root == NULL) return;
  if (root->lock_fd >= 0) close(root->lock_fd);
  if (root->root_fd >= 0) close(root->root_fd);
  free(root);
}

static napi_value open_root(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 2) {
    throw_code(env, "STORAGE_INVALID_ARGUMENT", "openRoot requires two arguments.");
    return NULL;
  }
  char path[PATH_MAX];
  bool initialize = false;
  if (get_string(env, args[0], path, sizeof(path)) != 0 ||
      napi_get_value_bool(env, args[1], &initialize) != napi_ok) {
    return NULL;
  }
  int root_fd = open_absolute_directory(path, initialize ? 1 : 0);
  if (root_fd < 0) {
    throw_errno(env, "open media root");
    return NULL;
  }
  struct stat status;
  if (validate_directory_fd(root_fd, &status) != 0 ||
      status.st_uid != geteuid() || (status.st_mode & 077) != 0) {
    int saved = errno == 0 ? EPERM : errno;
    close(root_fd);
    errno = saved;
    throw_errno(env, "validate media root");
    return NULL;
  }

  int lock_fd = openat(root_fd, ".writer.lock",
                       O_RDWR | O_CREAT | O_NOFOLLOW |
                           O_CLOEXEC,
                       0600);
  if (lock_fd < 0 || flock(lock_fd, LOCK_EX | LOCK_NB) != 0) {
    int saved = errno;
    if (lock_fd >= 0) close(lock_fd);
    close(root_fd);
    errno = saved;
    throw_errno(env, "acquire storage writer lock");
    return NULL;
  }
  struct stat lock_status;
  if (fstat(lock_fd, &lock_status) != 0 || !S_ISREG(lock_status.st_mode) ||
      lock_status.st_uid != geteuid() || lock_status.st_nlink != 1 ||
      (lock_status.st_mode & 077) != 0 || validate_no_extended_acl(lock_fd) != 0) {
    int saved = errno == 0 ? EPERM : errno;
    close(lock_fd);
    close(root_fd);
    errno = saved;
    throw_errno(env, "validate writer lock");
    return NULL;
  }

  char marker[33];
  if (read_marker(root_fd, marker, sizeof(marker), initialize ? 1 : 0) != 0) {
    int saved = errno;
    close(lock_fd);
    close(root_fd);
    errno = saved;
    throw_errno(env, "validate storage marker");
    return NULL;
  }
  const char *layouts[] = {"originals", "uploads", "temp"};
  for (size_t i = 0; i < sizeof(layouts) / sizeof(layouts[0]); i += 1) {
    int fd = secure_open_child_directory(root_fd, layouts[i],
                                         initialize ? 1 : 0, 1);
    int failure = fd < 0 ? errno : 0;
    if (failure == 0 && sync_directory_fd(fd) != 0) failure = errno;
    if (fd >= 0 && close(fd) != 0 && failure == 0) failure = errno;
    if (failure != 0) {
      close(lock_fd);
      close(root_fd);
      errno = failure;
      throw_errno(env, "validate storage layout");
      return NULL;
    }
  }
  if (probe_writable_root(root_fd) != 0) {
    int saved = errno;
    close(lock_fd);
    close(root_fd);
    errno = saved;
    throw_errno(env, "probe writable storage root");
    return NULL;
  }

  storage_root_t *root = calloc(1, sizeof(*root));
  if (root == NULL) {
    close(lock_fd);
    close(root_fd);
    throw_code(env, "STORAGE_NATIVE_ERROR", "Allocation failed.");
    return NULL;
  }
  root->root_fd = root_fd;
  root->lock_fd = lock_fd;
  root->device = status.st_dev;
  root->inode = status.st_ino;
  if (fcntl(root_fd, F_GETPATH, root->canonical_path) != 0) {
    finalize_root(env, root, NULL);
    throw_errno(env, "resolve media root");
    return NULL;
  }

  napi_value external;
  napi_value object;
  napi_value canonical;
  napi_value marker_value;
  napi_value device;
  napi_create_external(env, root, finalize_root, NULL, &external);
  napi_create_object(env, &object);
  napi_create_string_utf8(env, root->canonical_path, NAPI_AUTO_LENGTH, &canonical);
  napi_create_string_utf8(env, marker, NAPI_AUTO_LENGTH, &marker_value);
  char device_string[32];
  (void)snprintf(device_string, sizeof(device_string), "%llu",
                 (unsigned long long)root->device);
  napi_create_string_utf8(env, device_string, NAPI_AUTO_LENGTH, &device);
  napi_set_named_property(env, object, "handle", external);
  napi_set_named_property(env, object, "canonicalPath", canonical);
  napi_set_named_property(env, object, "markerId", marker_value);
  napi_set_named_property(env, object, "device", device);
  return object;
}

static napi_value close_root(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  storage_root_t *root = get_root(env, arg);
  if (root == NULL) return NULL;
  int failure = 0;
  if (root->lock_fd >= 0 && close(root->lock_fd) != 0) failure = errno;
  root->lock_fd = -1;
  if (close(root->root_fd) != 0 && failure == 0) failure = errno;
  root->root_fd = -1;
  if (failure != 0) {
    errno = failure;
    throw_errno(env, "close storage root");
    return NULL;
  }
  return undefined_value(env);
}

static napi_value ensure_directory(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  storage_root_t *root = get_root(env, args[0]);
  char relative[PATH_MAX];
  if (root == NULL || get_string(env, args[1], relative, sizeof(relative)) != 0)
    return NULL;
  int fd = open_relative_directory(root, relative, 1);
  int failure = fd < 0 ? errno : 0;
  if (failure == 0 && sync_directory_fd(fd) != 0) failure = errno;
  if (fd >= 0 && close(fd) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    errno = failure;
    throw_errno(env, "ensure directory");
    return NULL;
  }
  return undefined_value(env);
}

static napi_value create_exclusive(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  storage_root_t *root = get_root(env, args[0]);
  char relative[PATH_MAX];
  void *data = NULL;
  size_t length = 0;
  if (root == NULL || get_string(env, args[1], relative, sizeof(relative)) != 0 ||
      napi_get_buffer_info(env, args[2], &data, &length) != napi_ok) {
    return NULL;
  }
  char parent[PATH_MAX];
  char base[NAME_MAX + 1];
  if (split_parent(relative, parent, sizeof(parent), base, sizeof(base)) != 0) {
    throw_errno(env, "validate create path");
    return NULL;
  }
  int parent_fd = open_relative_directory(root, parent, 1);
  if (parent_fd < 0) {
    throw_errno(env, "open create parent");
    return NULL;
  }
  int file_fd = openat(parent_fd, base,
                       O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW |
                           O_CLOEXEC,
                       0600);
  if (file_fd < 0) {
    int saved = errno;
    close(parent_fd);
    errno = saved;
    throw_errno(env, "exclusive create");
    return NULL;
  }
  int failure = 0;
  if (write_all(file_fd, (const unsigned char *)data, length) != 0 ||
      fsync(file_fd) != 0)
    failure = errno;
  if (close(file_fd) != 0 && failure == 0) failure = errno;
  if (failure == 0 && sync_directory_fd(parent_fd) != 0) failure = errno;
  if (close(parent_fd) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    errno = failure;
    throw_errno(env, "durable exclusive create");
    return NULL;
  }
  return undefined_value(env);
}

static napi_value race_exclusive_create(napi_env env,
                                        napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  storage_root_t *root = get_root(env, args[0]);
  char relative[PATH_MAX];
  void *first_data = NULL;
  void *second_data = NULL;
  size_t first_length = 0;
  size_t second_length = 0;
  if (root == NULL || get_string(env, args[1], relative, sizeof(relative)) != 0 ||
      napi_get_buffer_info(env, args[2], &first_data, &first_length) != napi_ok ||
      napi_get_buffer_info(env, args[3], &second_data, &second_length) != napi_ok)
    return NULL;
  char parent[PATH_MAX];
  char base[NAME_MAX + 1];
  if (split_parent(relative, parent, sizeof(parent), base, sizeof(base)) != 0) {
    throw_errno(env, "validate create race path");
    return NULL;
  }
  int parent_fd = open_relative_directory(root, parent, 1);
  if (parent_fd < 0) {
    throw_errno(env, "open create race parent");
    return NULL;
  }
  race_gate_t gate;
  pthread_t first_thread;
  pthread_t second_thread;
  create_race_t races[2] = {
      {&gate, parent_fd, base, first_data, first_length, -1, 0},
      {&gate, parent_fd, base, second_data, second_length, -1, 0},
  };
  if (start_race(&gate) != 0) {
    close(parent_fd);
    throw_code(env, "STORAGE_NATIVE_ERROR", "Create race setup failed.");
    return NULL;
  }
  int first_created =
      pthread_create(&first_thread, NULL, exclusive_create_worker, &races[0]) ==
      0;
  int second_created =
      pthread_create(&second_thread, NULL, exclusive_create_worker, &races[1]) ==
      0;
  if (!first_created || !second_created) {
    cancel_race(&gate);
    if (first_created) pthread_join(first_thread, NULL);
    if (second_created) pthread_join(second_thread, NULL);
    finish_race(&gate);
    close(parent_fd);
    throw_code(env, "STORAGE_NATIVE_ERROR", "Create race setup failed.");
    return NULL;
  }
  release_race(&gate);
  pthread_join(first_thread, NULL);
  pthread_join(second_thread, NULL);
  finish_race(&gate);
  int successes = 0;
  int already_exists = 0;
  for (size_t i = 0; i < 2; i += 1) {
    if (races[i].result == 0)
      successes += 1;
    else if (races[i].error == EEXIST)
      already_exists += 1;
  }
  int failure = 0;
  if (successes == 1 && already_exists == 1 &&
      sync_directory_fd(parent_fd) != 0)
    failure = errno;
  if (close(parent_fd) != 0 && failure == 0) failure = errno;
  if (failure != 0 || successes != 1 || already_exists != 1) {
    errno = failure == 0 ? EIO : failure;
    throw_errno(env, "concurrent exclusive create");
    return NULL;
  }
  return race_result(env, successes, already_exists);
}

static napi_value publish_original(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  storage_root_t *root = get_root(env, args[0]);
  char source[PATH_MAX];
  char destination[PATH_MAX];
  if (root == NULL || get_string(env, args[1], source, sizeof(source)) != 0 ||
      get_string(env, args[2], destination, sizeof(destination)) != 0)
    return NULL;
  char source_parent[PATH_MAX], destination_parent[PATH_MAX];
  char source_base[NAME_MAX + 1], destination_base[NAME_MAX + 1];
  if (split_parent(source, source_parent, sizeof(source_parent), source_base,
                   sizeof(source_base)) != 0 ||
      split_parent(destination, destination_parent, sizeof(destination_parent),
                   destination_base, sizeof(destination_base)) != 0) {
    throw_errno(env, "validate publish path");
    return NULL;
  }
  int source_parent_fd = open_relative_directory(root, source_parent, 0);
  int destination_parent_fd = open_relative_directory(root, destination_parent, 1);
  if (source_parent_fd < 0 || destination_parent_fd < 0) {
    int saved = errno;
    if (source_parent_fd >= 0) close(source_parent_fd);
    if (destination_parent_fd >= 0) close(destination_parent_fd);
    errno = saved;
    throw_errno(env, "open publish parent");
    return NULL;
  }
  struct stat source_status;
  int source_fd = openat(source_parent_fd, source_base,
                         O_RDONLY | O_NOFOLLOW |
                             O_UNIQUE | O_CLOEXEC);
  if (source_fd < 0 || fstat(source_fd, &source_status) != 0 ||
      !S_ISREG(source_status.st_mode) || source_status.st_uid != geteuid() ||
      source_status.st_nlink != 1 || source_status.st_dev != root->device ||
      validate_no_extended_acl(source_fd) != 0) {
    int saved = errno == 0 ? EPERM : errno;
    if (source_fd >= 0) close(source_fd);
    close(source_parent_fd);
    close(destination_parent_fd);
    errno = saved;
    throw_errno(env, "validate publish source");
    return NULL;
  }
  if (fchmod(source_fd, 0400) != 0 || fsync(source_fd) != 0) {
    int saved = errno;
    close(source_fd);
    close(source_parent_fd);
    close(destination_parent_fd);
    errno = saved;
    throw_errno(env, "sync publish source");
    return NULL;
  }
  struct stat named_source_status;
  if (fstatat(source_parent_fd, source_base, &named_source_status,
              AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(named_source_status.st_mode) ||
      named_source_status.st_dev != source_status.st_dev ||
      named_source_status.st_ino != source_status.st_ino ||
      named_source_status.st_nlink != 1) {
    int saved = errno == 0 ? EPERM : errno;
    close(source_fd);
    close(source_parent_fd);
    close(destination_parent_fd);
    errno = saved;
    throw_errno(env, "revalidate publish source");
    return NULL;
  }
  if (renameatx_np(source_parent_fd, source_base, destination_parent_fd,
                   destination_base,
                   RENAME_EXCL | RENAME_NOFOLLOW_ANY |
                       RENAME_RESOLVE_BENEATH) != 0) {
    int saved = errno;
    close(source_fd);
    close(source_parent_fd);
    close(destination_parent_fd);
    errno = saved;
    throw_errno(env, "exclusive publish");
    return NULL;
  }

  int final_fd = openat(destination_parent_fd, destination_base,
                        O_RDONLY | O_NOFOLLOW |
                            O_UNIQUE | O_CLOEXEC);
  struct stat final_status;
  int failure = 0;
  if (final_fd < 0 || fstat(final_fd, &final_status) != 0 ||
      final_status.st_dev != source_status.st_dev ||
      final_status.st_ino != source_status.st_ino ||
      final_status.st_size != source_status.st_size ||
      validate_no_extended_acl(final_fd) != 0)
    failure = errno == 0 ? EIO : errno;
  if (failure == 0 && sync_directory_fd(source_parent_fd) != 0) failure = errno;
  if (failure == 0 && sync_directory_fd(destination_parent_fd) != 0)
    failure = errno;
  if (failure == 0 && full_sync_file_fd(final_fd) != 0) failure = errno;
  if (source_fd >= 0 && close(source_fd) != 0 && failure == 0) failure = errno;
  if (final_fd >= 0 && close(final_fd) != 0 && failure == 0) failure = errno;
  if (close(source_parent_fd) != 0 && failure == 0) failure = errno;
  if (close(destination_parent_fd) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    errno = failure;
    throw_errno(env, "durable publish");
    return NULL;
  }

  napi_value result;
  napi_value size;
  napi_value synced;
  napi_create_object(env, &result);
  napi_create_int64(env, (int64_t)final_status.st_size, &size);
  napi_get_boolean(env, true, &synced);
  napi_set_named_property(env, result, "byteSize", size);
  napi_set_named_property(env, result, "fileSynced", synced);
  napi_set_named_property(env, result, "sourceDirectorySynced", synced);
  napi_set_named_property(env, result, "destinationDirectorySynced", synced);
  napi_set_named_property(env, result, "fullSynced", synced);
  return result;
}

static napi_value race_exclusive_publish(napi_env env,
                                         napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  storage_root_t *root = get_root(env, args[0]);
  char first_source[PATH_MAX];
  char second_source[PATH_MAX];
  char destination[PATH_MAX];
  if (root == NULL ||
      get_string(env, args[1], first_source, sizeof(first_source)) != 0 ||
      get_string(env, args[2], second_source, sizeof(second_source)) != 0 ||
      get_string(env, args[3], destination, sizeof(destination)) != 0)
    return NULL;

  char first_parent[PATH_MAX], second_parent[PATH_MAX], destination_parent[PATH_MAX];
  char first_base[NAME_MAX + 1], second_base[NAME_MAX + 1];
  char destination_base[NAME_MAX + 1];
  if (split_parent(first_source, first_parent, sizeof(first_parent), first_base,
                   sizeof(first_base)) != 0 ||
      split_parent(second_source, second_parent, sizeof(second_parent),
                   second_base, sizeof(second_base)) != 0 ||
      split_parent(destination, destination_parent, sizeof(destination_parent),
                   destination_base, sizeof(destination_base)) != 0) {
    throw_errno(env, "validate publish race path");
    return NULL;
  }
  int first_parent_fd = open_relative_directory(root, first_parent, 0);
  int second_parent_fd = open_relative_directory(root, second_parent, 0);
  int destination_parent_fd =
      open_relative_directory(root, destination_parent, 1);
  if (first_parent_fd < 0 || second_parent_fd < 0 ||
      destination_parent_fd < 0) {
    int saved = errno;
    if (first_parent_fd >= 0) close(first_parent_fd);
    if (second_parent_fd >= 0) close(second_parent_fd);
    if (destination_parent_fd >= 0) close(destination_parent_fd);
    errno = saved;
    throw_errno(env, "open publish race parent");
    return NULL;
  }
  race_gate_t gate;
  pthread_t first_thread;
  pthread_t second_thread;
  publish_race_t races[2] = {
      {&gate, first_parent_fd, destination_parent_fd, first_base,
       destination_base, -1, 0},
      {&gate, second_parent_fd, destination_parent_fd, second_base,
       destination_base, -1, 0},
  };
  if (start_race(&gate) != 0) {
    close(first_parent_fd);
    close(second_parent_fd);
    close(destination_parent_fd);
    throw_code(env, "STORAGE_NATIVE_ERROR", "Publish race setup failed.");
    return NULL;
  }
  int first_created = pthread_create(&first_thread, NULL,
                                     exclusive_publish_worker, &races[0]) == 0;
  int second_created = pthread_create(&second_thread, NULL,
                                      exclusive_publish_worker, &races[1]) == 0;
  if (!first_created || !second_created) {
    cancel_race(&gate);
    if (first_created) pthread_join(first_thread, NULL);
    if (second_created) pthread_join(second_thread, NULL);
    finish_race(&gate);
    close(first_parent_fd);
    close(second_parent_fd);
    close(destination_parent_fd);
    throw_code(env, "STORAGE_NATIVE_ERROR", "Publish race setup failed.");
    return NULL;
  }
  release_race(&gate);
  pthread_join(first_thread, NULL);
  pthread_join(second_thread, NULL);
  finish_race(&gate);
  int successes = 0;
  int already_exists = 0;
  for (size_t i = 0; i < 2; i += 1) {
    if (races[i].result == 0)
      successes += 1;
    else if (races[i].error == EEXIST)
      already_exists += 1;
  }
  int final_fd = openat(destination_parent_fd, destination_base,
                        O_RDONLY | O_NOFOLLOW | O_UNIQUE | O_CLOEXEC);
  int failure = 0;
  if (successes != 1 || already_exists != 1 || final_fd < 0)
    failure = errno == 0 ? EIO : errno;
  if (failure == 0 && sync_directory_fd(first_parent_fd) != 0) failure = errno;
  if (failure == 0 && sync_directory_fd(second_parent_fd) != 0) failure = errno;
  if (failure == 0 && sync_directory_fd(destination_parent_fd) != 0)
    failure = errno;
  if (failure == 0 && full_sync_file_fd(final_fd) != 0) failure = errno;
  if (final_fd >= 0 && close(final_fd) != 0 && failure == 0) failure = errno;
  if (close(first_parent_fd) != 0 && failure == 0) failure = errno;
  if (close(second_parent_fd) != 0 && failure == 0) failure = errno;
  if (close(destination_parent_fd) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    errno = failure;
    throw_errno(env, "concurrent exclusive publish");
    return NULL;
  }
  return race_result(env, successes, already_exists);
}

static napi_value file_size(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  storage_root_t *root = get_root(env, args[0]);
  char relative[PATH_MAX];
  if (root == NULL || get_string(env, args[1], relative, sizeof(relative)) != 0)
    return NULL;
  char parent[PATH_MAX], base[NAME_MAX + 1];
  if (split_parent(relative, parent, sizeof(parent), base, sizeof(base)) != 0) {
    throw_errno(env, "validate stat path");
    return NULL;
  }
  int parent_fd = open_relative_directory(root, parent, 0);
  struct stat status;
  int file_fd = parent_fd < 0
                    ? -1
                    : open_validated_regular(root, parent_fd, base, O_RDONLY,
                                             &status);
  int failure = file_fd < 0 ? errno : 0;
  if (file_fd >= 0 && close(file_fd) != 0 && failure == 0) failure = errno;
  if (parent_fd >= 0 && close(parent_fd) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    errno = failure;
    throw_errno(env, "stat controlled file");
    return NULL;
  }
  char size[32];
  (void)snprintf(size, sizeof(size), "%llu",
                 (unsigned long long)status.st_size);
  napi_value result;
  napi_create_string_utf8(env, size, NAPI_AUTO_LENGTH, &result);
  return result;
}

/* Hash an already-open, validated regular file. The descriptor and its named
   inode must remain unchanged across the entire sequential read. For a final
   original, repeat the directory/file durability barrier before DB adoption. */
static napi_value verify_controlled_file(napi_env env,
                                         napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  storage_root_t *root = get_root(env, args[0]);
  char relative[PATH_MAX], mode_text[16];
  if (root == NULL ||
      get_string(env, args[1], relative, sizeof(relative)) != 0 ||
      get_string(env, args[2], mode_text, sizeof(mode_text)) != 0)
    return NULL;
  int final = strcmp(mode_text, "original") == 0;
  int prepared = strcmp(mode_text, "prepared") == 0;
  int finalizing = strcmp(mode_text, "finalizing") == 0;
  if (!final && !prepared && !finalizing && strcmp(mode_text, "staging") != 0) {
    throw_code(env, "STORAGE_INVALID_ARGUMENT", "Invalid file mode.");
    return NULL;
  }
  char parent[PATH_MAX], base[NAME_MAX + 1];
  if (split_parent(relative, parent, sizeof(parent), base,
                   sizeof(base)) != 0) {
    throw_errno(env, "validate verify path");
    return NULL;
  }
  int parent_fd = open_relative_directory(root, parent, 0);
  struct stat before, after, named;
  int file_fd = parent_fd < 0
                    ? -1
                    : open_validated_readonly(root, parent_fd, base,
                                              finalizing ? 0 :
                                                (final || prepared ? 0400 : 0600),
                                              &before);
  int failure = file_fd < 0 ? errno : 0;
  CC_SHA256_CTX context;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (failure == 0 && (before.st_size <= 0 ||
                       CC_SHA256_Init(&context) != 1))
    failure = EINVAL;
  unsigned char buffer[64 * 1024];
  off_t offset = 0;
  struct timespec started;
  if (failure == 0 && clock_gettime(CLOCK_MONOTONIC, &started) != 0)
    failure = errno;
  while (failure == 0 && offset < before.st_size) {
    struct timespec current;
    if (clock_gettime(CLOCK_MONOTONIC, &current) != 0) {
      failure = errno;
      break;
    }
    if (current.tv_sec - started.tv_sec >= 15 * 60) {
      failure = ETIMEDOUT;
      break;
    }
    size_t wanted = sizeof(buffer);
    off_t remaining = before.st_size - offset;
    if (remaining < (off_t)wanted) wanted = (size_t)remaining;
    ssize_t received = pread(file_fd, buffer, wanted, offset);
    if (received < 0) {
      if (errno == EINTR) continue;
      failure = errno;
      break;
    }
    if (received == 0 ||
        CC_SHA256_Update(&context, buffer, (CC_LONG)received) != 1) {
      failure = EIO;
      break;
    }
    offset += received;
  }
  if (failure == 0 && CC_SHA256_Final(digest, &context) != 1)
    failure = EIO;
  if (failure == 0 &&
      (fstat(file_fd, &after) != 0 ||
       fstatat(parent_fd, base, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
       !S_ISREG(named.st_mode) || after.st_dev != before.st_dev ||
       after.st_ino != before.st_ino || after.st_size != before.st_size ||
       named.st_dev != before.st_dev || named.st_ino != before.st_ino ||
       named.st_size != before.st_size || named.st_nlink != 1 ||
       (named.st_mode & 0777) != (before.st_mode & 0777) ||
       (!finalizing && (named.st_mode & 0777) !=
          (final || prepared ? 0400 : 0600)) ||
       (finalizing && (named.st_mode & 0777) != 0400 &&
        (named.st_mode & 0777) != 0600)))
    failure = errno == 0 ? EIO : errno;
  if (failure == 0 && final && sync_directory_fd(parent_fd) != 0)
    failure = errno;
  if (failure == 0 && final && full_sync_file_fd(file_fd) != 0)
    failure = errno;
  if (file_fd >= 0 && close(file_fd) != 0 && failure == 0)
    failure = errno;
  if (parent_fd >= 0 && close(parent_fd) != 0 && failure == 0)
    failure = errno;
  if (failure != 0) {
    errno = failure;
    throw_errno(env, "verify controlled file");
    return NULL;
  }
  char size[32];
  (void)snprintf(size, sizeof(size), "%llu",
                 (unsigned long long)before.st_size);
  napi_value result, hash_value, size_value;
  napi_create_object(env, &result);
  napi_create_buffer_copy(env, sizeof(digest), digest, NULL, &hash_value);
  napi_create_string_utf8(env, size, NAPI_AUTO_LENGTH, &size_value);
  napi_set_named_property(env, result, "sha256", hash_value);
  napi_set_named_property(env, result, "byteSize", size_value);
  return result;
}

static napi_value append_file_from_file(napi_env env,
                                        napi_callback_info info) {
  size_t argc = 5;
  napi_value args[5];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  storage_root_t *root = get_root(env, args[0]);
  char destination[PATH_MAX], source[PATH_MAX], expected_text[32], maximum_text[32];
  if (root == NULL ||
      get_string(env, args[1], destination, sizeof(destination)) != 0 ||
      get_string(env, args[2], source, sizeof(source)) != 0 ||
      get_string(env, args[3], expected_text, sizeof(expected_text)) != 0 ||
      get_string(env, args[4], maximum_text, sizeof(maximum_text)) != 0)
    return NULL;
  off_t expected, maximum;
  if (parse_offset(expected_text, &expected) != 0 ||
      parse_offset(maximum_text, &maximum) != 0 || expected > maximum) {
    throw_errno(env, "validate append offset");
    return NULL;
  }
  char destination_parent[PATH_MAX], source_parent[PATH_MAX];
  char destination_base[NAME_MAX + 1], source_base[NAME_MAX + 1];
  if (split_parent(destination, destination_parent, sizeof(destination_parent),
                   destination_base, sizeof(destination_base)) != 0 ||
      split_parent(source, source_parent, sizeof(source_parent), source_base,
                   sizeof(source_base)) != 0) {
    throw_errno(env, "validate append paths");
    return NULL;
  }
  int destination_parent_fd =
      open_relative_directory(root, destination_parent, 0);
  int source_parent_fd = open_relative_directory(root, source_parent, 0);
  struct stat destination_status, source_status;
  int destination_fd = destination_parent_fd < 0
                           ? -1
                           : open_validated_regular(root, destination_parent_fd,
                                                    destination_base, O_RDWR,
                                                    &destination_status);
  int source_fd = source_parent_fd < 0
                      ? -1
                      : open_validated_regular(root, source_parent_fd,
                                               source_base, O_RDONLY,
                                               &source_status);
  int failure = destination_fd < 0 || source_fd < 0 ? errno : 0;
  if (failure == 0 &&
      (destination_status.st_size != expected || source_status.st_size < 0 ||
       source_status.st_size > maximum - expected))
    failure = EFBIG;

  unsigned char buffer[64 * 1024];
  off_t source_offset = 0;
  while (failure == 0 && source_offset < source_status.st_size) {
    size_t wanted = sizeof(buffer);
    off_t remaining = source_status.st_size - source_offset;
    if (remaining < (off_t)wanted) wanted = (size_t)remaining;
    ssize_t received = pread(source_fd, buffer, wanted, source_offset);
    if (received < 0) {
      if (errno == EINTR) continue;
      failure = errno;
      break;
    }
    if (received == 0) {
      failure = EIO;
      break;
    }
    if (pwrite_all(destination_fd, buffer, (size_t)received,
                   expected + source_offset) != 0) {
      failure = errno;
      break;
    }
    source_offset += received;
  }
  if (failure == 0 && fsync(destination_fd) != 0) failure = errno;
  if (source_fd >= 0 && close(source_fd) != 0 && failure == 0) failure = errno;
  if (destination_fd >= 0 && close(destination_fd) != 0 && failure == 0)
    failure = errno;
  if (source_parent_fd >= 0 && close(source_parent_fd) != 0 && failure == 0)
    failure = errno;
  if (destination_parent_fd >= 0 && close(destination_parent_fd) != 0 &&
      failure == 0)
    failure = errno;
  if (failure != 0) {
    errno = failure;
    throw_errno(env, "durable positioned append");
    return NULL;
  }
  char size[32];
  (void)snprintf(size, sizeof(size), "%llu",
                 (unsigned long long)source_status.st_size);
  napi_value result;
  napi_create_string_utf8(env, size, NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value truncate_file(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  storage_root_t *root = get_root(env, args[0]);
  char relative[PATH_MAX], length_text[32];
  if (root == NULL || get_string(env, args[1], relative, sizeof(relative)) != 0 ||
      get_string(env, args[2], length_text, sizeof(length_text)) != 0)
    return NULL;
  off_t length;
  if (parse_offset(length_text, &length) != 0) {
    throw_errno(env, "validate truncate length");
    return NULL;
  }
  char parent[PATH_MAX], base[NAME_MAX + 1];
  if (split_parent(relative, parent, sizeof(parent), base, sizeof(base)) != 0) {
    throw_errno(env, "validate truncate path");
    return NULL;
  }
  int parent_fd = open_relative_directory(root, parent, 0);
  struct stat status;
  int file_fd = parent_fd < 0
                    ? -1
                    : open_validated_regular(root, parent_fd, base, O_RDWR,
                                             &status);
  int failure = file_fd < 0 ? errno : 0;
  if (failure == 0 && status.st_size < length) failure = EINVAL;
  if (failure == 0 && ftruncate(file_fd, length) != 0) failure = errno;
  if (failure == 0 && fsync(file_fd) != 0) failure = errno;
  if (file_fd >= 0 && close(file_fd) != 0 && failure == 0) failure = errno;
  if (parent_fd >= 0 && close(parent_fd) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    errno = failure;
    throw_errno(env, "durable truncate");
    return NULL;
  }
  return undefined_value(env);
}

static napi_value remove_file(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 3) {
    throw_code(env, "STORAGE_INVALID_ARGUMENT", "removeFile requires three arguments.");
    return NULL;
  }
  storage_root_t *root = get_root(env, args[0]);
  char relative[PATH_MAX];
  bool allow_prepared = false;
  if (root == NULL || get_string(env, args[1], relative, sizeof(relative)) != 0 ||
      napi_get_value_bool(env, args[2], &allow_prepared) != napi_ok)
    return NULL;
  char parent[PATH_MAX], base[NAME_MAX + 1];
  if (split_parent(relative, parent, sizeof(parent), base, sizeof(base)) != 0) {
    throw_errno(env, "validate remove path");
    return NULL;
  }
  int parent_fd = open_relative_directory(root, parent, 0);
  struct stat status;
  int file_fd = parent_fd < 0 ? -1 :
    allow_prepared ? open_validated_readonly(root, parent_fd, base, 0, &status) :
                     open_validated_regular(root, parent_fd, base, O_RDONLY,
                                            &status);
  int failure = file_fd < 0 ? errno : 0;
  struct stat current;
  if (failure == 0 &&
      (fstatat(parent_fd, base, &current, AT_SYMLINK_NOFOLLOW) != 0 ||
       !S_ISREG(current.st_mode) || current.st_dev != status.st_dev ||
       current.st_ino != status.st_ino || current.st_nlink != 1))
    failure = errno == 0 ? EPERM : errno;
  if (failure == 0 && unlinkat(parent_fd, base, 0) != 0) failure = errno;
  if (failure == 0 && sync_directory_fd(parent_fd) != 0) failure = errno;
  if (file_fd >= 0 && close(file_fd) != 0 && failure == 0) failure = errno;
  if (parent_fd >= 0 && close(parent_fd) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    errno = failure;
    throw_errno(env, "durable remove");
    return NULL;
  }
  return undefined_value(env);
}

static napi_value verify_root_identity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  storage_root_t *root = get_root(env, arg);
  if (root == NULL) return NULL;
  int current_fd = open_absolute_directory(root->canonical_path, 0);
  struct stat current, locked, on_disk_lock;
  char marker[33];
  int failure = current_fd < 0 ? errno : 0;
  if (failure == 0 &&
      (validate_directory_fd(current_fd, &current) != 0 ||
       current.st_dev != root->device || current.st_ino != root->inode ||
       read_marker(current_fd, marker, sizeof(marker), 0) != 0 ||
       fstat(root->lock_fd, &locked) != 0 ||
       fstatat(current_fd, ".writer.lock", &on_disk_lock,
               AT_SYMLINK_NOFOLLOW) != 0 ||
       !S_ISREG(on_disk_lock.st_mode) || locked.st_dev != on_disk_lock.st_dev ||
       locked.st_ino != on_disk_lock.st_ino ||
       locked.st_uid != geteuid() || locked.st_nlink != 1 ||
       (locked.st_mode & 0777) != 0600 ||
       on_disk_lock.st_nlink != 1 ||
       (on_disk_lock.st_mode & 0777) != 0600))
    failure = errno == 0 ? EPERM : errno;
  if (current_fd >= 0 && close(current_fd) != 0 && failure == 0)
    failure = errno;
  if (failure != 0) {
    errno = failure;
    throw_errno(env, "verify media root identity");
    return NULL;
  }
  napi_value result;
  napi_create_string_utf8(env, marker, NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value list_directory(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  storage_root_t *root = get_root(env, args[0]);
  char relative[PATH_MAX];
  uint32_t limit = 0;
  if (root == NULL || get_string(env, args[1], relative, sizeof(relative)) != 0 ||
      napi_get_value_uint32(env, args[2], &limit) != napi_ok || limit == 0 ||
      limit > 4096) {
    throw_code(env, "STORAGE_INVALID_ARGUMENT", "Invalid scan limit.");
    return NULL;
  }
  int fd = open_relative_directory(root, relative, 0);
  if (fd < 0) {
    throw_errno(env, "open scan directory");
    return NULL;
  }
  DIR *directory = fdopendir(fd);
  if (directory == NULL) {
    int saved = errno;
    close(fd);
    errno = saved;
    throw_errno(env, "scan directory");
    return NULL;
  }
  napi_value result;
  napi_create_array(env, &result);
  uint32_t count = 0;
  int failure = 0;
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
      continue;
    if (count >= limit) {
      failure = EOVERFLOW;
      break;
    }
    struct stat status;
    if (fstatat(dirfd(directory), entry->d_name, &status,
                AT_SYMLINK_NOFOLLOW) != 0) {
      failure = errno;
      break;
    }
    const char *kind = S_ISDIR(status.st_mode) ? "directory" :
                       S_ISREG(status.st_mode) ? "file" :
                       S_ISLNK(status.st_mode) ? "symlink" : "special";
    napi_value item, value;
    napi_create_object(env, &item);
    napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "name", value);
    napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "kind", value);
    char number[32];
    unsigned long long milliseconds =
        (unsigned long long)status.st_mtimespec.tv_sec * 1000ULL +
        (unsigned long long)status.st_mtimespec.tv_nsec / 1000000ULL;
    (void)snprintf(number, sizeof(number), "%llu", milliseconds);
    napi_create_string_utf8(env, number, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "mtimeMs", value);
    (void)snprintf(number, sizeof(number), "%llu",
                   (unsigned long long)status.st_nlink);
    napi_create_string_utf8(env, number, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "nlink", value);
    (void)snprintf(number, sizeof(number), "%llu",
                   (unsigned long long)status.st_dev);
    napi_create_string_utf8(env, number, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "device", value);
    (void)snprintf(number, sizeof(number), "%llu",
                   (unsigned long long)status.st_uid);
    napi_create_string_utf8(env, number, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "uid", value);
    napi_create_uint32(env, (uint32_t)(status.st_mode & 0777), &value);
    napi_set_named_property(env, item, "mode", value);
    napi_set_element(env, result, count, item);
    count += 1;
    errno = 0;
  }
  if (entry == NULL && errno != 0 && failure == 0) failure = errno;
  if (closedir(directory) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    errno = failure;
    throw_errno(env, "bounded directory scan");
    return NULL;
  }
  return result;
}

// Bounded lexical selection over a fixed dirfd. Every page scans the directory
// but retains at most limit+1 names, so a large directory never materializes
// in native or JS memory. An expected directory generation rejects changes
// between pages instead of silently treating a partial scan as complete.
static napi_value list_directory_page(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value args[5];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  storage_root_t *root = get_root(env, args[0]);
  char relative[PATH_MAX], after[NAME_MAX + 1], expected[192];
  uint32_t limit = 0;
  size_t after_length = 0, expected_length = 0;
  if (argc != 5 || root == NULL ||
      get_string(env, args[1], relative, sizeof(relative)) != 0 ||
      napi_get_value_string_utf8(env, args[2], after, sizeof(after),
                                 &after_length) != napi_ok ||
      after_length >= sizeof(after) ||
      napi_get_value_uint32(env, args[3], &limit) != napi_ok ||
      limit < 1 || limit > 256 ||
      napi_get_value_string_utf8(env, args[4], expected, sizeof(expected),
                                 &expected_length) != napi_ok ||
      expected_length >= sizeof(expected)) {
    throw_code(env, "STORAGE_INVALID_ARGUMENT", "Invalid directory page arguments.");
    return NULL;
  }
  if (after_length && validate_internal_component(after) != 0) {
    throw_errno(env, "validate directory cursor");
    return NULL;
  }
  int fd = open_relative_directory(root, relative, 0);
  if (fd < 0) { throw_errno(env, "open paged directory"); return NULL; }
  struct stat before, after_scan;
  int failure = fstat(fd, &before) == 0 ? 0 : errno;
  char generation[192];
  if (failure == 0) {
    (void)snprintf(generation, sizeof(generation), "%llu:%llu:%lld:%ld:%lld:%ld",
      (unsigned long long)before.st_dev, (unsigned long long)before.st_ino,
      (long long)before.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec,
      (long long)before.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec);
    if (expected_length && strcmp(expected, generation) != 0) failure = ESTALE;
  }
  char (*names)[NAME_MAX + 1] = calloc(limit + 1, NAME_MAX + 1);
  if (names == NULL && failure == 0) failure = ENOMEM;
  DIR *directory = NULL;
  if (failure == 0) {
    directory = fdopendir(fd);
    if (directory == NULL) failure = errno;
  }
  uint32_t count = 0;
  if (failure == 0) {
    struct dirent *entry;
    errno = 0;
    while ((entry = readdir(directory)) != NULL) {
      if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
      if (validate_internal_component(entry->d_name) != 0) {
        failure = EINVAL; break;
      }
      if (strcmp(entry->d_name, after) <= 0) continue;
      uint32_t index = 0;
      while (index < count && strcmp(names[index], entry->d_name) < 0) index++;
      if (index >= limit + 1) continue;
      if (count < limit + 1) count++;
      for (uint32_t position = count - 1; position > index; position--)
        strcpy(names[position], names[position - 1]);
      strcpy(names[index], entry->d_name);
    }
    if (failure == 0 && errno != 0) failure = errno;
    if (failure == 0 && fstat(dirfd(directory), &after_scan) != 0) failure = errno;
    if (failure == 0 && (before.st_dev != after_scan.st_dev ||
        before.st_ino != after_scan.st_ino ||
        before.st_mtimespec.tv_sec != after_scan.st_mtimespec.tv_sec ||
        before.st_mtimespec.tv_nsec != after_scan.st_mtimespec.tv_nsec ||
        before.st_ctimespec.tv_sec != after_scan.st_ctimespec.tv_sec ||
        before.st_ctimespec.tv_nsec != after_scan.st_ctimespec.tv_nsec)) failure = ESTALE;
  }
  napi_value result, items, value;
  napi_create_object(env, &result);
  napi_create_array(env, &items);
  const uint32_t returned = count > limit ? limit : count;
  for (uint32_t index = 0; index < returned && failure == 0; index++) {
    struct stat status;
    if (fstatat(dirfd(directory), names[index], &status,
                AT_SYMLINK_NOFOLLOW) != 0) { failure = errno; break; }
    const char *kind = S_ISDIR(status.st_mode) ? "directory" :
                       S_ISREG(status.st_mode) ? "file" :
                       S_ISLNK(status.st_mode) ? "symlink" : "special";
    napi_value item;
    napi_create_object(env, &item);
    napi_create_string_utf8(env, names[index], NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "name", value);
    napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "kind", value);
    char number[32];
    unsigned long long milliseconds =
      (unsigned long long)status.st_mtimespec.tv_sec * 1000ULL +
      (unsigned long long)status.st_mtimespec.tv_nsec / 1000000ULL;
    (void)snprintf(number, sizeof(number), "%llu", milliseconds);
    napi_create_string_utf8(env, number, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "mtimeMs", value);
    (void)snprintf(number, sizeof(number), "%llu", (unsigned long long)status.st_nlink);
    napi_create_string_utf8(env, number, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "nlink", value);
    (void)snprintf(number, sizeof(number), "%llu", (unsigned long long)status.st_dev);
    napi_create_string_utf8(env, number, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "device", value);
    (void)snprintf(number, sizeof(number), "%llu", (unsigned long long)status.st_uid);
    napi_create_string_utf8(env, number, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "uid", value);
    napi_create_uint32(env, (uint32_t)(status.st_mode & 0777), &value);
    napi_set_named_property(env, item, "mode", value);
    napi_set_element(env, items, index, item);
  }
  if (failure == 0) {
    struct stat after_items;
    if (fstat(dirfd(directory), &after_items) != 0) failure = errno;
    else if (before.st_dev != after_items.st_dev ||
             before.st_ino != after_items.st_ino ||
             before.st_mtimespec.tv_sec != after_items.st_mtimespec.tv_sec ||
             before.st_mtimespec.tv_nsec != after_items.st_mtimespec.tv_nsec ||
             before.st_ctimespec.tv_sec != after_items.st_ctimespec.tv_sec ||
             before.st_ctimespec.tv_nsec != after_items.st_ctimespec.tv_nsec)
      failure = ESTALE;
  }
  if (directory && closedir(directory) != 0 && failure == 0) failure = errno;
  if (!directory) close(fd);
  if (failure != 0) {
    free(names); errno = failure; throw_errno(env, "paged directory scan"); return NULL;
  }
  napi_set_named_property(env, result, "entries", items);
  napi_create_string_utf8(env, generation, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "generation", value);
  napi_create_string_utf8(env, returned ? names[returned - 1] : "",
                          NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "nextCursor", value);
  napi_get_boolean(env, count > limit, &value);
  napi_set_named_property(env, result, "hasMore", value);
  free(names);
  return result;
}

static napi_value directory_device(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  storage_root_t *root = get_root(env, args[0]);
  char relative[PATH_MAX];
  if (root == NULL || get_string(env, args[1], relative, sizeof(relative)) != 0)
    return NULL;
  int fd = open_relative_directory(root, relative, 0);
  struct stat status;
  int failure = fd < 0 ? errno : 0;
  if (failure == 0 && fstat(fd, &status) != 0) failure = errno;
  if (fd >= 0 && close(fd) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    errno = failure;
    throw_errno(env, "read directory device");
    return NULL;
  }
  char device[32];
  (void)snprintf(device, sizeof(device), "%llu",
                 (unsigned long long)status.st_dev);
  napi_value value;
  napi_create_string_utf8(env, device, NAPI_AUTO_LENGTH, &value);
  return value;
}

static int validate_decimal_identifier(const char *value) {
  if (value[0] < '1' || value[0] > '9') return -1;
  for (size_t i = 1; value[i] != '\0'; i += 1)
    if (value[i] < '0' || value[i] > '9') return -1;
  return 0;
}

static int validate_sha256_hex(const char *value) {
  if (strlen(value) != 64) return -1;
  for (size_t i = 0; i < 64; i += 1)
    if (!((value[i] >= '0' && value[i] <= '9') ||
          (value[i] >= 'a' && value[i] <= 'f')))
      return -1;
  return 0;
}

static int digest_open_fd(int fd, off_t size,
                          unsigned char digest[CC_SHA256_DIGEST_LENGTH]) {
  CC_SHA256_CTX context;
  if (size <= 0 || CC_SHA256_Init(&context) != 1) {
    errno = EINVAL;
    return -1;
  }
  unsigned char buffer[64 * 1024];
  off_t offset = 0;
  while (offset < size) {
    size_t wanted = sizeof(buffer);
    off_t remaining = size - offset;
    if (remaining < (off_t)wanted) wanted = (size_t)remaining;
    ssize_t received = pread(fd, buffer, wanted, offset);
    if (received < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (received == 0 ||
        CC_SHA256_Update(&context, buffer, (CC_LONG)received) != 1) {
      errno = EIO;
      return -1;
    }
    offset += received;
  }
  if (CC_SHA256_Final(digest, &context) != 1) {
    errno = EIO;
    return -1;
  }
  return 0;
}

static int reader_identity_is_current(original_reader_t *reader) {
  int current_root = open_absolute_directory(reader->canonical_path, 0);
  if (current_root < 0) return -1;
  struct stat root_status;
  char marker[33];
  int failure = 0;
  if (validate_directory_fd(current_root, &root_status) != 0 ||
      root_status.st_uid != geteuid() || (root_status.st_mode & 077) != 0 ||
      root_status.st_dev != reader->device ||
      root_status.st_ino != reader->root_inode ||
      read_marker(current_root, marker, sizeof(marker), 0) != 0 ||
      strcmp(marker, reader->marker) != 0)
    failure = errno == 0 ? ESTALE : errno;
  int current_originals = -1;
  if (failure == 0) {
    current_originals = secure_open_child_directory(current_root, "originals", 0, 1);
    struct stat originals_status;
    if (current_originals < 0 || fstat(current_originals, &originals_status) != 0 ||
        originals_status.st_dev != reader->device ||
        originals_status.st_ino != reader->originals_inode)
      failure = errno == 0 ? ESTALE : errno;
  }
  if (current_originals >= 0 && close(current_originals) != 0 && failure == 0)
    failure = errno;
  if (close(current_root) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    errno = failure;
    return -1;
  }
  return 0;
}

static void finalize_original_reader(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  original_reader_t *reader = (original_reader_t *)data;
  if (reader == NULL) return;
  if (reader->originals_fd >= 0) close(reader->originals_fd);
  if (reader->root_fd >= 0) close(reader->root_fd);
  reader->magic = 0;
  free(reader);
}

static void finalize_original_handle(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  original_handle_t *handle = (original_handle_t *)data;
  if (handle == NULL) return;
  if (handle->file_fd >= 0) close(handle->file_fd);
  if (handle->parent_fd >= 0) close(handle->parent_fd);
  handle->magic = 0;
  free(handle);
}

static napi_value open_original_reader(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  char path[PATH_MAX], expected_marker[33];
  if (argc != 2 || get_string(env, args[0], path, sizeof(path)) != 0 ||
      get_string(env, args[1], expected_marker, sizeof(expected_marker)) != 0 ||
      strlen(expected_marker) != 32) {
    if (argc == 2) throw_code(env, "STORAGE_INVALID_ARGUMENT", "Invalid reader identity.");
    return NULL;
  }
  int root_fd = open_absolute_directory(path, 0);
  struct stat root_status;
  char marker[33];
  int failure = root_fd < 0 ? errno : 0;
  if (failure == 0 &&
      (validate_directory_fd(root_fd, &root_status) != 0 ||
       root_status.st_uid != geteuid() || (root_status.st_mode & 077) != 0 ||
       read_marker(root_fd, marker, sizeof(marker), 0) != 0 ||
       strcmp(marker, expected_marker) != 0))
    failure = errno == 0 ? EPERM : errno;
  int originals_fd = -1;
  struct stat originals_status;
  if (failure == 0) {
    originals_fd = secure_open_child_directory(root_fd, "originals", 0, 1);
    if (originals_fd < 0 || fstat(originals_fd, &originals_status) != 0 ||
        originals_status.st_dev != root_status.st_dev)
      failure = errno == 0 ? EXDEV : errno;
  }
  if (failure != 0) {
    if (originals_fd >= 0) close(originals_fd);
    if (root_fd >= 0) close(root_fd);
    errno = failure;
    throw_errno(env, "open original reader");
    return NULL;
  }
  original_reader_t *reader = calloc(1, sizeof(*reader));
  if (reader == NULL) {
    close(originals_fd);
    close(root_fd);
    throw_code(env, "STORAGE_NATIVE_ERROR", "Allocation failed.");
    return NULL;
  }
  reader->magic = ORIGINAL_READER_MAGIC;
  reader->root_fd = root_fd;
  reader->originals_fd = originals_fd;
  reader->device = root_status.st_dev;
  reader->root_inode = root_status.st_ino;
  reader->originals_inode = originals_status.st_ino;
  strcpy(reader->marker, marker);
  if (fcntl(root_fd, F_GETPATH, reader->canonical_path) != 0) {
    finalize_original_reader(env, reader, NULL);
    throw_errno(env, "resolve original reader root");
    return NULL;
  }
  napi_value external, result, marker_value, device_value;
  napi_create_external(env, reader, finalize_original_reader, NULL, &external);
  napi_create_object(env, &result);
  napi_create_string_utf8(env, reader->marker, NAPI_AUTO_LENGTH, &marker_value);
  char device[32];
  (void)snprintf(device, sizeof(device), "%llu",
                 (unsigned long long)reader->device);
  napi_create_string_utf8(env, device, NAPI_AUTO_LENGTH, &device_value);
  napi_set_named_property(env, result, "handle", external);
  napi_set_named_property(env, result, "markerId", marker_value);
  napi_set_named_property(env, result, "device", device_value);
  return result;
}

static napi_value close_original_reader(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  original_reader_t *reader = get_original_reader(env, arg);
  if (reader == NULL) return NULL;
  int failure = 0;
  if (close(reader->originals_fd) != 0) failure = errno;
  reader->originals_fd = -1;
  if (close(reader->root_fd) != 0 && failure == 0) failure = errno;
  reader->root_fd = -1;
  if (failure != 0) {
    errno = failure;
    throw_errno(env, "close original reader");
    return NULL;
  }
  return undefined_value(env);
}

static napi_value open_verified_original(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  original_reader_t *reader = get_original_reader(env, args[0]);
  char family[32], sha[65], size_text[32];
  off_t expected_size;
  if (reader == NULL || argc != 4 ||
      get_string(env, args[1], family, sizeof(family)) != 0 ||
      get_string(env, args[2], sha, sizeof(sha)) != 0 ||
      get_string(env, args[3], size_text, sizeof(size_text)) != 0)
    return NULL;
  if (validate_decimal_identifier(family) != 0 ||
      validate_sha256_hex(sha) != 0 || parse_offset(size_text, &expected_size) != 0) {
    throw_code(env, "STORAGE_INVALID_ARGUMENT", "Invalid original identity.");
    return NULL;
  }
  if (reader_identity_is_current(reader) != 0) {
    throw_errno(env, "verify original reader identity");
    return NULL;
  }
  int family_fd = secure_open_child_directory(reader->originals_fd, family, 0, 1);
  char first[3] = {sha[0], sha[1], '\0'};
  char second[3] = {sha[2], sha[3], '\0'};
  int first_fd = family_fd < 0 ? -1 : secure_open_child_directory(family_fd, first, 0, 1);
  int parent_fd = first_fd < 0 ? -1 : secure_open_child_directory(first_fd, second, 0, 1);
  char base[NAME_MAX + 1];
  int base_length = snprintf(base, sizeof(base), "%s-%s", sha, size_text);
  struct stat before, after, named;
  int file_fd = -1;
  int failure = 0;
  if (family_fd < 0 || first_fd < 0 || parent_fd < 0 || base_length <= 0 ||
      (size_t)base_length >= sizeof(base))
    failure = errno == 0 ? EINVAL : errno;
  if (failure == 0) {
    storage_root_t root_view = {.root_fd = reader->root_fd,
                                .lock_fd = -1,
                                .device = reader->device,
                                .inode = reader->root_inode};
    file_fd = open_validated_original_reader(&root_view, parent_fd, base, &before);
    if (file_fd < 0) failure = errno;
  }
  int flags = 0;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH], expected_digest[CC_SHA256_DIGEST_LENGTH];
  if (failure == 0 &&
      (before.st_size != expected_size ||
       (flags = fcntl(file_fd, F_GETFL)) < 0 || (flags & O_ACCMODE) != O_RDONLY ||
       lseek(file_fd, 0, SEEK_CUR) < 0 || digest_open_fd(file_fd, before.st_size, digest) != 0))
    failure = errno == 0 ? EIO : errno;
  for (size_t i = 0; failure == 0 && i < sizeof(expected_digest); i += 1) {
    char byte[3] = {sha[i * 2], sha[i * 2 + 1], '\0'};
    expected_digest[i] = (unsigned char)strtoul(byte, NULL, 16);
  }
  if (failure == 0 && memcmp(digest, expected_digest, sizeof(digest)) != 0)
    failure = EIO;
  if (failure == 0 &&
      (fstat(file_fd, &after) != 0 ||
       fstatat(parent_fd, base, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
       !S_ISREG(named.st_mode) || before.st_dev != after.st_dev ||
       before.st_ino != after.st_ino || before.st_size != after.st_size ||
       before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec ||
       before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec ||
       named.st_dev != before.st_dev || named.st_ino != before.st_ino ||
       named.st_size != before.st_size || named.st_uid != before.st_uid ||
       named.st_nlink != 1 || (named.st_mode & 0777) != 0400 ||
       lseek(file_fd, 0, SEEK_SET) != 0))
    failure = errno == 0 ? ESTALE : errno;
  if (family_fd >= 0 && close(family_fd) != 0 && failure == 0) failure = errno;
  if (first_fd >= 0 && close(first_fd) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    if (file_fd >= 0) close(file_fd);
    if (parent_fd >= 0) close(parent_fd);
    errno = failure;
    throw_errno(env, "open verified original");
    return NULL;
  }
  original_handle_t *handle = calloc(1, sizeof(*handle));
  if (handle == NULL) {
    close(file_fd);
    close(parent_fd);
    throw_code(env, "STORAGE_NATIVE_ERROR", "Allocation failed.");
    return NULL;
  }
  handle->magic = ORIGINAL_HANDLE_MAGIC;
  handle->file_fd = file_fd;
  handle->parent_fd = parent_fd;
  handle->device = before.st_dev;
  handle->inode = before.st_ino;
  handle->size = before.st_size;
  handle->mode = before.st_mode & 0777;
  handle->mtime = before.st_mtimespec;
  strcpy(handle->base, base);
  strcpy(handle->root_path, reader->canonical_path);
  napi_value external;
  napi_create_external(env, handle, finalize_original_handle, NULL, &external);
  return external;
}

static napi_value close_original_handle(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  original_handle_t *handle = NULL;
  if (napi_get_value_external(env, arg, (void **)&handle) != napi_ok ||
      handle == NULL || handle->magic != ORIGINAL_HANDLE_MAGIC) {
    throw_code(env, "ORIGINAL_HANDLE_INVALID", "Invalid original handle.");
    return NULL;
  }
  int failure = 0;
  if (handle->file_fd >= 0 && close(handle->file_fd) != 0) failure = errno;
  handle->file_fd = -1;
  if (handle->parent_fd >= 0 && close(handle->parent_fd) != 0 && failure == 0)
    failure = errno;
  handle->parent_fd = -1;
  handle->consumed = 1;
  if (failure != 0) {
    errno = failure;
    throw_errno(env, "close original handle");
    return NULL;
  }
  return undefined_value(env);
}

static napi_value consume_original_handle(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  original_handle_t *handle = get_original_handle(env, arg);
  if (handle == NULL) return NULL;
  struct stat current, named;
  if (fstat(handle->file_fd, &current) != 0 ||
      fstatat(handle->parent_fd, handle->base, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      current.st_dev != handle->device || current.st_ino != handle->inode ||
      current.st_size != handle->size || (current.st_mode & 0777) != handle->mode ||
      current.st_mtimespec.tv_sec != handle->mtime.tv_sec ||
      current.st_mtimespec.tv_nsec != handle->mtime.tv_nsec ||
      named.st_dev != handle->device || named.st_ino != handle->inode ||
      named.st_nlink != 1 || (named.st_mode & 0777) != 0400 ||
      lseek(handle->file_fd, 0, SEEK_SET) != 0) {
    throw_errno(env, "revalidate original handoff");
    return NULL;
  }
  int transferred = handle->file_fd;
  handle->file_fd = -1;
  handle->consumed = 1;
  if (close(handle->parent_fd) != 0) {
    int saved = errno;
    close(transferred);
    handle->parent_fd = -1;
    errno = saved;
    throw_errno(env, "consume original handle");
    return NULL;
  }
  handle->parent_fd = -1;
  napi_value result, fd_value, root_value;
  napi_create_object(env, &result);
  napi_create_int32(env, transferred, &fd_value);
  napi_create_string_utf8(env, handle->root_path, NAPI_AUTO_LENGTH, &root_value);
  napi_set_named_property(env, result, "fd", fd_value);
  napi_set_named_property(env, result, "rootPath", root_value);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"provisionCapacityGate", NULL, provision_capacity_gate, NULL, NULL,
       NULL, napi_default, NULL},
      {"openCapacityGate", NULL, open_capacity_gate, NULL, NULL, NULL,
       napi_default, NULL},
      {"tryAcquireCapacityGate", NULL, try_acquire_capacity_gate, NULL, NULL,
       NULL, napi_default, NULL},
      {"releaseCapacityGate", NULL, release_capacity_gate, NULL, NULL, NULL,
       napi_default, NULL},
      {"capacityGateSnapshot", NULL, capacity_gate_snapshot, NULL, NULL, NULL,
       napi_default, NULL},
      {"closeCapacityGate", NULL, close_capacity_gate, NULL, NULL, NULL,
       napi_default, NULL},
      {"openRoot", NULL, open_root, NULL, NULL, NULL, napi_default, NULL},
      {"closeRoot", NULL, close_root, NULL, NULL, NULL, napi_default, NULL},
      {"ensureDirectory", NULL, ensure_directory, NULL, NULL, NULL,
       napi_default, NULL},
      {"createExclusive", NULL, create_exclusive, NULL, NULL, NULL,
       napi_default, NULL},
      {"raceExclusiveCreate", NULL, race_exclusive_create, NULL, NULL, NULL,
       napi_default, NULL},
      {"publishOriginal", NULL, publish_original, NULL, NULL, NULL,
       napi_default, NULL},
      {"raceExclusivePublish", NULL, race_exclusive_publish, NULL, NULL, NULL,
       napi_default, NULL},
      {"fileSize", NULL, file_size, NULL, NULL, NULL, napi_default, NULL},
      {"verifyControlledFile", NULL, verify_controlled_file, NULL, NULL,
       NULL, napi_default, NULL},
      {"appendFileFromFile", NULL, append_file_from_file, NULL, NULL, NULL,
       napi_default, NULL},
      {"truncateFile", NULL, truncate_file, NULL, NULL, NULL, napi_default,
       NULL},
      {"removeFile", NULL, remove_file, NULL, NULL, NULL, napi_default, NULL},
      {"verifyRootIdentity", NULL, verify_root_identity, NULL, NULL, NULL,
       napi_default, NULL},
      {"listDirectory", NULL, list_directory, NULL, NULL, NULL,
       napi_default, NULL},
      {"listDirectoryPage", NULL, list_directory_page, NULL, NULL, NULL,
       napi_default, NULL},
      {"directoryDevice", NULL, directory_device, NULL, NULL, NULL,
       napi_default, NULL},
      {"openOriginalReader", NULL, open_original_reader, NULL, NULL, NULL,
       napi_default, NULL},
      {"closeOriginalReader", NULL, close_original_reader, NULL, NULL, NULL,
       napi_default, NULL},
      {"openVerifiedOriginal", NULL, open_verified_original, NULL, NULL, NULL,
       napi_default, NULL},
      {"closeOriginalHandle", NULL, close_original_handle, NULL, NULL, NULL,
       napi_default, NULL},
      {"consumeOriginalHandle", NULL, consume_original_handle, NULL, NULL,
       NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports,
                         sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
