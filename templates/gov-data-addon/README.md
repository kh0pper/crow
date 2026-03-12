# Government Data Add-on Template

Template for building government data MCP servers as Crow add-ons.

## Quick Start

1. Copy this template to `bundles/your-addon-name/`
2. Edit `manifest.json` — replace all `{{PLACEHOLDER}}` values
3. Add your data sources to `server/index.js` in the `DATA_SOURCES` array
4. Implement the `search_datasets` and `get_dataset` tools
5. Create a skill file in `skills/` describing the workflow
6. Add an entry to `registry/add-ons.json`
7. Test: `node server/index.js` (should start without errors)

## Template Structure

```
gov-data-addon/
├── manifest.json          # Add-on metadata (edit placeholders)
├── server/
│   └── index.js           # MCP server with rate limiting and caching
├── skills/
│   └── (create your skill file here)
└── README.md              # This file
```

## Built-in Features

- **Rate limiting** per data source (configurable per-source)
- **Response caching** (5-minute TTL, 100-entry LRU)
- **Source registry** pattern for multiple government APIs
- **Zod validation** on all tool parameters

## Adding a Data Source

In `server/index.js`, add to the `DATA_SOURCES` array:

```javascript
{
  id: "education",
  name: "Department of Education",
  baseUrl: "https://api.ed.gov/v1",
  description: "K-12 and higher education statistics",
  rateLimit: 60, // requests per minute
}
```

Then implement the fetch logic in `search_datasets` and `get_dataset`.

## Examples

- Texas government data: education, licensing, legislative records
- Federal government data: Census, BLS, NCES, FRED
- California government data: education, employment, environmental
