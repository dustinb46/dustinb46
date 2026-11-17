'use strict';

// Display-layer cleanup for plant records. Nothing here changes what is
// stored: the database keeps each source's name verbatim (search runs
// against that), and the plant page still shows it as "Listed as".
//
// Two jobs:
//
// 1. plantKind() — the FDA IMS list mixes real processing plants with
//    listings that are not plants at all: bulk tank units (a farm or a
//    group of farms rated as one raw-milk supply, usually listed at the
//    co-op's office address), receiving stations, and transfer stations.
//    IMS marks them in the name: "(BTU)", "(RS)", "(TR)". We read that
//    marker so the site can stop counting and mapping them as plants.
//
// 2. displayName() / displayCity() — IMS and USDA print names in ALL
//    CAPS with their own abbreviations (DY, CRY, FMS). We title-case
//    those and expand the abbreviations so a page reads "Westby Co-op
//    Creamery" instead of "WESTBY COOP CRY (PLT)". Names that already
//    arrive in mixed case are left alone apart from marker removal.

const KIND_LABELS = {
  plant: 'Plant',
  btu: 'Bulk tank unit',
  receiving: 'Receiving station',
  transfer: 'Transfer station',
};

const KIND_NOTES = {
  btu: 'This listing is a bulk tank unit: a farm or group of farms whose raw milk ' +
       'is rated as a single supply on the FDA milk shippers list. It is not a ' +
       'processing plant, and the address is usually the co-op or handler office, ' +
       'not where the cows are.',
  receiving: 'This listing is a receiving station: raw milk is collected and cooled ' +
       'here before going on to a plant. Nothing is bottled or made at this site.',
  transfer: 'This listing is a transfer station: raw milk moves from one tanker to ' +
       'another here. Nothing is bottled or made at this site.',
};

function plantKind(name) {
  const n = String(name || '');
  if (/BTU/i.test(n)) return 'btu';
  if (/\(\s*RS\s*\)/i.test(n)) return 'receiving';
  if (/\(\s*TR\s*\)|\(\s*T\.?S\.?\s*\)/i.test(n)) return 'transfer';
  return 'plant';
}

function kindLabel(kind) { return KIND_LABELS[kind] || KIND_LABELS.plant; }
function kindNote(kind) { return KIND_NOTES[kind] || null; }
function isPlant(name) { return plantKind(name) === 'plant'; }

// Tokens that stay upper-case. Co-op and company initialisms that show
// up in the source lists, plus legal-form suffixes.
const ACRONYMS = new Set([
  'DFA', 'NFO', 'AMPI', 'MMPA', 'NDA', 'MPA', 'SMI', 'SMP', 'LOL', 'CDI',
  'MWC', 'CFD', 'BSF', 'DRB', 'TMC', 'MPM', 'VDS', 'CEC', 'SRDA', 'IFS',
  'UDA', 'UDIA', 'FDA', 'USDA', 'USA', 'US', 'LLC', 'LLP', 'LP', 'DBA',
  'FKA', 'BTU', 'PMO', 'UHT', 'ESL', 'HP', 'GH', 'KA', 'EB',
  'II', 'III', 'IV', 'NW', 'SW', 'NE', 'SE',
]);

// State codes that are safe to upper-case as bare tokens. Codes that are
// also ordinary words or abbreviations (CO, LA, DE, IN, OR, ME, HI, AL,
// MT) are left out on purpose.
const STATE_TOKENS = new Set([
  'AK', 'AR', 'AZ', 'CA', 'CT', 'FL', 'GA', 'IA', 'ID', 'IL', 'KS', 'KY',
  'MA', 'MD', 'MI', 'MN', 'MO', 'MS', 'NC', 'ND', 'NH', 'NJ', 'NM', 'NV',
  'NY', 'OH', 'OK', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'VT',
  'WA', 'WI', 'WV', 'WY', 'PR', 'DC',
]);
const ALL_STATES = new Set([...STATE_TOKENS,
  'CO', 'LA', 'DE', 'IN', 'OR', 'ME', 'HI', 'AL', 'MT', 'NE']);

// IMS / USDA shorthand, expanded. Keys are upper-case tokens with any
// trailing period removed.
const EXPANSIONS = {
  DY: 'Dairy', DYS: 'Dairies', CRY: 'Creamery', CRYS: 'Creameries',
  FM: 'Farm', FMS: 'Farms', FDS: 'Foods', PROD: 'Products',
  COOP: 'Co-op', PLT: 'Plant', CTY: 'County', LTD: 'Ltd', MFG: 'Mfg',
  // Brands that style their own name.
  BELGIOIOSO: 'BelGioioso', FAIRLIFE: 'fairlife',
};

const SMALL_WORDS = new Set(['OF', 'AND', 'THE', 'AT', 'DU']);

function titleWord(w) {
  // "O'LAKES" -> "O'Lakes", "VON'S" -> "Von's"
  return w.split("'").map((seg, i) => {
    if (!seg) return seg;
    if (i > 0 && seg.length === 1) return seg.toLowerCase();
    let out = seg[0].toUpperCase() + seg.slice(1).toLowerCase();
    if (/^Mc[a-z]{3,}$/.test(out)) out = 'Mc' + out[2].toUpperCase() + out.slice(3);
    return out;
  }).join("'");
}

function caseToken(tok, isFirst) {
  const dot = tok.endsWith('.') ? '.' : '';
  const bare = dot ? tok.slice(0, -1) : tok;
  const up = bare.toUpperCase();
  if (!/[A-Z]/.test(up)) return tok;                       // numbers, "#01"
  if (/^([A-Z]\.)+[A-Z]?$/.test(tok.toUpperCase())) return tok.toUpperCase();   // "H.P.", "R.C."
  if (/^[A-Z](&[A-Z])+$/.test(up)) return up + dot;        // "V&V", "M&B"
  if (/\d/.test(up)) return up + dot;                      // "1F", "I-76N"
  if (EXPANSIONS[up]) return EXPANSIONS[up] + (up === 'LTD' ? dot : '');
  if (ACRONYMS.has(up) || STATE_TOKENS.has(up)) return up + dot;
  if (up.length === 1) return up + dot;
  if (!isFirst && SMALL_WORDS.has(up)) return up.toLowerCase() + dot;
  if (up.length <= 5 && !/[AEIOUY]/.test(up)) return up + dot;   // unknown initialism
  return titleWord(bare) + dot;
}

function titleCase(s) {
  // Split on separators but keep them, so hyphens and slashes survive.
  const parts = String(s).split(/([\s\-/,()&:#]+)/);
  let seenWord = false;
  const out = parts.map(p => {
    if (!p || /^[\s\-/,()&:#]+$/.test(p)) return p;
    const r = caseToken(p, !seenWord);
    seenWord = true;
    return r;
  }).join('');
  return out.replace(/\bCo-Op\b/g, 'Co-op');
}

function tidy(s) {
  // A stray ")" with no opener is a source typo ("APPEL FMS DYBTU)").
  if ((s.match(/\)/g) || []).length > (s.match(/\(/g) || []).length) s = s.replace(/\)\s*$/, '');
  return s
    .replace(/\s*\(\s*\)/g, '')            // empty parens left by marker removal
    .replace(/\s+-(?=\S)/g, ' - ')         // "FOODS -GREELEY" -> "FOODS - GREELEY"
    .replace(/(?<=\S)-\s+/g, ' - ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–,]+|[\s\-–,]+$/g, '')
    .trim();
}

function displayName(name) {
  const raw = String(name || '').trim();
  if (!raw) return raw;
  let s = raw
    .replace(/DYBTU/gi, 'DY BTU')                                  // source typo: "DYBTU"
    // "(BTU#01)" keeps its unit number, plain "(BTU)" just goes away.
    .replace(/\(\s*BTU\s*#?\s*([A-Z0-9]+)\s*\)/gi, ' BTU #$1 ')
    .replace(/\(\s*BTU\s*\)/gi, ' ')
    .replace(/\(\s*(RS|TR|T\.?S\.?|PLT|PLANT)\s*\)/gi, ' ');
  s = tidy(s);
  if (!s) return raw;
  // Only re-case names the source printed (mostly) in capitals. A name
  // that arrives in mixed case was typed by a person and is left alone.
  const letters = s.replace(/[^A-Za-z]/g, '');
  const upper = letters.replace(/[^A-Z]/g, '').length;
  if (letters.length && upper / letters.length >= 0.7) s = titleCase(s);
  return tidy(s) || raw;
}

const CITY_PREFIX = { 'ST': 'St.', 'MT': 'Mt.', 'FT': 'Ft.' };

function displayCity(city) {
  const raw = String(city || '').trim();
  if (!raw || raw !== raw.toUpperCase()) return raw;
  const toks = raw.split(/\s+/);
  return toks.map((t, i) => {
    const bare = t.replace(/[.,]$/, '');
    const last = i === toks.length - 1;
    // "ANDOVER MA", "DAYTON OH." — a trailing state code stays upper.
    if (last && toks.length > 1 && ALL_STATES.has(bare)) return bare;
    if (i < toks.length - 1 && CITY_PREFIX[bare]) return CITY_PREFIX[bare];
    if (i > 0 && (bare === 'DU' || bare === 'OF' || bare === 'THE')) return t.toLowerCase();
    return t.split('-').map(titleWord).join('-');
  }).join(' ');
}

module.exports = {
  plantKind, kindLabel, kindNote, isPlant,
  displayName, displayCity, titleCase,
};
