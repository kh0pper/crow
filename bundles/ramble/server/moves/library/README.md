# Moves library entries

Entries arrive in Task 10. Each entry is one `*.json` file, loaded and
validated by `../library.js`. The server serves only entries with
`"reviewed": true` (`servedLibrary`), and every entry must cite at least one
source from the register in `../SOURCES.md` — an UNVERIFIED source may not be
cited.
