#define _DARWIN_C_SOURCE 1
#include <sandbox.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef PS_RENDERER_MODULE_PATH
#error PS_RENDERER_MODULE_PATH must be set to the fixed package-owned module
#endif

/* D3a-0 candidate only. The final profile is embedded, never read from input. */
static const char kFinalProfile[] =
    "(version 1)\n"
    "(deny default)\n"
    "(allow file-read* (literal \"/dev/null\"))\n"
    "(allow file-read* (literal \"" PS_RENDERER_MODULE_PATH "\"))\n"
    "(allow file-read-metadata (path-ancestors \"" PS_RENDERER_MODULE_PATH "\"))\n"
    "(deny file-write*)\n"
    "(deny network*)\n"
    "(deny process-fork)\n"
    "(deny process-exec)\n";

/* The SDK omits this deprecated query; a failed query is a failed gate. */
extern int sandbox_check(pid_t pid, const char *operation, int type, ...);

static int exact_fd(int fd, int mode, int regular) {
  struct stat st;
  int flags = fcntl(fd, F_GETFL);
  return flags >= 0 && (flags & O_ACCMODE) == mode &&
         fstat(fd, &st) == 0 && (!regular || S_ISREG(st.st_mode));
}

int main(int argc, char **argv) {
#ifndef PS_STARTUP_DIAGNOSTIC
  if (argc != 1 || argv == NULL || argv[0] == NULL ||
      !exact_fd(0, O_RDONLY, 0) || !exact_fd(1, O_WRONLY, 0) ||
      !exact_fd(2, O_WRONLY, 0) || !exact_fd(3, O_RDONLY, 1))
    return 64;
#else
  (void)argc;
  (void)argv;
  (void)exact_fd;
#endif

#ifdef PS_FORCE_EARLY_READ
  unsigned char early_byte;
  (void)pread(3, &early_byte, 1, 0);
  static const char early_event[] = "EARLY_FD3_READ\n";
  (void)write(2, early_event, sizeof(early_event) - 1);
#endif

  char *error = NULL;
#ifdef PS_FORCE_ACTIVATION_FAILURE
  return 70;
#endif
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  int activated = sandbox_init(kFinalProfile, 0, &error);
  if (error != NULL) sandbox_free_error(error);
#pragma clang diagnostic pop
  if (activated != 0) return 70;
  if (sandbox_check(getpid(), "process-exec", 1) == 0 ||
      sandbox_check(getpid(), "process-fork", 1) == 0)
    return 71;
  static const char activated_event[] = "SANDBOX_ACTIVATED\n";
  if (write(2, activated_event, sizeof(activated_event) - 1) !=
      (ssize_t)(sizeof(activated_event) - 1)) return 71;

#ifdef PS_FORCE_NO_READY
  return 72;
#endif
#ifdef PS_FORCE_CRASH_BEFORE_READY
  raise(SIGABRT);
  return 72;
#endif
#ifdef PS_FORCE_TIMEOUT_BEFORE_READY
  for (;;) pause();
#endif
#ifdef PS_FORCE_IGNORE_TERM
  if (signal(SIGTERM, SIG_IGN) == SIG_ERR) return 72;
  for (;;) pause();
#endif
#ifdef PS_FORCE_BAD_READY
  static const char bad_ready[] = "PS_RENDER_WRONG_V1\n";
  (void)write(1, bad_ready, sizeof(bad_ready) - 1);
  return 72;
#endif

  static const char ready[] = "PS_RENDER_READY_V1\n";
  if (write(1, ready, sizeof(ready) - 1) != (ssize_t)(sizeof(ready) - 1))
    return 72;
#ifdef PS_FORCE_DUP_READY
  if (write(1, ready, sizeof(ready) - 1) != (ssize_t)(sizeof(ready) - 1))
    return 72;
#endif

  void *module = dlopen(PS_RENDERER_MODULE_PATH, RTLD_NOW | RTLD_LOCAL);
  if (module == NULL) return 73;
  int (*entry)(void) = (int (*)(void))dlsym(module, "ps_synthetic_renderer_entry");
  if (entry == NULL) return 74;
  int result = entry();
  dlclose(module);
  return result;
}
