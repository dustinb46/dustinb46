# Seed data

These CSVs ship with **clearly illustrative placeholder data** so the UI has
something to render before the IMS PDF is ingested or your verified brand
mappings are loaded.

**Replace before any real launch.** Every row marked `illustrative_seed`
should be removed once you have:

1. Real plants from `npm run ims:ingest` (populates `plants` from the FDA
   IMS List PDF).
2. Your hand-curated brand-to-plant CSV with `source`, `confidence`, and
   `last_verified` filled in honestly.

## Files

- `plants.csv` — placeholder plant rows. Use only until IMS ingest works.
- `brands.csv` — brand name registry. Editable by hand.
- `plant_brands.csv` — the mappings. **This is the file you care about most.**

## plant_brands.csv columns

| column            | required | notes                                                            |
|-------------------|----------|------------------------------------------------------------------|
| plant_code        | yes      | Must match an existing `plants.plant_code`                       |
| brand_name        | yes      | Auto-created in `brands` if missing                              |
| product_category  | no       | milk / yogurt / cream / cheese / other                           |
| region            | no       | Free text, e.g. "Northeast US"; required for private-label rows  |
| source            | yes      | URL, document reference, or "manual"                             |
| confidence        | yes      | high / medium / low                                              |
| notes             | no       | Anything a reviewer should know                                  |
| last_verified     | yes      | ISO date (YYYY-MM-DD) of the most recent check                   |
| verified_by       | no       | Initials or name                                                 |

Loaded with `npm run seed:load`. Safe to re-run; existing rows are upserted
on (plant_code, brand_name, region).
