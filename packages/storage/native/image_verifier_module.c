#define _DARWIN_C_SOURCE 1
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#include <webp/decode.h>

#ifndef PS_VERIFIER_BOOTSTRAP_PATH
#error PS_VERIFIER_BOOTSTRAP_PATH must be fixed at build time
#endif
#ifndef PS_DENIED_TEST_PATH
#error PS_DENIED_TEST_PATH must be fixed at build time
#endif

#define VERIFY_BYTE_CAP (4U * 1024U * 1024U)
#define VERIFY_AXIS_CAP 2560

extern int sandbox_check(pid_t pid, const char *operation, int type, ...);

__attribute__((constructor)) static void verifier_loaded(void) {
  static const char event[] = "VERIFIER_MODULE_LOADED\n";
  (void)write(2, event, sizeof(event) - 1);
}

static int denied(int error) { return error == EPERM || error == EACCES; }

static uint32_t le32(const unsigned char *bytes) {
  return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) |
         ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

/* Recipe 1 container: one static VP8 image, or VP8X + optional ALPH + VP8.
 * EXIF, XMP, ICCP, ANIM, ANMF, VP8L and unknown chunks are rejected here,
 * before any pixel buffer is allocated. */
static int container_allows(const unsigned char *bytes, size_t size,
                            int *alpha_flag) {
  if (size < 12 || memcmp(bytes, "RIFF", 4) != 0 ||
      memcmp(bytes + 8, "WEBP", 4) != 0)
    return 0;
  uint32_t declared = le32(bytes + 4);
  if ((size_t)declared + 8 != size || declared < 4) return 0;
  size_t offset = 12;
  int seen_vp8x = 0;
  int seen_alph = 0;
  int seen_vp8 = 0;
  *alpha_flag = 0;
  while (offset + 8 <= size) {
    char tag[5] = {0};
    memcpy(tag, bytes + offset, 4);
    uint32_t chunk = le32(bytes + offset + 4);
    offset += 8;
    if (chunk > size - offset) return 0;
    int known = 0;
    if (strcmp(tag, "VP8 ") == 0) {
      if (seen_vp8 || chunk < 10) return 0;
      seen_vp8 = 1;
      known = 1;
    } else if (strcmp(tag, "VP8X") == 0) {
      if (seen_vp8x || seen_alph || seen_vp8 || chunk != 10) return 0;
      unsigned char flags = bytes[offset];
      if ((flags & (unsigned char)~0x10) != 0) return 0;
      *alpha_flag = (flags & 0x10) != 0;
      uint32_t width = 1u + (bytes[offset + 4] | (bytes[offset + 5] << 8) |
                             (bytes[offset + 6] << 16));
      uint32_t height = 1u + (bytes[offset + 7] | (bytes[offset + 8] << 8) |
                              (bytes[offset + 9] << 16));
      if (width == 0 || height == 0 || width > VERIFY_AXIS_CAP ||
          height > VERIFY_AXIS_CAP)
        return 0;
      seen_vp8x = 1;
      known = 1;
    } else if (strcmp(tag, "ALPH") == 0) {
      if (!seen_vp8x || !*alpha_flag || seen_alph || seen_vp8 || chunk < 1)
        return 0;
      seen_alph = 1;
      known = 1;
    }
    if (!known) return 0;
    offset += chunk;
    if ((chunk & 1u) != 0) {
      if (offset >= size) return 0;
      offset += 1;
    }
    if (seen_vp8) break;
  }
  if (offset != size || !seen_vp8) return 0;
  if (*alpha_flag && !seen_alph) return 0;
  if (!*alpha_flag && seen_alph) return 0;
  return 1;
}

static int isolation_holds(void) {
  unsigned char byte = 0;
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
  char *const self_argv[] = {(char *)PS_VERIFIER_BOOTSTRAP_PATH, NULL};
  errno = 0;
  execve(PS_VERIFIER_BOOTSTRAP_PATH, self_argv, clean_env);
  if (!denied(errno)) return 79;
  pid_t spawned = -1;
  int spawn_error = posix_spawn(&spawned, "/usr/bin/true", NULL, NULL,
                                target_argv, clean_env);
  if (spawn_error == 0) return 80;
  if (!denied(spawn_error)) return 81;
  errno = 0;
  int other = open(PS_DENIED_TEST_PATH, O_RDONLY);
  if (other >= 0) {
    close(other);
    return 83;
  }
  if (!denied(errno)) return 84;
  errno = 0;
  int output = open(PS_DENIED_TEST_PATH, O_WRONLY | O_CREAT, 0600);
  if (output >= 0) {
    close(output);
    return 85;
  }
  if (!denied(errno)) return 86;
  errno = 0;
  int root = open("/", O_RDONLY | O_DIRECTORY);
  if (root >= 0) {
    close(root);
    return 87;
  }
  if (!denied(errno)) return 88;
  int socket_fd = socket(AF_INET, SOCK_STREAM, 0);
  if (socket_fd >= 0) {
    struct sockaddr_in loopback = {.sin_family = AF_INET,
                                   .sin_port = htons(9),
                                   .sin_addr.s_addr = htonl(0x7f000001)};
    errno = 0;
    int connected = connect(socket_fd, (struct sockaddr *)&loopback,
                            sizeof(loopback));
    int network_error = errno;
    close(socket_fd);
    if (connected == 0 || !denied(network_error)) return 89;
  } else if (!denied(errno)) {
    return 90;
  }
  if (sandbox_check(getpid(), "mach-lookup", 1, "com.apple.mDNSResponder") == 0)
    return 96;
  struct addrinfo *resolved = NULL;
  struct addrinfo hints = {.ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM};
  int dns = getaddrinfo("phase4d3b0-invalid.example.invalid", NULL, &hints,
                        &resolved);
  if (resolved != NULL) freeaddrinfo(resolved);
  if (dns == 0) return 97;
  errno = 0;
  if (write(3, &byte, 1) != -1 || !(denied(errno) || errno == EBADF)) return 91;
  return 0;
}

int ps_verify_output_entry(void) {
  unsigned char first = 0;
  static const char first_read[] = "FIRST_FD3_READ\n";
  if (pread(3, &first, 1, 0) != 1) return 75;
  if (write(2, first_read, sizeof(first_read) - 1) !=
      (ssize_t)(sizeof(first_read) - 1))
    return 74;
  int isolated = isolation_holds();
  if (isolated != 0) return isolated;

  unsigned char *bytes = malloc(VERIFY_BYTE_CAP + 1);
  if (bytes == NULL) return 112;
  size_t size = 0;
  while (size <= VERIFY_BYTE_CAP) {
    ssize_t count = pread(3, bytes + size, VERIFY_BYTE_CAP + 1 - size,
                          (off_t)size);
    if (count > 0) {
      size += (size_t)count;
      continue;
    }
    if (count == 0) break;
    if (errno == EINTR) continue;
    free(bytes);
    return 113;
  }
  if (size == 0 || size > VERIFY_BYTE_CAP) {
    free(bytes);
    return 114;
  }
  int alpha_flag = 0;
  if (!container_allows(bytes, size, &alpha_flag)) {
    free(bytes);
    return 110;
  }

  WebPDecoderConfig config;
  if (WebPInitDecoderConfig(&config) == 0) {
    free(bytes);
    return 115;
  }
  if (WebPGetFeatures(bytes, size, &config.input) != VP8_STATUS_OK ||
      config.input.has_animation != 0 || config.input.width <= 0 ||
      config.input.height <= 0 || config.input.width > VERIFY_AXIS_CAP ||
      config.input.height > VERIFY_AXIS_CAP ||
      (config.input.has_alpha != 0) != (alpha_flag != 0)) {
    free(bytes);
    return 110;
  }
  int width = config.input.width;
  int height = config.input.height;
  if ((size_t)width > (SIZE_MAX / 4) / (size_t)height) {
    free(bytes);
    return 114;
  }
  size_t pixels = (size_t)width * (size_t)height * 4;
  uint8_t *rgba = malloc(pixels);
  if (rgba == NULL) {
    free(bytes);
    return 112;
  }
  config.options.use_threads = 0;
  config.options.use_scaling = 0;
  config.options.use_cropping = 0;
  config.output.colorspace = MODE_RGBA;
  config.output.u.RGBA.rgba = rgba;
  config.output.u.RGBA.stride = width * 4;
  config.output.u.RGBA.size = pixels;
  config.output.is_external_memory = 1;
  VP8StatusCode decoded = WebPDecode(bytes, size, &config);
  free(bytes);
  if (decoded != VP8_STATUS_OK || config.output.width != width ||
      config.output.height != height || config.output.colorspace != MODE_RGBA) {
    free(rgba);
    WebPFreeDecBuffer(&config.output);
    return 111;
  }
  int decoded_alpha = 0;
  for (size_t index = 3; index < pixels; index += 4) {
    if (rgba[index] != 255) decoded_alpha = 1;
  }
  free(rgba);
  WebPFreeDecBuffer(&config.output);
  if (alpha_flag == 0 && decoded_alpha != 0) return 111;
  if (alpha_flag != 0 && config.input.has_alpha == 0) return 111;

  char json[160];
  int written =
      snprintf(json, sizeof(json),
               "{\"status\":\"ok\",\"width\":%d,\"height\":%d,"
               "\"static\":true,\"alpha\":%s,\"transparent\":%s}\n",
               width, height, alpha_flag ? "true" : "false",
               decoded_alpha ? "true" : "false");
  if (written < 0 || (size_t)written >= sizeof(json)) return 116;
  if (write(1, json, (size_t)written) != written) return 117;
  return 0;
}
