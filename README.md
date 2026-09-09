# Dairy Plant Atlas

An educational lookup for U.S. dairy plants. Take the code printed on a
carton, tub, or wedge and find the facility that actually made it — plus
the other brands that come out of the same plant and its FDA recall
history.

Live: https://dairyplant-atlas.up.railway.app

## What it does

- **Plant code lookup** — type `55-372` and get the plant (name, city,
  state, category, ratings, code aliases).
- **Brand / company search** — type "Cabot" or "fairlife" and see which
  plants make those products, each mapping with a source and confidence.
- **Map** — every geocoded plant on an interactive U.S. map.
- **Recall timeline** — FDA dairy enforcement records over time, matched
  to plants where possible, with CSV/JSON export.

## Stack

- Node.js + Express, EJS templates (server-rendered, no React/build step)
- SQLite via `better-sqlite3`, FTS5 for search
- `pdf-parse` for the IMS PDF; plain-text parse for the USDA list
- openFDA Food Enforcement API; OpenStreetMap Nominatim for geocoding
- Leaflet + OpenStreetMap tiles for the map (no API keys anywhere)
- Deployed on Railway with a persistent volume
- Tests via Node's built-in `node --test`

## Data sources

| Source | Covers | In the app as |
|--------|--------|---------------|
| FDA Interstate Milk Shippers (IMS) List (PDF, quarterly) | Grade A fluid + cultured plants | `source='IMS'`, codes like `55-372` |
| USDA AMS Approved Dairy Plant List | Manufactured products: cheese, butter, dry milk, frozen desserts, whey | `source='USDA-AMS'`, codes like `USDA-55-322` (+ bare-code alias) |
| Wisconsin DATCP licensed dairy plants | All WI state-licensed dairy operations (long tail not in federal data); supplies street addresses for IMS overlaps | `source='WI-DATCP'` (or supplements existing IMS rows); license no. as alias |
| openFDA Food Enforcement API | Recalls | `recalls` table |
| Hand-curated CSV + recall code harvest | Brand→plant mappings | `plant_brands`, each row sourced |

## Quick start (local)

```bash
npm install
npm run db:init      # create db/plant_track.db from db/schema.sql
npm run seed:load    # load brand/brand-mapping CSVs
npm run dev          # http://localhost:3000
npm test             # run the unit tests
```

Local dev has no plant rows until you ingest IMS/USDA data (those scripts
need network access to FDA/USDA, which may be firewalled in some
environments — they run fine on Railway or a normal machine).

## Database refresh runbook

Everything below runs against the **deployed** container through the
token-protected admin endpoint, so data lands on the Railway volume.
Set two shell variables first:

```bash
URL=https://dairyplant-atlas.up.railway.app
TOKEN=<the ADMIN_TOKEN you set in Railway>
```

`POST /admin/run/<name>` runs a script and streams its output back.
Authenticate with the `X-Admin-Token` header. Run them in this order on
a fresh database; individually thereafter as needed.

```bash
# 1. IMS plants. Get the current PDF link from the FDA IMS List page first.
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/ims-download?url=<PDF_URL>"
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/ims-ingest"
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/ims-sanity"   # eyeball before trusting

# 2. USDA manufactured-product plants (cheese/butter/dry/frozen).
#    The list text is checked in at data/usda/usda-list.txt; refresh it
#    quarterly from apps.ams.usda.gov/dairy/ApprovedPlantList.
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/usda-ingest"

# 2b. Wisconsin DATCP licensed plants (long tail of WI cheese/cream/butter
#     not in federal data; also supplies street addresses for IMS overlaps).
#     CSV at data/datcp/wi-licensed-plants.csv; refresh quarterly from
#     mydatcp.wisconsin.gov -> Registries/Lists -> Dairy Plant License Holders.
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/datcp-ingest"

# 2c. State-license gap packs (curated candidates outside federal data:
#     IA, MN, PA, OH, ID, MI, NY, VT, SD, TX, KS so far). All CSV files in
#     data/state-gap/ are loaded — each curation round can ship its own
#     file for a per-round audit trail. Respects 'Review Status' and
#     dedups against IMS/USDA/DATCP via normalized code lookup.
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/state-gap-ingest"

# 3. Geocode plants for the map (~15 min first run; cached by city after).
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/geocode"

# 4. Recalls from openFDA, then pin any with a printed plant code.
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/recalls-sync?max_pages=20"
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/harvest-codes?apply=1"

# Reload brand mappings after a wipe (also runs automatically on deploy).
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/seeds-load"
```

Available admin scripts: `ims-download`, `ims-ingest`, `ims-sanity`,
`ims-dump` (debug; `?from=&to=` or `?grep=`), `usda-ingest`, `geocode`,
`recalls-sync` (`?max_pages=`), `harvest-codes` (`?apply=1`),
`resolve-plants` (`?queries=a,b,c`), `seeds-load`.

## Brand mappings

Hand-curated in `data/seeds/plant_brands.csv`, checked into git so the
history is the audit trail. Every row needs `source`, `confidence`
(high/medium/low), and `last_verified`; the loader refuses rows missing
any of them. Two evidence classes are used today:

- **Documented** — company "our plants" pages, trade press, Wikipedia.
- **Recall-derived** — FDA recall notices that print the producing
  plant's code on the recalled product (see `harvest-codes`). These are
  the only sourced path into private-label / co-pack relationships.

## Project layout

```
db/schema.sql              Full schema (FTS5, triggers, all tables)
src/server.js              Express app + admin endpoint
src/views/                 EJS templates
src/public/style.css       Visual identity
scripts/
  init-db.js               Apply schema (+ defensive column migrations)
  load-seeds.js            Load brand CSVs; refuses unsourced rows
  ingest-ims.js            Parse IMS PDF -> plants  (parseImsText is pure/tested)
  ingest-ims-sanity.js     Red-flag report + sample rows
  dump-ims.js              Raw PDF text inspector (debug)
  ingest-usda.js           Parse USDA list -> plants (parseUsdaText is pure/tested)
  sync-recalls.js          openFDA pull + fuzzy match (matchPlant is pure/tested)
  harvest-recall-codes.js  Plant codes printed in recalls (extractCodes pure/tested)
  resolve-plants.js        Batch code lookup by name
  geocode-plants.js        City-centroid geocoding for the map
data/seeds/                Brand CSVs (checked in)
data/usda/usda-list.txt    USDA list snapshot (checked in)
data/ims/                  Downloaded PDFs (gitignored; on volume in prod)
test/                      node --test unit tests
```

## Schema notes worth knowing

- `plant_code_aliases` lets one plant resolve by multiple code systems
  (IMS, USDA bare code, future FDA-FFR/state). The recall harvester and
  code lookup both consult it, not just `plants.plant_code`.
- `plant_brands.region` is required for private-label rows — store brands
  source from different processors by geography.
- `recalls.match_method` is `name` | `name+geo` | `plt_code` | `manual` |
  `unmatched`; `plt_code`/`manual` are never overwritten by a re-sync.
- `recall_overrides` is a manual correction table; survives resyncs.
- `plants.lat/lon/geocoded_at` back the map; populated by `geocode`.

## Durable state (survives a lost volume)

Most of the database rebuilds from files in git: plants come from the
USDA/DATCP/state-gap ingests, brand mappings from `data/seeds/`, recalls
from a re-sync. Two things did not, and were lost when the Railway trial
lapsed and took the volume with it:

- **Geocodes.** Cheap per lookup, but Nominatim allows about one request
  per second, so a full run is 20-30 minutes of wall clock that cannot be
  hurried.
- **Recall overrides.** Hand-typed corrections pinning a recall to a
  plant. Nothing regenerates these.

Both now export to CSV under `data/durable/` and are restored on every
container start.

```bash
npm run durable:export    # DB  -> data/durable/*.csv   (then commit)
npm run durable:import    # CSV -> DB                   (runs in prestart)
```

`durable:import` runs automatically as part of `prestart`, so a fresh
volume comes back with its map and corrections already populated and
makes zero network calls doing it. It is deliberately non-fatal: a
missing, partial, or corrupt file logs and is skipped, never blocking a
boot.

**After any geocode run, export and commit**, or the work only exists on
the volume again:

```bash
npm run geocode
npm run durable:export
git add data/durable && git commit -m "Refresh geocache"
```

Notes on how the files are keyed, both of which matter:

- Geocodes are keyed on `(address, city, state)`, the inputs to the
  lookup, not on `plant_code`. A plant that moves to a new address misses
  the cache and gets re-geocoded rather than silently keeping a stale
  pin. Because many plants share a town, roughly 430 cached lookups
  restore around 550 plants.
- Overrides are exported against `plant_code`, never `plant_id`.
  `plant_id` is an autoincrement rowid that gets reassigned on every
  rebuild; a correction stored against it would come back pointing at an
  unrelated plant.

Not covered, on purpose: `recalls` (re-syncs from openFDA), harvested
recall codes (derived, re-runnable), and `search_log` (telemetry). The
uploaded hero image under `data/assets/` is still volume-only.

## Health check

`GET /healthz` reports the database path, whether it resolves to a
mounted volume, row counts, the state of the durable files, and explicit
warnings. It returns counts and deployment shape only, never environment
values. It exists so a deploy can be diagnosed without a Railway login:
"up but the volume didn't mount" and "up but empty" otherwise look
identical from outside.

```json
{
  "ok": false,
  "db": { "path": "/data/plant_track.db", "on_volume": true },
  "data": { "plants": 955, "geocoded": 941, "recalls": 0 },
  "durable": { "geocache_rows": 434, "override_rows": 1 },
  "warnings": ["no_plants: database has no plant rows; ingests have not been run"]
}
```

## Deploying to Railway

1. Service branch points at this branch; build runs `db:init` + `seed:load`.
2. Persistent volume mounted at `/data`.
3. Variables: `PLANT_TRACK_DB=/data/plant_track.db`,
   `ADMIN_TOKEN=<long random string>`.
4. Node pinned to 20 (`.node-version`/`.nvmrc`) — `better-sqlite3` has no
   prebuilt binary for newer majors on Railway's image.

The volume is load-bearing. If `PLANT_TRACK_DB` points at `/data` and no
volume is mounted there, the app refuses to start with an error naming
the path, rather than creating the directory and quietly writing to
ephemeral container disk that vanishes on the next deploy.

If the service ever comes back on a hostname that returns Railway's
`{"code":404,"message":"Application not found"}`, that is the edge saying
no service claims that domain — the app is not the problem. Regenerate
the public domain in the service's networking settings. A crashed app
returns a 502 instead, which is a different fix.

Schema init + seed load run on every container start (`prestart`), both
idempotent, against the volume.

## A note on accuracy

Federal-database rows (IMS, USDA AMS, openFDA) are as authoritative as
those sources. Brand mappings each carry a citation and a confidence
level. Corrections welcome at the email on the About page; manual
overrides persist across refreshes.
