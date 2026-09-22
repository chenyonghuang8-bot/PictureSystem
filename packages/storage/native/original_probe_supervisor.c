#define _DARWIN_C_SOURCE 1
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "process_lifecycle.h"

#define STDOUT_LIMIT (64 * 1024)
#define STDERR_LIMIT (16 * 1024)
#define TERM_GRACE_MS 250

static long long monotonic_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  return (long long)now.tv_sec * 1000LL + now.tv_nsec / 1000000LL;
}

static int approved_kind(const char *kind) {
  return strcmp(kind, "capabilities") == 0 ||
         strcmp(kind, "metadata") == 0 ||
         strcmp(kind, "fork-denied") == 0 ||
         strcmp(kind, "exec-denied") == 0 ||
         strcmp(kind, "timeout-ignore-term") == 0 ||
         strcmp(kind, "crash") == 0 ||
         strcmp(kind, "stdout-flood") == 0 ||
         strcmp(kind, "stderr-flood") == 0 ||
         strcmp(kind, "invalid-json") == 0 ||
         strcmp(kind, "deep-json") == 0;
}

int main(int argc, char **argv) {
  if (argc != 7 || argv[1][0] != '/' || argv[2][0] != '/' ||
      argv[3][0] != '/' || argv[4][0] != '/' || !approved_kind(argv[5]))
    return 64;
  char *end = NULL;
  long timeout_ms = strtol(argv[6], &end, 10);
  if (end == NULL || *end != '\0' || timeout_ms < 50 || timeout_ms > 30000)
    return 64;

  int out_pipe[2], err_pipe[2];
  if (pipe(out_pipe) != 0 || pipe(err_pipe) != 0) return 70;
  pid_t pid = fork();
  if (pid < 0) return 70;
  if (pid == 0) {
    (void)setpgid(0, 0);
    int null_fd = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (null_fd < 0 || dup2(null_fd, STDIN_FILENO) < 0 ||
        dup2(out_pipe[1], STDOUT_FILENO) < 0 ||
        dup2(err_pipe[1], STDERR_FILENO) < 0)
      _exit(70);
    if (null_fd > 3) close(null_fd);
    close(out_pipe[0]); close(out_pipe[1]);
    close(err_pipe[0]); close(err_pipe[1]);
    for (int fd = 4; fd < 1024; fd += 1) close(fd);
    char root_definition[4096 + 16], home_definition[4096 + 16];
    char child_definition[4096 + 16];
    if (snprintf(root_definition, sizeof(root_definition), "MEDIA_ROOT=%s", argv[3]) < 0 ||
        snprintf(home_definition, sizeof(home_definition), "HOME_ROOT=%s", argv[4]) < 0 ||
        snprintf(child_definition, sizeof(child_definition), "CHILD=%s", argv[2]) < 0)
      _exit(70);
    char *const child_argv[] = {
        (char *)"sandbox-exec", (char *)"-f", argv[1],
        (char *)"-D", root_definition, (char *)"-D", child_definition,
        (char *)"-D", home_definition, argv[2], argv[5], NULL};
    char *const clean_env[] = {(char *)"PATH=/usr/bin:/bin", (char *)"LANG=C", NULL};
    execve("/usr/bin/sandbox-exec", child_argv, clean_env);
    _exit(71);
  }
  (void)setpgid(pid, pid);
  ps_lifecycle owner;
  ps_lifecycle_init(&owner, pid);
  close(out_pipe[1]); close(err_pipe[1]);
  (void)fcntl(out_pipe[0], F_SETFL, O_NONBLOCK);
  (void)fcntl(err_pipe[0], F_SETFL, O_NONBLOCK);

  unsigned char stdout_buffer[STDOUT_LIMIT + 1];
  unsigned char stderr_buffer[STDERR_LIMIT + 1];
  size_t stdout_size = 0, stderr_size = 0;
  int child_done = 0, failed = 0;
  long long deadline = monotonic_ms() + timeout_ms;
  while (!child_done) {
    struct pollfd fds[3] = {{out_pipe[0], POLLIN | POLLHUP, 0},
                            {err_pipe[0], POLLIN | POLLHUP, 0},
                            {4, POLLIN | POLLHUP, 0}};
    int remaining = (int)(deadline - monotonic_ms());
    if (remaining < 0) remaining = 0;
    int poll_result = poll(fds, 3, remaining > 20 ? 20 : remaining);
    if (poll_result < 0 && errno != EINTR) { failed = 74; break; }
    if ((fds[2].revents & (POLLHUP | POLLERR | POLLNVAL)) != 0) {
      failed = 75;
      break;
    }
    for (int index = 0; index < 2; index += 1) {
      int fd = index == 0 ? out_pipe[0] : err_pipe[0];
      unsigned char *buffer = index == 0 ? stdout_buffer : stderr_buffer;
      size_t *size = index == 0 ? &stdout_size : &stderr_size;
      size_t limit = index == 0 ? STDOUT_LIMIT : STDERR_LIMIT;
      if ((fds[index].revents & (POLLIN | POLLHUP)) != 0) {
        for (;;) {
          ssize_t received = read(fd, buffer + *size, limit + 1 - *size);
          if (received > 0) {
            *size += (size_t)received;
            if (*size > limit) { failed = index == 0 ? 76 : 77; break; }
            continue;
          }
          if (received < 0 && errno == EINTR) continue;
          break;
        }
      }
      if (failed != 0) break;
    }
    if (failed != 0) break;
    int waited = ps_poll_exact(&owner);
    if (waited == 1) child_done = 1;
    else if (waited < 0) { failed = 74; break; }
    if (monotonic_ms() >= deadline) { failed = 78; break; }
  }
  if (!child_done && ps_stop_exact(&owner, monotonic_ms, TERM_GRACE_MS) < 0)
    failed = 74;
  close(out_pipe[0]); close(err_pipe[0]);
  if (failed != 0) return failed;
  int denied_operation = strcmp(argv[5], "fork-denied") == 0 ||
                         strcmp(argv[5], "exec-denied") == 0;
  const char *expected_attempt = strcmp(argv[5], "fork-denied") == 0
                                     ? "FORK_ATTEMPT\n"
                                     : "EXEC_ATTEMPT\n";
  if (denied_operation && stdout_size == strlen(expected_attempt) &&
      memcmp(stdout_buffer, expected_attempt, stdout_size) == 0 &&
      (!WIFEXITED(owner.status) || WEXITSTATUS(owner.status) != 0)) {
    const char denied_json[] = "{\"denied\":true}\n";
    memcpy(stdout_buffer, denied_json, sizeof(denied_json) - 1);
    stdout_size = sizeof(denied_json) - 1;
    owner.status = 0;
  }
  if (!WIFEXITED(owner.status)) return 200 + WTERMSIG(owner.status);
  if (WEXITSTATUS(owner.status) != 0) return 100 + WEXITSTATUS(owner.status);
  if (stdout_size == 0 || stdout_size > STDOUT_LIMIT || stderr_size > STDERR_LIMIT)
    return 80;
  size_t written = 0;
  while (written < stdout_size) {
    ssize_t amount = write(STDOUT_FILENO, stdout_buffer + written,
                           stdout_size - written);
    if (amount < 0) { if (errno == EINTR) continue; return 81; }
    written += (size_t)amount;
  }
  return 0;
}
