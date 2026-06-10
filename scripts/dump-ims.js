#!/usr/bin/env node
// Debug helper: dumps raw pdf-parse output so we can see the real
// structure of the IMS List before trusting any parser. Not part of the
// normal ingest flow.
//
//   node scripts/dump-ims.js          -> prints sample + paren-code lines
//   node scripts/dump-ims.js 500 560  -> prints raw lines [500, 560)

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const PDF_PATH = process.env.IMS_PDF_PATH
  || path.join(__dirname, '..', 'data', 'ims', 'ims-list.pdf');

if (!fs.existsSync(PDF_PATH)) {
  console.error(`[dump-ims] PDF not found at ${PDF_PATH}`);
  process.exit(2);
}

const argFrom = parseInt(process.argv[2], 10);
const argTo = parseInt(process.argv[3], 10);

(async () => {
  const buf = fs.readFileSync(PDF_PATH);
  const pdf = await pdfParse(buf);
  const lines = pdf.text.split('\n');
  console.log(`[dump-ims] total lines: ${lines.length}`);

  if (!Number.isNaN(argFrom)) {
    const from = argFrom;
    const to = Number.isNaN(argTo) ? from + 40 : argTo;
    console.log(`\n=== raw lines [${from}, ${to}) ===`);
    for (let i = from; i < to && i < lines.length; i++) {
      console.log(`${String(i).padStart(5)} | ${lines[i]}`);
    }
    return;
  }

  // Default: show a mid-document sample and lines with parenthetical codes.
  console.log(`\n=== sample raw lines [300, 360) ===`);
  for (let i = 300; i < 360 && i < lines.length; i++) {
    console.log(`${String(i).padStart(5)} | ${lines[i]}`);
  }

  console.log(`\n=== first 40 lines containing a (NN-NNN) paren code ===`);
  const parenRe = /\(\d{1,3}-\d{1,5}\)/;
  let shown = 0;
  for (let i = 0; i < lines.length && shown < 40; i++) {
    if (parenRe.test(lines[i])) {
      console.log(`${String(i).padStart(5)} | ${lines[i]}`);
      shown++;
    }
  }
  console.log(`\n[dump-ims] paren-code lines shown: ${shown}`);
})().catch(err => {
  console.error('[dump-ims] failed:', err);
  process.exit(1);
});
