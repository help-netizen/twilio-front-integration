# ZIP-POLYGONS-001 — ZIP boundary polygons on Service areas

**Status:** Implemented, owner Cloud configuration required  
**Date:** 2026-07-18  
**Owner decision:** Variant A — Google Maps data-driven styling for boundaries

## Goal

In Settings → Scheduling & service areas → Service areas, replace the list-mode
wall of ZIP centroid pins with simple filled ZIP polygons. Each configured
service area has a stable, distinct color while the company has at most 16
areas. Keep radius mode's `google.maps.Circle` overlays unchanged. Polygon
borders, per-ZIP labels, and high-fidelity choropleth behavior are out of scope.

## Verified Google API facts

The implementation is based on the current Google Maps Platform documentation:

1. [Data-driven styling for boundaries overview](https://developers.google.com/maps/documentation/javascript/dds-boundaries/overview)
   lists `POSTAL_CODE` as a supported boundary feature and supports polygon fill,
   fill opacity, stroke color, stroke opacity, and stroke weight.
2. [Google boundaries coverage](https://developers.google.com/maps/documentation/javascript/dds-boundaries/coverage)
   lists the United States (`US`) as covered for Postal Code boundaries.
3. [DDS boundaries: Get started](https://developers.google.com/maps/documentation/javascript/dds-boundaries/start)
   requires a **JavaScript Vector Map ID**, a cloud map style associated with
   that ID, and the required boundary feature layer enabled on that style. The
   Map ID and Maps JavaScript API key must belong to the same Google Cloud
   project. This is the vector/WebGL renderer path; a default raster map is not
   sufficient.
4. The same guide documents `map.getMapCapabilities()` and
   `isDataDrivenStylingAvailable`. The
   [data-driven styling reference](https://developers.google.com/maps/documentation/javascript/reference/data-driven-styling)
   additionally exposes `FeatureLayer.isAvailable`. Both are runtime gates used
   by this implementation.
5. The styling callback is synchronous. A postal `PlaceFeature` exposes a
   `placeId`; it does not expose the ZIP string. Fetching a Place asynchronously
   inside the style callback is explicitly unsupported by the reference.
6. [Using Places and Geocoding with DDS boundaries](https://developers.google.com/maps/documentation/javascript/dds-boundaries/dds-use-maps-places-apis)
   documents Geocoding component filtering as a supported way to obtain postal
   region Place IDs.
7. [Google Place ID storage guidance](https://developers.google.com/maps/documentation/places/web-service/place-id)
   permits Place IDs to be stored and reused. Google recommends refreshing IDs
   older than 12 months.

The API reality therefore supports the approved plan; no substitute polygon
source is used.

## ZIP → Google Place ID strategy

### Persistent global cache

Migration `186_zip_polygon_place_ids.sql` extends the existing documented
global `zip_geocache` with:

- `google_place_id TEXT`
- `place_id_resolved_at TIMESTAMPTZ`

This is the correct cache seam because ZIP geography and its Google Place ID
are public, non-tenant data. The existing table already has the explicit
tenant-scope exception and is reused across companies.

`territoryGeoService` keeps the current component-filtered server request:

```text
GET https://maps.googleapis.com/maps/api/geocode/json
    ?components=postal_code:{ZIP}|country:US
```

It reads `GOOGLE_GEOCODING_KEY || GOOGLE_PLACES_KEY`; the server key never
reaches the browser. A Place ID is accepted only when the returned
`postal_code` address component normalizes to the requested ZIP. The resulting
geography and Place ID are upserted atomically. Fresh cache hits make no Google
request. IDs older than 12 months are eligible for refresh; a failed refresh
keeps the prior ID available as a safe fallback.

### Bounded warm-up

`GET /api/settings/service-territories/config` returns cached Place IDs with
the existing centroid records. It never waits for Google. After responding, it
uses the existing lazy geography seeder with one shared cap of **10 Google
lookups per config view**. Missing centroids retain priority, and remaining
capacity resolves Place IDs. This prevents a tenant with ~227 ZIPs from
creating ~227 live browser or server requests on every page view.

For initial production warm-up, run the bounded maintenance command after
migration 186. The normal mode requires an explicit tenant UUID and selects
only ZIPs currently configured for that company:

```bash
docker compose exec app node scripts/backfill-zip-place-ids.js \
  --company-id=YOUR_COMPANY_UUID
```

The company filter is mandatory because `service_territories` is tenant data.
The default limit is 500 and concurrency is 5, so one successful invocation
attempts all ~227 currently served ZIPs. The script prints `eligible_before`,
`attempted`, `resolved`, `unresolved_attempts`, `remaining`, `complete`, and the
minimum number of additional runs at the current limit. If Google rejects or
fails any ZIP, rerun until `remaining: 0`; it is not honest to call a run complete
merely because every row was attempted.

Without the backfill, the lazy resolver needs at least `ceil(227 / 10) = 23`
successful config views when its full budget is available. The cap is shared
with missing-centroid resolution, so a cold centroid cache can require more
than 23 views. It is best-effort rather than a guaranteed batch job: repeatedly
failing low-sorted ZIPs can keep consuming part of the next view's budget. With
the backfill, one successful run is sufficient for 227 ZIPs because all fit
under the default 500-row limit. A persistent nonzero `remaining` count means
the failing ZIPs need investigation; the marker fallback remains available.

The former global-cache scan remains available only with the explicit
full-US flag:

```bash
docker compose exec app node scripts/backfill-zip-place-ids.js --all-us
```

`--all-us` scans every US ZIP candidate already present in the global
`zip_geocache`; it never reads tenant territory rows. Both modes accept
`--limit=N` and `--concurrency=N`, with the existing
`ZIP_PLACE_ID_BACKFILL_LIMIT` and `ZIP_PLACE_ID_BACKFILL_CONCURRENCY`
environment variables retained as optional bounds. Repeat runs are cache-first;
normal page views are DB-only once warm.

## Map behavior and fallback contract

### List/district mode

When `VITE_GOOGLE_MAPS_MAP_ID` is present, the map is created with that Map ID.
The code then requires all of the following:

1. `map.getMapCapabilities().isDataDrivenStylingAvailable === true`
2. `map.getFeatureLayer(FeatureType.POSTAL_CODE)` succeeds
3. `FeatureLayer.isAvailable === true`
4. At least one selected ZIP has a cached Place ID

The config response carries the existing `service_territories.area` value with
each ZIP plus `area_names`, the complete distinct company area set derived from
all configured territory rows — including areas whose ZIP centroids have not
resolved yet. The frontend NFC-normalizes and sorts that complete set using an
explicit codepoint comparator, then assigns colors by sorted index from the
fixed 16-color `--blanc-map-area-*` palette. API order, centroid order, and a
filtered centroid subset therefore cannot recolor an area. Colors are unique
while the company has at most 16 areas; area 17 and later intentionally wrap
the finite palette. The exported registry helper is the future legend seam; no
legend is built in this feature.

The synchronous style function matches `PlaceFeature.placeId` against the
cached ID set. Matching polygons receive their area fill at 0.42 opacity and
`strokeWeight: 0`, leaving Google city labels readable without ZIP borders. No
labels are added.

ZIPs still awaiting a Place ID retain their centroid marker while resolved ZIPs
use polygons. Bounds continue to use all centroids, so the viewport behavior is
unchanged.

### Mandatory graceful degradation

Any of these conditions produces a `console.warn` and the complete legacy
centroid-marker rendering:

- Map ID absent
- Map ID invalid or not a JavaScript vector Map ID
- map style not associated with the Map ID
- Postal Code feature layer not enabled
- DDS capability or feature layer unavailable
- feature-layer setup throws
- no cached Place IDs yet

If constructing the Map-ID-backed map throws, the component immediately creates
the original map without a Map ID. The map and page never become blank because
of polygon configuration.

### Radius mode

Radius mode does not receive the Map ID, does not inspect a FeatureLayer, and
continues rendering the existing `google.maps.Circle` behavior unchanged.

The pre-existing missing/invalid **API key** behavior is unchanged: when the
Maps JavaScript API itself cannot load, the preview remains hidden and the rest
of Settings stays functional.

## Owner Cloud Console steps

Use the same Google Cloud project as `VITE_GOOGLE_MAPS_API_KEY`:

1. Confirm Maps JavaScript API and Geocoding API are enabled and billing is active.
2. Open Google Maps Platform → **Map Management** → **Map IDs**.
3. Click **Create map ID**.
4. Set platform/type to **JavaScript** and renderer to **Vector**. Tilt and
   rotation are unnecessary for this read-only map and should remain off.
5. Open **Map Styles** and create or select a **light** cloud map style.
6. In that style's **Feature layers** control, enable **Postal Code** only, then
   save/publish the style.
7. Associate that style with the new JavaScript Vector Map ID.
8. Confirm the Map ID and browser API key belong to the same project and that
   the browser key's HTTP-referrer restrictions include `app.albusto.com`.
9. Copy the Map ID into the production build variable below.

## Exact build/deploy environment step

`VITE_*` values are compiled into the frontend asset. A runtime container
environment change, `.env` change followed only by `restart`, or `docker compose
up` without rebuilding does **not** update the browser bundle.

On the production host:

1. Set this Compose-substitution value in `/opt/albusto/.env`:

   ```dotenv
   VITE_GOOGLE_MAPS_MAP_ID=YOUR_JAVASCRIPT_VECTOR_MAP_ID
   ```

2. The tracked production override passes it under
   `services.app.build.args.VITE_GOOGLE_MAPS_MAP_ID`, and the Dockerfile declares
   the matching `ARG`/`ENV` before `npm run build`.
3. Build the new app image (this is the step that bakes the Map ID into the
   frontend asset):

   ```bash
   cd /opt/albusto
   docker compose build app
   ```

4. Apply migration 186 through the standard production migration procedure
   **before** replacing the running app. The new config query reads the additive
   cache columns.
5. Replace the app container, then run the cache warmer:

   ```bash
   cd /opt/albusto
   docker compose up -d app
   docker compose exec app node scripts/backfill-zip-place-ids.js \
     --company-id=YOUR_COMPANY_UUID
   ```

   A missing warm-up is safe: markers remain and the bounded lazy resolver
   fills the cache over later views.

## Tests

- Missing Map ID returns the complete legacy marker set and warns.
- Invalid/non-DDS Map ID and missing Postal Code layer return markers and warn.
- Polygon styling matches only selected Place IDs; unresolved ZIPs retain markers.
- The complete realistic area set produces distinct colors, and shuffling both
  area registry and centroid order preserves every area-to-color assignment.
- Filtering rendered centroids while retaining the complete area registry does
  not recolor the remaining area.
- Polygon styles use `strokeWeight: 0` and semi-transparent fills.
- Radius mode never reads or styles the postal FeatureLayer.
- ZIP Place ID resolver tests cache hit, exact-ZIP miss resolution/upsert,
  mismatch rejection, and stale-ID safe fallback.
- Config tests enforce the shared 10-lookup cap and cached Place ID response.
- Backfill tests enforce company-scoped served-ZIP defaults, explicit
  `--all-us`, and convergence reporting.
- Migration test verifies additive/replay-safe forward and rollback SQL.
