# Geocoding (SalonTime Backend)

**All geocoding uses the OpenStreetMap API** (via `node-geocoder`). No hardcoded city/location mappings. No API key. Works globally (NL, US, etc.).

## API endpoints

- **Address → coordinates**: Used internally on salon create/update (see `src/utils/geocoding.js`).
- **Coordinates → place name**:  
  `GET /api/geocode/reverse?lat=<lat>&lon=<lon>`  
  Returns `{ city, country, countryCode, formattedAddress, street, zipCode, state }` from OpenStreetMap.

## Salon coordinates

- `salons.latitude` / `salons.longitude` are set on create/update via **geocoding API** (address → coords).
- Existing rows with `latitude`/`longitude` = `NULL` can be backfilled.

## Backfill salons without coordinates

Run from the **Dotcorr workspace root** (not from `dcf_go` or other subprojects):

```bash
cd /Users/tahiruagbanwa/Desktop/Dotcorr/Agency/salontime-backend
node scripts/backfill-salon-coordinates.js
```

Or, if you're already in `Agency/salontime-backend`:

```bash
node scripts/backfill-salon-coordinates.js
```

Optional env: `BATCH=50` (default). The script loops until no salons lack coordinates. Uses full address first, then city+country as fallback.

## User location

User location comes from the client (e.g. device GPS). For "use address as location", geocode the address in the app (e.g. `geocoding` package, `locationFromAddress`) and send `latitude`/`longitude` to the API. Use `GET /api/geocode/reverse?lat=...&lon=...` to resolve coords → place name when needed.
