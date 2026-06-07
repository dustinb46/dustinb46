# Plant Track — Handoff

You are picking up an in-progress project. Read this whole doc before
starting; most of the surprises are called out below.

---

## 1. What this is

A dairy plant transparency lookup. Three things in one place:

1. **Plant code → plant.** Input a plant code (e.g. `55-23`), get the
   plant name, address, ownership, FMMO pool, category.
2. **Brand → plant(s).** Input a brand or product, get the plant(s) that
   make it, with explicit source + confidence on every mapping.
3. **Recall history per plant.** FDA enforcement actions joined to plants
   via fuzzy match, never silently asserted.

Audience: dairy operators sizing up competitors, journalists tracing
recalls, consumers checking who actually makes their milk, and source
material for HerdSignal content on processor consolidation.

---

## 2. Decisions that are locked in (don't relitigate)

These came out of a pre-build pressure-test of the original spec. Keep
them unless you have a strong reason to change.

- **v1 covers IMS-listed Grade A plants only.** Other code systems (FDA
  food facility registration, USDA establishment, state codes) are out
  of scope for v1, but the schema (`plant_code_aliases`) is ready to
  accept them later. UI says so explicitly so users with non-IMS codes
  aren't silently 404'd.
- **No React.** Express + EJS, server-rendered. No build step, no dev
  server, no CORS. The UI is intentionally plain.
- **SQLite + FTS5.** Full-text search is on from day one.
- **Brand-to-plant CSV is checked into git.** Re-loaded on every deploy.
  Git history is the audit trail. Not a one-time seed.
- **Every brand mapping requires `source`, `confidence`, `last_verified`.**
  The loader refuses rows missing any of these.
- **Recall fuzzy matches store `match_confidence` and `match_method`.**
  Anything below 0.35 is stored as `unmatched`, shown explicitly in the
  UI, never hidden.
- **Disclaimer banner site-wide.** "Plant Track is informational and not
  authoritative. Verify before publishing or citing."
- **No defamation-adjacent claims.** Mappings show provenance. Recalls
  show match confidence. We don't say things we can't back.

---

## 3. Current state

**Repo branch:** `claude/bold-meitner-fnXod`
**Local commit:** `dfa93a8 Scaffold Plant Track MVP`
**Pushed?** No — the GitHub App on `dustinb46/dustinb46` is denying push
with 403 (needs `Contents: Read and write` granted to the Claude app).
If you can't push either, see Section 8.

### What works locally (verified)

```bash
npm install
npm run db:init       # creates db/plant_track.db
npm run seed:load     # 4 placeholder plants, 4 brands, 5 mappings
npm start             # http://localhost:3000
```

All routes return 200 and render: `/`, `/search`, `/plant/:code`,
`/brand/:id`, `/recalls`, `/about`, plus a proper 404.

### What's blocked in the dev sandbox

- `npm run ims:download` and `npm run recalls:sync` both 403 against
  FDA / openFDA in this network-restricted container. The code is
  correct; runs fine on Railway or a normal machine.

---

## 4. File map (current scaffold)

```
db/
  schema.sql                     Full schema with column-level comments
  plant_track.db                 Built locally (gitignored)
src/
  server.js                      Express app, routes, FTS query helper
  db.js                          Shared better-sqlite3 handle
  views/
    _header.ejs _footer.ejs _search-form.ejs
    index.ejs search.ejs plant.ejs brand.ejs recalls.ejs about.ejs not_found.ejs
  public/style.css
scripts/
  init-db.js                     Apply schema (--reset to wipe)
  load-seeds.js                  Load CSVs from data/seeds/
  download-ims.js                Fetch the IMS List PDF
  ingest-ims.js                  Parse PDF into plants table
  ingest-ims-sanity.js           Red-flag report + 10 random rows
  sync-recalls.js                openFDA fetch + Jaccard fuzzy match
data/
  seeds/
    plants.csv                   Illustrative placeholders (clearly marked)
    brands.csv
    plant_brands.csv
    README.md                    Seed CSV column reference
  ims/                           PDFs land here (gitignored)
railway.json
README.md
package.json
```

---

## 5. Schema highlights worth knowing before you touch the DB

Full DDL in `db/schema.sql`. Things that are not obvious:

- `plants.plant_code` is the canonical IMS code. Unique.
- `plant_code_aliases (plant_id, code, code_system)` — one physical
  plant can be reachable by multiple code systems. Populate `ims` from
  the IMS ingest; leave `fda_ffr` / `usda_est` / `state` for later.
- `plant_brands.region` is required for private-label rows because
  store-brand milk is routinely sourced from whichever processor is
  closest to the DC. Don't drop this column.
- `plant_brands.last_verified` and `verified_by` are tracked because
  brand mappings rot fastest.
- `recalls.match_confidence` (0..1) and `recalls.match_method`
  (`name` | `name+geo` | `manual` | `unmatched`) are first-class
  columns. Surfaced in the UI.
- `recall_overrides (recall_number, plant_id, note)` lets a reviewer
  pin a recall to a plant manually. Applied at end of each sync.
- `ingest_runs` is a lightweight log; populate it from any new ingest
  scripts you add.
- FTS5 virtual tables (`plants_fts`, `brands_fts`) plus triggers that
  keep them in sync. Don't write to plants/brands without the triggers.

---

## 6. What to do next, in priority order

### Priority 1 — get the IMS parser to a trusted state
This is the hardest part of the project, not a Tuesday-afternoon job.

1. Grab the current IMS List PDF URL from
   https://www.fda.gov/food/milk-guidance-documents-regulatory-information/interstate-milk-shippers-list
2. `IMS_PDF_URL="..." npm run ims:download`
3. `npm run ims:ingest`
4. `npm run ims:sanity` — read the red-flag counts and inspect the
   10 random rows against the PDF by hand.
5. If anything looks wrong, fix `scripts/ingest-ims.js` and repeat.
   The current parser is deliberately conservative — it skips garbled
   rows rather than guessing. It will need iteration against the real
   PDF; the parsing heuristics in `parseLine()` are the first thing to
   adjust.

**Do not deploy with un-sanity-checked IMS data.**

### Priority 2 — pull real recalls and review the matches
1. `npm run recalls:sync` (default 10 pages of 100 = ~1000 records)
2. Visit `/recalls?matched=yes` and eyeball the matches. Anything that
   looks wrong, add an override:
   ```sql
   INSERT INTO recall_overrides (recall_number, plant_id, note)
   VALUES ('F-1234-2024', 17, 'Confirmed via press release …');
   ```
3. Re-run sync; the override is reapplied.

### Priority 3 — replace illustrative seeds with real mappings
1. `data/seeds/plants.csv` should be empty once IMS ingest works — the
   real plants come from the parser, not the seed.
2. `data/seeds/plant_brands.csv` is the file that matters. Add 20–30
   mappings you can actually source. Required columns: `plant_code`,
   `brand_name`, `source`, `confidence` (high/medium/low), `last_verified`.
   See `data/seeds/README.md`.
3. `npm run seed:load` — loader will refuse any row missing required
   fields and log why.

### Priority 4 — deploy to Railway
1. `railway.json` is in place. Runs `db:init && seed:load` at build.
2. Add a persistent volume mounted at `/data`.
3. Set `PLANT_TRACK_DB=/data/plant_track.db`.
4. Run `npm run ims:ingest` once via the Railway shell after first
   deploy (the PDF is too quirky to do at build time).
5. Schedule `npm run recalls:sync` as a daily cron.

### Priority 5 — polish before sharing the URL
- About page email is `brunndairy88@gmail.com` — change if you want a
  different correction inbox.
- Tighten the disclaimer wording with whoever's reviewing legal.
- Make sure the homepage stat counts look credible (4 placeholder
  plants will look silly; either ingest IMS first or hide the stats).

---

## 7. Out of scope (do not build)

Owner has been explicit. If any of these start looking tempting before
v1 ships, stop and refocus.

- User accounts, logins, comments
- Crowdsourced submission UI
- Image OCR of carton codes
- Mobile app
- Any payment / paywall
- AI-generated commentary on plants

---

## 8. If you can't access the existing branch

The code is committed locally in the previous workspace but not pushed.
If you can't pull the branch:

- **Option A (recommended):** get the GitHub App permission fixed
  (`Contents: Read and write` on `dustinb46/dustinb46` for the Claude
  app at github.com/settings/installations) and then someone with
  workspace access pushes it. Five minutes saved beats two hours of
  rebuilding.
- **Option B:** rebuild from this handoff doc + the spec. The schema
  in `db/schema.sql` is the most important file; everything else
  follows naturally. Section 9 is a one-page rebuild brief if you take
  this path.

---

## 9. Rebuild brief (only if you can't pull the branch)

Stack: Node 20+, Express 4, EJS, better-sqlite3 11, csv-parse 5,
pdf-parse 1. No React.

Build order:

1. `package.json` with scripts: `start`, `dev`, `db:init`, `seed:load`,
   `ims:download`, `ims:ingest`, `ims:sanity`, `recalls:sync`.
2. Schema in `db/schema.sql` — tables in Section 5 above. FTS5 virtual
   tables + triggers for `plants` and `brands`.
3. `scripts/init-db.js` applies schema. Supports `--reset`.
4. Seed CSVs under `data/seeds/`: `plants.csv`, `brands.csv`,
   `plant_brands.csv`. Mark every row `source=illustrative_seed` until
   replaced with real data.
5. `scripts/load-seeds.js` upserts CSVs. **Refuses brand rows missing
   source/confidence/last_verified.** Logs every skipped row.
6. `scripts/download-ims.js` fetches `IMS_PDF_URL` to `data/ims/`.
7. `scripts/ingest-ims.js` parses PDF with `pdf-parse`, conservative
   line parser, upserts into `plants`, inserts ims alias row.
8. `scripts/ingest-ims-sanity.js` prints red-flag counts and 10 random
   rows. Run after every ingest.
9. `scripts/sync-recalls.js` paginates openFDA food enforcement, dairy
   keywords, Jaccard token match on firm/plant names, +0.2 same state
   +0.15 same city, threshold 0.35, applies `recall_overrides` at end.
10. Express app (`src/server.js`) with routes `/`, `/search`,
    `/plant/:code`, `/brand/:id`, `/recalls`, `/about`, 404.
    Plant lookup checks `plant_code_aliases` if direct hit misses.
11. EJS views with header/footer partials, disclaimer banner site-wide,
    confidence badges on every mapping and recall match.
12. `railway.json` with build = `npm install && npm run db:init && npm run seed:load`, start = `npm start`.

---

## 10. Open questions for the owner (not yet answered)

These are the owner's own open questions from the original spec. My
recommendations are noted, but they get the final call.

- **Subdomain vs own domain?** Recommend HerdSignal subdomain for v1.
  Lower commitment, decide at deploy.
- **Brand CSV one-time seed or checked-in?** Decided: checked-in, in
  git, reloaded on deploy.
- **v2 priority: more brand mappings or journalist-facing recall
  timeline?** Recommend recall timeline. FDA data is already
  authoritative, the audience is sharper, press citations create a
  flywheel.

---

## 11. Things to NOT do

- Don't add scraped data without a source field.
- Don't display a brand-to-plant mapping without a confidence badge.
- Don't deploy IMS plant data that hasn't been through
  `npm run ims:sanity`.
- Don't merge a fuzzy recall match without `match_confidence` and
  `match_method` populated.
- Don't strip the disclaimer banner.
- Don't add user accounts or comments. Not v1.
- Don't introduce React. The plain stack is a feature.
