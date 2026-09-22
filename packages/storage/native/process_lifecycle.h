#ifndef PS_PROCESS_LIFECYCLE_H
#define PS_PROCESS_LIFECYCLE_H

#include <errno.h>
#include <signal.h>
#include <stddef.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

typedef enum {
  PS_RUNNING,
  PS_TERM_SENT,
  PS_KILL_SENT,
  PS_REAPED,
  PS_ANOMALY
} ps_lifecycle_state;

typedef struct {
  pid_t pid;
  pid_t pgid;
  int status;
  ps_lifecycle_state state;
} ps_lifecycle;

#ifdef PS_LIFECYCLE_TRACE
static void ps_trace(const char *event) {
  const char *p = event;
  while (*p != '\0') p++;
  (void)write(STDERR_FILENO, event, (size_t)(p - event));
}
#else
static void ps_trace(const char *event) { (void)event; }
#endif

static void ps_lifecycle_init(ps_lifecycle *owner, pid_t child) {
  owner->pid = child;
  owner->pgid = child;
  owner->status = 0;
  owner->state = PS_RUNNING;
}

/* 1=reaped, 0=still running, -1=ownership anomaly (no signal authority). */
static int ps_poll_exact(ps_lifecycle *owner) {
  if (owner->state == PS_REAPED) return 1;
  if (owner->state == PS_ANOMALY) return -1;
  pid_t result;
  do { result = waitpid(owner->pid, &owner->status, WNOHANG); }
  while (result < 0 && errno == EINTR);
  if (result == owner->pid) {
    owner->state = PS_REAPED;
    owner->pid = -1;
    owner->pgid = -1;
    ps_trace("WAITPID_REAPED\n");
    return 1;
  }
  if (result == 0) return 0;
  owner->state = PS_ANOMALY;
  owner->pid = -1;
  owner->pgid = -1;
  ps_trace("WAITPID_ANOMALY\n");
  return -1;
}

static void ps_signal_owned(ps_lifecycle *owner, int signal_number) {
  if (owner->state == PS_REAPED || owner->state == PS_ANOMALY ||
      owner->pid <= 0 || owner->pgid <= 0) return;
  /* A child may have left its original process group. Never signal a stale
   * group identifier that could now identify an unrelated group. */
  if (getpgid(owner->pid) == owner->pgid) {
#ifndef PS_TEST_GROUP_SIGNAL_LOST
    if (signal_number == SIGTERM) ps_trace("SIGNAL_TERM_GROUP\n");
    else ps_trace("SIGNAL_KILL_GROUP\n");
    (void)kill(-owner->pgid, signal_number);
#else
    ps_trace("GROUP_SIGNAL_TEST_SUPPRESSED\n");
#endif
  }
  /* Still-unreaped exact PID fallback if the child changed/lost its group. */
  if (signal_number == SIGTERM) ps_trace("SIGNAL_TERM_PID\n");
  else ps_trace("SIGNAL_KILL_PID\n");
  (void)kill(owner->pid, signal_number);
}

/* now_ms is the monotonic clock supplied by the owning supervisor. */
static int ps_stop_exact(ps_lifecycle *owner, long long (*now_ms)(void),
                         int grace_ms) {
  int observed = ps_poll_exact(owner);
  if (observed != 0) return observed;
  ps_signal_owned(owner, SIGTERM);
  owner->state = PS_TERM_SENT;
  long long deadline = now_ms() + grace_ms;
  while (now_ms() < deadline) {
    observed = ps_poll_exact(owner);
    if (observed != 0) return observed;
    usleep(10000);
  }
  observed = ps_poll_exact(owner);
  if (observed != 0) return observed;
  ps_signal_owned(owner, SIGKILL);
  owner->state = PS_KILL_SENT;
  for (;;) {
    pid_t result = waitpid(owner->pid, &owner->status, 0);
    if (result == owner->pid) {
      owner->state = PS_REAPED;
      owner->pid = -1;
      owner->pgid = -1;
      ps_trace("WAITPID_REAPED\n");
      return 1;
    }
    if (result < 0 && errno == EINTR) continue;
    owner->state = PS_ANOMALY;
    owner->pid = -1;
    owner->pgid = -1;
    ps_trace("WAITPID_ANOMALY\n");
    return -1;
  }
}

#endif
