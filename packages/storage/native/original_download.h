/*
 * Phase 6D1: asynchronous, same-FD verified original download capability.
 *
 * This file is included by storage_native.c after the existing original
 * reader implementation. It deliberately exposes no path or descriptor to
 * JavaScript. The only data-bearing operation is one bounded sequential read.
 */
#ifndef FAMILY_ALBUM_ORIGINAL_DOWNLOAD_H
#define FAMILY_ALBUM_ORIGINAL_DOWNLOAD_H

#define ORIGINAL_DOWNLOAD_MAGIC UINT64_C(0x4f444f574e4c4431)
#define ORIGINAL_DOWNLOAD_CHUNK_MAX (256U * 1024U)

typedef enum {
  ORIGINAL_DOWNLOAD_OPENING = 1,
  ORIGINAL_DOWNLOAD_VERIFYING = 2,
  ORIGINAL_DOWNLOAD_VERIFIED = 3,
  ORIGINAL_DOWNLOAD_STREAMING = 4,
  ORIGINAL_DOWNLOAD_EOF_VALIDATED = 5,
  ORIGINAL_DOWNLOAD_CANCELLING = 6,
  ORIGINAL_DOWNLOAD_FAILED = 7,
  ORIGINAL_DOWNLOAD_CLOSED = 8,
} original_download_state_t;

struct original_download_work;

typedef struct original_download {
  uint64_t magic;
  pthread_mutex_t mutex;
  pthread_cond_t work_settled;
  atomic_int cancelled;
  unsigned refs;
  unsigned active_work;
  int native_use_pending;
  pthread_t worker_thread;
  int worker_joinable;
  struct original_download_work *current_work;
  int close_requested;
  int failed;
  original_download_state_t state;

  int root_fd;
  int originals_fd;
  int parent_fd;
  int file_fd;
  dev_t device;
  ino_t root_inode;
  ino_t originals_inode;
  ino_t marker_inode;
  ino_t family_inode;
  ino_t first_inode;
  ino_t parent_inode;
  ino_t inode;
  dev_t marker_device;
  uid_t uid;
  uid_t marker_uid;
  off_t expected_size;
  off_t offset;
  mode_t mode;
  struct timespec mtime;
  struct timespec ctime;
  struct timespec marker_mtime;
  struct timespec marker_ctime;
  off_t marker_size;
  mode_t marker_mode;
  char marker[33];
  char canonical_path[PATH_MAX];
  char family[32];
  char sha[65];
  char size_text[32];
  char base[NAME_MAX + 1];

  napi_async_cleanup_hook_handle cleanup_hook;
  int cleanup_running;
} original_download_t;

typedef enum {
  ORIGINAL_DOWNLOAD_WORK_OPEN = 1,
  ORIGINAL_DOWNLOAD_WORK_READ = 2,
} original_download_work_kind_t;

typedef struct original_download_work {
  original_download_work_kind_t kind;
  original_download_t *download;
  int success;
  int cancelled;
  int error_number;
  const char *error_code;
  unsigned char *buffer;
  size_t buffer_size;
  size_t received;
  off_t start;
  int final;
} original_download_work_t;

#ifdef PS_STORAGE_TEST_HOOKS
typedef struct {
  pthread_mutex_t mutex;
  pthread_cond_t condition;
  int armed;
  int reached;
  int released;
  char stage[16];
} original_download_test_barrier_t;

static original_download_test_barrier_t original_download_barrier = {
    PTHREAD_MUTEX_INITIALIZER, PTHREAD_COND_INITIALIZER, 0, 0, 0, ""};
#endif
static atomic_ullong original_download_open_count;
static atomic_ullong original_download_close_count;
static atomic_ullong original_download_active_work;
static atomic_ullong original_download_max_active_work;
static atomic_ullong original_download_max_read_buffer;
static atomic_ullong original_download_live_contexts;
static atomic_ullong original_download_owned_fds;
#ifdef PS_STORAGE_TEST_HOOKS
static atomic_int original_download_fault_short_eof;
static atomic_int original_download_fault_extra_byte;
static atomic_ullong original_download_hash_mismatch_count;
static atomic_ullong original_download_size_mismatch_count;
static atomic_ullong original_download_short_eof_count;
static atomic_ullong original_download_extra_byte_count;
static atomic_ullong original_download_final_withheld_count;
#endif

static void original_download_update_max(atomic_ullong *maximum,
                                         unsigned long long value) {
  unsigned long long current = atomic_load(maximum);
  while (current < value &&
         !atomic_compare_exchange_weak(maximum, &current, value)) {
  }
}

static void original_download_test_wait(original_download_t *download,
                                        const char *stage) {
#ifdef PS_STORAGE_TEST_HOOKS
  pthread_mutex_lock(&original_download_barrier.mutex);
  if (original_download_barrier.armed &&
      strcmp(original_download_barrier.stage, stage) == 0) {
    original_download_barrier.reached = 1;
    pthread_cond_broadcast(&original_download_barrier.condition);
    while (!original_download_barrier.released &&
           !atomic_load(&download->cancelled)) {
      pthread_cond_wait(&original_download_barrier.condition,
                        &original_download_barrier.mutex);
    }
  }
  pthread_mutex_unlock(&original_download_barrier.mutex);
#else
  (void)download;
  (void)stage;
#endif
}

static void original_download_wake_test_barrier(void) {
#ifdef PS_STORAGE_TEST_HOOKS
  pthread_mutex_lock(&original_download_barrier.mutex);
  pthread_cond_broadcast(&original_download_barrier.condition);
  pthread_mutex_unlock(&original_download_barrier.mutex);
#endif
}

static void original_download_retain(original_download_t *download) {
  pthread_mutex_lock(&download->mutex);
  download->refs += 1;
  pthread_mutex_unlock(&download->mutex);
}

static void original_download_destroy(original_download_t *download) {
  download->magic = 0;
  atomic_fetch_sub(&original_download_live_contexts, 1);
  pthread_cond_destroy(&download->work_settled);
  pthread_mutex_destroy(&download->mutex);
  free(download);
}

static void original_download_release(original_download_t *download) {
  int destroy = 0;
  pthread_mutex_lock(&download->mutex);
  if (download->refs > 0) download->refs -= 1;
  if (download->refs == 0) destroy = 1;
  pthread_mutex_unlock(&download->mutex);
  if (destroy) original_download_destroy(download);
}

static void original_download_close_file(original_download_t *download) {
  if (download->file_fd >= 0) {
    (void)close(download->file_fd);
    download->file_fd = -1;
    atomic_fetch_add(&original_download_close_count, 1);
    atomic_fetch_sub(&original_download_owned_fds, 1);
  }
}

/* Caller holds download->mutex and active_work is zero. */
static void original_download_close_locked(original_download_t *download) {
  original_download_close_file(download);
  if (download->parent_fd >= 0) {
    (void)close(download->parent_fd);
    download->parent_fd = -1;
    atomic_fetch_sub(&original_download_owned_fds, 1);
  }
  if (download->originals_fd >= 0) {
    (void)close(download->originals_fd);
    download->originals_fd = -1;
    atomic_fetch_sub(&original_download_owned_fds, 1);
  }
  if (download->root_fd >= 0) {
    (void)close(download->root_fd);
    download->root_fd = -1;
    atomic_fetch_sub(&original_download_owned_fds, 1);
  }
  download->state = ORIGINAL_DOWNLOAD_CLOSED;
}

static napi_value original_download_error(napi_env env, const char *code,
                                          const char *message) {
  napi_value code_value, message_value, error;
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value);
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value);
  napi_create_error(env, code_value, message_value, &error);
  return error;
}

static original_download_t *get_original_download(napi_env env,
                                                  napi_value value) {
  original_download_t *download = NULL;
  if (napi_get_value_external(env, value, (void **)&download) != napi_ok ||
      download == NULL || download->magic != ORIGINAL_DOWNLOAD_MAGIC) {
    throw_code(env, "ORIGINAL_DOWNLOAD_INVALID",
               "Invalid original download capability.");
    return NULL;
  }
  return download;
}

static int original_download_cancelled(original_download_t *download) {
  if (atomic_load(&download->cancelled)) {
    errno = ECANCELED;
    return 1;
  }
  return 0;
}

static int original_download_reader_current(original_download_t *download) {
  if (original_download_cancelled(download)) return -1;
  int current_root = open_absolute_directory(download->canonical_path, 0);
  if (current_root < 0) return -1;
  struct stat root_status;
  char marker[33];
  int failure = 0;
  struct stat marker_status;
  if (validate_directory_fd(current_root, &root_status) != 0 ||
      root_status.st_uid != geteuid() || (root_status.st_mode & 077) != 0 ||
      root_status.st_dev != download->device ||
      root_status.st_ino != download->root_inode ||
      read_marker(current_root, marker, sizeof(marker), 0) != 0 ||
      strcmp(marker, download->marker) != 0 ||
      fstatat(current_root, ".storage-root", &marker_status,
              AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(marker_status.st_mode) ||
      marker_status.st_dev != download->marker_device ||
      marker_status.st_ino != download->marker_inode ||
      marker_status.st_uid != download->marker_uid ||
      marker_status.st_size != download->marker_size ||
      (marker_status.st_mode & 0777) != download->marker_mode ||
      marker_status.st_nlink != 1 ||
      marker_status.st_mtimespec.tv_sec != download->marker_mtime.tv_sec ||
      marker_status.st_mtimespec.tv_nsec != download->marker_mtime.tv_nsec ||
      marker_status.st_ctimespec.tv_sec != download->marker_ctime.tv_sec ||
      marker_status.st_ctimespec.tv_nsec != download->marker_ctime.tv_nsec)
    failure = errno == 0 ? ESTALE : errno;
  int current_originals = -1;
  if (failure == 0) {
    current_originals =
        secure_open_child_directory(current_root, "originals", 0, 1);
    struct stat originals_status;
    if (current_originals < 0 ||
        fstat(current_originals, &originals_status) != 0 ||
        originals_status.st_dev != download->device ||
        originals_status.st_ino != download->originals_inode)
      failure = errno == 0 ? ESTALE : errno;
  }
  if (current_originals >= 0 && close(current_originals) != 0 && failure == 0)
    failure = errno;
  if (close(current_root) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    errno = failure;
    return -1;
  }
  return original_download_cancelled(download) ? -1 : 0;
}

static int original_download_directory_chain_current(
    original_download_t *download) {
  int family_fd = secure_open_child_directory(download->originals_fd,
                                               download->family, 0, 1);
  char first[3] = {download->sha[0], download->sha[1], '\0'};
  char second[3] = {download->sha[2], download->sha[3], '\0'};
  int first_fd = family_fd < 0
                     ? -1
                     : secure_open_child_directory(family_fd, first, 0, 1);
  int parent_fd = first_fd < 0
                      ? -1
                      : secure_open_child_directory(first_fd, second, 0, 1);
  struct stat family_status, first_status, parent_status;
  int failure = 0;
  if (family_fd < 0 || first_fd < 0 || parent_fd < 0 ||
      fstat(family_fd, &family_status) != 0 ||
      fstat(first_fd, &first_status) != 0 ||
      fstat(parent_fd, &parent_status) != 0 ||
      family_status.st_dev != download->device ||
      first_status.st_dev != download->device ||
      parent_status.st_dev != download->device ||
      family_status.st_ino != download->family_inode ||
      first_status.st_ino != download->first_inode ||
      parent_status.st_ino != download->parent_inode)
    failure = errno == 0 ? ESTALE : errno;
  if (parent_fd >= 0 && close(parent_fd) != 0 && failure == 0) failure = errno;
  if (first_fd >= 0 && close(first_fd) != 0 && failure == 0) failure = errno;
  if (family_fd >= 0 && close(family_fd) != 0 && failure == 0) failure = errno;
  if (failure != 0) {
    errno = failure;
    return -1;
  }
  return original_download_cancelled(download) ? -1 : 0;
}

static int original_download_file_current(original_download_t *download,
                                          int include_name) {
  struct stat current, named;
  if (download->file_fd < 0 || fstat(download->file_fd, &current) != 0 ||
      !S_ISREG(current.st_mode) || current.st_dev != download->device ||
      current.st_ino != download->inode || current.st_uid != download->uid ||
      current.st_size != download->expected_size ||
      current.st_nlink != 1 || (current.st_mode & 0777) != download->mode ||
      current.st_mtimespec.tv_sec != download->mtime.tv_sec ||
      current.st_mtimespec.tv_nsec != download->mtime.tv_nsec ||
      current.st_ctimespec.tv_sec != download->ctime.tv_sec ||
      current.st_ctimespec.tv_nsec != download->ctime.tv_nsec ||
      validate_no_extended_acl(download->file_fd) != 0) {
    errno = errno == 0 ? ESTALE : errno;
    return -1;
  }
  if (include_name &&
      (download->parent_fd < 0 ||
       fstatat(download->parent_fd, download->base, &named,
               AT_SYMLINK_NOFOLLOW) != 0 ||
       !S_ISREG(named.st_mode) || named.st_dev != download->device ||
       named.st_ino != download->inode || named.st_uid != download->uid ||
       named.st_size != download->expected_size || named.st_nlink != 1 ||
       (named.st_mode & 0777) != download->mode ||
       named.st_mtimespec.tv_sec != download->mtime.tv_sec ||
       named.st_mtimespec.tv_nsec != download->mtime.tv_nsec ||
       named.st_ctimespec.tv_sec != download->ctime.tv_sec ||
       named.st_ctimespec.tv_nsec != download->ctime.tv_nsec)) {
    errno = errno == 0 ? ESTALE : errno;
    return -1;
  }
  return original_download_cancelled(download) ? -1 : 0;
}

static int original_download_digest(original_download_t *download, int fd,
                                    off_t size,
                                    unsigned char digest[CC_SHA256_DIGEST_LENGTH]) {
  CC_SHA256_CTX context;
  if (size <= 0 || CC_SHA256_Init(&context) != 1) {
    errno = EINVAL;
    return -1;
  }
  unsigned char buffer[64 * 1024];
  off_t offset = 0;
  while (offset < size) {
    if (original_download_cancelled(download)) return -1;
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
  if (original_download_cancelled(download) ||
      CC_SHA256_Final(digest, &context) != 1) {
    if (errno == 0) errno = ECANCELED;
    return -1;
  }
  return 0;
}

static int original_download_open_verify(original_download_t *download) {
  if (original_download_reader_current(download) != 0) return -1;
  int family_fd =
      secure_open_child_directory(download->originals_fd, download->family, 0, 1);
  char first[3] = {download->sha[0], download->sha[1], '\0'};
  char second[3] = {download->sha[2], download->sha[3], '\0'};
  int first_fd = family_fd < 0
                     ? -1
                     : secure_open_child_directory(family_fd, first, 0, 1);
  int parent_fd = first_fd < 0
                      ? -1
                      : secure_open_child_directory(first_fd, second, 0, 1);
  int base_length = snprintf(download->base, sizeof(download->base), "%s-%s",
                             download->sha, download->size_text);
  struct stat before, family_status, first_status, parent_status;
  int file_fd = -1;
  int failure = 0;
  int parent_owned = 0;
  if (family_fd < 0 || first_fd < 0 || parent_fd < 0 || base_length <= 0 ||
      (size_t)base_length >= sizeof(download->base))
    failure = errno == 0 ? EINVAL : errno;
  if (failure == 0 &&
      (fstat(family_fd, &family_status) != 0 ||
       fstat(first_fd, &first_status) != 0 ||
       fstat(parent_fd, &parent_status) != 0))
    failure = errno;
  if (failure == 0) {
    storage_root_t root_view = {.root_fd = download->root_fd,
                                .lock_fd = -1,
                                .device = download->device,
                                .inode = download->root_inode};
    file_fd = open_validated_original_reader(&root_view, parent_fd,
                                             download->base, &before);
    if (file_fd < 0)
      failure = errno;
    else {
      atomic_fetch_add(&original_download_open_count, 1);
      atomic_fetch_add(&original_download_owned_fds, 1);
    }
  }
  if (family_fd >= 0) (void)close(family_fd);
  if (first_fd >= 0) (void)close(first_fd);
  original_download_test_wait(download, "VERIFY");
  int flags = 0;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  unsigned char expected_digest[CC_SHA256_DIGEST_LENGTH];
  if (failure == 0 && before.st_size != download->expected_size) {
#ifdef PS_STORAGE_TEST_HOOKS
    atomic_fetch_add(&original_download_size_mismatch_count, 1);
#endif
    failure = EIO;
  }
  if (failure == 0 &&
      (original_download_cancelled(download) ||
       (flags = fcntl(file_fd, F_GETFL)) < 0 ||
       (flags & O_ACCMODE) != O_RDONLY ||
       original_download_digest(download, file_fd, before.st_size, digest) !=
           0))
    failure = errno == 0 ? EIO : errno;
  for (size_t i = 0; failure == 0 && i < sizeof(expected_digest); i += 1) {
    char byte[3] = {download->sha[i * 2], download->sha[i * 2 + 1], '\0'};
    expected_digest[i] = (unsigned char)strtoul(byte, NULL, 16);
  }
  if (failure == 0 && memcmp(digest, expected_digest, sizeof(digest)) != 0) {
#ifdef PS_STORAGE_TEST_HOOKS
    atomic_fetch_add(&original_download_hash_mismatch_count, 1);
#endif
    failure = EIO;
  }
  if (failure == 0) {
    download->file_fd = file_fd;
    download->parent_fd = parent_fd;
    atomic_fetch_add(&original_download_owned_fds, 1);
    parent_owned = 1;
    download->inode = before.st_ino;
    download->family_inode = family_status.st_ino;
    download->first_inode = first_status.st_ino;
    download->parent_inode = parent_status.st_ino;
    download->uid = before.st_uid;
    download->mode = before.st_mode & 0777;
    download->mtime = before.st_mtimespec;
    download->ctime = before.st_ctimespec;
    if (original_download_file_current(download, 1) != 0 ||
        original_download_directory_chain_current(download) != 0 ||
        original_download_reader_current(download) != 0)
      failure = errno == 0 ? ESTALE : errno;
  }
  if (failure != 0) {
    if (file_fd >= 0) {
      (void)close(file_fd);
      atomic_fetch_add(&original_download_close_count, 1);
      atomic_fetch_sub(&original_download_owned_fds, 1);
    }
    if (parent_fd >= 0) {
      (void)close(parent_fd);
      if (parent_owned) atomic_fetch_sub(&original_download_owned_fds, 1);
    }
    download->file_fd = -1;
    download->parent_fd = -1;
    errno = failure;
    return -1;
  }
  return 0;
}

static int original_download_read_chunk(original_download_work_t *work) {
  original_download_t *download = work->download;
  original_download_test_wait(download, "READ");
  if (original_download_cancelled(download) ||
      original_download_file_current(download, 1) != 0)
    return -1;
  size_t received = 0;
  while (received < work->buffer_size) {
    if (original_download_cancelled(download)) return -1;
    ssize_t amount;
#ifdef PS_STORAGE_TEST_HOOKS
    if (atomic_exchange(&original_download_fault_short_eof, 0)) {
      amount = 0;
      atomic_fetch_add(&original_download_short_eof_count, 1);
    } else
#endif
      amount = pread(download->file_fd, work->buffer + received,
                     work->buffer_size - received,
                     work->start + (off_t)received);
    if (amount < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (amount == 0) {
      errno = EIO;
      return -1;
    }
    received += (size_t)amount;
  }
  work->received = received;
  if (work->final) {
#ifdef PS_STORAGE_TEST_HOOKS
    atomic_fetch_add(&original_download_final_withheld_count, 1);
#endif
    original_download_test_wait(download, "FINAL");
  }
  if (original_download_file_current(download, work->final) != 0) return -1;
  if (work->final) {
    unsigned char extra;
    ssize_t amount;
    do {
      if (original_download_cancelled(download)) return -1;
      #ifdef PS_STORAGE_TEST_HOOKS
      if (atomic_exchange(&original_download_fault_extra_byte, 0)) {
        amount = 1;
        atomic_fetch_add(&original_download_extra_byte_count, 1);
      } else
      #endif
        amount = pread(download->file_fd, &extra, 1,
                       download->expected_size);
    } while (amount < 0 && errno == EINTR);
    if (amount != 0) {
      errno = amount > 0 ? EFBIG : errno;
      return -1;
    }
    if (original_download_file_current(download, 1) != 0 ||
        original_download_directory_chain_current(download) != 0 ||
        original_download_reader_current(download) != 0)
      return -1;
  }
  return original_download_cancelled(download) ? -1 : 0;
}

static void *original_download_execute(void *data) {
  original_download_work_t *work = data;
  unsigned long long active = atomic_fetch_add(&original_download_active_work, 1) + 1;
  original_download_update_max(&original_download_max_active_work, active);
  errno = 0;
  int result = work->kind == ORIGINAL_DOWNLOAD_WORK_OPEN
                   ? original_download_open_verify(work->download)
                   : original_download_read_chunk(work);
  work->success = result == 0;
  work->cancelled = atomic_load(&work->download->cancelled);
  work->error_number = errno;
  pthread_mutex_lock(&work->download->mutex);
  work->download->native_use_pending = 0;
  pthread_cond_broadcast(&work->download->work_settled);
  pthread_mutex_unlock(&work->download->mutex);
  atomic_fetch_sub(&original_download_active_work, 1);
  return NULL;
}

static void original_download_remove_hook(original_download_t *download) {
  napi_async_cleanup_hook_handle hook = NULL;
  pthread_mutex_lock(&download->mutex);
  if (!download->cleanup_running && download->cleanup_hook != NULL) {
    hook = download->cleanup_hook;
    download->cleanup_hook = NULL;
  }
  pthread_mutex_unlock(&download->mutex);
  if (hook != NULL) {
    (void)napi_remove_async_cleanup_hook(hook);
    original_download_release(download);
  }
}

static void original_download_free_work(original_download_work_t *work) {
  original_download_t *download = work->download;
  if (work->buffer != NULL) {
    memset(work->buffer, 0, work->buffer_size);
    free(work->buffer);
  }
  free(work);
  original_download_release(download);
}

static original_download_work_t *original_download_cancel_join(
    original_download_t *download) {
  pthread_t thread;
  int join = 0;
  original_download_work_t *work = NULL;
  pthread_mutex_lock(&download->mutex);
  atomic_store(&download->cancelled, 1);
  download->close_requested = 1;
  if (download->state != ORIGINAL_DOWNLOAD_CLOSED)
    download->state = ORIGINAL_DOWNLOAD_CANCELLING;
  if (download->worker_joinable) {
    thread = download->worker_thread;
    download->worker_joinable = 0;
    join = 1;
  }
  pthread_mutex_unlock(&download->mutex);
  original_download_wake_test_barrier();
  if (join) (void)pthread_join(thread, NULL);
  pthread_mutex_lock(&download->mutex);
  work = download->current_work;
  download->current_work = NULL;
  download->active_work = 0;
  download->native_use_pending = 0;
  original_download_close_locked(download);
  pthread_mutex_unlock(&download->mutex);
  return work;
}

static void original_download_cleanup_hook(
    napi_async_cleanup_hook_handle handle, void *data) {
  original_download_t *download = data;
  original_download_work_t *work = original_download_cancel_join(download);
  pthread_mutex_lock(&download->mutex);
  download->cleanup_running = 1;
  download->cleanup_hook = NULL;
  pthread_mutex_unlock(&download->mutex);
  if (work != NULL) original_download_free_work(work);
  (void)napi_remove_async_cleanup_hook(handle);
  original_download_release(download);
}

static void finalize_original_download(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  original_download_t *download = data;
  if (download == NULL || download->magic != ORIGINAL_DOWNLOAD_MAGIC) return;
  original_download_work_t *work = original_download_cancel_join(download);
  if (work != NULL) original_download_free_work(work);
  original_download_remove_hook(download);
  original_download_release(download);
}

static napi_value start_verified_original_download(napi_env env,
                                                   napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  original_reader_t *reader = argc == 4 ? get_original_reader(env, args[0]) : NULL;
  char family[32], sha[65], size_text[32];
  off_t expected_size;
  if (reader == NULL || argc != 4 ||
      get_string(env, args[1], family, sizeof(family)) != 0 ||
      get_string(env, args[2], sha, sizeof(sha)) != 0 ||
      get_string(env, args[3], size_text, sizeof(size_text)) != 0)
    return NULL;
  if (validate_decimal_identifier(family) != 0 ||
      validate_sha256_hex(sha) != 0 ||
      parse_offset(size_text, &expected_size) != 0 || expected_size <= 0) {
    throw_code(env, "STORAGE_INVALID_ARGUMENT", "Invalid original identity.");
    return NULL;
  }

  original_download_t *download = calloc(1, sizeof(*download));
  if (download == NULL) {
    throw_code(env, "STORAGE_NATIVE_ERROR", "Allocation failed.");
    return NULL;
  }
  download->magic = ORIGINAL_DOWNLOAD_MAGIC;
  pthread_mutex_init(&download->mutex, NULL);
  pthread_cond_init(&download->work_settled, NULL);
  atomic_init(&download->cancelled, 0);
  atomic_fetch_add(&original_download_live_contexts, 1);
  download->refs = 1; /* External wrapper. */
  download->state = ORIGINAL_DOWNLOAD_OPENING;
  download->root_fd = fcntl(reader->root_fd, F_DUPFD_CLOEXEC, 0);
  download->originals_fd = fcntl(reader->originals_fd, F_DUPFD_CLOEXEC, 0);
  if (download->root_fd >= 0)
    atomic_fetch_add(&original_download_owned_fds, 1);
  if (download->originals_fd >= 0)
    atomic_fetch_add(&original_download_owned_fds, 1);
  download->parent_fd = -1;
  download->file_fd = -1;
  download->device = reader->device;
  download->root_inode = reader->root_inode;
  download->originals_inode = reader->originals_inode;
  download->expected_size = expected_size;
  strcpy(download->marker, reader->marker);
  strcpy(download->canonical_path, reader->canonical_path);
  strcpy(download->family, family);
  strcpy(download->sha, sha);
  strcpy(download->size_text, size_text);
  download->marker_device = reader->marker_device;
  download->marker_inode = reader->marker_inode;
  download->marker_uid = reader->marker_uid;
  download->marker_size = reader->marker_size;
  download->marker_mode = reader->marker_mode;
  download->marker_mtime = reader->marker_mtime;
  download->marker_ctime = reader->marker_ctime;
  if (download->root_fd < 0 || download->originals_fd < 0) {
    pthread_mutex_lock(&download->mutex);
    original_download_close_locked(download);
    pthread_mutex_unlock(&download->mutex);
    original_download_release(download);
    throw_errno(env, "duplicate original reader identity");
    return NULL;
  }

  napi_value external;
  if (napi_create_external(env, download, finalize_original_download, NULL,
                           &external) != napi_ok) {
    pthread_mutex_lock(&download->mutex);
    original_download_close_locked(download);
    pthread_mutex_unlock(&download->mutex);
    original_download_release(download);
    throw_code(env, "STORAGE_NATIVE_ERROR", "Create download handle failed.");
    return NULL;
  }
  original_download_retain(download); /* Async cleanup hook. */
  if (napi_add_async_cleanup_hook(env, original_download_cleanup_hook, download,
                                  &download->cleanup_hook) != napi_ok) {
    original_download_release(download);
    throw_code(env, "STORAGE_NATIVE_ERROR", "Register cleanup hook failed.");
    return NULL;
  }

  original_download_work_t *work = calloc(1, sizeof(*work));
  if (work == NULL) {
    atomic_store(&download->cancelled, 1);
    throw_code(env, "STORAGE_NATIVE_ERROR", "Allocation failed.");
    return NULL;
  }
  work->kind = ORIGINAL_DOWNLOAD_WORK_OPEN;
  work->download = download;
  work->error_code = "ORIGINAL_DOWNLOAD_OPEN_FAILED";
  original_download_retain(download);
  pthread_mutex_lock(&download->mutex);
  download->active_work = 1;
  download->native_use_pending = 1;
  download->current_work = work;
  download->state = ORIGINAL_DOWNLOAD_VERIFYING;
  int thread_error = pthread_create(&download->worker_thread, NULL,
                                    original_download_execute, work);
  if (thread_error != 0) {
    download->active_work = 0;
    download->native_use_pending = 0;
    download->current_work = NULL;
    download->failed = 1;
    download->close_requested = 1;
    original_download_close_locked(download);
    pthread_mutex_unlock(&download->mutex);
    original_download_free_work(work);
    throw_code(env, "STORAGE_NATIVE_ERROR", "Start download verification failed.");
    return NULL;
  }
  download->worker_joinable = 1;
  pthread_mutex_unlock(&download->mutex);
  return external;
}

static napi_value start_original_download_read(napi_env env,
                                               napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  original_download_t *download =
      argc == 1 ? get_original_download(env, arg) : NULL;
  if (download == NULL) return NULL;
  original_download_work_t *work = calloc(1, sizeof(*work));
  if (work == NULL) {
    throw_code(env, "STORAGE_NATIVE_ERROR", "Allocation failed.");
    return NULL;
  }
  pthread_mutex_lock(&download->mutex);
  if (download->active_work != 0) {
    pthread_mutex_unlock(&download->mutex);
    free(work);
    throw_code(env, "ORIGINAL_DOWNLOAD_BUSY", "A read is already active.");
    return NULL;
  }
  if (atomic_load(&download->cancelled) ||
      download->state == ORIGINAL_DOWNLOAD_CLOSED ||
      download->state == ORIGINAL_DOWNLOAD_FAILED ||
      download->state == ORIGINAL_DOWNLOAD_CANCELLING) {
    pthread_mutex_unlock(&download->mutex);
    free(work);
    throw_code(env, "ORIGINAL_DOWNLOAD_CLOSED", "Download is not readable.");
    return NULL;
  }
  if (download->state == ORIGINAL_DOWNLOAD_EOF_VALIDATED) {
    pthread_mutex_unlock(&download->mutex);
    free(work);
    throw_code(env, "ORIGINAL_DOWNLOAD_EOF", "Download is complete.");
    return NULL;
  }
  off_t remaining = download->expected_size - download->offset;
  if (remaining <= 0) {
    pthread_mutex_unlock(&download->mutex);
    free(work);
    throw_code(env, "ORIGINAL_DOWNLOAD_FAILED", "Invalid byte accounting.");
    return NULL;
  }
  work->buffer_size = remaining > (off_t)ORIGINAL_DOWNLOAD_CHUNK_MAX
                          ? ORIGINAL_DOWNLOAD_CHUNK_MAX
                          : (size_t)remaining;
  work->buffer = malloc(work->buffer_size);
  if (work->buffer == NULL) {
    pthread_mutex_unlock(&download->mutex);
    free(work);
    throw_code(env, "STORAGE_NATIVE_ERROR", "Allocation failed.");
    return NULL;
  }
  work->kind = ORIGINAL_DOWNLOAD_WORK_READ;
  work->download = download;
  work->error_code = "ORIGINAL_DOWNLOAD_READ_FAILED";
  work->start = download->offset;
  work->final = remaining <= (off_t)ORIGINAL_DOWNLOAD_CHUNK_MAX;
  download->active_work = 1;
  download->native_use_pending = 1;
  download->current_work = work;
  download->state = ORIGINAL_DOWNLOAD_STREAMING;
  download->refs += 1; /* Work reference; download->mutex is already held. */
  int thread_error = pthread_create(&download->worker_thread, NULL,
                                    original_download_execute, work);
  if (thread_error != 0) {
    download->active_work = 0;
    download->native_use_pending = 0;
    download->current_work = NULL;
    download->failed = 1;
    download->close_requested = 1;
    original_download_close_locked(download);
    pthread_mutex_unlock(&download->mutex);
    original_download_free_work(work);
    throw_code(env, "STORAGE_NATIVE_ERROR", "Start download read failed.");
    return NULL;
  }
  download->worker_joinable = 1;
  pthread_mutex_unlock(&download->mutex);
  original_download_update_max(&original_download_max_read_buffer,
                               work->buffer_size);
  return undefined_value(env);
}

static napi_value poll_original_download(napi_env env,
                                         napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  original_download_t *download =
      argc == 1 ? get_original_download(env, arg) : NULL;
  if (download == NULL) return NULL;

  pthread_t thread;
  original_download_work_t *work;
  pthread_mutex_lock(&download->mutex);
  if (download->current_work == NULL || download->active_work == 0) {
    pthread_mutex_unlock(&download->mutex);
    throw_code(env, "ORIGINAL_DOWNLOAD_NO_WORK", "No download work is pending.");
    return NULL;
  }
  if (download->native_use_pending) {
    pthread_mutex_unlock(&download->mutex);
    napi_value pending;
    napi_get_null(env, &pending);
    return pending;
  }
  work = download->current_work;
  thread = download->worker_thread;
  download->worker_joinable = 0;
  download->current_work = NULL;
  pthread_mutex_unlock(&download->mutex);
  (void)pthread_join(thread, NULL);

  int cancelled = atomic_load(&download->cancelled) || work->cancelled;
  int failed = !work->success;
  pthread_mutex_lock(&download->mutex);
  download->active_work = 0;
  if (cancelled) {
    download->state = ORIGINAL_DOWNLOAD_CANCELLING;
    download->close_requested = 1;
  } else if (failed) {
    download->state = ORIGINAL_DOWNLOAD_FAILED;
    download->failed = 1;
    download->close_requested = 1;
  } else if (work->kind == ORIGINAL_DOWNLOAD_WORK_OPEN) {
    download->state = ORIGINAL_DOWNLOAD_VERIFIED;
  } else {
    download->offset = work->start + (off_t)work->received;
    download->state = work->final ? ORIGINAL_DOWNLOAD_EOF_VALIDATED
                                  : ORIGINAL_DOWNLOAD_STREAMING;
  }
  if (download->close_requested) original_download_close_locked(download);
  pthread_mutex_unlock(&download->mutex);

  if (cancelled || failed) {
    const char *code = cancelled ? "ORIGINAL_DOWNLOAD_CANCELLED"
                                 : work->error_code;
    if (code == NULL) code = "ORIGINAL_DOWNLOAD_FAILED";
    original_download_free_work(work);
    napi_throw(env, original_download_error(
                        env, code, cancelled
                                       ? "Original download was cancelled."
                                       : "Original download failed safely."));
    return NULL;
  }

  napi_value result, kind;
  napi_create_object(env, &result);
  napi_create_string_utf8(
      env, work->kind == ORIGINAL_DOWNLOAD_WORK_OPEN ? "open" : "read",
      NAPI_AUTO_LENGTH, &kind);
  napi_set_named_property(env, result, "kind", kind);
  if (work->kind == ORIGINAL_DOWNLOAD_WORK_READ) {
    napi_value bytes, final;
    napi_create_buffer_copy(env, work->received, work->buffer, NULL, &bytes);
    napi_get_boolean(env, work->final, &final);
    napi_set_named_property(env, result, "bytes", bytes);
    napi_set_named_property(env, result, "final", final);
  }
  original_download_free_work(work);
  return result;
}

static napi_value cancel_original_download(napi_env env,
                                           napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  original_download_t *download =
      argc == 1 ? get_original_download(env, arg) : NULL;
  if (download == NULL) return NULL;
  pthread_mutex_lock(&download->mutex);
  if (download->state != ORIGINAL_DOWNLOAD_CLOSED) {
    atomic_store(&download->cancelled, 1);
    download->close_requested = 1;
    download->state = ORIGINAL_DOWNLOAD_CANCELLING;
    if (download->active_work == 0) original_download_close_locked(download);
  }
  pthread_mutex_unlock(&download->mutex);
  original_download_wake_test_barrier();
  return undefined_value(env);
}

static napi_value close_original_download(napi_env env,
                                          napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  original_download_t *download =
      argc == 1 ? get_original_download(env, arg) : NULL;
  if (download == NULL) return NULL;
  pthread_mutex_lock(&download->mutex);
  if (download->active_work != 0) {
    pthread_mutex_unlock(&download->mutex);
    throw_code(env, "ORIGINAL_DOWNLOAD_BUSY",
               "Cannot close an active original download.");
    return NULL;
  }
  original_download_close_locked(download);
  pthread_mutex_unlock(&download->mutex);
  original_download_remove_hook(download);
  return undefined_value(env);
}

/* Compiled only into storage_native_test.node. */
#ifdef PS_STORAGE_TEST_HOOKS
static napi_value original_download_test_barrier(napi_env env,
                                                 napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  char action[32];
  if (argc != 1 || get_string(env, arg, action, sizeof(action)) != 0)
    return NULL;
  pthread_mutex_lock(&original_download_barrier.mutex);
  if (strcmp(action, "ARM_VERIFY") == 0 || strcmp(action, "ARM_READ") == 0 ||
      strcmp(action, "ARM_FINAL") == 0) {
    original_download_barrier.armed = 1;
    original_download_barrier.reached = 0;
    original_download_barrier.released = 0;
    strcpy(original_download_barrier.stage,
           strcmp(action, "ARM_VERIFY") == 0
               ? "VERIFY"
               : (strcmp(action, "ARM_READ") == 0 ? "READ" : "FINAL"));
  } else if (strcmp(action, "RELEASE") == 0) {
    original_download_barrier.released = 1;
    original_download_barrier.armed = 0;
    pthread_cond_broadcast(&original_download_barrier.condition);
  } else if (strcmp(action, "RESET") == 0) {
    original_download_barrier.armed = 0;
    original_download_barrier.reached = 0;
    original_download_barrier.released = 1;
    original_download_barrier.stage[0] = '\0';
    pthread_cond_broadcast(&original_download_barrier.condition);
  } else {
    pthread_mutex_unlock(&original_download_barrier.mutex);
    throw_code(env, "STORAGE_INVALID_ARGUMENT", "Invalid test barrier action.");
    return NULL;
  }
  pthread_mutex_unlock(&original_download_barrier.mutex);
  return undefined_value(env);
}

static napi_value original_download_test_fault(napi_env env,
                                               napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  char action[32];
  if (argc != 1 || get_string(env, arg, action, sizeof(action)) != 0)
    return NULL;
  if (strcmp(action, "SHORT_EOF_ONCE") == 0)
    atomic_store(&original_download_fault_short_eof, 1);
  else if (strcmp(action, "EXTRA_BYTE_ONCE") == 0)
    atomic_store(&original_download_fault_extra_byte, 1);
  else if (strcmp(action, "RESET") == 0) {
    atomic_store(&original_download_fault_short_eof, 0);
    atomic_store(&original_download_fault_extra_byte, 0);
  } else {
    throw_code(env, "STORAGE_INVALID_ARGUMENT", "Invalid test fault action.");
    return NULL;
  }
  return undefined_value(env);
}

static napi_value original_download_test_diagnostics(
    napi_env env, napi_callback_info info) {
  size_t argc = 0;
  napi_get_cb_info(env, info, &argc, NULL, NULL, NULL);
  int reached;
  pthread_mutex_lock(&original_download_barrier.mutex);
  reached = original_download_barrier.reached;
  pthread_mutex_unlock(&original_download_barrier.mutex);
  napi_value result, value;
  char number[32];
  napi_create_object(env, &result);
#define SET_DOWNLOAD_DIAGNOSTIC(name, counter)                              \
  (void)snprintf(number, sizeof(number), "%llu",                           \
                 (unsigned long long)atomic_load(&(counter)));             \
  napi_create_string_utf8(env, number, NAPI_AUTO_LENGTH, &value);          \
  napi_set_named_property(env, result, (name), value)
  SET_DOWNLOAD_DIAGNOSTIC("openCount", original_download_open_count);
  SET_DOWNLOAD_DIAGNOSTIC("closeCount", original_download_close_count);
  SET_DOWNLOAD_DIAGNOSTIC("activeWork", original_download_active_work);
  SET_DOWNLOAD_DIAGNOSTIC("maxActiveWork",
                          original_download_max_active_work);
  SET_DOWNLOAD_DIAGNOSTIC("maxReadBuffer",
                          original_download_max_read_buffer);
  SET_DOWNLOAD_DIAGNOSTIC("liveContexts", original_download_live_contexts);
  SET_DOWNLOAD_DIAGNOSTIC("ownedFds", original_download_owned_fds);
  SET_DOWNLOAD_DIAGNOSTIC("hashMismatchCount",
                          original_download_hash_mismatch_count);
  SET_DOWNLOAD_DIAGNOSTIC("sizeMismatchCount",
                          original_download_size_mismatch_count);
  SET_DOWNLOAD_DIAGNOSTIC("shortEofCount", original_download_short_eof_count);
  SET_DOWNLOAD_DIAGNOSTIC("extraByteCount",
                          original_download_extra_byte_count);
  SET_DOWNLOAD_DIAGNOSTIC("finalWithheldCount",
                          original_download_final_withheld_count);
#undef SET_DOWNLOAD_DIAGNOSTIC
  napi_get_boolean(env, reached, &value);
  napi_set_named_property(env, result, "barrierReached", value);
  return result;
}
#endif

#endif
