# libwebp source provenance

- Dependency: libwebp
- Version: 1.6.0
- Official release archive: `https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz`
- Official detached signature: `https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz.asc`
- Archive SHA-256 (computed from downloaded bytes): `e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564`
- Official Git-at-Google tag: `v1.6.0`
- Tag object: `b7e29b9d75bd31422b00c2a446d49d7af06c328d`
- Tag target commit: `4fa21912338357f89e4fd51cf2368325b59e9bd9`
- Source identity: official release archive, root `libwebp-1.6.0/`; `README.md` and `configure.ac` identify version 1.6.0; `src/` codec tree present.
- Independent tag-tree comparison: downloaded the official `webmproject/libwebp` Git tag archive (`SHA-256 93a852c2b3efafee3723efd4636de855b46f9fe1efddd607e1f42f60fc8f2136`); all 197 `src/`, `sharpyuv/`, and license files in that tag tree are byte-identical to the release archive. The release archive additionally contains generated Autotools `Makefile.in` and `config.h.in` files, which are not codec-source differences.
- Archive safety: 392 members, all under the expected root; 367 regular files and 25 directories; no symlinks, special members, absolute paths, or parent traversal.
- Detached signature: downloaded from the official release host, **not verified**. No previously trusted release signing key or GPG verifier was available; no keyserver key was implicitly trusted.
- Licenses retained: `COPYING`, `PATENTS`, `AUTHORS`.
- Upstream source: unmodified. This provenance file is repository metadata, not an upstream codec change.
- Retrieval: HTTPS, redirects disabled, bounded temporary download outside the repository; SHA-256 and archive checks before extraction.
- Target build: macOS arm64, Apple clang, static `libwebp.a` and `libsharpyuv.a`; no runtime download, Homebrew encoder, `pkg-config` lookup, or arbitrary codec plugin.
