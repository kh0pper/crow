# Vendored code provenance

`src/rookery_manifest/` + `tests/test_{manifest,assemble,cli}.py` are vendored
BYTE-IDENTICAL from the private rookery repo (`adapters/manifest/`, upstream of
record). Do not patch them here — change upstream, re-copy, and update the
hashes in `tests/test_vendor_drift.py`. New bundle logic belongs in
`src/rookery_mcp/`.
Upstream commit at vendor time: cc9cce4
