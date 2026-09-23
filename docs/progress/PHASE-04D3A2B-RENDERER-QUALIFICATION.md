# Phase 4D3a-2b renderer qualification

The qualification result is in memory. This slice does not publish, mark `derived_assets` READY, serve bytes, or complete a background job.

## Pipeline

Synthetic original in the DEV media root → fixed renderer producer → `UnverifiedRenderedCandidate` → confirmed capacity admission → deterministic owned temp → seal → isolated verify-output.

Decoded width and height from the verifier are the geometry fact. Producer control JSON is not the authority. The reservation row stays `RESERVED`.

## Matrix

JPEG, PNG, WebP, and GIF, each as thumbnail and preview. Geometry uses the approved inside-fit rule: orientation first, scale at most 1, per-side integer truncation, minimum 1.

| Case                     | Input          | Recipe    | Decoded result |
| ------------------------ | -------------- | --------- | -------------- |
| Small landscape          | 320×240        | thumbnail | 320×240        |
| Large landscape          | 4000×3000      | thumbnail | 480×360        |
| Large landscape          | 4000×3000      | preview   | 2560×1920      |
| No upscale               | 100×100        | both      | 100×100        |
| Portrait                 | 240×320        | thumbnail | 240×320        |
| JPEG orientation 1       | 320×240 stored | thumbnail | 320×240        |
| JPEG orientation 5/6/7/8 | 320×240 stored | thumbnail | 240×320        |
| Near axis limit          | 16384×1 PNG    | thumbnail | 480×1          |

## Alpha, metadata, animation

PNG and WebP sources with a transparent sample stay `alpha` and `transparent` after seal and isolated decode. JPEG EXIF orientation is applied visually; the sealed WebP has no `EXIF`, `XMP `, `ANIM`, or `ANMF` chunk. A two-frame GIF and a two-frame WebP produce one static image. A truncated GIF is rejected before admission, so no reservation or temp is created.

## Identity and originals

For every successful case, candidate SHA-256, sealed SHA-256, and verified SHA-256 are the same. The original bytes, SHA-256, inode, mode, and mtime are unchanged after render and after verification.

## Security

Sandbox, FD map, high FD, timeout, crash, and owner death stay on the existing producer and verifier suites. This slice does not replace those tests.

## Limitations

macOS ImageIO plus vendored libwebp 1.6.0 is the qualified DEV path. Seatbelt here is not a production isolation claim. Decoded geometry is not yet compared with persisted D2 metadata; these cases use the known synthetic dimensions. No pixel-golden claim beyond geometry, alpha presence, static output, and metadata-container absence. Uid-mismatch and cross-device fixtures remain unconstructable without extra privileges.

Schema: no. Migration: no.
