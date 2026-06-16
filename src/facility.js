'use strict';

// Many plant codes in our database actually describe the same physical
// facility — IMS sometimes splits a single building into multiple codes
// (main plant + BTU + receiving line), and a building can carry both an
// IMS code AND a USDA code. We don't merge the underlying rows (each
// code is a real record from a real source), but we group them for
// display.
//
// facilityKey() returns a key intended to collapse codes that almost
// certainly belong to one site: same first significant name token, same
// city, same state. It WILL occasionally merge two genuinely distinct
// plants that share an operator name in one city (Tulare CA has several
// Saputo buildings, for example) — that's a known imperfection. Users
// can still see each underlying code as a member of the group.

const SUFFIX_TOKENS = new Set([
  'llc', 'inc', 'inc.', 'co', 'co.', 'corp', 'corp.', 'corporation',
  'company', 'cooperative', 'coop', 'cooperatives', 'usa', 'u.s.a.',
  'dba', 'ltd', 'holdings', 'group', 'brands', 'the', 'of',
  'foods', 'food', 'dairy', 'dairies', 'creamery', 'creameries',
  'cheese', 'cheeses', 'milk', 'farms', 'farm',
]);

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[‘’“”]/g, '')        // smart quotes
    .replace(/\([^)]*\)/g, ' ')                         // drop parenthetical bits
    .replace(/[^a-z0-9 ]+/g, ' ')                       // strip punctuation
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !SUFFIX_TOKENS.has(t))
    .join(' ');
}

// "operator" = first significant token after normalization. Used to
// cluster Gossner Foods + Gossner Cheese + Gossner Receiving as one site
// when they share a city, without merging two different operators that
// happen to be in the same town.
function operatorToken(name) {
  const tokens = normalizeName(name).split(/\s+/).filter(Boolean);
  return tokens[0] || '';
}

function facilityKey(name, city, state) {
  const op = operatorToken(name);
  const c = (city || '').trim().toUpperCase();
  const s = (state || '').trim().toUpperCase();
  if (!op || !c || !s) return null;
  return `${op}|${c}|${s}`;
}

module.exports = { facilityKey, operatorToken, normalizeName };
