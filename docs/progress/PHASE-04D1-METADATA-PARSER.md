# Phase 4D1 — Isolated Metadata Parser

Status: implementation complete; pending independent review. This slice does
not persist metadata, mutate jobs/media state, create derived files, or change
the database schema.

## Architecture

The only supported production-code entry is
`IsolatedProbeRunner.probeMetadata`. It requires a runner whose D0 capability
probes have succeeded, opens the canonical original through `OriginalReader`,
and hands its opaque single-use handle to the fixed D0 supervisor. The
supervisor launches the fixed `metadata_parser_child` under the reviewed
macOS sandbox with the verified read-only original on FD 3.

No public API accepts a path, FD, executable, profile, environment, argv, MIME,
or filename. The parser never queries the database and never starts another
process.

## Parser Technology and Capabilities

The current DEV-only implementation is a fixed Objective-C native child using
macOS ImageIO through a `CGDataProvider` backed by bounded `pread` calls on FD 3. ImageIO caching is disabled. A small byte-magic classifier selects one
approved image/container branch before ImageIO is invoked.

| Format  | Current level | Notes                                                                            |
| ------- | ------------- | -------------------------------------------------------------------------------- |
| JPEG    | SUPPORTED     | Dimensions and approved EXIF/TIFF fields                                         |
| PNG     | SUPPORTED     | Dimensions; no full ancillary metadata map                                       |
| WebP    | SUPPORTED     | Dimensions and bounded frame-count-derived animation flag                        |
| GIF     | SUPPORTED     | Dimensions and bounded frame-count-derived animation flag                        |
| HEIC    | PARTIAL       | Current macOS synthetic HEIC probe succeeds; decoder/derivatives remain disabled |
| DNG/RAW | PARTIAL       | TIFF/DNG header and ImageIO metadata only; no broad camera RAW claim             |
| MP4/MOV | UNSUPPORTED   | Recognized by bytes but no ffprobe capability is installed or enabled            |

ExifTool, ffprobe, and FFmpeg are not installed. There is no path-based or
unsandboxed fallback. XMP presence is detected within the bounded header scan;
because full XMP extraction is unavailable, such results are explicitly
`PARTIAL` with `PARTIAL_METADATA` rather than silently claiming complete
metadata support.

## Typed Output

The child emits one fixed-key JSON object. The parent rejects unknown/missing
keys, unknown enums, non-finite/-0 numbers, oversized strings/arrays, invalid
dimension pairs, excessive pixels, invalid decimal strings, and unexpected
nested shapes.

Returned product fields are limited to media type/MIME/container, raw/display
dimensions, orientation, animation flag, normalized capture fields, paired
GPS coordinates, bounded camera make/model, and reserved bounded video fields.
No raw EXIF/XMP/MakerNotes/ICC/thumbnail/binary/arbitrary map is returned.

Bounds:

- original <= 512 MiB for this image metadata capability;
- dimensions <= 16,384 per side and <= 50,000,000 pixels;
- camera make/model <= 128 UTF-8 bytes;
- MIME <= the fixed allowlist; container/codec <= fixed mappings;
- capture candidates <= 4; warnings <= 8 fixed codes;
- stdout <= 64 KiB; stderr <= 16 KiB; metadata timeout defaults to 15s.

## Capture Time

The implemented precedence is EXIF DateTimeOriginal with its same-source
subsecond/offset, then EXIF CreateDate with its same-source offset. Gregorian
calendar components and leap years are validated without local-time `Date`
parsing. Explicit offsets are limited to ±14:00, and only known offsets produce
UTC. Offset-less values retain device-local wall time with
`OFFSET_UNKNOWN`; server timezone and GPS are never used to infer timezone.

The caller supplies the trusted source-receipt UTC upper bound. The normalizer
accepts 1900-01-01 through that value plus 48 hours and tries the next approved
candidate after an invalid/out-of-range candidate. XMP-only capture metadata is
currently PARTIAL, not silently discarded as a fully supported result.

## GPS, Orientation, and Text

Latitude/longitude must both exist, be finite, and fall within [-90,90] and
[-180,180]. Invalid/half pairs are dropped together with `INVALID_GPS`; no
network lookup occurs. Output is normalized to six decimal places.

Raw image orientation is independently read from the bounded TIFF/EXIF header
so invalid values are not hidden by ImageIO normalization. Only 1–8 are
accepted; 5–8 swap display dimensions. The original is never rotated or
rewritten.

Camera strings are compatibility-normalized, stripped of control, zero-width,
and bidi-format characters, trimmed, and limited by UTF-8 bytes. They never
enter a path, command, SQL expression, or log.

## Failure Model

- `SUCCESS`: supported image and valid required metadata.
- `PARTIAL`: base metadata is usable but an approved optional capability is
  unavailable, including XMP-only, HEIC, or DNG/RAW limitations.
- `UNSUPPORTED`: recognized container with no enabled parser, currently video.
- `INVALID_MEDIA`: unknown, malformed, or truncated media/container.
- `RESOURCE_LIMIT`: original or declared dimensions exceed approved limits.

Supervisor timeout/crash/signal/output/protocol failures remain sanitized
`StorageSafetyError` failures and are not converted into storage corruption.
Phase 4D2 will map reviewed parser outcomes into fenced repository/job state.

## Original Preservation Evidence

Each parser test snapshots bytes, SHA-256, path, inode, mode, and mtime before
and after successful, malformed, unsupported, and resource-limit probes. All
remain unchanged. Handles remain single-use and are closed by callback/finally;
D0 capability, timeout, crash, flooding, parent-death, and sandbox regression
tests remain green.

## Known Limitations / Deferred P2

- The backend is macOS DEV-only and depends on the verified `sandbox-exec`
  capability; no production isolation backend is claimed.
- No kernel-enforced hard RSS/CPU guarantee is claimed. Wall/output bounds and
  process-tree cleanup are verified; production resource stress remains due.
- Full XMP extraction, all RAW camera formats, video metadata, HEVC/HDR probe,
  and QuickTime capture-time semantics are not enabled.
- D0 P2 items remain open: high-numbered inherited-FD coverage beyond the
  current close range, the post-`waitpid` PGID-reuse hardening, privileged
  wrong-UID/cross-device fixtures, internal FD/rootPath access in the storage
  adapter, independent `posix_spawn` denial coverage, and the extra low-level
  synthetic probe export.
- The low-level fixed metadata adapter exists to bridge the opaque storage
  handle into the media package; application parser flow is restricted to the
  capability-gated `IsolatedProbeRunner.probeMetadata` API.

## Stop Point

No metadata persistence, job completion, derived publishing, thumbnail,
preview, poster, or transcoding is implemented in Phase 4D1.
