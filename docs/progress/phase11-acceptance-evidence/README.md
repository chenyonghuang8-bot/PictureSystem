# Phase11 acceptance evidence archive

These are byte-for-byte copies of existing DEV evidence. `archive-manifest.json` maps ignored local evidence paths to tracked archive paths with SHA256 and byte size. Original fingerprints and review input are unchanged. Log files have an added `.txt` suffix to preserve ordinary log ignores.

The final runner inherits unchanged unit/build from final-2 and API/standalone Admin E2E from final-4, recording original timestamps and applicability; it does not claim every stage ran in final-6. The fixed review input binds the independent Astra report. The separate delegation recheck is a subsequent read-only DEV proof, not a repeated Quality Gate.

Build products, local TLS certificates, private keys, synthetic media quarantine and mutable cache directories are not published. Rebuild products from checked-in source. Historical logs unavailable after reboot remain unavailable; an archived hash is not a claim that missing bytes were restored. Three early mutable helper proofs differ from old supporting hashes and are not current acceptance evidence.

Retirement registries contain exact synthetic IDs and row digests only. Production admission never reads them. A fresh DEV database has no retired history and needs no registry. On the existing DEV database, restore only the matching verified registry copies to the documented `.cache/phase11-r1/` paths before tests; mismatched history must refuse. No registry authorizes deletion, replaces recovery or changes a product gate.

Current fingerprint includes generated Next agent hints and references to old unrelated observer artifacts; those files are deliberately excluded from this commit. This archive does not assert a clean full workspace or Production readiness.

Four original logs contain trailing blank lines that trigger diff checks. Their `.base64.txt` copies decode to the exact original bytes; manifest `sha256` is the decoded original hash and `storedSHA256` is the encoded artifact hash. This preserves evidence without rewriting whitespace.
