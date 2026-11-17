'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { plantKind, kindLabel, kindNote, displayName, displayCity } = require('../src/naming');

test('plantKind reads the IMS markers', () => {
  assert.equal(plantKind('WESTBY COOP CRY (PLT)'), 'plant');
  assert.equal(plantKind('HILMAR CHEESE COMPANY, INC.'), 'plant');
  assert.equal(plantKind('DFA(BTU)'), 'btu');
  assert.equal(plantKind('SMI(BTU#01)-GA'), 'btu');
  assert.equal(plantKind('CYPRESS GROVE BTU'), 'btu');
  assert.equal(plantKind('APPEL FMS DYBTU)'), 'btu');            // source typo still counts
  assert.equal(plantKind('MMPA (RS)'), 'receiving');
  assert.equal(plantKind("OPIE'S TRANSPORT (TR)"), 'transfer');
  assert.equal(plantKind(''), 'plant');
  assert.equal(plantKind(null), 'plant');
});

test('only non-plant kinds carry an explainer', () => {
  assert.equal(kindNote('plant'), null);
  assert.match(kindNote('btu'), /not a\s+processing plant/);
  assert.equal(kindLabel('btu'), 'Bulk tank unit');
  assert.equal(kindLabel('nonsense'), 'Plant');
});

test('displayName title-cases and expands IMS shorthand', () => {
  assert.equal(displayName('WESTBY COOP CRY (PLT)'), 'Westby Co-op Creamery');
  assert.equal(displayName('ALASKA RANGE DY LLC'), 'Alaska Range Dairy LLC');
  assert.equal(displayName('PRAIRIE FMS(BTU)-KASBERGEN DY'), 'Prairie Farms - Kasbergen Dairy');
  assert.equal(displayName('TOMALES BAY FDS / COWGIRL CRY'), 'Tomales Bay Foods / Cowgirl Creamery');
  assert.equal(displayName('DAIRY FARMERS OF AMERICA, INC.'), 'Dairy Farmers of America, Inc.');
  assert.equal(displayName('MAGIC VALLEY GROWERS LTD.'), 'Magic Valley Growers Ltd.');
});

test('displayName keeps initialisms, state codes and odd tokens intact', () => {
  assert.equal(displayName('DFA(BTU)'), 'DFA');
  assert.equal(displayName('MMPA (RS)'), 'MMPA');
  assert.equal(displayName('H.P. HOOD LLC'), 'H.P. Hood LLC');
  assert.equal(displayName('V&V SUPREMO FOODS'), 'V&V Supremo Foods');
  assert.equal(displayName('DFA INC - EAST I-76N'), 'DFA Inc - East I-76N');
  assert.equal(displayName('DFA DAIRY BRANDS-KY'), 'DFA Dairy Brands-KY');
  assert.equal(displayName('123 DOUGH FOOD LAB'), '123 Dough Food Lab');
});

test('displayName keeps BTU unit numbers but drops the bare marker', () => {
  assert.equal(displayName('SMI(BTU#01)-GA'), 'SMI BTU #01 - GA');
  assert.equal(displayName('AGROPUR(BTU)-BALTIC'), 'Agropur - Baltic');
  assert.equal(displayName('NDA(BTU#03)'), 'NDA BTU #03');
  assert.equal(displayName('APPEL FMS DYBTU)'), 'Appel Farms Dairy BTU');
});

test('displayName handles apostrophes, Mc names and house styles', () => {
  assert.equal(displayName("LAND O'LAKES WESTERN REGION"), "Land O'Lakes Western Region");
  assert.equal(displayName("LOS ANGELES MILK PLT - VON'S CO INC"), "Los Angeles Milk Plant - Von's Co Inc");
  assert.equal(displayName('MCCADAM CHEESE CO'), 'McCadam Cheese Co');
  assert.equal(displayName('BELGIOIOSO CHEESE, INC.'), 'BelGioioso Cheese, Inc.');
});

test('displayName leaves names that already arrive in mixed case', () => {
  assert.equal(displayName('BelGioioso Cheese, Inc.'), 'BelGioioso Cheese, Inc.');
  assert.equal(displayName('Darigold – Boise'), 'Darigold – Boise');
  assert.equal(displayName('Great Lakes Cheese of La Crosse, Wisconsin, Inc.'),
    'Great Lakes Cheese of La Crosse, Wisconsin, Inc.');
  // Mostly-caps with a mixed-case tail still gets cleaned up.
  assert.equal(displayName('FOREMOST FMS USA(BTU) - New Albin'), 'Foremost Farms USA - New Albin');
});

test('displayName never returns an empty string for a real name', () => {
  assert.equal(displayName('(BTU)'), '(BTU)');
  assert.equal(displayName(''), '');
  assert.equal(displayName(null), '');
});

test('displayCity title-cases source capitals', () => {
  assert.equal(displayCity('FOND DU LAC'), 'Fond du Lac');
  assert.equal(displayCity('ST. ALBANS'), 'St. Albans');
  assert.equal(displayCity('ST PAUL'), 'St. Paul');
  assert.equal(displayCity('LA CROSSE'), 'La Crosse');
  assert.equal(displayCity('WILKES-BARRE'), 'Wilkes-Barre');
  assert.equal(displayCity('ANDOVER MA'), 'Andover MA');
  assert.equal(displayCity('LAKE OF THE OZARKS'), 'Lake of the Ozarks');
  assert.equal(displayCity('Hudson Falls'), 'Hudson Falls');
  assert.equal(displayCity(''), '');
});
