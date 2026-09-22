#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <Foundation/Foundation.h>

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "webp/encode.h"
#include "image_renderer_header_gate.h"

#ifndef PS_RENDER_KIND
#error PS_RENDER_KIND must be a fixed build-time recipe (1 or 2)
#endif
#if PS_RENDER_KIND != 1 && PS_RENDER_KIND != 2
#error Unsupported render recipe
#endif

#define MAX_ORIGINAL_BYTES (512LL * 1024LL * 1024LL)
#define MAX_DIMENSION 16384LL
#define MAX_PIXELS 50000000LL
#define PROVIDER_READ_LIMIT (2LL * 1024LL * 1024LL * 1024LL)

__attribute__((constructor)) static void renderer_module_loaded(void) {
  static const char event[] = "RENDERER_MODULE_LOADED\n";
  (void)write(2, event, sizeof(event) - 1);
}

#if PS_RENDER_KIND == 1
#define RECIPE_NAME "THUMBNAIL"
#define RECIPE_BOX 480
#define RECIPE_QUALITY 75.0f
#define OUTPUT_LIMIT (512 * 1024)
#else
#define RECIPE_NAME "PREVIEW"
#define RECIPE_BOX 2560
#define RECIPE_QUALITY 82.0f
#define OUTPUT_LIMIT (4 * 1024 * 1024)
#endif

typedef struct {
  int fd;
  long long cumulative;
} original_provider;

typedef struct {
  size_t bytes;
  int failed;
} binary_writer;

static size_t provider_read(void *raw, void *buffer, off_t position,
                            size_t count) {
  original_provider *source = raw;
  if (position < 0 || source->cumulative >= PROVIDER_READ_LIMIT ||
      count > (size_t)(PROVIDER_READ_LIMIT - source->cumulative))
    return 0;
  size_t total = 0;
  while (total < count) {
    ssize_t n = pread(source->fd, (uint8_t *)buffer + total,
                      count - total, position + (off_t)total);
    if (n > 0) total += (size_t)n;
    else if (n < 0 && errno == EINTR) continue;
    else break;
  }
  source->cumulative += (long long)total;
  return total;
}

static void provider_release(void *raw) { free(raw); }

static int writer_callback(const uint8_t *data, size_t size,
                           const WebPPicture *picture) {
  binary_writer *writer = picture->custom_ptr;
  if (writer == NULL || writer->failed || size > OUTPUT_LIMIT - writer->bytes) {
    if (writer != NULL) writer->failed = 1;
    return 0;
  }
  size_t written = 0;
  while (written < size) {
    ssize_t n = write(4, data + written, size - written);
    if (n > 0) written += (size_t)n;
    else if (n < 0 && errno == EINTR) continue;
    else { writer->failed = 1; return 0; }
  }
  writer->bytes += size;
  return 1;
}

static int source_type(int fd) {
  static const char event[] = "FIRST_FD3_MEDIA_READ\n";
  (void)write(2, event, sizeof(event) - 1);
  uint8_t header[16] = {0};
  ssize_t n = pread(fd, header, sizeof(header), 0);
  if (n < 12) return 0;
  if (header[0] == 0xff && header[1] == 0xd8 && header[2] == 0xff) return 1;
  static const uint8_t png[] = {0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a};
  if (memcmp(header, png, sizeof(png)) == 0) return 2;
  if (memcmp(header, "RIFF", 4) == 0 && memcmp(header + 8, "WEBP", 4) == 0)
    return 3;
  if (memcmp(header, "GIF87a", 6) == 0 || memcmp(header, "GIF89a", 6) == 0)
    return 4;
  return 0;
}

static int number_property(NSDictionary *properties, CFStringRef key) {
  NSNumber *number = properties[(__bridge NSString *)key];
  return [number isKindOfClass:[NSNumber class]] &&
                 number.longLongValue > 0 && number.longLongValue <= INT32_MAX
             ? number.intValue : 0;
}

/* Untrusted media is first read only after the tiny bootstrap's READY. */
int ps_image_renderer_entry(void) {
  struct stat st;
  if (fstat(3, &st) != 0 || !S_ISREG(st.st_mode) ||
      st.st_size <= 0 || st.st_size > MAX_ORIGINAL_BYTES ||
      (fcntl(3, F_GETFL) & O_ACCMODE) != O_RDONLY ||
      (fcntl(4, F_GETFL) & O_ACCMODE) != O_WRONLY) return 75;
  int format = source_type(3);
  uint32_t header_width = 0, header_height = 0, header_frames = 0;
  if (format == 0 || !ps_renderer_header_gate(3, st.st_size, format,
      &header_width, &header_height, &header_frames)) return 75;

  original_provider *context = calloc(1, sizeof(*context));
  if (context == NULL) return 76;
  context->fd = 3;
  CGDataProviderDirectCallbacks callbacks = {
    .version = 0, .getBytePointer = NULL, .releaseBytePointer = NULL,
    .getBytesAtPosition = provider_read, .releaseInfo = provider_release,
  };
  CGDataProviderRef provider = CGDataProviderCreateDirect(context, st.st_size,
                                                         &callbacks);
  if (provider == NULL) { free(context); return 76; }
  NSDictionary *options = @{
    (__bridge NSString *)kCGImageSourceShouldCache: @NO,
    (__bridge NSString *)kCGImageSourceShouldCacheImmediately: @NO,
  };
  CGImageSourceRef source = CGImageSourceCreateWithDataProvider(
      provider, (__bridge CFDictionaryRef)options);
  CGDataProviderRelease(provider);
  if (source == NULL) return 77;
  size_t frame_count = CGImageSourceGetCount(source);
  if (frame_count == 0 || frame_count > 256 ||
      frame_count != header_frames) { CFRelease(source); return 78; }
  CFDictionaryRef copied = CGImageSourceCopyPropertiesAtIndex(
      source, 0, (__bridge CFDictionaryRef)options);
  if (copied == NULL) { CFRelease(source); return 77; }
  NSDictionary *properties = CFBridgingRelease(copied);
  int raw_width = number_property(properties, kCGImagePropertyPixelWidth);
  int raw_height = number_property(properties, kCGImagePropertyPixelHeight);
  int orientation = number_property(properties, kCGImagePropertyOrientation);
  if (orientation == 0) orientation = 1;
  if (raw_width <= 0 || raw_height <= 0 ||
      (uint32_t)raw_width != header_width ||
      (uint32_t)raw_height != header_height ||
      raw_width > MAX_DIMENSION ||
      raw_height > MAX_DIMENSION ||
      raw_width > MAX_PIXELS / raw_height) {
    CFRelease(source); return 86;
  }
  if (orientation < 1 || orientation > 8) {
    CFRelease(source); return 87;
  }
  BOOL swapped = orientation >= 5;
  int display_width = swapped ? raw_height : raw_width;
  int display_height = swapped ? raw_width : raw_height;
  int width = display_width, height = display_height;
  if (display_width > RECIPE_BOX || display_height > RECIPE_BOX) {
    if (display_width >= display_height) {
      width = RECIPE_BOX;
      height = (int)((int64_t)display_height * RECIPE_BOX / display_width);
    } else {
      height = RECIPE_BOX;
      width = (int)((int64_t)display_width * RECIPE_BOX / display_height);
    }
    if (width < 1) width = 1;
    if (height < 1) height = 1;
  }
  NSDictionary *thumb_options = @{
    (__bridge NSString *)kCGImageSourceShouldCache: @NO,
    (__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
    (__bridge NSString *)kCGImageSourceCreateThumbnailWithTransform: @YES,
    (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize: @(RECIPE_BOX),
  };
  CGImageRef image = CGImageSourceCreateThumbnailAtIndex(
      source, 0, (__bridge CFDictionaryRef)thumb_options);
  CFRelease(source);
  if (image == NULL) return 79;
  size_t bitmap_size = (size_t)width * (size_t)height * 4;
  uint8_t *bitmap = calloc(1, bitmap_size);
  if (bitmap == NULL) { CGImageRelease(image); return 80; }
  CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  if (color == NULL) { free(bitmap); CGImageRelease(image); return 80; }
  CGContextRef canvas = CGBitmapContextCreate(bitmap, width, height, 8,
      (size_t)width * 4, color,
      kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(color);
  if (canvas == NULL) { free(bitmap); CGImageRelease(image); return 80; }
  CGContextSetInterpolationQuality(canvas, kCGInterpolationHigh);
  CGContextDrawImage(canvas, CGRectMake(0, 0, width, height), image);
  CGContextRelease(canvas);
  CGImageRelease(image);
  for (size_t i = 0; i < bitmap_size; i += 4) {
    unsigned alpha = bitmap[i + 3];
    if (alpha == 0) { bitmap[i] = bitmap[i + 1] = bitmap[i + 2] = 0; }
    else if (alpha < 255) {
      for (int channel = 0; channel < 3; channel++) {
        unsigned unpremultiplied = (unsigned)bitmap[i + channel] * 255 + alpha / 2;
        bitmap[i + channel] = (uint8_t)((unpremultiplied / alpha) > 255
                                                   ? 255 : unpremultiplied / alpha);
      }
    }
  }
  WebPConfig config;
  WebPPicture picture;
  if (!WebPConfigInit(&config) || !WebPPictureInit(&picture)) {
    free(bitmap); return 81;
  }
  config.quality = RECIPE_QUALITY;
  config.method = 4;
  config.lossless = 0;
  config.thread_level = 0;
  picture.width = width;
  picture.height = height;
  binary_writer writer = {0};
  picture.writer = writer_callback;
  picture.custom_ptr = &writer;
  int imported = WebPPictureImportRGBA(&picture, bitmap, width * 4);
  free(bitmap);
  int encoded = imported && WebPEncode(&config, &picture);
  WebPPictureFree(&picture);
  if (!encoded || writer.failed || writer.bytes == 0) return 82;
  char control[256];
  int length = snprintf(control, sizeof(control),
      "{\"status\":\"ok\",\"kind\":\"%s\",\"recipe\":1,"
      "\"mime\":\"image/webp\",\"width\":%d,\"height\":%d,"
      "\"byteCount\":%zu,\"producerCode\":\"ENCODED\"}\n",
      RECIPE_NAME, width, height, writer.bytes);
  return length > 0 && (size_t)length < sizeof(control) &&
                 write(1, control, (size_t)length) == length ? 0 : 83;
}
