# Herd dispersal listings

CSV files in this folder feed the "Herd dispersals" layer on `/map`, the
"Where are herds exiting?" view, `/api/records.json` and `/feed.xml`.

Every `.csv` file here is loaded by `scripts/ingest-dispersals.js`, which
runs on every container start and can be re-run by hand:

```bash
node scripts/ingest-dispersals.js
curl -X POST -H "X-Admin-Token: $TOKEN" "$URL/admin/run/dispersals-ingest"
```

`dispersals.csv` ships with a header and no rows. The layer stays empty,
and says so on the page, until real listings are added. Each scrape or
curation round can add its own file (for example `2026-11-wi.csv`); rows
upsert on date + headline + source link, so overlap between files is safe.

## Columns

| column      | required | notes                                                        |
|-------------|----------|--------------------------------------------------------------|
| event_date  | yes      | Sale date, `YYYY-MM-DD`                                      |
| headline    | yes      | One line, as it should read in the feed                      |
| head_count  | no       | Whole number of head listed, when the listing states it      |
| herd_type   | no       | Free text, e.g. `Holstein`, `organic`, `Jersey`              |
| city        | no       | Town where the sale is held                                  |
| county      | no       | County, without the word "County"                            |
| state       | yes      | Two-letter code                                              |
| lat, lon    | no       | Both or neither. Use them for towns that have no plant       |
| auctioneer  | no       | Who is running the sale                                      |
| source_url  | yes      | Link to the listing. No link, no row                         |
| source_name | no       | e.g. the auctioneer's site name                              |
| added_by    | no       | Initials, or the name of the scraper                         |

## How a listing gets on the map

A row with `lat` and `lon` is pinned there. A row without them is pinned
at the centre of its town if the atlas already has a plant in that town.
A row with neither still shows in the feed, marked "not on the map".

Rows missing a date, headline, state or source link are refused and
logged, the same rule the news and brand loaders apply.
