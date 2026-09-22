#define _DARWIN_C_SOURCE 1
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stddef.h>
#include <string.h>
#include <unistd.h>

/* Fixed synthetic module; never selected by the package renderer API. */
__attribute__((constructor)) static void loaded(void) {
  static const char event[] = "RENDERER_MODULE_LOADED\n";
  (void)write(2, event, sizeof(event) - 1);
}

static int flood(int fd, size_t size) {
  char bytes[4096];
  memset(bytes, fd == 4 ? 0x5a : 'F', sizeof(bytes));
  while (size > 0) {
    size_t amount = size < sizeof(bytes) ? size : sizeof(bytes);
    ssize_t n = write(fd, bytes, amount);
    if (n <= 0) return 1;
    size -= (size_t)n;
  }
  return 0;
}

int ps_image_renderer_entry(void) {
  char mode;
  static const char first_read[] = "FIRST_FD3_MEDIA_READ\n";
  if (write(2, first_read, sizeof(first_read) - 1) < 0 ||
      pread(3, &mode, 1, 0) != 1) return 75;
  switch (mode) {
    case 'B': return flood(4, 4 * 1024 * 1024 + 1) ? 82 : 0;
    case 'P':
      if (flood(4, 4 * 1024 * 1024)) return 82;
      break;
    case 'C': return flood(1, 4097) ? 82 : 0;
    case 'E': return flood(2, 16385) ? 82 : 0;
    case 'T': for (;;) pause();
    case 'X': raise(SIGSEGV); return 82;
    case 'I':
      if (write(4, "x", 1) != 1 || write(1, "not-json\n", 9) != 9)
        return 82;
      return 0;
    case 'S':
      if (write(4, "x", 1) != 1) return 82;
      break;
    case 'H':
      for (int i = 0; i < 3; i++) {
        int fd = i == 0 ? 1500 : i == 1 ? 1601 : 1703;
        errno = 0;
        if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) return 93;
      }
      if (write(4, "ok", 2) != 2) return 82;
      break;
    default: return 82;
  }
  static const char control[] =
      "{\"status\":\"ok\",\"kind\":\"PREVIEW\",\"recipe\":1,"
      "\"mime\":\"image/webp\",\"width\":1,\"height\":1,"
      "\"byteCount\":2,\"producerCode\":\"ENCODED\"}\n";
  return write(1, control, sizeof(control) - 1) == sizeof(control) - 1
             ? 0 : 82;
}
