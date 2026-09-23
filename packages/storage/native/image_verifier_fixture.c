#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <webp/encode.h>

static int write_encoded(const char *directory, const char *name,
                         const uint8_t *rgba, int width, int height) {
  char path[512];
  if (snprintf(path, sizeof(path), "%s/%s", directory, name) >= (int)sizeof(path))
    return 70;
  WebPConfig config;
  WebPPicture picture;
  if (WebPConfigInit(&config) == 0 || WebPPictureInit(&picture) == 0) return 71;
  config.lossless = 0;
  config.quality = 90;
  config.exact = 1;
  if (WebPValidateConfig(&config) == 0) return 72;
  picture.width = width;
  picture.height = height;
  picture.use_argb = 1;
  if (WebPPictureImportRGBA(&picture, rgba, width * 4) == 0) return 73;
  WebPMemoryWriter writer;
  WebPMemoryWriterInit(&writer);
  picture.writer = WebPMemoryWrite;
  picture.custom_ptr = &writer;
  if (WebPEncode(&config, &picture) == 0) {
    WebPPictureFree(&picture);
    WebPMemoryWriterClear(&writer);
    return 74;
  }
  FILE *output = fopen(path, "wb");
  if (output == NULL ||
      fwrite(writer.mem, 1, writer.size, output) != writer.size) {
    if (output != NULL) fclose(output);
    WebPPictureFree(&picture);
    WebPMemoryWriterClear(&writer);
    return 75;
  }
  fclose(output);
  WebPPictureFree(&picture);
  WebPMemoryWriterClear(&writer);
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  enum { width = 8, height = 4 };
  uint8_t opaque[width * height * 4];
  uint8_t alpha[width * height * 4];
  memset(opaque, 200, sizeof(opaque));
  memset(alpha, 180, sizeof(alpha));
  for (int index = 3; index < width * height * 4; index += 4) {
    opaque[index] = 255;
    alpha[index] = 255;
  }
  alpha[3] = 0;
  int opaque_result = write_encoded(argv[1], "opaque.webp", opaque, width, height);
  if (opaque_result != 0) return opaque_result;
  return write_encoded(argv[1], "alpha.webp", alpha, width, height);
}
