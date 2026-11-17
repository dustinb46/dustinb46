# Dairy Plant Atlas — Runbook

Written for someone who has not touched this in six months. Keep it
short and update it when something here stops being true.

## Where everything is

| Thing | Where |
|-------|-------|
| Live site | https://dairyplant-atlas.up.railway.app |
| Code | GitHub `dustinb46/dustinb46`, branch `claude/bold-meitner-fnXod` (not `main`; `main` is the profile page and the daily brief) |
| Hosting | Railway, project `welcoming-perfection`, service `dustinb46` |
| Database | SQLite file on the Railway volume `dustinb46-volume`, mounted at `/data` |
| Secrets | Railway service Variables: `ADMIN_TOKEN`, `PLANT_TRACK_DB` |

## Deploy

Push to the branch. Railway builds the `Dockerfile` and swaps the new
container in. If a build fails, the previous deployment keeps serving.

To redeploy without a code change: Railway, service `dustinb46`,
Deployments tab, three dots on the latest deployment, Redeploy.

## The site is down. Check in this order.

1. **Billing.** This is what took the site down from July to November
   2026. If the Railway subscription lapses, every deployment is removed
   and the URL returns "Application not found". Fix: reactivate the plan,
   then redeploy the latest deployment (steps above). Railway only keeps
   volume data for a limited window after a plan is cancelled (60 days on
   Hobby as of Nov 2026), so do not sit on this.
2. **Wrong thing got deployed.** If the latest deployment in Railway says
   FAILED and names a commit like "Create README.md", it tried to build
   `main`. Under Settings, "Branch connected to production" must read
   `claude/bold-meitner-fnXod`. Then redeploy the last good deployment
   from the History list.
3. **Build failed.** Open the failed deployment, View logs, Build tab.
   The build is plain: `npm ci` then `npm start` on Node 20.
4. **Deploys but 502s.** Open the Deploy logs. The usual cause is a
   missing variable: `PLANT_TRACK_DB` must be `/data/plant_track.db` and
   the volume must still be attached to the service.
5. **Site loads but data is empty.** The volume is detached or new. Check
   the volume is attached and mounted at `/data`. If the data is really
   gone, rebuild it with the refresh steps in `README.md`.

## Routine upkeep

- **Recalls** sync from openFDA daily on their own. The timeline page
  shows when the last sync ran. If that date is more than a few days
  old, the scheduler is not running: check the Deploy logs for lines
  starting `[scheduler]`.
- **News** is a hand-edited CSV: `data/seeds/news_items.csv`. Edit it,
  push, and the deploy reloads it. The CSV is the whole truth: a row
  removed from the CSV is removed from the site.
- **Brand mappings** work the same way: `data/seeds/plant_brands.csv`.
- **IMS plant list** is refreshed by hand, roughly quarterly, through the
  admin endpoint. Steps are in `README.md` under "Database refresh
  runbook".

## Admin pages

Add `?token=<ADMIN_TOKEN>` to the URL (the token is in Railway Variables):

- `/admin/searches` — what people searched for, and what returned nothing
- `/admin/ingest` — ingest history and row counts

## Things that are not done

- **No backup of the database exists.** Railway volume backups need the
  Pro plan. Until there is a copy somewhere else, a deleted volume means
  re-running every ingest and geocode from scratch.
- **No uptime alert.** The July 2026 outage went unnoticed for four
  months. A free monitor on the live URL would have emailed the same day.
- **Some co-op milk supply listings are still counted as plants.** IMS
  does not mark all of them `(BTU)`. Example: about twenty "Dairy
  Farmers of America" rows listed at Syracuse, NY.

## Run it locally

```bash
npm install
npm run db:init
npm run seed:load
npm run dev      # http://localhost:3000
npm test
```

A local database has brands and news but no plants until the ingest
scripts are run (they need to reach FDA and USDA).
