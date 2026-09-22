#define _DARWIN_C_SOURCE 1
#include <signal.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "process_lifecycle.h"

static long long monotonic_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  pid_t child = fork();
  if (child < 0) return 70;
  if (child == 0) _exit(0);
  int status = 0;
  if (waitpid(child, &status, 0) != child) return 71;
  ps_lifecycle owner;
  ps_lifecycle_init(&owner, child);
  if (strcmp(argv[1], "echild") == 0) {
    if (ps_poll_exact(&owner) != -1 || owner.state != PS_ANOMALY ||
        owner.pid != -1 || owner.pgid != -1 ||
        ps_stop_exact(&owner, monotonic_ms, 10) != -1) return 72;
    return 0;
  }
  if (strcmp(argv[1], "reaped") == 0) {
    /* A recorded REAPED state must never recover stale signal authority. */
    owner.state = PS_REAPED;
    owner.pid = -1;
    owner.pgid = -1;
    return ps_stop_exact(&owner, monotonic_ms, 10) == 1 ? 0 : 73;
  }
  return 64;
}
