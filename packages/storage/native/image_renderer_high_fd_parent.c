#define _DARWIN_C_SOURCE 1
#include <errno.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef PS_TEST_SUPERVISOR_PATH
#error PS_TEST_SUPERVISOR_PATH must be fixed at build time
#endif

/* Test-only native parent: unlike a JS launcher, it proves non-CLOEXEC
 * regular, locked, and socket descriptors really reached the supervisor. */
int main(int argc, char **argv) {
  if (argc != 2) return 64;
  int original = open(argv[1], O_RDONLY);
  int locked = open(argv[1], O_RDONLY);
  int sockets[2], live[2];
  if (original < 0 || locked < 0 || flock(locked, LOCK_SH | LOCK_NB) != 0 ||
      socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) != 0 || pipe(live) != 0)
    return 70;
  pid_t child = fork();
  if (child < 0) return 70;
  if (child == 0) {
    if (dup2(original, 3) != 3 || dup2(live[0], 4) != 4 ||
        dup2(original, 1500) != 1500 || dup2(locked, 1601) != 1601 ||
        dup2(sockets[0], 1703) != 1703) _exit(71);
    (void)fcntl(1500, F_SETFD, 0);
    (void)fcntl(1601, F_SETFD, 0);
    (void)fcntl(1703, F_SETFD, 0);
    close(live[1]);
    close(sockets[1]);
    execl(PS_TEST_SUPERVISOR_PATH, PS_TEST_SUPERVISOR_PATH, (char *)0);
    _exit(72);
  }
  close(live[0]);
  close(sockets[0]);
  close(sockets[1]);
  close(original);
  close(locked);
  int status;
  pid_t waited;
  do { waited = waitpid(child, &status, 0); }
  while (waited < 0 && errno == EINTR);
  close(live[1]);
  if (waited != child || !WIFEXITED(status)) return 73;
  return WEXITSTATUS(status);
}
