'use strict';
// Approximate bounding boxes per US state/territory: [minLat, minLon, maxLat, maxLon].
// Padded slightly. Purpose is catching GROSS geocode errors — a plant
// listed in WI whose coordinates land in California — not precise
// point-in-polygon. Border-straddling false-negatives are fine; we only
// want to flag pins that are obviously in the wrong state.
const BOUNDS = {
  AL:[30.1,-88.5,35.1,-84.9], AK:[51.0,-180.0,71.6,-129.0], AZ:[31.3,-115.0,37.1,-109.0],
  AR:[33.0,-94.7,36.6,-89.6], CA:[32.5,-124.5,42.1,-114.1], CO:[36.9,-109.1,41.1,-102.0],
  CT:[40.9,-73.8,42.1,-71.7], DE:[38.4,-75.8,39.9,-75.0], DC:[38.7,-77.2,39.0,-76.9],
  FL:[24.3,-87.7,31.1,-79.9], GA:[30.3,-85.7,35.1,-80.8], HI:[18.8,-160.3,22.3,-154.7],
  ID:[41.9,-117.3,49.1,-111.0], IL:[36.9,-91.6,42.6,-87.4], IN:[37.7,-88.2,41.8,-84.7],
  IA:[40.3,-96.7,43.6,-90.1], KS:[36.9,-102.1,40.1,-94.5], KY:[36.4,-89.6,39.2,-81.9],
  LA:[28.9,-94.1,33.1,-88.8], ME:[42.9,-71.2,47.5,-66.9], MD:[37.8,-79.5,39.8,-75.0],
  MA:[41.2,-73.6,42.9,-69.8], MI:[41.6,-90.5,48.3,-82.3], MN:[43.4,-97.3,49.5,-89.4],
  MS:[30.1,-91.7,35.0,-88.0], MO:[35.9,-95.8,40.7,-89.0], MT:[44.3,-116.1,49.1,-104.0],
  NE:[39.9,-104.1,43.1,-95.2], NV:[34.9,-120.1,42.1,-114.0], NH:[42.6,-72.6,45.4,-70.6],
  NJ:[38.8,-75.6,41.4,-73.8], NM:[31.3,-109.1,37.1,-102.9], NY:[40.4,-79.8,45.1,-71.8],
  NC:[33.8,-84.4,36.6,-75.4], ND:[45.9,-104.1,49.1,-96.5], OH:[38.3,-84.9,42.4,-80.5],
  OK:[33.6,-103.1,37.1,-94.4], OR:[41.9,-124.6,46.3,-116.4], PA:[39.7,-80.6,42.3,-74.6],
  RI:[41.1,-71.9,42.1,-71.1], SC:[32.0,-83.4,35.3,-78.5], SD:[42.4,-104.1,45.9,-96.4],
  TN:[34.9,-90.4,36.7,-81.6], TX:[25.8,-106.7,36.6,-93.5], UT:[36.9,-114.1,42.1,-109.0],
  VT:[42.7,-73.5,45.1,-71.4], VA:[36.5,-83.7,39.5,-75.2], WA:[45.5,-124.9,49.1,-116.9],
  WV:[37.1,-82.7,40.7,-77.7], WI:[42.4,-92.9,47.1,-86.8], WY:[40.9,-111.1,45.1,-104.0],
  PR:[17.8,-67.3,18.6,-65.2],
};

// True only when we can affirmatively say the point is outside the state
// box (with a ~0.3deg pad). Unknown state or missing coords -> false
// (we don't flag what we can't check).
function isOutsideState(lat, lon, state) {
  if (lat == null || lon == null || !state) return false;
  const b = BOUNDS[String(state).toUpperCase()];
  if (!b) return false;
  const pad = 0.3;
  return lat < b[0] - pad || lat > b[2] + pad || lon < b[1] - pad || lon > b[3] + pad;
}

module.exports = { BOUNDS, isOutsideState };
