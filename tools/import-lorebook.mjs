#!/usr/bin/env node
// SillyTavern lorebook -> QMM lore.json converter (thin CLI over server/lorebook-import.mjs).
//
//   node tools/import-lorebook.mjs <st-lorebook.json> <modules/<id>/lore.json> [--merge]
//
// --merge keeps existing entries (by id) and rails in the target; imported entries win on id clash.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { convertLorebook } from '../server/lorebook-import.mjs';

const [, , src, dst, ...flags] = process.argv;
if (!src || !dst) {
  console.error('usage: node tools/import-lorebook.mjs <st-lorebook.json> <lore.json> [--merge]');
  process.exit(2);
}
const merge = flags.includes('--merge');

const book = JSON.parse(readFileSync(src, 'utf8'));
let existingDoc;
if (merge && existsSync(dst)) existingDoc = JSON.parse(readFileSync(dst, 'utf8'));

let result;
try {
  result = convertLorebook(book, { existingDoc, merge });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

writeFileSync(dst, JSON.stringify(result.doc, null, 2) + '\n');
console.log(`imported ${result.imported} entries -> ${dst}${merge ? ' (merged)' : ''}`);
for (const w of result.warnings) console.warn(`WARN ${w}`);
