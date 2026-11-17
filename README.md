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
- **Layered map** (`/map`) — the same plants with plant events, herd
  dispersals and recalls as layers you can turn on, four ready-made
  views built from those layers, and a "what changed" list beside the map.
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
`resolve-plants` (`?queries=a,b,c`), `seeds-load`, `dispersals-ingest`.

## Brand mappings

Hand-curated in `data/seeds/plant_brands.csv`, checked into git so the
history is the audit trail. Every row needs `source`, `confidence`
(high/medium/low), and `last_verified`; the loader refuses rows missing
any of them. Two evidence classes are used today:

- **Documented** — company "our plants" pages, trade press, Wikipedia.
- **Recall-derived** — FDA recall notices that print the producing
  plant's code on the recalled product (see `harvest-codes`). These are
  the only sourced path into private-label / co-pack relationships.

## Layered map (`/map`)

One page, many views. A view is a set of layers plus a time window, and
it lives in the URL, so every view can be linked from anywhere (the
HerdSignal brief, an email, a post).

| Link | What it shows |
|------|---------------|
| `/map?lens=capacity` | Plants + plant events ("Where is capacity moving?") |
| `/map?lens=exits` | Plants + herd dispersals ("Where are herds exiting?") |
| `/map?lens=buyers` | Plants, plus a click-to-count ring: processing plants and operators within 25/50/100 miles of any spot (supply listings are not counted) |
| `/map?lens=safety` | Plants + recalls matched to a plant |
| `/map?layers=plants,events,recalls` | Any combination, picked by the reader (`supply` adds bulk tank units and receiving/transfer stations) |

Add `&days=90` or `&days=0` (all time) to change the window; the default
is one year.

How it is put together:

- **One record shape.** `src/records.js` turns `news_items`, `recalls`
  and `dispersals` rows into the same thing: type, kind, date, title,
  place, source. A layer is a filter on type. A lens is a saved set of
  layers (the `LENSES` list in that file). The "what changed" list is the
  same records, newest first.
- **`GET /api/records.json?days=365&types=event,recall,dispersal`** is
  that record set as JSON. **`GET /feed.xml`** is the newest 50 as RSS
  (`?types=` narrows it).
- **Adding a signal** means one normalizer and one query in
  `src/records.js`, one entry in `LAYERS`/`LAYER_TYPE`, and a checkbox in
  `src/views/map.ejs`. It does not mean a new page.
- **Pins follow the same honesty rules as the rest of the site.** A
  record linked to a plant is pinned at the plant. A record with only a
  town is pinned at the town centre and says so. An unmatched recall is
  listed but never pinned, because the recalling firm's city is not the
  plant.

Herd dispersals load from `data/dispersals/*.csv` (see the README in that
folder). The file ships empty, and the page says so, until real listings
are added.

Not built yet, on purpose: a milkshed competition score. The buyers view
counts plants and operators inside a ring, which is a fact. A score needs
a decision about which plants buy farm milk and how to weigh capacity
against supply, and that decision has not been made.

## Project layout

```
db/schema.sql              Full schema (FTS5, triggers, all tables)
src/server.js              Express app + admin endpoint
src/records.js             News, recalls, dispersals in one shape; lenses; RSS
src/public/map.js          Browser code for /map (no build step)
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
  ingest-dispersals.js     Load data/dispersals/*.csv (parseDispersalRow is pure/tested)
data/seeds/                Brand CSVs (checked in)
data/usda/usda-list.txt    USDA list snapshot (checked in)
data/dispersals/           Herd dispersal CSVs (checked in; empty until fed)
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

## Deploying to Railway

1. The service deploys from this branch (`claude/bold-meitner-fnXod` of
   `dustinb46/dustinb46`). A push to the branch triggers a redeploy.
2. The build is the root `Dockerfile` (Node 20, `npm ci`, `npm start`).
   There is no `railway.json` and nothing depends on the Nixpacks
   builder; Railway deprecated both.
3. Persistent volume mounted at `/data`. The SQLite database lives there
   and is never part of the image.
4. Variables: `PLANT_TRACK_DB=/data/plant_track.db`,
   `ADMIN_TOKEN=<long random string>`.
5. Node pinned to 20 (`Dockerfile`, `.node-version`, `.nvmrc`).

Schema init + seed load run on every container start (`prestart`), both
idempotent, against the volume.

See `RUNBOOK.md` for what to do when the site is down.

## Admin pages

Everything under `/admin` needs the token, either as an `X-Admin-Token`
header or as `?token=` on the URL:

- `/admin/searches?token=...` — what visitors searched for, including
  zero-result queries (the list of brand mappings to add next)
- `/admin/ingest?token=...` — ingest run history and row counts

## How listings are shown

- The database stores every name exactly as its source prints it.
  `src/naming.js` cleans names up for display only (title case, IMS
  shorthand like `DY`/`CRY`/`FMS` expanded). The plant page shows the
  original as "Listed as"; search matches the original.
- The FDA IMS list also rates raw-milk supplies. Names marked `(BTU)`,
  `(RS)` or `(TR)` are bulk tank units and receiving/transfer stations,
  not plants. They are labelled, left out of the plant count and the
  default map layer, and listed separately on the browse pages.

## A note on accuracy

Federal-database rows (IMS, USDA AMS, openFDA) are as authoritative as
those sources. Brand mappings each carry a citation and a confidence
level. Corrections welcome at the email on the About page; manual
overrides persist across refreshes.
