#ifndef PS_IMAGE_RENDERER_HEADER_GATE_H
#define PS_IMAGE_RENDERER_HEADER_GATE_H

#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

#define PS_HEADER_BUDGET (4U * 1024U * 1024U)
#define PS_RECORD_BUDGET 65536U

typedef struct {
  int fd;
  uint64_t file_size;
  uint32_t inspected;
  uint32_t records;
  uint32_t width;
  uint32_t height;
  uint32_t frames;
} ps_header_gate;

static int ps_read_at(ps_header_gate *gate, uint64_t offset,
                      unsigned char *bytes, size_t length) {
  if (length > PS_HEADER_BUDGET - gate->inspected ||
      offset > gate->file_size || length > gate->file_size - offset)
    return 0;
  size_t received = 0;
  while (received < length) {
    ssize_t n = pread(gate->fd, bytes + received, length - received,
                      (off_t)(offset + received));
    if (n > 0) received += (size_t)n;
    else if (n < 0 && errno == EINTR) continue;
    else return 0;
  }
  gate->inspected += (uint32_t)length;
  return 1;
}

static int ps_record(ps_header_gate *gate) {
  if (gate->records >= PS_RECORD_BUDGET) return 0;
  gate->records++;
  return 1;
}

static uint32_t ps_be16(const unsigned char *bytes) {
  return ((uint32_t)bytes[0] << 8) | bytes[1];
}

static uint32_t ps_be32(const unsigned char *bytes) {
  return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) |
         ((uint32_t)bytes[2] << 8) | bytes[3];
}

static uint32_t ps_le16(const unsigned char *bytes) {
  return bytes[0] | ((uint32_t)bytes[1] << 8);
}

static uint32_t ps_le24(const unsigned char *bytes) {
  return bytes[0] | ((uint32_t)bytes[1] << 8) |
         ((uint32_t)bytes[2] << 16);
}

static uint32_t ps_le32(const unsigned char *bytes) {
  return ps_le24(bytes) | ((uint32_t)bytes[3] << 24);
}

static int ps_jpeg_header(ps_header_gate *gate) {
  unsigned char marker[2];
  uint64_t cursor = 2;
  while (cursor < gate->file_size && ps_record(gate)) {
    if (!ps_read_at(gate, cursor, marker, 2) || marker[0] != 0xff)
      return 0;
    cursor += 2;
    while (marker[1] == 0xff) {
      if (!ps_read_at(gate, cursor, marker + 1, 1)) return 0;
      cursor++;
    }
    unsigned code = marker[1];
    if (code == 0xd9 || code == 0xda || code == 0x00) return 0;
    if (code == 0xd8 || code == 0x01 || (code >= 0xd0 && code <= 0xd7))
      continue;
    unsigned char segment_length[2];
    if (!ps_read_at(gate, cursor, segment_length, 2)) return 0;
    uint32_t length = ps_be16(segment_length);
    if (length < 2 || length > gate->file_size - cursor) return 0;
    if ((code >= 0xc0 && code <= 0xc3) ||
        (code >= 0xc5 && code <= 0xc7) ||
        (code >= 0xc9 && code <= 0xcb) ||
        (code >= 0xcd && code <= 0xcf)) {
      unsigned char dimensions[5];
      if (length < 7 || !ps_read_at(gate, cursor + 2, dimensions, 5))
        return 0;
      gate->height = ps_be16(dimensions + 1);
      gate->width = ps_be16(dimensions + 3);
      gate->frames = 1;
      return 1;
    }
    cursor += length;
  }
  return 0;
}

static int ps_png_header(ps_header_gate *gate) {
  unsigned char header[24];
  if (!ps_record(gate) || !ps_read_at(gate, 0, header, sizeof(header)) ||
      memcmp(header, "\x89PNG\r\n\x1a\n", 8) != 0 ||
      ps_be32(header + 8) != 13 || memcmp(header + 12, "IHDR", 4) != 0)
    return 0;
  gate->width = ps_be32(header + 16);
  gate->height = ps_be32(header + 20);
  gate->frames = 1;
  return 1;
}

static int ps_gif_subblocks(ps_header_gate *gate, uint64_t *cursor) {
  unsigned char length;
  do {
    if (!ps_record(gate) || !ps_read_at(gate, *cursor, &length, 1)) return 0;
    (*cursor)++;
    if (length > gate->file_size - *cursor) return 0;
    *cursor += length;
  } while (length != 0);
  return 1;
}

static int ps_gif_header(ps_header_gate *gate) {
  unsigned char header[13];
  if (!ps_read_at(gate, 0, header, sizeof(header)) ||
      (memcmp(header, "GIF87a", 6) != 0 &&
       memcmp(header, "GIF89a", 6) != 0)) return 0;
  gate->width = ps_le16(header + 6);
  gate->height = ps_le16(header + 8);
  uint64_t cursor = 13;
  if (header[10] & 0x80) cursor += 3ULL << ((header[10] & 7) + 1);
  while (cursor < gate->file_size && ps_record(gate)) {
    unsigned char token;
    if (!ps_read_at(gate, cursor++, &token, 1)) return 0;
    if (token == 0x3b) return gate->frames > 0;
    if (token == 0x21) {
      unsigned char extension;
      if (!ps_read_at(gate, cursor++, &extension, 1) ||
          !ps_gif_subblocks(gate, &cursor)) return 0;
    } else if (token == 0x2c) {
      unsigned char descriptor[9];
      if (!ps_read_at(gate, cursor, descriptor, sizeof(descriptor))) return 0;
      cursor += sizeof(descriptor);
      if (++gate->frames > 256) return 0;
      if (descriptor[8] & 0x80)
        cursor += 3ULL << ((descriptor[8] & 7) + 1);
      unsigned char code_size;
      if (!ps_read_at(gate, cursor++, &code_size, 1) ||
          !ps_gif_subblocks(gate, &cursor)) return 0;
    } else return 0;
  }
  return 0;
}

static int ps_webp_header(ps_header_gate *gate) {
  unsigned char header[12];
  if (!ps_read_at(gate, 0, header, sizeof(header)) ||
      memcmp(header, "RIFF", 4) != 0 ||
      memcmp(header + 8, "WEBP", 4) != 0 ||
      ps_le32(header + 4) != gate->file_size - 8) return 0;
  uint64_t cursor = 12;
  int animated = 0;
  while (cursor < gate->file_size && ps_record(gate)) {
    unsigned char chunk[18];
    if (!ps_read_at(gate, cursor, chunk, 8)) return 0;
    uint32_t length = ps_le32(chunk + 4);
    uint64_t payload = cursor + 8;
    if (length > gate->file_size - payload ||
        (length & 1 && payload + length >= gate->file_size)) return 0;
    if (memcmp(chunk, "VP8X", 4) == 0 && cursor == 12 && length == 10) {
      if (!ps_read_at(gate, payload, chunk + 8, 10)) return 0;
      animated = (chunk[8] & 0x02) != 0;
      gate->width = 1 + ps_le24(chunk + 12);
      gate->height = 1 + ps_le24(chunk + 15);
    } else if (memcmp(chunk, "VP8 ", 4) == 0 && gate->width == 0 &&
               length >= 10) {
      if (!ps_read_at(gate, payload, chunk + 8, 10) ||
          memcmp(chunk + 11, "\x9d\x01\x2a", 3) != 0) return 0;
      gate->width = ps_le16(chunk + 14) & 0x3fff;
      gate->height = ps_le16(chunk + 16) & 0x3fff;
    } else if (memcmp(chunk, "VP8L", 4) == 0 && gate->width == 0 &&
               length >= 5) {
      if (!ps_read_at(gate, payload, chunk + 8, 5) || chunk[8] != 0x2f)
        return 0;
      uint32_t packed = ps_le32(chunk + 9);
      gate->width = 1 + (packed & 0x3fff);
      gate->height = 1 + ((packed >> 14) & 0x3fff);
    } else if (memcmp(chunk, "ANMF", 4) == 0) {
      if (++gate->frames > 256) return 0;
    }
    cursor = payload + length + (length & 1);
  }
  if (cursor != gate->file_size || gate->width == 0 || gate->height == 0 ||
      (animated && gate->frames == 0) || (!animated && gate->frames != 0))
    return 0;
  if (!animated) gate->frames = 1;
  return 1;
}

static int ps_renderer_header_gate(int fd, off_t size, int type,
                                   uint32_t *width, uint32_t *height,
                                   uint32_t *frames) {
  if (size <= 0 || size > 512LL * 1024LL * 1024LL) return 0;
  ps_header_gate gate = {.fd = fd, .file_size = (uint64_t)size};
  int accepted = type == 1 ? ps_jpeg_header(&gate) :
                 type == 2 ? ps_png_header(&gate) :
                 type == 3 ? ps_webp_header(&gate) :
                 type == 4 ? ps_gif_header(&gate) : 0;
  if (!accepted || gate.width == 0 || gate.height == 0 ||
      gate.width > 16384 || gate.height > 16384 ||
      gate.width > 50000000U / gate.height || gate.frames == 0 ||
      gate.frames > 256) return 0;
  *width = gate.width;
  *height = gate.height;
  *frames = gate.frames;
  return 1;
}

#endif
