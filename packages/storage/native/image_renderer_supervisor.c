#define _DARWIN_C_SOURCE 1
#include <errno.h>
#include <CommonCrypto/CommonDigest.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "process_lifecycle.h"

#ifndef PS_RENDERER_BOOTSTRAP_PATH
#error PS_RENDERER_BOOTSTRAP_PATH must be fixed at build time
#endif
#ifndef PS_RENDERER_MODULE_PATH
#error PS_RENDERER_MODULE_PATH must be fixed at build time
#endif
#ifndef PS_RENDERER_BOOTSTRAP_SHA256
#error PS_RENDERER_BOOTSTRAP_SHA256 must be fixed at build time
#endif
#ifndef PS_RENDERER_MODULE_SHA256
#error PS_RENDERER_MODULE_SHA256 must be fixed at build time
#endif
#ifndef PS_EXPECTED_OS_BUILD
#error PS_EXPECTED_OS_BUILD must be fixed at build time
#endif

#define CONTROL_LIMIT 4096
#define STDERR_LIMIT 16384
#define STARTUP_TIMEOUT_MS 5000

static int fixed_artifact_matches(const char *path, const char *expected) {
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return 0;
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1 ||
      st.st_uid != geteuid() || (st.st_mode & 0022) != 0 ||
      st.st_size <= 0 || st.st_size > 16 * 1024 * 1024) {
    close(fd);
    return 0;
  }
  unsigned char *bytes = malloc((size_t)st.st_size);
  if (bytes == NULL) { close(fd); return 0; }
  size_t done = 0;
  while (done < (size_t)st.st_size) {
    ssize_t n = read(fd, bytes + done, (size_t)st.st_size - done);
    if (n > 0) done += (size_t)n;
    else if (n < 0 && errno == EINTR) continue;
    else { free(bytes); close(fd); return 0; }
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  (void)CC_SHA256(bytes, (CC_LONG)st.st_size, digest);
  free(bytes);
  close(fd);
  static const char hex[] = "0123456789abcdef";
  char actual[CC_SHA256_DIGEST_LENGTH * 2 + 1];
  for (size_t i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
    actual[i * 2] = hex[digest[i] >> 4];
    actual[i * 2 + 1] = hex[digest[i] & 15];
  }
  actual[CC_SHA256_DIGEST_LENGTH * 2] = '\0';
  return strcmp(actual, expected) == 0;
}

static int os_build_matches(void) {
  char build[64];
  size_t size = sizeof(build);
  return sysctlbyname("kern.osversion", build, &size, NULL, 0) == 0 &&
         size > 0 && size <= sizeof(build) &&
         strcmp(build, PS_EXPECTED_OS_BUILD) == 0;
}

static long long now_ms(void) {
  struct timespec ts;
  return clock_gettime(CLOCK_MONOTONIC, &ts) == 0
             ? (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000
             : -1;
}

static int owned_pipe(int pair[2]) {
  if (pipe(pair) != 0) return -1;
  if (fcntl(pair[0], F_SETFD, FD_CLOEXEC) != 0 ||
      fcntl(pair[1], F_SETFD, FD_CLOEXEC) != 0) {
    close(pair[0]); close(pair[1]);
    return -1;
  }
  return 0;
}

int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1) return 64;
  if (fcntl(3, F_GETFL) < 0 || fcntl(4, F_GETFL) < 0) return 64;
#ifdef PS_REQUIRE_HIGH_FDS
  if (fcntl(1500, F_GETFD) < 0 || fcntl(1601, F_GETFD) < 0) return 66;
#endif
#ifdef PS_REQUIRE_SOCKET_FD
  if (fcntl(1703, F_GETFD) < 0) return 66;
#endif
  if (!os_build_matches()) return 65;
  if (!fixed_artifact_matches(PS_RENDERER_BOOTSTRAP_PATH,
                              PS_RENDERER_BOOTSTRAP_SHA256) ||
      !fixed_artifact_matches(PS_RENDERER_MODULE_PATH,
                              PS_RENDERER_MODULE_SHA256)) return 65;

  int control[2] = {-1, -1}, errors[2] = {-1, -1};
  if (owned_pipe(control) != 0 || owned_pipe(errors) != 0) return 70;
  int input_source = fcntl(3, F_DUPFD_CLOEXEC, 10);
  if (input_source < 0) return 70;
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  if (posix_spawn_file_actions_init(&actions) != 0 ||
      posix_spawnattr_init(&attributes) != 0) return 70;
  short flags = POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP |
                POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK;
  sigset_t empty, defaults;
  sigemptyset(&empty);
  sigemptyset(&defaults);
  sigaddset(&defaults, SIGPIPE);
  if (posix_spawnattr_setflags(&attributes, flags) != 0 ||
      posix_spawnattr_setpgroup(&attributes, 0) != 0 ||
      posix_spawnattr_setsigmask(&attributes, &empty) != 0 ||
      posix_spawnattr_setsigdefault(&attributes, &defaults) != 0 ||
      posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0) != 0 ||
      posix_spawn_file_actions_adddup2(&actions, control[1], 1) != 0 ||
      posix_spawn_file_actions_adddup2(&actions, errors[1], 2) != 0 ||
      posix_spawn_file_actions_adddup2(&actions, input_source, 3) != 0 ||
      posix_spawn_file_actions_addclose(&actions, input_source) != 0 ||
      posix_spawn_file_actions_addchdir(&actions, "/") != 0) return 70;

  char *const child_argv[] = {(char *)PS_RENDERER_BOOTSTRAP_PATH, NULL};
  char *const clean_env[] = {(char *)"LANG=C", (char *)"LC_ALL=C", NULL};
  pid_t child = -1;
  int launch = posix_spawn(&child, PS_RENDERER_BOOTSTRAP_PATH, &actions,
                           &attributes, child_argv, clean_env);
  close(input_source);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attributes);
  close(control[1]); close(errors[1]);
  if (launch != 0) { close(control[0]); close(errors[0]); return 71; }
  ps_lifecycle owner;
  ps_lifecycle_init(&owner, child);
  (void)fcntl(control[0], F_SETFL, O_NONBLOCK);
  (void)fcntl(errors[0], F_SETFL, O_NONBLOCK);

  char output[CONTROL_LIMIT + 1], stderr_output[STDERR_LIMIT + 1];
  size_t output_size = 0, error_size = 0;
  int out_eof = 0, err_eof = 0, failure = 0;
  long long deadline = now_ms() + STARTUP_TIMEOUT_MS;
  while (!failure && (owner.state != PS_REAPED || !out_eof || !err_eof)) {
    int wait_ms = (int)(deadline - now_ms());
    if (wait_ms <= 0) { failure = 78; break; }
    struct pollfd fds[3] = {{control[0], POLLIN | POLLHUP, 0},
                            {errors[0], POLLIN | POLLHUP, 0},
                            {4, POLLIN | POLLHUP, 0}};
    if (poll(fds, 3, wait_ms > 20 ? 20 : wait_ms) < 0 && errno != EINTR) {
      failure = 79; break;
    }
    if (fds[2].revents & (POLLHUP | POLLERR | POLLNVAL)) {
      failure = 80; break;
    }
    for (int i = 0; i < 2; i++) {
      if (!(fds[i].revents & (POLLIN | POLLHUP))) continue;
      char *buffer = i == 0 ? output : stderr_output;
      size_t *length = i == 0 ? &output_size : &error_size;
      size_t limit = i == 0 ? CONTROL_LIMIT : STDERR_LIMIT;
      int fd = i == 0 ? control[0] : errors[0];
      for (;;) {
        ssize_t n = read(fd, buffer + *length, limit + 1 - *length);
        if (n > 0) {
          *length += (size_t)n;
          if (*length > limit) { failure = 81; break; }
        } else if (n == 0) {
          if (i == 0) out_eof = 1; else err_eof = 1;
          break;
        } else if (errno == EINTR) {
          continue;
        } else if (errno != EAGAIN) {
          failure = 82; break;
        } else break;
      }
      if (failure) break;
    }
    if (owner.state != PS_REAPED) {
      if (ps_poll_exact(&owner) < 0) { failure = 83; break; }
    }
  }
  if (owner.state != PS_REAPED && ps_stop_exact(&owner, now_ms, 250) < 0)
    failure = 83;
  close(control[0]); close(errors[0]);
  if (error_size <= STDERR_LIMIT) {
    stderr_output[error_size] = '\0';
    if (strstr(stderr_output, "EARLY_FD3_READ") != NULL ||
        (output_size == 0 &&
         (strstr(stderr_output, "MODULE_LOADED") != NULL ||
          strstr(stderr_output, "FIRST_FD3_READ") != NULL)))
      return 86;
  }
  static const char expected[] = "PS_RENDER_READY_V1\n{\"status\":\"ok\"}\n";
  static const char expected_events[] =
      "SANDBOX_ACTIVATED\nMODULE_LOADED\nFIRST_FD3_READ\n";
  if (failure || owner.state != PS_REAPED ||
      !WIFEXITED(owner.status) || WEXITSTATUS(owner.status) != 0 ||
      output_size != sizeof(expected) - 1 ||
      memcmp(output, expected, sizeof(expected) - 1) != 0 ||
      error_size != sizeof(expected_events) - 1 ||
      memcmp(stderr_output, expected_events, sizeof(expected_events) - 1) != 0)
    return failure ? failure : 84;
  return write(1, output, output_size) == (ssize_t)output_size ? 0 : 85;
}
