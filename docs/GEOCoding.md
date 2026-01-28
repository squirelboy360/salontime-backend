# Geocoding (SalonTime Backend)

Salon and address geocoding uses **OpenStreetMap** (via `node-geocoder`). No API key required. Works globally (NL, US, etc.).

## Salon coordinates

- `salons.latitude` / `salons.longitude` are set on create/update from address (see `src/utils/geocoding.js`).
- Existing rows with `latitude`/`longitude` = `NULL` can be backfilled.

## Backfill salons without coordinates

Run from project root:

```bash
cd Agency/salontime-backend
node scripts/backfill-salon-coordinates.js
```

Optional env:

- `BATCH=50` — salons per batch (default 50).

The script loops until no salons remain without coordinates. Uses full address first, then city+country as fallback.

## User location

User location is provided by the client (e.g. device GPS). If you add “use address as location” (e.g. when GPS is off), geocode the address in the app (e.g. `geocoding` package, `locationFromAddress`) and send `latitude`/`longitude` to the API instead of hardcoding.
