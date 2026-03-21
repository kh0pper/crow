---
name: gis
description: Geocoding, mapping, and geographic data analysis with self-hosted Nominatim
triggers:
  - "geocode"
  - "reverse geocode"
  - "latitude longitude"
  - "map"
  - "geojson"
  - "address to coordinates"
  - "where is"
  - "batch geocode"
  - "choropleth"
tools:
  - crow_gis_geocode
  - crow_gis_reverse
  - crow_gis_search
  - crow_gis_batch_geocode
  - crow_gis_create_geojson
---

# GIS Skill

## When to Activate
User wants to geocode addresses, find places, create maps, or work with geographic data.

## Workflow

### Single Address Geocoding
1. `crow_gis_geocode` — convert address/place to lat/lng
2. Multiple results returned ranked by relevance

### Reverse Geocoding
1. `crow_gis_reverse` — convert lat/lng to address
2. Zoom level controls detail (3=country, 10=city, 18=building)

### Batch Geocoding (Data Dashboard Integration)
1. User has a table with an address column in a data_backend database
2. `crow_gis_batch_geocode` — adds lat/lon columns and geocodes all rows
3. Rate-limited to respect the Nominatim API
4. Results stored directly in the database for further analysis

### Map Data Generation
1. After geocoding, use `crow_gis_create_geojson` to generate GeoJSON
2. GeoJSON can be used in Leaflet maps, case studies, or exported

## Requirements
- Nominatim Docker container must be running (`docker compose up` in the bundle directory)
- Initial import of map data takes several hours (US extract: ~30GB)
- 4GB+ RAM recommended for the Nominatim container

## Safety
- Self-hosted Nominatim — no external API calls, all data stays local
- Geographic data is processed on your own infrastructure
