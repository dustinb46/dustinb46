# Plant Track

A dairy plant transparency lookup tool. Maps plant codes printed on dairy
packaging to the plant that made the product, the brands that come out of
that plant, and the recall history attached to it.

> **v1 scope:** IMS-listed Grade A fluid and cultured plants only. Codes
> from other systems (FDA food facility registration, USDA establishment
> numbers, state-specific codes) are not yet supported — packages carrying
> those will not resolve in this version.

## Stack

- Node.js + Express, EJS templates (no React, no build step)
- SQLite via `better-sqlite3`, with FTS5 for search
- `pdf-parse` for IMS List ingestion
- openFDA Food Enforcement API (no key required)
- Railway-ready

## Quick start

```bash
npm install
npm run db:init        # creates db/plant_track.db from db/schema.sql
npm run seed:load      # loads illustrative placeholder data
npm run dev            # http://localhost:3000
```

You'll see four placeholder plants and a few mappings. That's enough to
walk through the UI and decide what to change next.

## Real data

### 1. IMS plant list (the FDA PDF)

The PDF URL rotates each quarter. Find the current one on the
[FDA IMS List page](https://www.fda.gov/food/milk-guidance-documents-regulatory-information/interstate-milk-shippers-list),
then:

```bash
IMS_PDF_URL="https://www.fda.gov/...your-url..." npm run ims:download
npm run ims:ingest
npm run ims:sanity     # ALWAYS run after ingest; spot-check the sample rows
```

The parser is deliberately conservative. Sanity-check output will:

- Count red flags (missing state, garbled names, code-in-name, duplicates)
- Print 10 random rows for you to manually compare against the PDF

If anything looks off, fix the parser before trusting the data. **Do not
deploy with un-sanity-checked IMS data.**

### 2. Recall data (openFDA)

```bash
npm run recalls:sync                    # default: 10 pages of 100
RECALL_MAX_PAGES=50 npm run recalls:sync # pull more history
```

Each recall is fuzzy-matched to a plant using a Jaccard score on
normalized firm/plant names, with bonuses for matching state and city.
Matches under 0.35 are stored as `unmatched`. Confidence and method
(`name`, `name+geo`, `manual`, `unmatched`) are stored on the row and
shown in the UI.

To pin or unpin a specific recall manually, insert into `recall_overrides`:

```sql
INSERT INTO recall_overrides (recall_number, plant_id, note)
VALUES ('F-1234-2024', 17, 'Confirmed by press release dated ...');
```

The override is applied at the end of each sync run.

### 3. Brand-to-plant mappings

Hand-curated in `data/seeds/plant_brands.csv`. **Checked into git** so the
history is your audit trail. Every row requires `source`, `confidence`,
and `last_verified`. The loader (`npm run seed:load`) refuses rows
missing any of those.

See `data/seeds/README.md` for the column reference.

## Project layout

```
db/
  schema.sql              Full schema with comments
  plant_track.db          SQLite file (gitignored)
src/
  server.js               Express app
  db.js                   Shared DB handle
  views/                  EJS templates
  public/style.css
scripts/
  init-db.js              Apply schema (--reset to wipe)
  load-seeds.js           Load CSVs from data/seeds/
  download-ims.js         Fetch the IMS List PDF
  ingest-ims.js           Parse PDF into plants
  ingest-ims-sanity.js    Red-flag report on parsed data
  sync-recalls.js         Pull openFDA, fuzzy-match to plants
data/
  seeds/                  Brand/plant CSVs (checked in)
  ims/                    Downloaded PDFs (gitignored)
```

## Schema notes worth knowing

- `plant_code_aliases` lets one plant be reachable by multiple code
  systems (IMS, FDA FFR, USDA est., state codes). v1 only populates IMS,
  but the surface is there.
- `plant_brands.region` is required for private-label rows because store
  brands routinely source from different processors by geography.
- `plant_brands.last_verified` and `verified_by` are tracked because
  brand mappings rot fastest.
- `recalls.match_confidence` and `recalls.match_method` are first-class
  columns and surfaced in the UI — never display a fuzzy match as fact.
- `recall_overrides` is a manual correction table; values survive
  resyncs.

## Journalist features

- `/timeline` — monthly recall volume, class breakdown, most-recalled
  firms, filterable by class / state / date range / firm / match status.
- `/api/recalls.json` and `/api/recalls.csv` — exports with the same
  filter surface (`?class=Class+I&state=WI&from=2023-01-01&firm=...`),
  capped at 5000 rows.
- `/admin/ingest` — read-only audit of every ingest run and current row
  counts. No auth; it's all public-source metadata.

## Deploying to Railway

The app is deployed from the GitHub repo with these settings:

1. **Branch**: point the service at this branch.
2. **Volume**: add a persistent volume mounted at `/data`.
3. **Variables**:
   - `PLANT_TRACK_DB=/data/plant_track.db`
   - `ADMIN_TOKEN=<long random string>` (e.g.
     `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`)
4. Node is pinned to 20 (`.node-version` / `.nvmrc`) because
   `better-sqlite3` has no prebuilt binary for newer majors on
   Railway's build image.

Schema init and seed loading run automatically on every container
start (`prestart`), against the volume. Both are idempotent, and the
illustrative placeholder rows are automatically retired once real IMS
data exists.

### Running ingests on the deployed container

`POST /admin/run/:name` triggers a script inside the running container
and streams its output back. Authenticate with the `X-Admin-Token`
header. Available names: `ims-download`, `ims-ingest`, `ims-sanity`,
`recalls-sync`, `seeds-load`.

```bash
URL=https://your-app.up.railway.app
TOKEN=your-admin-token

# 1. Recalls (no input needed). max_pages of 100 records each.
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/recalls-sync?max_pages=20"

# 2. IMS plants. Get the current PDF link from the FDA IMS List page first.
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/ims-download?url=<PDF_URL>"
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/ims-ingest"
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/ims-sanity"
# Read the sanity output before trusting the data.

# 3. Re-sync recalls so they match against the real IMS plants.
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/recalls-sync?max_pages=20"
```

For ongoing freshness, schedule `recalls-sync` daily (Railway cron
service hitting the endpoint, or any external cron + curl).

## Sandbox / restricted egress

If you're running where openFDA or the FDA domain is blocked, recall and
IMS scripts will fail with HTTP 403 / connection errors. Run them
elsewhere (locally or on Railway) and the rest of the app works fine
from the seed data.

## Disclaimer

Plant Track is informational and not authoritative. Mappings carry an
explicit source and confidence; recall matches carry a confidence score
and method. **Verify before publishing or citing.** Corrections welcome
via the email on the About page.
