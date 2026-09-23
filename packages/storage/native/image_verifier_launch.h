/* Isolated verify-output launcher.
 * Included once from storage_native.c after derived_store.h.
 * The sealed read descriptor is duplicated onto the child FD3.
 * No path, raw fd, or buffer is accepted from JavaScript.
 */
#ifndef FAMILY_ALBUM_IMAGE_VERIFIER_LAUNCH_H
#define FAMILY_ALBUM_IMAGE_VERIFIER_LAUNCH_H

#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <time.h>

#ifndef PS_VERIFIER_SUPERVISOR_PATH
#define PS_VERIFIER_SUPERVISOR_PATH ""
#endif
#ifndef PS_VERIFIER_TIMEOUT_PATH
#define PS_VERIFIER_TIMEOUT_PATH ""
#endif
#ifndef PS_VERIFIER_CRASH_PATH
#define PS_VERIFIER_CRASH_PATH ""
#endif
#ifndef PS_VERIFIER_IGNORE_TERM_PATH
#define PS_VERIFIER_IGNORE_TERM_PATH ""
#endif
#ifndef PS_VERIFIER_HIGH_FD_PATH
#define PS_VERIFIER_HIGH_FD_PATH ""
#endif

static int derived_verify_bound(derived_writer_t *writer, int read_fd) {
  struct stat opened, named;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (derived_require_root(writer->store) != 0 ||
      derived_revalidate_parent(writer) != 0 || fstat(read_fd, &opened) != 0 ||
      fstatat(writer->epoch_fd, writer->leaf, &named, AT_SYMLINK_NOFOLLOW) !=
          0) {
    errno = errno == 0 ? EPERM : errno;
    return -1;
  }
  if (!S_ISREG(opened.st_mode) || !S_ISREG(named.st_mode) ||
      opened.st_dev != writer->device || opened.st_ino != writer->inode ||
      named.st_dev != opened.st_dev || named.st_ino != opened.st_ino ||
      opened.st_nlink != 1 || named.st_nlink != 1 ||
      opened.st_size != writer->size || named.st_size != writer->size ||
      (opened.st_mode & 0777) != 0400 || (named.st_mode & 0777) != 0400 ||
      !owned_by_caller(&opened) || !owned_by_caller(&named)) {
    errno = EPERM;
    return -1;
  }
  if (derived_hash_fd(read_fd, writer->size, digest) != 0) return -1;
  if (memcmp(digest, writer->sha, sizeof(digest)) != 0) {
    errno = EILSEQ;
    return -1;
  }
  return 0;
}

static void derived_consume_sealed(derived_sealed_t *sealed) {
  derived_close_fd(&sealed->read_fd);
  sealed->consumed = 1;
  if (sealed->writer != NULL && sealed->writer->store != NULL) {
    derived_unregister(sealed->writer->store, sealed->writer);
  }
}

static long long verifier_now_ms(void) {
  struct timespec ts;
  return clock_gettime(CLOCK_MONOTONIC, &ts) == 0
             ? (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000
             : 0;
}

static const char *verifier_supervisor_path(const char *scenario) {
  if (strcmp(scenario, "run") == 0) return PS_VERIFIER_SUPERVISOR_PATH;
  if (strcmp(scenario, "timeout") == 0) return PS_VERIFIER_TIMEOUT_PATH;
  if (strcmp(scenario, "crash") == 0) return PS_VERIFIER_CRASH_PATH;
  if (strcmp(scenario, "ignore-term") == 0) return PS_VERIFIER_IGNORE_TERM_PATH;
  if (strcmp(scenario, "owner-death") == 0) return PS_VERIFIER_SUPERVISOR_PATH;
  if (strcmp(scenario, "high-fd") == 0) return PS_VERIFIER_HIGH_FD_PATH;
  return NULL;
}

static int accept_verifier_json(const char *json, int *width, int *height,
                                int *alpha, int *transparent) {
  int parsed_width = 0;
  int parsed_height = 0;
  char alpha_text[8] = {0};
  char transparent_text[8] = {0};
  if (sscanf(json,
             "{\"status\":\"ok\",\"width\":%d,\"height\":%d,\"static\":true,"
             "\"alpha\":%7[a-z],\"transparent\":%7[a-z]}\n",
             &parsed_width, &parsed_height, alpha_text,
             transparent_text) != 4) {
    return -1;
  }
  if ((strcmp(alpha_text, "true") != 0 && strcmp(alpha_text, "false") != 0) ||
      (strcmp(transparent_text, "true") != 0 &&
       strcmp(transparent_text, "false") != 0) ||
      parsed_width <= 0 || parsed_height <= 0 || parsed_width > 2560 ||
      parsed_height > 2560) {
    return -1;
  }
  char rebuilt[160];
  int written = snprintf(rebuilt, sizeof(rebuilt),
                         "{\"status\":\"ok\",\"width\":%d,\"height\":%d,"
                         "\"static\":true,\"alpha\":%s,\"transparent\":%s}\n",
                         parsed_width, parsed_height, alpha_text,
                         transparent_text);
  if (written < 0 || (size_t)written >= sizeof(rebuilt) ||
      strcmp(json, rebuilt) != 0) {
    return -1;
  }
  *width = parsed_width;
  *height = parsed_height;
  *alpha = strcmp(alpha_text, "true") == 0;
  *transparent = strcmp(transparent_text, "true") == 0;
  return 0;
}

static int spawn_verifier(const char *supervisor, int sealed_fd, int owner_death,
                          int prove_high_fds, char *output, size_t output_cap,
                          size_t *output_size, int *status) {
  int control[2] = {-1, -1};
  int errors[2] = {-1, -1};
  int liveness[2] = {-1, -1};
  int input = -1;
  int high_file = -1;
  int high_lock = -1;
  int sockets[2] = {-1, -1};
  int high_installed = 0;
  pid_t child = -1;
  int result = 70;
  if (pipe(control) != 0 || pipe(errors) != 0 || pipe(liveness) != 0) goto done;
  int pipe_fds[] = {control[0], control[1], errors[0], errors[1], liveness[0],
                    liveness[1]};
  for (size_t index = 0; index < sizeof(pipe_fds) / sizeof(pipe_fds[0]);
       index += 1) {
    if (fcntl(pipe_fds[index], F_SETFD, FD_CLOEXEC) != 0) goto done;
  }
  input = fcntl(sealed_fd, F_DUPFD_CLOEXEC, 10);
  if (input < 0) goto done;
  if (prove_high_fds) {
    high_file = open("/dev/null", O_RDONLY | O_CLOEXEC);
    high_lock = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (high_file < 0 || high_lock < 0 ||
        flock(high_lock, LOCK_SH | LOCK_NB) != 0 ||
        socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) != 0 ||
        dup2(high_file, 1500) != 1500 || dup2(high_lock, 1601) != 1601 ||
        dup2(sockets[0], 1703) != 1703) {
      goto done;
    }
    if (fcntl(1500, F_SETFD, 0) != 0 || fcntl(1601, F_SETFD, 0) != 0 ||
        fcntl(1703, F_SETFD, 0) != 0)
      goto done;
    high_installed = 1;
  }
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  if (posix_spawn_file_actions_init(&actions) != 0 ||
      posix_spawnattr_init(&attributes) != 0)
    goto done;
  short flags = POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF |
                POSIX_SPAWN_SETSIGMASK;
  sigset_t empty, defaults;
  sigemptyset(&empty);
  sigemptyset(&defaults);
  sigaddset(&defaults, SIGPIPE);
  int ready = posix_spawnattr_setflags(&attributes, flags) == 0 &&
              posix_spawnattr_setpgroup(&attributes, 0) == 0 &&
              posix_spawnattr_setsigmask(&attributes, &empty) == 0 &&
              posix_spawnattr_setsigdefault(&attributes, &defaults) == 0 &&
              posix_spawn_file_actions_addopen(&actions, 0, "/dev/null",
                                               O_RDONLY, 0) == 0 &&
              posix_spawn_file_actions_adddup2(&actions, control[1], 1) == 0 &&
              posix_spawn_file_actions_adddup2(&actions, errors[1], 2) == 0 &&
              posix_spawn_file_actions_adddup2(&actions, input, 3) == 0 &&
              posix_spawn_file_actions_adddup2(&actions, liveness[1], 4) == 0;
  char *const child_argv[] = {(char *)supervisor, NULL};
  char *const clean_env[] = {(char *)"LANG=C", (char *)"LC_ALL=C", NULL};
  int launch = ready ? posix_spawn(&child, supervisor, &actions, &attributes,
                                   child_argv, clean_env)
                     : 70;
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attributes);
  if (launch != 0) goto done;
  close(control[1]);
  control[1] = -1;
  close(errors[1]);
  errors[1] = -1;
  close(liveness[1]);
  liveness[1] = -1;
  if (owner_death) {
    close(liveness[0]);
    liveness[0] = -1;
  }
  size_t used = 0;
  int out_eof = 0;
  long long deadline = verifier_now_ms() + 15000;
  while (!out_eof) {
    if (verifier_now_ms() > deadline) {
      result = 78;
      goto done;
    }
    struct pollfd fd = {control[0], POLLIN | POLLHUP, 0};
    if (poll(&fd, 1, 50) < 0 && errno != EINTR) goto done;
    if (!(fd.revents & (POLLIN | POLLHUP))) continue;
    char buffer[512];
    ssize_t count = read(control[0], buffer, sizeof(buffer));
    if (count > 0) {
      if (used + (size_t)count > output_cap) {
        result = 81;
        goto done;
      }
      memcpy(output + used, buffer, (size_t)count);
      used += (size_t)count;
    } else if (count == 0) {
      out_eof = 1;
    } else if (errno != EINTR) {
      goto done;
    }
  }
  int wait_status = 0;
  pid_t waited;
  do {
    waited = waitpid(child, &wait_status, 0);
  } while (waited < 0 && errno == EINTR);
  if (waited != child) goto done;
  child = -1;
  *output_size = used;
  *status = wait_status;
  result = 0;
done:
  if (child > 0) {
    kill(child, SIGKILL);
    int ignored = 0;
    while (waitpid(child, &ignored, 0) < 0 && errno == EINTR) {
    }
  }
  if (control[0] >= 0) close(control[0]);
  if (control[1] >= 0) close(control[1]);
  if (errors[0] >= 0) close(errors[0]);
  if (errors[1] >= 0) close(errors[1]);
  if (liveness[0] >= 0) close(liveness[0]);
  if (liveness[1] >= 0) close(liveness[1]);
  if (input >= 0) close(input);
  if (high_file >= 0) close(high_file);
  if (high_lock >= 0) close(high_lock);
  if (sockets[0] >= 0) close(sockets[0]);
  if (sockets[1] >= 0) close(sockets[1]);
  if (high_installed) {
    close(1500);
    close(1601);
    close(1703);
  }
  return result;
}

static napi_value verify_sealed_output(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  derived_sealed_t *sealed = argc == 3 ? derived_get_sealed(env, args[0]) : NULL;
  derived_store_t *store = sealed == NULL ? NULL : derived_get_store(env, args[1]);
  char scenario[16];
  if (sealed == NULL || store == NULL ||
      get_string(env, args[2], scenario, sizeof(scenario)) != 0) {
    return NULL;
  }
  if (strcmp(scenario, "run") != 0 && process_is_production()) {
    derived_throw(env, "DERIVED_FAULT_DEV_ONLY",
                  "Verifier lifecycle fixtures are dev-only.");
    return NULL;
  }
  const char *supervisor = verifier_supervisor_path(scenario);
  if (supervisor == NULL || supervisor[0] == '\0') {
    derived_throw(env, strcmp(scenario, "run") == 0
                          ? "DERIVED_VERIFIER_UNAVAILABLE"
                          : "STORAGE_INVALID_ARGUMENT",
                  "Verifier supervisor is not available.");
    return NULL;
  }
  pthread_mutex_lock(&store->mutex);
  if (sealed->consumed || sealed->writer == NULL ||
      sealed->writer->store != store ||
      sealed->writer->state != DERIVED_TEMP_SEALED || sealed->read_fd < 0) {
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, "DERIVED_SEALED_CLOSED",
                  "Sealed output does not belong to this store.");
    return NULL;
  }
  if (sealed->writer->verified) {
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, "DERIVED_ALREADY_VERIFIED",
                  "Sealed output was already verified.");
    return NULL;
  }
  int identity = derived_verify_bound(sealed->writer, sealed->read_fd);
  int identity_errno = errno;
  if (identity != 0) {
    derived_consume_sealed(sealed);
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, identity_errno == EILSEQ ? "DERIVED_HASH_MISMATCH"
                                               : "DERIVED_VERIFY_IDENTITY",
                  "Sealed identity did not match before verification.");
    return NULL;
  }
  int sealed_fd = sealed->read_fd;
  int post_fault = store->fail_next_verify_post;
  store->fail_next_verify_post = 0;
  pthread_mutex_unlock(&store->mutex);

  char output[4096];
  size_t output_size = 0;
  int wait_status = 0;
  int launched = spawn_verifier(
      supervisor, sealed_fd, strcmp(scenario, "owner-death") == 0,
      strcmp(scenario, "high-fd") == 0, output, sizeof(output) - 1,
      &output_size, &wait_status);

  pthread_mutex_lock(&store->mutex);
  if (sealed->consumed || sealed->writer == NULL ||
      sealed->writer->store != store) {
    pthread_mutex_unlock(&store->mutex);
    derived_throw(env, "DERIVED_SEALED_CLOSED",
                  "Sealed output was closed during verification.");
    return NULL;
  }
  int post = derived_verify_bound(sealed->writer, sealed->read_fd);
  int post_errno = errno;
  if (post == 0 && post_fault) {
    post = -1;
    post_errno = EPERM;
  }
  char sha_hex[65];
  if (post == 0) derived_digest_hex(sealed->writer->sha, sha_hex);
  static const char ready[] = "PS_RENDER_READY_V1\n";
  int exit_status = launched == 0 && WIFEXITED(wait_status) ? WEXITSTATUS(wait_status) : -1;
  int width = 0;
  int height = 0;
  int alpha = 0;
  int transparent = 0;
  int protocol_ok = post == 0 && exit_status == 0 &&
                    output_size >= sizeof(ready) - 1 &&
                    memcmp(output, ready, sizeof(ready) - 1) == 0;
  if (protocol_ok) {
    output[output_size] = '\0';
    protocol_ok = accept_verifier_json(output + sizeof(ready) - 1, &width,
                                       &height, &alpha, &transparent) == 0;
  }
  if (!protocol_ok) derived_consume_sealed(sealed);
  else sealed->writer->verified = 1;
  pthread_mutex_unlock(&store->mutex);
  if (post != 0) {
    derived_throw(env, post_errno == EILSEQ ? "DERIVED_HASH_MISMATCH"
                                           : "DERIVED_VERIFY_IDENTITY",
                  "Sealed identity changed during verification.");
    return NULL;
  }
  if (launched != 0 || exit_status < 0) {
    derived_throw(env, "DERIVED_VERIFY_FAILED",
                  "Verifier process did not exit cleanly.");
    return NULL;
  }
  if (exit_status == 76) {
    derived_throw(env, "DERIVED_VERIFY_CRASH", "Verifier crashed.");
    return NULL;
  }
  if (exit_status == 78) {
    derived_throw(env, "DERIVED_VERIFY_TIMEOUT", "Verifier timed out.");
    return NULL;
  }
  if (exit_status == 80) {
    derived_throw(env, "DERIVED_VERIFY_OWNER_LOST",
                  "Verifier owner disappeared.");
    return NULL;
  }
  if (!protocol_ok) {
    derived_throw(env, "DERIVED_VERIFY_REJECTED",
                  "Verifier rejected the sealed output.");
    return NULL;
  }
  napi_value result;
  napi_value width_value;
  napi_value height_value;
  napi_value alpha_value;
  napi_value transparent_value;
  napi_value static_value;
  napi_value sha_value;
  napi_create_object(env, &result);
  napi_create_int32(env, width, &width_value);
  napi_create_int32(env, height, &height_value);
  napi_get_boolean(env, alpha, &alpha_value);
  napi_get_boolean(env, transparent, &transparent_value);
  napi_get_boolean(env, 1, &static_value);
  napi_create_string_utf8(env, sha_hex, NAPI_AUTO_LENGTH, &sha_value);
  napi_set_named_property(env, result, "width", width_value);
  napi_set_named_property(env, result, "height", height_value);
  napi_set_named_property(env, result, "alpha", alpha_value);
  napi_set_named_property(env, result, "transparent", transparent_value);
  napi_set_named_property(env, result, "staticImage", static_value);
  napi_set_named_property(env, result, "sha256Hex", sha_value);
  return result;
}

static napi_value fail_next_verify_post(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument;
  napi_get_cb_info(env, info, &argc, &argument, NULL, NULL);
  derived_store_t *store = argc == 1 ? derived_get_store(env, argument) : NULL;
  if (store == NULL) return NULL;
  if (process_is_production()) {
    derived_throw(env, "DERIVED_FAULT_DEV_ONLY", "Fault injection is dev-only.");
    return NULL;
  }
  pthread_mutex_lock(&store->mutex);
  store->fail_next_verify_post = 1;
  pthread_mutex_unlock(&store->mutex);
  return undefined_value(env);
}

#endif
