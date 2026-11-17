const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const r = require('../src/records');

// ---------------- views ----------------

test('resolveView defaults to the first lens and the default window', () => {
  const v = r.resolveView({});
  assert.equal(v.lens, r.LENSES[0].id);
  assert.deepEqual(v.layers, r.LENSES[0].layers);
  assert.equal(v.days, r.DEFAULT_DAYS);
});

test('resolveView picks a named lens and its layers', () => {
  const v = r.resolveView({ lens: 'safety' });
  assert.equal(v.lens, 'safety');
  assert.deepEqual(v.layers, ['plants', 'recalls']);
});

test('resolveView falls back to the first lens for an unknown lens name', () => {
  assert.equal(r.resolveView({ lens: 'nonsense' }).lens, r.LENSES[0].id);
});

test('a layers list with no valid lens is a custom view', () => {
  const v = r.resolveView({ layers: 'recalls,events' });
  assert.equal(v.lens, 'custom');
  assert.deepEqual(v.layers, ['plants', 'events', 'recalls']);
});

test('a valid lens wins over a layers list', () => {
  const v = r.resolveView({ lens: 'capacity', layers: 'recalls' });
  assert.equal(v.lens, 'capacity');
  assert.deepEqual(v.layers, ['plants', 'events']);
});

test('parseLayers always keeps plants, drops unknowns and duplicates', () => {
  assert.deepEqual(r.parseLayers(''), ['plants']);
  assert.deepEqual(r.parseLayers('events,events,bogus, RECALLS '), ['plants', 'events', 'recalls']);
  assert.deepEqual(r.parseLayers(undefined), ['plants']);
});

test('parseDays only accepts the offered windows', () => {
  assert.equal(r.parseDays('90'), 90);
  assert.equal(r.parseDays('0'), 0);
  assert.equal(r.parseDays('17'), r.DEFAULT_DAYS);
  assert.equal(r.parseDays('abc'), r.DEFAULT_DAYS);
  assert.equal(r.parseDays(undefined), r.DEFAULT_DAYS);
});

test('viewQuery round-trips through resolveView', () => {
  for (const q of [{ lens: 'exits' }, { lens: 'buyers', days: '90' },
                   { layers: 'events,dispersals' }, { layers: '', days: '0' }]) {
    const v = r.resolveView(q);
    const again = r.resolveView(Object.fromEntries(new URLSearchParams(r.viewQuery(v))));
    assert.deepEqual(again, v);
  }
});

test('viewQuery leaves the default window out of the link', () => {
  assert.equal(r.viewQuery(r.resolveView({ lens: 'capacity' })), 'lens=capacity');
  assert.equal(r.viewQuery(r.resolveView({ lens: 'capacity', days: '90' })), 'lens=capacity&days=90');
});

test('sinceDate counts back from now, and is null for all time', () => {
  const now = new Date('2026-11-17T12:00:00Z');
  assert.equal(r.sinceDate(90, now), '2026-08-19');
  assert.equal(r.sinceDate(365, now), '2025-11-17');
  assert.equal(r.sinceDate(0, now), null);
});

test('typesFromQuery defaults to every type and ignores unknown names', () => {
  assert.deepEqual(r.typesFromQuery(undefined), r.TYPES);
  assert.deepEqual(r.typesFromQuery('recall,bogus'), ['recall']);
  assert.deepEqual(r.typesFromQuery('bogus'), r.TYPES);
});

// ---------------- normalizers ----------------

test('news linked to a plant is pinned at the plant', () => {
  const rec = r.normalizeNews({
    id: 7, event_date: '2026-06-17', kind: 'closure', headline: 'Plant to idle',
    plant_code: 'USDA-50-60', plant_name: 'Some Plant', plant_lat: 44.8, plant_lon: -73.1,
    city_lat: 44.0, city_lon: -73.0, source_url: 'https://example.org/a',
  });
  assert.equal(rec.id, 'event-7');
  assert.equal(rec.type, 'event');
  assert.equal(rec.located_by, 'plant');
  assert.equal(rec.lat, 44.8);
});

test('news with no plant falls back to the town centre, and says so', () => {
  const rec = r.normalizeNews({
    id: 8, event_date: '2026-08-04', kind: 'closure', headline: 'Factory to close',
    city: 'Bridgeton', state: 'NJ', city_lat: 39.4, city_lon: -75.2,
  });
  assert.equal(rec.located_by, 'city');
  assert.equal(rec.lon, -75.2);
});

test('news with no plant and no known town has no pin', () => {
  const rec = r.normalizeNews({ id: 9, event_date: '2026-01-01', kind: 'other', headline: 'x' });
  assert.equal(rec.lat, null);
  assert.equal(rec.located_by, null);
});

test('an unmatched recall is never pinned, even when the firm city is known', () => {
  const rec = r.normalizeRecall({
    event_key: '99458', event_date: '2026-07-18', firm_name: 'M.G. Foods',
    firm_city: 'Charlotte', firm_state: 'NC', classification: 'Class I',
    plant_code: null, plant_lat: 35.2, plant_lon: -80.8, product_count: 3,
  });
  assert.equal(rec.lat, null);
  assert.equal(rec.lon, null);
  assert.equal(rec.located_by, null);
  assert.equal(rec.title, 'M.G. Foods');
  assert.equal(rec.city, 'Charlotte');
});

test('a matched recall is pinned at its plant and titled with the plant', () => {
  const rec = r.normalizeRecall({
    event_key: '1', event_date: '2026-03-01', firm_name: 'Recalling Firm',
    classification: 'Class II', plant_code: '55-372', plant_name: 'The Plant',
    plant_city: 'Monroe', plant_state: 'WI', plant_lat: 42.6, plant_lon: -89.6,
  });
  assert.equal(rec.title, 'The Plant');
  assert.equal(rec.located_by, 'plant');
  assert.equal(rec.state, 'WI');
});

test('a dispersal uses its own coordinates before the town centre', () => {
  const own = r.normalizeDispersal({
    id: 1, event_date: '2026-11-01', headline: 'Herd dispersal', lat: 43.5, lon: -89.0,
    city_lat: 43.0, city_lon: -88.0, head_count: 1200, herd_type: 'Holstein',
  });
  assert.equal(own.located_by, 'listing');
  assert.equal(own.lat, 43.5);
  assert.equal(own.summary, '1,200 head · Holstein');
  const town = r.normalizeDispersal({
    id: 2, event_date: '2026-11-01', headline: 'Herd dispersal', city_lat: 43.0, city_lon: -88.0,
  });
  assert.equal(town.located_by, 'city');
  assert.equal(town.summary, null);
});

test('recall names and towns printed in capitals are cleaned for display', () => {
  const rec = r.normalizeRecall({
    event_key: '2', event_date: '2026-10-14', firm_name: 'Family Farmstead Dairy, LLC',
    classification: 'Class I', plant_code: '36-1', plant_name: 'FAMILY FARMSTEAD DY LLC',
    plant_city: 'WORCESTER', plant_state: 'NY', plant_lat: 42.6, plant_lon: -74.7,
  });
  assert.equal(rec.title, 'Family Farmstead Dairy LLC');
  assert.equal(rec.plant_name, 'Family Farmstead Dairy LLC');
  assert.equal(rec.city, 'Worcester');
  assert.equal(rec.firm, 'Family Farmstead Dairy, LLC');   // typed in mixed case: untouched
});

test('sortRecords is newest first and stable on ties', () => {
  const sorted = r.sortRecords([
    { id: 'b', date: '2026-01-01' }, { id: 'a', date: '2026-01-01' }, { id: 'c', date: '2026-05-01' },
  ]);
  assert.deepEqual(sorted.map(x => x.id), ['c', 'a', 'b']);
});

// ---------------- dispersal CSV rows ----------------

const GOOD = {
  event_date: '2026-11-20', headline: 'Complete herd dispersal', state: 'wi',
  source_url: 'https://example.com/sale/1',
};

test('parseDispersalRow accepts a minimal sourced row', () => {
  const p = r.parseDispersalRow(GOOD);
  assert.equal(p.ok, true);
  assert.equal(p.value.state, 'WI');
  assert.equal(p.value.head_count, null);
  assert.equal(p.value.lat, null);
  assert.equal(p.value.fingerprint.length, 40);
});

test('parseDispersalRow refuses rows with no source, date, headline or state', () => {
  assert.equal(r.parseDispersalRow({ ...GOOD, source_url: '' }).ok, false);
  assert.equal(r.parseDispersalRow({ ...GOOD, source_url: 'javascript:alert(1)' }).ok, false);
  assert.equal(r.parseDispersalRow({ ...GOOD, event_date: '11/20/2026' }).ok, false);
  assert.equal(r.parseDispersalRow({ ...GOOD, event_date: '2026-02-30' }).ok, false);
  assert.equal(r.parseDispersalRow({ ...GOOD, headline: '  ' }).ok, false);
  assert.equal(r.parseDispersalRow({ ...GOOD, state: 'Wisconsin' }).ok, false);
});

test('parseDispersalRow reads head counts with commas and refuses junk', () => {
  assert.equal(r.parseDispersalRow({ ...GOOD, head_count: '1,250' }).value.head_count, 1250);
  assert.equal(r.parseDispersalRow({ ...GOOD, head_count: 'about 300' }).ok, false);
});

test('parseDispersalRow refuses half a coordinate pair or an impossible one', () => {
  assert.equal(r.parseDispersalRow({ ...GOOD, lat: '43.5' }).ok, false);
  assert.equal(r.parseDispersalRow({ ...GOOD, lat: '143.5', lon: '-89' }).ok, false);
  const ok = r.parseDispersalRow({ ...GOOD, lat: '43.5', lon: '-89.1' });
  assert.equal(ok.value.lon, -89.1);
});

test('dispersal fingerprint ignores case and surrounding whitespace', () => {
  assert.equal(r.dispersalFingerprint('2026-11-20', ' Herd Sale ', 'https://X.com/a'),
               r.dispersalFingerprint('2026-11-20', 'herd sale', 'https://x.com/a'));
});

// ---------------- RSS ----------------

test('toRss escapes markup and links each item to its source', () => {
  const xmlOut = r.toRss([{
    id: 'event-1', type: 'event', kind: 'closure', date: '2026-06-17',
    title: 'A & B <Dairy> to close', summary: 'About "80" jobs', city: 'St. Albans', state: 'VT',
    source_url: 'https://example.org/a?x=1&y=2', source_name: 'Example',
  }], { abs: p => 'https://atlas.test' + p, title: 'T', description: 'D', selfPath: '/feed.xml' });
  assert.match(xmlOut, /<title>Closure: A &amp; B &lt;Dairy&gt; to close<\/title>/);
  assert.match(xmlOut, /<link>https:\/\/example\.org\/a\?x=1&amp;y=2<\/link>/);
  assert.match(xmlOut, /<pubDate>Wed, 17 Jun 2026 12:00:00 GMT<\/pubDate>/);
  assert.ok(!xmlOut.includes('<Dairy>'));
});

test('recordLink prefers the source, then the plant page, then the feed', () => {
  const abs = p => 'https://atlas.test' + p;
  assert.equal(r.recordLink({ source_url: 'https://s.test/x', plant_code: '55-1' }, abs), 'https://s.test/x');
  assert.equal(r.recordLink({ plant_code: 'USDA-55-1' }, abs), 'https://atlas.test/plant/USDA-55-1');
  assert.equal(r.recordLink({}, abs), 'https://atlas.test/timeline');
});

// ---------------- loadRecords against a real schema ----------------

function freshDb() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  // init-db adds this column after the schema on older databases.
  const hasEvent = db.prepare(`PRAGMA table_info(recalls)`).all().some(c => c.name === 'event_id');
  if (!hasEvent) db.exec(`ALTER TABLE recalls ADD COLUMN event_id TEXT`);
  return db;
}

test('loadRecords merges all three tables, newest first, inside the window', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO plants (plant_code, name, city, state, lat, lon)
              VALUES ('55-1', 'Plant One', 'Monroe', 'WI', 42.6, -89.6)`).run();
  const pid = db.prepare(`SELECT id FROM plants`).get().id;
  db.prepare(`INSERT INTO news_items (event_date, kind, headline, plant_id, city, state, source_url, fingerprint)
              VALUES ('2026-10-01', 'expansion', 'Linked news', ?, 'Monroe', 'WI', 'https://s.test/1', 'f1')`).run(pid);
  db.prepare(`INSERT INTO news_items (event_date, kind, headline, city, state, source_url, fingerprint)
              VALUES ('2026-09-01', 'closure', 'Unlinked, same town', 'monroe', 'wi', 'https://s.test/2', 'f2')`).run();
  db.prepare(`INSERT INTO news_items (event_date, kind, headline, city, state, source_url, fingerprint)
              VALUES ('2020-01-01', 'closure', 'Too old', 'Monroe', 'WI', 'https://s.test/3', 'f3')`).run();
  // One recall event, two product rows, matched to the plant.
  const rec = db.prepare(`INSERT INTO recalls (recall_number, event_id, firm_name, plant_id, classification, recall_date)
                          VALUES (?, 'E1', 'Firm', ?, ?, '2026-11-01')`);
  rec.run('F-1', pid, 'Class II');
  rec.run('F-2', pid, 'Class I');
  // One unmatched recall.
  db.prepare(`INSERT INTO recalls (recall_number, event_id, firm_name, firm_city, firm_state, classification, recall_date)
              VALUES ('F-3', 'E2', 'Other Firm', 'Monroe', 'WI', 'Class III', '2026-08-01')`).run();
  db.prepare(`INSERT INTO dispersals (event_date, headline, city, state, source_url, fingerprint)
              VALUES ('2026-11-10', 'Herd dispersal', 'Monroe', 'WI', 'https://s.test/d', 'd1')`).run();

  const out = r.loadRecords(db, { days: 365, now: new Date('2026-11-17T12:00:00Z') });
  assert.deepEqual(out.map(x => x.title),
    ['Herd dispersal', 'Plant One', 'Linked news', 'Unlinked, same town', 'Other Firm']);

  const recall = out.find(x => x.id === 'recall-E1');
  assert.equal(recall.product_count, 2);
  assert.equal(recall.kind, 'Class I');           // most serious class in the event
  assert.equal(recall.located_by, 'plant');

  const unmatched = out.find(x => x.id === 'recall-E2');
  assert.equal(unmatched.lat, null);              // firm city is known, still no pin

  const unlinked = out.find(x => x.title === 'Unlinked, same town');
  assert.equal(unlinked.located_by, 'city');      // matched the town case-insensitively
  assert.equal(unlinked.lat, 42.6);

  const disp = out.find(x => x.type === 'dispersal');
  assert.equal(disp.located_by, 'city');

  assert.equal(r.loadRecords(db, { days: 0 }).length, 6);   // all time includes the old item
});

test('loadRecords works on a database that has no dispersals table yet', () => {
  const db = freshDb();
  db.exec('DROP TABLE dispersals');
  assert.deepEqual(r.loadRecords(db, { days: 0 }), []);
});
