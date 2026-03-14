---
title: Citations & Source Verification
---

# Citations & Source Verification

Crow generates properly formatted citations automatically and tracks how every source was found — so your research is always verifiable.

## Multi-Format Citations

When you add a source, Crow generates citations in four formats from the metadata you provide:

| Format | Style | Best for |
|--------|-------|----------|
| **APA** | Author (Year). Title. Publisher. URL | Academic papers, psychology, social sciences |
| **MLA** | Author. "Title." *Publisher*, Date. URL. | Humanities, literature, arts |
| **Chicago** | Author. "Title." Publisher. Date. URL. | History, publishing, many academic fields |
| **Web** | Title. URL. Accessed DATE. [Found via METHOD] | Blog posts, quick references, AI-assisted research |

### How it works

All four formats are generated at query time from stored source fields (authors, title, date, URL, etc.) — no extra data entry needed.

- **Adding a source**: By default, the APA format is stored as the primary citation. Use the `citation_format` parameter to change this.
- **Viewing a source**: `crow_get_source` shows all four citation formats.
- **Generating a bibliography**: `crow_generate_bibliography` accepts a `format` parameter: `apa`, `mla`, `chicago`, `web`, or `all`.

### Example

> "Crow, generate a Chicago-style bibliography for my Civil War research project"

Crow fetches all sources in the project and generates Chicago-format citations, sorted alphabetically.

> "Crow, show me source #42 with all citation formats"

Crow displays the full source details including APA, MLA, Chicago, and web citations.

## Source Verification

Crow tracks **how** each source was found, so you can distinguish between sources you found yourself and sources discovered by AI search.

### Retrieval methods

When adding a source, the `retrieval_method` field records how it was obtained:

- `"direct URL"` — user provided the link
- `"AI search via Claude"` — found during an AI-assisted search
- `"library database"` — found via academic database
- `"user-provided"` — user supplied the source directly

### Verification workflow

1. **Add the source** with accurate metadata and retrieval method
2. **Verify the URL** is real and accessible (especially for AI-discovered sources)
3. **Cross-reference** claims with other sources
4. **Mark as verified** using `crow_verify_source` with notes about what was checked

### The "no unverified claims" principle

When conducting research through Crow, every factual claim should link to a stored, cited source. This means:

- AI summaries are not sources — trace back to the original
- If a URL can't be verified, note that in the verification status
- Primary sources are preferred over secondary summaries

## Customization

You can set a default citation format in your crow.md:

> "Crow, always use MLA format for my citations"

This updates your research protocol to generate MLA as the primary format when adding sources.
