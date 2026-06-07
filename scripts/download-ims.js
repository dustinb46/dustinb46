#!/usr/bin/env node
// Downloads the current FDA Interstate Milk Shippers (IMS) List PDF.
// The exact URL changes each quarter; pass --url=https://... to override.

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'data', 'ims');
const OUT_PATH = path.join(OUT_DIR, 'ims-list.pdf');

const urlArg = process.argv.find(a => a.startsWith('--url='));
const url = urlArg ? urlArg.slice('--url='.length) : process.env.IMS_PDF_URL;

if (!url) {
  console.error(
    [
      '[download-ims] no URL provided.',
      '',
      'Find the current IMS List PDF link on:',
      '  https://www.fda.gov/food/milk-guidance-documents-regulatory-information/interstate-milk-shippers-list',
      '',
      'Then run one of:',
      '  IMS_PDF_URL="https://..." npm run ims:download',
      '  node scripts/download-ims.js --url=https://...',
    ].join('\n')
  );
  process.exit(2);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[download-ims] GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[download-ims] HTTP ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(OUT_PATH, buf);
  console.log(`[download-ims] wrote ${OUT_PATH} (${buf.length.toLocaleString()} bytes)`);
})().catch(err => {
  console.error('[download-ims] failed:', err.message);
  process.exit(1);
});
