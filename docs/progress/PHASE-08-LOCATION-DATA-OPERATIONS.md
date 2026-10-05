# Phase 8 location dataset operations (DEV)

## Fixed runtime bundle

Use `LOCATION_DATA_DIR=resources/location/2026-10-03` from the repository root (resolve to an absolute path for processes started elsewhere). API and metadata driver must use the same immutable bundle. The runtime loader verifies the exact policy, normalization and SHA-256 of both normalized files. Dataset version is SHA-256 of the **literal manifest bytes**, including whitespace; editing the manifest changes the version.

- Policy version: 1; `h3-js@4.5.0`, fixed resolution 6, center-only labels, ambiguous country unknown, Haversine radius 6371008.8m, city distance <=50000m, numeric GeoNames ID tie break.
- Normalization: `naturalearth-iso-a2-eh-geonames-cities1000-v2-dbf-null-padding`.
- Dataset version: `b91de06689ac1ecd6b7910e0fbdc1289cef8c63ba390bb00732ae19dcf9695ed`.
- `countries.json`: `a7e5413cede2d8b28cbc4821615457018bec1cbbd0c1c2700b46be241f8804f1`, 258 features.
- `cities.json`: `55e458a90afc5f39f08d7d5ec9e53cc5f9d82e624d9a6dfce943a0bc89e72bf9`, 171102 entries.

The complete archive/country-code source checksums, source URLs and import timestamp are in `resources/location/2026-10-03/manifest.json`. Natural Earth is version 5.1.1. GeoNames cities1000 is a dated downloaded snapshot pinned by archive checksum, not an invented upstream release number. Runtime never downloads datasets or geocodes GPS.

## Attribution

Country boundaries: [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/), public domain. Nearby city data: [GeoNames](https://www.geonames.org/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Normalized from cities1000 and countryInfo; nearby-city labels describe distance from the coarse H3 center and are not administrative membership. Retain these credits and the manifest when distributing the dataset. Basemap attribution is separate and remains displayed by the map UI.

## Manual updates

1. Create a new dated directory; retain the existing bundle unchanged. Download only public source datasets manually, retain archive checksums and the Natural Earth version file. Do not read family media for an import.
2. Run `pnpm exec tsx packages/media/scripts/import-location-data.ts <new-directory>` with the extracted Natural Earth shapefile/DBF/version file, source archives, GeoNames cities1000 text and countryInfo expected by the importer. Review all output counts, normalization, source hashes and licenses. Do not substitute a new algorithm under an existing policy version; algorithm changes require the approved design workflow.
3. Verify the loader and targeted projector tests against the new bundle. A byte-identical manifest must be deployed to each participating process. Restart with the explicit new directory; there is no automatic highest-version selection or old-version fallback.
4. For an authorized DEV family, preview with `pnpm exec tsx packages/db/scripts/backfill-location-projections.ts --family <id> --dataset <new-directory> --batch-size 20 --max-batches 1`. It defaults to dry-run. Only explicitly authorized apply runs add `--apply`; limits are bounded, each media uses current-state CAS, and Original files are never opened.
5. Coverage remains incomplete until the current-version projections exist. Dataset switches invalidate existing location cursors; clients must begin a fresh query. An execution failure stops the batch without replay. Start a new independent scan for recovery; do not treat a prior cursor or STALE result as a permanent completion checkpoint.

This is a DEV procedure. It grants no Production, storage ownership, upload scheduling, purge or writer changes. Metadata extraction alone does not prove new-upload visibility: the existing derived pipeline must also reach READY under a separately approved runtime attachment.
