#!/usr/bin/env node
// SillyTavern lorebook -> QMM lore.json converter. The authoring bridge: write/playtest lore in
// SillyTavern's World Info editor (same gemma model via ollama), export the book as JSON, then:
//
//   node tools/import-lorebook.mjs <st-lorebook.json> <modules/<id>/lore.json> [--merge]
//
// --merge keeps existing entries (by id) and rails in the target; imported entries win on id clash.
// ST field mapping (world-info.js entry template -> our lore engine):
//   key[]        -> keys[]        comment -> comment (+ slug source for id)
//   content      -> content       constant -> constant
//   order        -> order         probability/useProbability -> probability
//   delay        -> delay         cooldown -> cooldown        sticky -> sticky
//   group        -> group         caseSensitive -> case_sensitive
//   disable      -> enabled:false scanDepth -> scan_depth
// Unsupported ST features (secondary keys, recursion, positions) are dropped WITH A WARNING —
// silent truncation reads as "imported everything" when it didn't.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [, , src, dst, ...flags] = process.argv;
if (!src || !dst) {
  console.error('usage: node tools/import-lorebook.mjs <st-lorebook.json> <lore.json> [--merge]');
  process.exit(2);
}
const merge = flags.includes('--merge');

const book = JSON.parse(readFileSync(src, 'utf8'));
const entries = book.entries ? Object.values(book.entries) : [];
if (!entries.length) { console.error('no entries found — is this a SillyTavern lorebook export?'); process.exit(1); }

const slug = (s, i) => (String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || `entry-${i}`;
const warnings = [];
const out = [];
const seen = new Set();

entries.forEach((e, i) => {
  if (!e || typeof e.content !== 'string' || !e.content.trim()) return;
  let id = slug(e.comment, i);
  while (seen.has(id)) id = `${id}-${i}`;
  seen.add(id);

  if (Array.isArray(e.keysecondary) && e.keysecondary.length) warnings.push(`${id}: secondary keys dropped (unsupported v1)`);
  if (e.selectiveLogic) warnings.push(`${id}: selectiveLogic dropped (unsupported v1)`);
  if (e.position !== undefined && e.position !== 0) warnings.push(`${id}: ST position ignored (QMM has one lore slot)`);

  const entry = {
    id,
    keys: (Array.isArray(e.key) ? e.key : []).map(String).filter(Boolean),
    content: e.content.trim(),
  };
  if (e.comment) entry.comment = String(e.comment);
  if (e.constant) entry.constant = true;
  if (e.caseSensitive) entry.case_sensitive = true;
  if (Number(e.order)) entry.order = Number(e.order);
  if (e.useProbability && Number(e.probability) < 100) entry.probability = Number(e.probability);
  for (const f of ['delay', 'cooldown', 'sticky']) if (Number(e[f]) > 0) entry[f] = Number(e[f]);
  if (e.group) entry.group = String(e.group);
  if (Number(e.scanDepth) > 0) entry.scan_depth = Number(e.scanDepth);
  if (e.disable) entry.enabled = false;
  if (!entry.keys.length && !entry.constant) { warnings.push(`${id}: no keys and not constant — will never fire`); }
  out.push(entry);
});

let doc = { lore: { budget_pct: 10, scan_depth: 8, entries: out }, rails: [] };
if (merge && existsSync(dst)) {
  const prev = JSON.parse(readFileSync(dst, 'utf8'));
  const imported = new Set(out.map(e => e.id));
  const kept = (prev.lore?.entries || []).filter(e => !imported.has(e.id));
  doc = {
    lore: {
      budget_pct: prev.lore?.budget_pct ?? 10,
      scan_depth: prev.lore?.scan_depth ?? 8,
      entries: [...kept, ...out],
    },
    rails: prev.rails || [],
  };
}

writeFileSync(dst, JSON.stringify(doc, null, 2) + '\n');
console.log(`imported ${out.length} entries -> ${dst}${merge ? ' (merged)' : ''}`);
for (const w of warnings) console.warn(`WARN ${w}`);
