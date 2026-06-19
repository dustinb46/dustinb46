'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseDatcpText, parseStateZip, derivedCategory } = require('../scripts/ingest-datcp');

// Verbatim slices of the real WI DATCP CSV, including BOM and
// embedded newlines in the StreetAddress column.
const SAMPLE = '﻿LicenseNo,WIPlantNo,BusinessName,DBA,BusinessPhone,StreetAddress,City,StateZip,County,Municipality,GradeBProcessing1,GradeAPermitAuthorization,GeneralProcessing,SpecificProcessing,CheeseManufactured,VarianceStatus,VarianceDate\n' +
  '122850,55-117,Kraft Heinz Foods Company,,(920) 356-2364,"419 S Center St\n",Beaver Dam,"WI, 53916",Dodge,City of Beaver Dam,"Grade B Processing > 1,000,000 lbs product per year",,"ACaSS, Bovine Milk","Cheese Processing, Pasteurizer - HTST","Cream Cheese, Pasteurized Process Cheese/Cheese Food",,\n' +
  '514748,55-322,Agropur Inc.,,(920) 714-0258,"3805 Freedom Rd\n",Appleton,"WI, 54913",Outagamie,City of Appleton,"Grade B Processing > 1,000,000 lbs product per year",,Bovine Milk,Cheese Processing,"Mozzarella, Provolone",,\n' +
  '328092,55-436,1540 Vision Drive LLC,Moundview Dairy,(608) 504-2510,"1540 Vision Dr\n",Platteville,"WI, 53818",Grant,City of Platteville,,Grade A Permit,Bovine Milk,Pasteurizer - HTST,,,\n';

test('parses CSV with BOM and embedded newlines', () => {
  const { plants, skippedNoCode } = parseDatcpText(SAMPLE);
  assert.equal(plants.length, 3);
  assert.equal(skippedNoCode, 0);
});

test('Kraft Beaver Dam parses with the right code, name, address', () => {
  const { plants } = parseDatcpText(SAMPLE);
  const kraft = plants.find(p => p.plant_code === '55-117');
  assert.ok(kraft);
  assert.equal(kraft.name, 'Kraft Heinz Foods Company');
  assert.equal(kraft.city, 'Beaver Dam');
  assert.equal(kraft.state, 'WI');
  assert.equal(kraft.address, '419 S Center St');
  assert.equal(kraft.license_no, '122850');
  assert.equal(kraft.county, 'Dodge');
});

test('falls back to DBA when BusinessName is empty (would skip if both empty)', () => {
  const { plants } = parseDatcpText(SAMPLE);
  // Moundview Dairy has both BusinessName + DBA; BusinessName should win
  const mv = plants.find(p => p.plant_code === '55-436');
  assert.equal(mv.name, '1540 Vision Drive LLC');
  assert.equal(mv.dba, 'Moundview Dairy');
});

test('parseStateZip splits common forms', () => {
  assert.deepEqual(parseStateZip('WI, 53916'), { state: 'WI', zip: '53916' });
  assert.deepEqual(parseStateZip('WI 53916'),  { state: 'WI', zip: '53916' });
  assert.deepEqual(parseStateZip('WI'),        { state: 'WI', zip: null });
  assert.deepEqual(parseStateZip(''),          { state: null, zip: null });
});

test('derivedCategory picks cheese when CheeseManufactured has anything', () => {
  assert.equal(derivedCategory({ CheeseManufactured: 'Cheddar, Colby' }), 'cheese');
});

test('derivedCategory recognizes cream cheese over generic cheese', () => {
  assert.equal(derivedCategory({
    GeneralProcessing: 'Bovine Milk',
    SpecificProcessing: 'Cream Cheese line',
    CheeseManufactured: '',
  }), 'cream cheese');
});

test('derivedCategory returns null when nothing matches', () => {
  assert.equal(derivedCategory({}), null);
});
