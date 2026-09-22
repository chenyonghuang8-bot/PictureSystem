#define _DARWIN_C_SOURCE 1
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int denied(int result) { return result < 0; }

static int derive_paths(char *original, size_t original_size,
                        char *root, size_t root_size,
                        char *second, size_t second_size,
                        char *secret, size_t secret_size) {
  if (original_size < 4096 || fcntl(3, F_GETPATH, original) != 0) return -1;
  const char *needle = strstr(original, "/originals/");
  if (needle == NULL) return -1;
  size_t root_length = (size_t)(needle - original);
  if (root_length == 0 || root_length >= root_size) return -1;
  memcpy(root, original, root_length);
  root[root_length] = '\0';
  const char *slash = strrchr(original, '/');
  if (slash == NULL) return -1;
  size_t parent_length = (size_t)(slash - original);
  if (parent_length + sizeof("/second-object") >= second_size) return -1;
  memcpy(second, original, parent_length);
  strcpy(second + parent_length, "/second-object");
  if (snprintf(secret, secret_size, "%s/.probe-secret", root) < 0) return -1;
  return 0;
}

static int probe_capabilities(void) {
  int fd_clean = fcntl(4, F_GETFD) < 0;
  char byte;
  if (lseek(3, 0, SEEK_SET) != 0 || read(3, &byte, 1) != 1 ||
      lseek(3, 0, SEEK_SET) != 0)
    return 20;

  char original[4096], root[4096], second[4096], secret[4096];
  if (derive_paths(original, sizeof(original), root, sizeof(root), second,
                   sizeof(second), secret, sizeof(secret)) != 0)
    return 21;

  int writes_denied = denied((int)write(3, "x", 1)) &&
                      denied((int)pwrite(3, "x", 1, 0)) &&
                      denied(ftruncate(3, 0)) && denied(fchmod(3, 0600));
  int path_fd = open(original, O_RDONLY | O_NOFOLLOW);
  int reopen_denied = path_fd < 0;
  if (path_fd >= 0) close(path_fd);
  path_fd = open(second, O_RDONLY | O_NOFOLLOW);
  int second_denied = path_fd < 0;
  if (path_fd >= 0) close(path_fd);
  path_fd = open(secret, O_RDONLY | O_NOFOLLOW);
  int secret_denied = path_fd < 0;
  if (path_fd >= 0) close(path_fd);
  DIR *directory = opendir(root);
  int browse_denied = directory == NULL;
  if (directory != NULL) closedir(directory);

  char renamed[4096];
  (void)snprintf(renamed, sizeof(renamed), "%s.renamed", original);
  int mutation_denied = denied(chmod(original, 0600)) &&
                        denied(unlink(original)) &&
                        denied(rename(original, renamed)) &&
                        denied(link(original, renamed));

  int socket_fd = socket(AF_INET, SOCK_STREAM, 0);
  int connect_denied = 0, listen_denied = 0;
  if (socket_fd < 0) {
    connect_denied = 1;
    listen_denied = 1;
  } else {
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons(9);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    connect_denied = connect(socket_fd, (struct sockaddr *)&address,
                             sizeof(address)) < 0;
    listen_denied = listen(socket_fd, 1) < 0;
    close(socket_fd);
  }
  struct addrinfo *addresses = NULL;
  int dns_denied = getaddrinfo("example.com", "80", NULL, &addresses) != 0;
  if (addresses != NULL) freeaddrinfo(addresses);

  int env_clean = getenv("DATABASE_URL") == NULL && getenv("HOME") == NULL &&
                  getenv("NODE_OPTIONS") == NULL && getenv("DYLD_INSERT_LIBRARIES") == NULL &&
                  getenv("PERL5OPT") == NULL;
  int ok = writes_denied && reopen_denied && second_denied && secret_denied &&
           browse_denied && mutation_denied && connect_denied &&
           listen_denied && dns_denied && env_clean && fd_clean;
  dprintf(STDOUT_FILENO,
          "{\"ok\":%s,\"read\":true,\"seek\":true,"
          "\"writeDenied\":%s,\"reopenDenied\":%s,"
          "\"secondDenied\":%s,\"secretDenied\":%s,"
          "\"browseDenied\":%s,\"mutationDenied\":%s,"
          "\"networkDenied\":%s,\"dnsDenied\":%s,"
          "\"envClean\":%s,\"fdAllowlist\":%s}\n",
          ok ? "true" : "false", writes_denied ? "true" : "false",
          reopen_denied ? "true" : "false", second_denied ? "true" : "false",
          secret_denied ? "true" : "false", browse_denied ? "true" : "false",
          mutation_denied ? "true" : "false",
          connect_denied && listen_denied ? "true" : "false",
          dns_denied ? "true" : "false", env_clean ? "true" : "false",
          fd_clean ? "true" : "false");
  if (ok) return 0;
  if (!writes_denied) return 23;
  if (!reopen_denied) return 24;
  if (!second_denied) return 25;
  if (!secret_denied) return 26;
  if (!browse_denied) return 27;
  if (!mutation_denied) return 28;
  if (!connect_denied || !listen_denied) return 29;
  if (!dns_denied) return 30;
  if (!env_clean) return 33;
  return 34;
}

int main(int argc, char **argv) {
  for (int fd = 4; fd < 1024; fd += 1) close(fd);
  if (argc != 2) return 64;
  if (strcmp(argv[1], "capabilities") == 0) return probe_capabilities();
  if (strcmp(argv[1], "fork-denied") == 0) {
    dprintf(STDOUT_FILENO, "FORK_ATTEMPT\n");
    pid_t child = fork();
    if (child < 0) return 36;
    if (child == 0) _exit(0);
    (void)waitpid(child, NULL, 0);
    return 0;
  }
  if (strcmp(argv[1], "exec-denied") == 0) {
    dprintf(STDOUT_FILENO, "EXEC_ATTEMPT\n");
    char *const exec_argv[] = {(char *)"true", NULL};
    execve("/usr/bin/true", exec_argv, environ);
    return 36;
  }
  if (strcmp(argv[1], "timeout-ignore-term") == 0) {
    signal(SIGTERM, SIG_IGN);
    for (;;) pause();
  }
  if (strcmp(argv[1], "crash") == 0) abort();
  if (strcmp(argv[1], "stdout-flood") == 0) {
    char block[4096];
    memset(block, 'x', sizeof(block));
    for (;;) if (write(STDOUT_FILENO, block, sizeof(block)) < 0) return 0;
  }
  if (strcmp(argv[1], "stderr-flood") == 0) {
    char block[4096];
    memset(block, 'e', sizeof(block));
    for (;;) if (write(STDERR_FILENO, block, sizeof(block)) < 0) return 0;
  }
  if (strcmp(argv[1], "invalid-json") == 0) {
    dprintf(STDOUT_FILENO, "not-json\n");
    return 0;
  }
  if (strcmp(argv[1], "deep-json") == 0) {
    for (int i = 0; i < 80; i += 1) dprintf(STDOUT_FILENO, "{\"x\":");
    dprintf(STDOUT_FILENO, "true");
    for (int i = 0; i < 80; i += 1) dprintf(STDOUT_FILENO, "}");
    dprintf(STDOUT_FILENO, "\n");
    return 0;
  }
  return 65;
}
