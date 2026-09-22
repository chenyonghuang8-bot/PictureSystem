#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>

#include <fcntl.h>
#include <math.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_ORIGINAL_BYTES (512LL * 1024LL * 1024LL)
#define MAX_DIMENSION 16384LL
#define MAX_PIXELS 50000000LL

typedef struct {
  int fd;
} fd_provider_t;

typedef struct {
  NSString *mediaType;
  NSString *mime;
  NSString *container;
  BOOL imageIOCandidate;
  BOOL partial;
} format_info_t;

static size_t read_at_position(void *raw, void *buffer, off_t position,
                               size_t count) {
  fd_provider_t *provider = raw;
  size_t total = 0;
  while (total < count) {
    ssize_t amount = pread(provider->fd, (unsigned char *)buffer + total,
                           count - total, position + (off_t)total);
    if (amount > 0) {
      total += (size_t)amount;
      continue;
    }
    if (amount < 0 && errno == EINTR) continue;
    break;
  }
  return total;
}

static void release_provider(void *raw) { free(raw); }

static NSString *bounded_text(id value, NSUInteger maximumBytes) {
  if (![value isKindOfClass:[NSString class]]) return nil;
  NSString *normalized = [(NSString *)value precomposedStringWithCompatibilityMapping];
  NSMutableString *clean = [NSMutableString string];
  [normalized enumerateSubstringsInRange:NSMakeRange(0, normalized.length)
                                  options:NSStringEnumerationByComposedCharacterSequences
                               usingBlock:^(NSString *substring, NSRange range,
                                            NSRange enclosingRange, BOOL *stop) {
    (void)range;
    (void)enclosingRange;
    (void)stop;
    BOOL rejected = NO;
    for (NSUInteger index = 0; index < substring.length; index += 1) {
      unichar scalar = [substring characterAtIndex:index];
      if (scalar < 0x20 || (scalar >= 0x7f && scalar <= 0x9f) ||
          scalar == 0x200b || scalar == 0x200c || scalar == 0x200d ||
          scalar == 0x200e || scalar == 0x200f ||
          (scalar >= 0x202a && scalar <= 0x202e) ||
          (scalar >= 0x2066 && scalar <= 0x2069) || scalar == 0xfeff) {
        rejected = YES;
        break;
      }
    }
    if (!rejected) [clean appendString:substring];
  }];
  while ([clean dataUsingEncoding:NSUTF8StringEncoding].length > maximumBytes &&
         clean.length > 0) {
    [clean deleteCharactersInRange:[clean rangeOfComposedCharacterSequenceAtIndex:clean.length - 1]];
  }
  NSString *trimmed = [clean stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  return trimmed.length == 0 ? nil : trimmed;
}

static BOOL bytes_equal(const unsigned char *bytes, const char *literal,
                        size_t count) {
  return memcmp(bytes, literal, count) == 0;
}

static uint16_t tiff_u16(const unsigned char *bytes, BOOL little) {
  return little ? (uint16_t)(bytes[0] | ((uint16_t)bytes[1] << 8))
                : (uint16_t)(((uint16_t)bytes[0] << 8) | bytes[1]);
}

static uint32_t tiff_u32(const unsigned char *bytes, BOOL little) {
  return little
             ? (uint32_t)(bytes[0] | ((uint32_t)bytes[1] << 8) |
                          ((uint32_t)bytes[2] << 16) |
                          ((uint32_t)bytes[3] << 24))
             : (uint32_t)(((uint32_t)bytes[0] << 24) |
                          ((uint32_t)bytes[1] << 16) |
                          ((uint32_t)bytes[2] << 8) | bytes[3]);
}

static int orientation_from_tiff(const unsigned char *bytes, size_t size) {
  if (size < 8) return -1;
  BOOL little = bytes[0] == 'I' && bytes[1] == 'I';
  BOOL big = bytes[0] == 'M' && bytes[1] == 'M';
  if ((!little && !big) || tiff_u16(bytes + 2, little) != 42) return -1;
  uint32_t offset = tiff_u32(bytes + 4, little);
  if (offset > size - 2) return -1;
  uint16_t count = tiff_u16(bytes + offset, little);
  if (count > 256 || (size_t)offset + 2 + (size_t)count * 12 > size) return -1;
  for (uint16_t index = 0; index < count; index += 1) {
    const unsigned char *entry = bytes + offset + 2 + (size_t)index * 12;
    if (tiff_u16(entry, little) == 0x0112 &&
        tiff_u16(entry + 2, little) == 3 &&
        tiff_u32(entry + 4, little) == 1)
      return (int)tiff_u16(entry + 8, little);
  }
  return -1;
}

static BOOL dimensions_from_tiff(const unsigned char *bytes, size_t size,
                                 uint32_t *width, uint32_t *height) {
  if (size < 8) return NO;
  BOOL little = bytes[0] == 'I' && bytes[1] == 'I';
  BOOL big = bytes[0] == 'M' && bytes[1] == 'M';
  if ((!little && !big) || tiff_u16(bytes + 2, little) != 42) return NO;
  uint32_t offset = tiff_u32(bytes + 4, little);
  if (offset > size - 2) return NO;
  uint16_t count = tiff_u16(bytes + offset, little);
  if (count > 256 || (size_t)offset + 2 + (size_t)count * 12 > size) return NO;
  BOOL hasWidth = NO, hasHeight = NO;
  for (uint16_t index = 0; index < count; index += 1) {
    const unsigned char *entry = bytes + offset + 2 + (size_t)index * 12;
    uint16_t tag = tiff_u16(entry, little);
    uint16_t type = tiff_u16(entry + 2, little);
    if ((tag != 0x0100 && tag != 0x0101) ||
        (type != 3 && type != 4) || tiff_u32(entry + 4, little) != 1)
      continue;
    uint32_t value = type == 3 ? tiff_u16(entry + 8, little)
                               : tiff_u32(entry + 8, little);
    if (tag == 0x0100) {
      *width = value;
      hasWidth = YES;
    } else {
      *height = value;
      hasHeight = YES;
    }
  }
  return hasWidth && hasHeight;
}

static BOOL raw_tiff_dimensions(int fd, off_t fileSize, uint32_t *width,
                                uint32_t *height) {
  size_t amount = fileSize > 64 * 1024 ? 64 * 1024 : (size_t)fileSize;
  if (amount < 8) return NO;
  unsigned char *buffer = malloc(amount);
  if (buffer == NULL) return NO;
  ssize_t readAmount = pread(fd, buffer, amount, 0);
  BOOL found = readAmount >= 8 &&
               dimensions_from_tiff(buffer, (size_t)readAmount, width, height);
  free(buffer);
  return found;
}

static int raw_orientation(int fd, off_t fileSize) {
  size_t amount = fileSize > 1024 * 1024 ? 1024 * 1024 : (size_t)fileSize;
  if (amount < 8) return -1;
  unsigned char *buffer = malloc(amount);
  if (buffer == NULL) return -1;
  ssize_t readAmount = pread(fd, buffer, amount, 0);
  if (readAmount < 8) {
    free(buffer);
    return -1;
  }
  size_t size = (size_t)readAmount;
  int result = orientation_from_tiff(buffer, size);
  if (result < 0) {
    for (size_t index = 0; index + 14 <= size; index += 1) {
      if (memcmp(buffer + index, "Exif\0\0", 6) == 0) {
        result = orientation_from_tiff(buffer + index + 6, size - index - 6);
        if (result >= 0) break;
      }
    }
  }
  free(buffer);
  return result;
}

static BOOL fd_contains_marker(int fd, off_t fileSize, const char *marker) {
  size_t amount = fileSize > 1024 * 1024 ? 1024 * 1024 : (size_t)fileSize;
  size_t markerLength = strlen(marker);
  if (amount < markerLength) return NO;
  unsigned char *buffer = malloc(amount);
  if (buffer == NULL) return NO;
  ssize_t readAmount = pread(fd, buffer, amount, 0);
  BOOL found = NO;
  if (readAmount >= (ssize_t)markerLength) {
    for (size_t index = 0; index + markerLength <= (size_t)readAmount;
         index += 1) {
      if (memcmp(buffer + index, marker, markerLength) == 0) {
        found = YES;
        break;
      }
    }
  }
  free(buffer);
  return found;
}

static format_info_t sniff_format(int fd) {
  unsigned char bytes[32] = {0};
  ssize_t amount = pread(fd, bytes, sizeof(bytes), 0);
  format_info_t unknown = {@"UNKNOWN", @"application/octet-stream", @"UNKNOWN", NO, NO};
  if (amount < 12) return unknown;
  if (bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff)
    return (format_info_t){@"IMAGE", @"image/jpeg", @"JPEG", YES, NO};
  static const unsigned char png[] = {0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a};
  if (memcmp(bytes, png, sizeof(png)) == 0)
    return (format_info_t){@"IMAGE", @"image/png", @"PNG", YES, NO};
  if (bytes_equal(bytes, "GIF87a", 6) || bytes_equal(bytes, "GIF89a", 6))
    return (format_info_t){@"IMAGE", @"image/gif", @"GIF", YES, NO};
  if (bytes_equal(bytes, "RIFF", 4) && bytes_equal(bytes + 8, "WEBP", 4))
    return (format_info_t){@"IMAGE", @"image/webp", @"WEBP", YES, NO};
  if ((bytes[0] == 'I' && bytes[1] == 'I' && bytes[2] == 42 && bytes[3] == 0) ||
      (bytes[0] == 'M' && bytes[1] == 'M' && bytes[2] == 0 && bytes[3] == 42))
    return (format_info_t){@"IMAGE", @"image/x-adobe-dng", @"DNG_RAW", YES, YES};
  if (bytes_equal(bytes + 4, "ftyp", 4)) {
    const unsigned char *brand = bytes + 8;
    if (bytes_equal(brand, "heic", 4) || bytes_equal(brand, "heix", 4) ||
        bytes_equal(brand, "hevc", 4) || bytes_equal(brand, "hevx", 4) ||
        bytes_equal(brand, "mif1", 4))
      return (format_info_t){@"IMAGE", @"image/heic", @"HEIC", YES, YES};
    if (bytes_equal(brand, "qt  ", 4))
      return (format_info_t){@"VIDEO", @"video/quicktime", @"MOV", NO, YES};
    return (format_info_t){@"VIDEO", @"video/mp4", @"MP4", NO, YES};
  }
  return unknown;
}

static BOOL imageio_supports(format_info_t format) {
  CFArrayRef identifiers = CGImageSourceCopyTypeIdentifiers();
  if (identifiers == NULL) return NO;
  BOOL supported = NO;
  for (CFIndex index = 0; index < CFArrayGetCount(identifiers); index += 1) {
    CFStringRef raw = CFArrayGetValueAtIndex(identifiers, index);
    if (raw == NULL) continue;
    NSString *identifier = [(__bridge NSString *)raw lowercaseString];
    if ([format.container isEqualToString:@"HEIC"] &&
        ([identifier containsString:@"heic"] ||
         [identifier containsString:@"heif"])) {
      supported = YES;
      break;
    }
    if ([format.container isEqualToString:@"DNG_RAW"] &&
        ([identifier containsString:@"raw"] ||
         [identifier containsString:@"digital-negative"] ||
         [identifier containsString:@"tiff"])) {
      supported = YES;
      break;
    }
  }
  CFRelease(identifiers);
  return supported;
}

static NSNumber *number_value(NSDictionary *dictionary, CFStringRef key) {
  id value = dictionary[(__bridge NSString *)key];
  return [value isKindOfClass:[NSNumber class]] ? value : nil;
}

static NSString *string_value(NSDictionary *dictionary, CFStringRef key,
                              NSUInteger limit) {
  return bounded_text(dictionary[(__bridge NSString *)key], limit);
}

static NSMutableDictionary *base_result(format_info_t format,
                                        NSString *status) {
  return [@{
    @"schemaVersion": @1,
    @"parserStatus": status,
    @"detectedMediaType": format.mediaType,
    @"detectedMime": format.mime,
    @"container": format.container,
    @"width": [NSNull null],
    @"height": [NSNull null],
    @"orientationRaw": [NSNull null],
    @"isAnimated": @NO,
    @"captureCandidates": [NSMutableArray array],
    @"gpsLatitudeRaw": [NSNull null],
    @"gpsLongitudeRaw": [NSNull null],
    @"cameraMake": [NSNull null],
    @"cameraModel": [NSNull null],
    @"durationMs": [NSNull null],
    @"rotationDegrees": [NSNull null],
    @"videoCodec": [NSNull null],
    @"warnings": [NSMutableArray array],
  } mutableCopy];
}

static void append_capture_candidate(NSMutableArray *candidates,
                                     NSString *source, NSString *local,
                                     NSString *offset, NSString *subsecond) {
  if (local == nil || candidates.count >= 4) return;
  [candidates addObject:@{
    @"source": source,
    @"local": local,
    @"offset": offset ?: [NSNull null],
    @"subsecond": subsecond ?: [NSNull null],
  }];
}

static double gps_value(id raw, BOOL *ok) {
  if ([raw isKindOfClass:[NSNumber class]]) {
    double value = [raw doubleValue];
    *ok = isfinite(value);
    return value;
  }
  if ([raw isKindOfClass:[NSString class]]) {
    NSScanner *scanner = [NSScanner scannerWithString:raw];
    double value = 0;
    *ok = [scanner scanDouble:&value] && scanner.isAtEnd && isfinite(value);
    return value;
  }
  *ok = NO;
  return 0;
}

static int emit_json(NSDictionary *result) {
  if (![NSJSONSerialization isValidJSONObject:result]) return 70;
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:result
                                                  options:NSJSONWritingSortedKeys
                                                    error:&error];
  if (data == nil || error != nil || data.length == 0 || data.length > 65536)
    return 70;
  const unsigned char newline = '\n';
  if (write(STDOUT_FILENO, data.bytes, data.length) != (ssize_t)data.length ||
      write(STDOUT_FILENO, &newline, 1) != 1)
    return 71;
  return 0;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    for (int fd = 4; fd < 1024; fd += 1) close(fd);
    if (argc != 2 || strcmp(argv[1], "metadata") != 0) return 64;
    struct stat status;
    if (fstat(3, &status) != 0 || !S_ISREG(status.st_mode)) return 65;
    format_info_t format = sniff_format(3);
    if (status.st_size <= 0) return emit_json(base_result(format, @"INVALID_MEDIA"));
    if (status.st_size > MAX_ORIGINAL_BYTES)
      return emit_json(base_result(format, @"RESOURCE_LIMIT"));
    if ([format.mediaType isEqualToString:@"UNKNOWN"])
      return emit_json(base_result(format, @"INVALID_MEDIA"));
    if (!format.imageIOCandidate)
      return emit_json(base_result(format, @"UNSUPPORTED"));
    if ([format.container isEqualToString:@"DNG_RAW"]) {
      uint32_t rawWidth = 0, rawHeight = 0;
      if (raw_tiff_dimensions(3, status.st_size, &rawWidth, &rawHeight) &&
          (rawWidth == 0 || rawHeight == 0 || rawWidth > MAX_DIMENSION ||
           rawHeight > MAX_DIMENSION || rawWidth > MAX_PIXELS / rawHeight))
        return emit_json(base_result(format, @"RESOURCE_LIMIT"));
    }

    fd_provider_t *context = calloc(1, sizeof(*context));
    if (context == NULL) return 70;
    context->fd = 3;
    CGDataProviderDirectCallbacks callbacks = {
      .version = 0,
      .getBytePointer = NULL,
      .releaseBytePointer = NULL,
      .getBytesAtPosition = read_at_position,
      .releaseInfo = release_provider,
    };
    CGDataProviderRef provider =
        CGDataProviderCreateDirect(context, status.st_size, &callbacks);
    if (provider == NULL) {
      free(context);
      return 70;
    }
    NSDictionary *options = @{
      (__bridge NSString *)kCGImageSourceShouldCache: @NO,
      (__bridge NSString *)kCGImageSourceShouldCacheImmediately: @NO,
    };
    CGImageSourceRef source = CGImageSourceCreateWithDataProvider(
        provider, (__bridge CFDictionaryRef)options);
    CGDataProviderRelease(provider);
    if (source == NULL || CGImageSourceGetCount(source) == 0) {
      if (source != NULL) CFRelease(source);
      NSString *failure =
          format.partial && !imageio_supports(format) ? @"UNSUPPORTED"
                                                     : @"INVALID_MEDIA";
      return emit_json(base_result(format, failure));
    }
    CFDictionaryRef copied = CGImageSourceCopyPropertiesAtIndex(
        source, 0, (__bridge CFDictionaryRef)options);
    size_t frameCount = CGImageSourceGetCount(source);
    CFRelease(source);
    if (copied == NULL) return emit_json(base_result(format, @"INVALID_MEDIA"));
    NSDictionary *properties = CFBridgingRelease(copied);
    NSNumber *width = number_value(properties, kCGImagePropertyPixelWidth);
    NSNumber *height = number_value(properties, kCGImagePropertyPixelHeight);
    long long widthValue = width.longLongValue;
    long long heightValue = height.longLongValue;
    if (width == nil || height == nil || widthValue <= 0 || heightValue <= 0)
      return emit_json(base_result(format, @"INVALID_MEDIA"));
    if (widthValue > MAX_DIMENSION || heightValue > MAX_DIMENSION ||
        widthValue > MAX_PIXELS / heightValue)
      return emit_json(base_result(format, @"RESOURCE_LIMIT"));

    NSMutableDictionary *result = base_result(
        format, format.partial ? @"PARTIAL" : @"SUCCESS");
    result[@"width"] = @(widthValue);
    result[@"height"] = @(heightValue);
    result[@"isAnimated"] = frameCount > 1 ? @YES : @NO;
    NSMutableArray *warnings = result[@"warnings"];
    if (format.partial) [warnings addObject:@"PARTIAL_METADATA"];

    int originalOrientation = raw_orientation(3, status.st_size);
    NSNumber *orientation = originalOrientation >= 0
                                ? @(originalOrientation)
                                : number_value(properties, kCGImagePropertyOrientation);
    if (orientation != nil) result[@"orientationRaw"] = orientation;
    NSDictionary *tiff = properties[(__bridge NSString *)kCGImagePropertyTIFFDictionary];
    if (![tiff isKindOfClass:[NSDictionary class]]) tiff = @{};
    if (orientation == nil) {
      orientation = number_value(tiff, kCGImagePropertyTIFFOrientation);
      if (orientation != nil) result[@"orientationRaw"] = orientation;
    }
    NSString *make = string_value(tiff, kCGImagePropertyTIFFMake, 128);
    NSString *model = string_value(tiff, kCGImagePropertyTIFFModel, 128);
    if (make != nil) result[@"cameraMake"] = make;
    if (model != nil) result[@"cameraModel"] = model;

    NSDictionary *exif = properties[(__bridge NSString *)kCGImagePropertyExifDictionary];
    if (![exif isKindOfClass:[NSDictionary class]]) exif = @{};
    NSMutableArray *candidates = result[@"captureCandidates"];
    append_capture_candidate(
        candidates, @"EXIF_ORIGINAL",
        string_value(exif, kCGImagePropertyExifDateTimeOriginal, 64),
        string_value(exif, kCGImagePropertyExifOffsetTimeOriginal, 16),
        string_value(exif, kCGImagePropertyExifSubsecTimeOriginal, 16));
    append_capture_candidate(
        candidates, @"EXIF_CREATE",
        string_value(exif, kCGImagePropertyExifDateTimeDigitized, 64),
        string_value(exif, kCGImagePropertyExifOffsetTimeDigitized, 16),
        string_value(exif, kCGImagePropertyExifSubsecTimeDigitized, 16));
    if (fd_contains_marker(3, status.st_size,
                           "http://ns.adobe.com/xap/1.0/")) {
      result[@"parserStatus"] = @"PARTIAL";
      if (![warnings containsObject:@"PARTIAL_METADATA"])
        [warnings addObject:@"PARTIAL_METADATA"];
    }

    NSDictionary *gps = properties[(__bridge NSString *)kCGImagePropertyGPSDictionary];
    if ([gps isKindOfClass:[NSDictionary class]]) {
      BOOL latitudeOk = NO, longitudeOk = NO;
      double latitude = gps_value(gps[(__bridge NSString *)kCGImagePropertyGPSLatitude], &latitudeOk);
      double longitude = gps_value(gps[(__bridge NSString *)kCGImagePropertyGPSLongitude], &longitudeOk);
      NSString *latitudeRef = string_value(gps, kCGImagePropertyGPSLatitudeRef, 2);
      NSString *longitudeRef = string_value(gps, kCGImagePropertyGPSLongitudeRef, 2);
      if (latitudeOk && longitudeOk && latitudeRef != nil && longitudeRef != nil) {
        if ([latitudeRef caseInsensitiveCompare:@"S"] == NSOrderedSame) latitude = -fabs(latitude);
        else if ([latitudeRef caseInsensitiveCompare:@"N"] == NSOrderedSame) latitude = fabs(latitude);
        else latitudeOk = NO;
        if ([longitudeRef caseInsensitiveCompare:@"W"] == NSOrderedSame) longitude = -fabs(longitude);
        else if ([longitudeRef caseInsensitiveCompare:@"E"] == NSOrderedSame) longitude = fabs(longitude);
        else longitudeOk = NO;
      }
      if (latitudeOk && longitudeOk) {
        result[@"gpsLatitudeRaw"] = @(latitude);
        result[@"gpsLongitudeRaw"] = @(longitude);
      } else if (gps.count > 0) {
        [warnings addObject:@"INVALID_GPS"];
      }
    }
    return emit_json(result);
  }
}
