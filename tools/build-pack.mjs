#!/usr/bin/env node
// Parses the QMM design markdown (ChatGPT project mirror) into server/story-pack.json.
// Usage: node tools/build-pack.mjs [designDir]
// Design dir is read-only; re-run after the ChatGPT project sync updates the templates.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const designDir = process.argv[2] ?? process.env.QMM_DESIGN_DIR ?? '../qmm-design';
const outPath = join(here, '..', 'server', 'story-pack.json');

const INTENTS = ['INVESTIGATE', 'HIDE', 'CONFRONT', 'CALL_HELP', 'RECORD_EVIDENCE', 'ESCAPE', 'RESCUE_KENJI', 'OTHER'];

function section(md, heading) {
  // returns lines between "## heading" and the next "## " heading (any level-2)
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'm');
  const m = re.exec(md);
  if (!m) return null;
  const rest = md.slice(m.index + m[0].length);
  const next = rest.search(/^##[^#]/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function bullets(text) {
  if (!text) return [];
  return text.split('\n').filter(l => l.trim().startsWith('- ')).map(l => l.trim().slice(2).trim());
}

function firstFence(text) {
  const m = /```text\n([\s\S]*?)```/.exec(text);
  return m ? m[1].replace(/\s+$/, '') : null;
}

// --- state-update value parser ---------------------------------------------
function parseUpdateValue(raw) {
  const v = raw.trim();
  if (/^preserve/i.test(v)) return { kind: 'skip', raw: v };
  if (/^unchanged/i.test(v)) return { kind: 'skip', raw: v };
  if (/^conditional/i.test(v)) return { kind: 'cond', raw: v };
  const addM = /^([+-]\d+)/.exec(v);
  if (addM) {
    const n = parseInt(addM[1], 10);
    if (/ if /.test(v)) return { kind: 'cond', lead: n, raw: v };
    return { kind: 'add', n, raw: v };
  }
  if (/^true/i.test(v)) {
    if (/ if | unless /.test(v)) return { kind: 'cond', lead: true, raw: v };
    return { kind: 'set', value: true, raw: v };
  }
  if (/^false/i.test(v)) {
    if (/ if | unless /.test(v)) return { kind: 'cond', lead: false, raw: v };
    return { kind: 'set', value: false, raw: v };
  }
  const ticks = [...v.matchAll(/`([^`]+)`/g)].map(m => m[1]);
  if (v.startsWith('`') && ticks.length) {
    if (ticks.length >= 2 && / if /.test(v) && /otherwise/.test(v)) {
      return { kind: 'set2', a: ticks[0], b: ticks[1], raw: v };
    }
    return { kind: 'set', value: ticks[0], raw: v };
  }
  return { kind: 'skip', raw: v };
}

function parseTemplateBlock(block, familyN) {
  const idM = /^R0\d+_[A-Z_]+/.exec(block.trim());
  // block starts right after "## Template ID: " so first token is the id
  const id = block.trim().split(/\s/)[0];
  const intent = id.replace(/^R0\d+_/, '');
  const sub = (name) => {
    const re = new RegExp(`###\\s+${name}\\s*\\n([\\s\\S]*?)(?=\\n###\\s|$)`);
    const m = re.exec(block);
    return m ? m[1].trim() : null;
  };
  const intentDesc = (sub('Intent') || '').replace(/\s+/g, ' ').trim();
  const template = firstFence(sub('Template') || '') || '';
  const fill = bullets(sub('Fill Guidance') || '');
  const updates = bullets(sub('State Updates') || '').map(b => {
    const m = /^`([a-z_]+)`\s*:\s*([\s\S]+)$/.exec(b);
    if (!m) return null;
    return { field: m[1], ...parseUpdateValue(m[2]) };
  }).filter(Boolean);
  if (!template) throw new Error(`No template text for ${id}`);
  if (!INTENTS.includes(intent)) throw new Error(`Unknown intent in ${id}`);
  return { id, intent, intent_desc: intentDesc, template, fill_guidance: fill, updates };
}

function parseFamily(md, file) {
  const purpose = section(md, 'Purpose') || '';
  const stM = /transition from `(S\d+_[A-Za-z_]+)` to `(S\d+_[A-Za-z_]+)`/.exec(purpose);
  if (!stM) throw new Error(`No from/to states in ${file}`);
  const n = parseInt(/response-0(\d)/.exec(file)[1], 10);
  const contract = section(md, 'Runtime Contract') || '';
  const bubM = /`yuki_messages`[^\n]*?(\d+)\s+to\s+(\d+)/.exec(contract);
  const inputFields = bullets(contract.split('### Output')[0] || '')
    .map(b => (/^`([a-z_]+)`/.exec(b) || [])[1]).filter(Boolean);
  const shared = bullets(section(md, 'Shared Generation Rules') || '');
  const context = bullets(section(md, 'Available Context') || '');

  const blocks = md.split(/^##\s+Template ID:\s+/m).slice(1);
  const templates = {};
  for (const b of blocks) {
    const t = parseTemplateBlock(b, n);
    templates[t.intent] = t;
  }
  const missing = INTENTS.filter(i => !templates[i]);
  if (missing.length) throw new Error(`${file} missing intents: ${missing.join(', ')}`);
  return {
    n, from: stM[1], to: stM[2],
    bubbles: bubM ? [parseInt(bubM[1], 10), parseInt(bubM[2], 10)] : [3, 8],
    shared_rules: shared, available_context: context, input_fields: inputFields,
    templates,
  };
}

// --- main -------------------------------------------------------------------
const planMd = readFileSync(join(designDir, 'story-demo-plan.md'), 'utf8');
const coldFence = firstFence(section(planMd, 'Cold Open Message') || '');
if (!coldFence) throw new Error('No cold open found');
const coldOpen = coldFence.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);

const intentDefs = {};
for (const b of bullets(section(planMd, 'Suggested Intent Categories') || '')) {
  const m = /^`([A-Z_]+)`\s*:\s*(.+)$/.exec(b);
  if (m) intentDefs[m[1]] = m[2];
}
if (Object.keys(intentDefs).length !== 8) throw new Error(`Expected 8 intent defs, got ${Object.keys(intentDefs).length}`);

const files = readdirSync(designDir).filter(f => /^response-0\d.*\.md$/.test(f)).sort();
const families = files.map(f => parseFamily(readFileSync(join(designDir, f), 'utf8'), f));
if (families.length !== 6) throw new Error(`Expected 6 families, got ${families.length}`);

const pack = {
  meta: {
    title: 'Quantum Murder Mysteries — Kokugikan Demo',
    generated_from: designDir,
    cold_open: coldOpen,
    intents: intentDefs,
    voice_example: firstFence(section(planMd, 'Text Message Voice') || '') || '',
  },
  families,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(pack, null, 2));
const tCount = families.reduce((a, f) => a + Object.keys(f.templates).length, 0);
console.log(`story-pack.json written: ${families.length} families, ${tCount} templates, ${coldOpen.length} cold-open bubbles.`);
for (const f of families) console.log(`  R0${f.n}: ${f.from} -> ${f.to} bubbles ${f.bubbles.join('-')} inputs ${f.input_fields.length}`);
