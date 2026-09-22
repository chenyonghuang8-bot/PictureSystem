#define _DARWIN_C_SOURCE 1
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <spawn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef PS_RENDERER_BOOTSTRAP_PATH
#error PS_RENDERER_BOOTSTRAP_PATH must be fixed at build time
#endif
#ifndef PS_DENIED_TEST_PATH
#error PS_DENIED_TEST_PATH must be fixed at build time
#endif

static int denied(int error) { return error == EPERM || error == EACCES; }
extern int sandbox_check(pid_t pid, const char *operation, int type, ...);

__attribute__((constructor)) static void module_loaded(void) {
  static const char event[] = "MODULE_LOADED\n";
  (void)write(2, event, sizeof(event) - 1);
}

/* Test-only module: exactly one byte is read only after bootstrap READY. */
int ps_synthetic_renderer_entry(void) {
  unsigned char byte;
  static const char first_read[] = "FIRST_FD3_READ\n";
  if (pread(3, &byte, 1, 0) != 1) return 75;
  if (write(2, first_read, sizeof(first_read) - 1) !=
      (ssize_t)(sizeof(first_read) - 1)) return 74;
  /* Probe descriptor existence, not sandbox policy. Low, sparse and >1023
   * parent descriptors must be absent after CLOEXEC_DEFAULT spawn. */
  for (int fd = 4; fd < 64; fd++) {
    errno = 0;
    if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) return 101;
  }
  for (int i = 0; i < 3; i++) {
    int fd = i == 0 ? 1500 : i == 1 ? 1601 : 1703;
    struct stat inherited;
    errno = 0;
    if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) return 102;
    errno = 0;
    if (fstat(fd, &inherited) != -1 || errno != EBADF) return 103;
    errno = 0;
    if (read(fd, &byte, 1) != -1 || errno != EBADF) return 104;
  }
  errno = 0;
  pid_t fork_result = fork();
  if (fork_result == 0) _exit(90);
  if (fork_result != -1 || !denied(errno)) return 77;
  char *const target_argv[] = {(char *)"/usr/bin/true", NULL};
  char *const clean_env[] = {(char *)"LANG=C", NULL};
  errno = 0;
  execve("/usr/bin/true", target_argv, clean_env);
  if (!denied(errno)) return 78;
  char *const self_argv[] = {(char *)PS_RENDERER_BOOTSTRAP_PATH, NULL};
  errno = 0;
  execve(PS_RENDERER_BOOTSTRAP_PATH, self_argv, clean_env);
  if (!denied(errno)) return 79;
  pid_t spawned = -1;
  int spawn_error = posix_spawn(&spawned, "/usr/bin/true", NULL, NULL,
                                target_argv, clean_env);
  if (spawn_error == 0) return 80;
  if (!denied(spawn_error)) return 81;
  if (getenv("HOME") != NULL || getenv("PATH") != NULL ||
      getenv("TMPDIR") != NULL || getenv("DYLD_INSERT_LIBRARIES") != NULL ||
      getenv("PS_PLUGIN_PATH") != NULL ||
      getenv("LANG") == NULL || strcmp(getenv("LANG"), "C") != 0 ||
      getenv("LC_ALL") == NULL || strcmp(getenv("LC_ALL"), "C") != 0)
    return 82;
  errno = 0;
  int other = open(PS_DENIED_TEST_PATH, O_RDONLY);
  if (other >= 0) { close(other); return 83; }
  if (!denied(errno)) return 84;
  errno = 0;
  int output = open(PS_DENIED_TEST_PATH, O_WRONLY | O_CREAT, 0600);
  if (output >= 0) { close(output); return 85; }
  if (!denied(errno)) return 86;
  errno = 0;
  int root = open("/", O_RDONLY | O_DIRECTORY);
  if (root >= 0) { close(root); return 87; }
  if (!denied(errno)) return 88;
  int socket_fd = socket(AF_INET, SOCK_STREAM, 0);
  if (socket_fd >= 0) {
    struct sockaddr_in loopback = {.sin_family = AF_INET, .sin_port = 9,
                                   .sin_addr.s_addr = 0x0100007f};
    errno = 0;
    int connected = connect(socket_fd, (struct sockaddr *)&loopback,
                            sizeof(loopback));
    int network_error = errno;
    close(socket_fd);
    if (connected == 0 || !denied(network_error)) return 89;
  } else if (!denied(errno)) return 90;
  int socket6 = socket(AF_INET6, SOCK_STREAM, 0);
  if (socket6 >= 0) {
    struct sockaddr_in6 loopback6 = {.sin6_family = AF_INET6,
                                     .sin6_port = 9,
                                     .sin6_addr = IN6ADDR_LOOPBACK_INIT};
    errno = 0;
    int connected = connect(socket6, (struct sockaddr *)&loopback6,
                            sizeof(loopback6));
    int network_error = errno;
    close(socket6);
    if (connected == 0 || !denied(network_error)) return 92;
  } else if (!denied(errno)) return 93;
  int udp = socket(AF_INET, SOCK_DGRAM, 0);
  if (udp >= 0) {
    struct sockaddr_in loopback = {.sin_family = AF_INET, .sin_port = 9,
                                   .sin_addr.s_addr = 0x0100007f};
    errno = 0;
    ssize_t sent = sendto(udp, &byte, 1, 0, (struct sockaddr *)&loopback,
                          sizeof(loopback));
    int network_error = errno;
    close(udp);
    if (sent >= 0 || !denied(network_error)) return 94;
  } else if (!denied(errno)) return 95;
  if (sandbox_check(getpid(), "mach-lookup", 1,
                    "com.apple.mDNSResponder") == 0) return 96;
  struct addrinfo *resolved = NULL;
  struct addrinfo hints = {.ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM};
  int dns = getaddrinfo("phase4d3a0-invalid.example.invalid", NULL, &hints,
                        &resolved);
  if (resolved != NULL) freeaddrinfo(resolved);
  if (dns == 0) return 97;
  errno = 0;
  if (write(3, &byte, 1) != -1 ||
      !(denied(errno) || errno == EBADF)) return 91;
  errno = 0;
  if (pwrite(3, &byte, 1, 0) != -1 ||
      !(denied(errno) || errno == EBADF)) return 98;
  errno = 0;
  if (ftruncate(3, 0) != -1 || !(denied(errno) || errno == EINVAL || errno == EBADF))
    return 99;
  errno = 0;
  if (fchmod(3, 0600) != -1 || !denied(errno)) return 100;
  static const char result[] = "{\"status\":\"ok\"}\n";
  return write(1, result, sizeof(result) - 1) == (ssize_t)(sizeof(result) - 1)
             ? 0
             : 76;
}
