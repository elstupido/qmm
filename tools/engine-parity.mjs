#!/usr/bin/env node
// Prompt-parity harness: proves the extracted engine builders (server/engine.mjs) reproduce,
// BYTE FOR BYTE, the prompt strings the pre-extraction server sent to the model. The golden
// fixtures under tools/fixtures/ were captured from the pre-refactor server via a temporary
// dump hook (two live turns; inputs recorded alongside outputs). Run: node tools/engine-parity.mjs
//
// The prompts ARE the product — any diff here fails the extraction, no matter how green the
// other tests are.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModules, buildRoutePrompt, buildGeneratePrompt, buildChatPrompt } from '../server/engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures');
const { modules } = loadModules(join(here, '..', 'modules'));

let failures = 0;
function compare(name, field, expected, actual) {
  if (expected === actual) { console.log(`PASS  ${name} ${field} (${actual.length} chars)`); return; }
  failures++;
  console.log(`FAIL  ${name} ${field}`);
  const n = Math.min(expected.length, actual.length);
  let i = 0;
  while (i < n && expected[i] === actual[i]) i++;
  console.log(`      first diff at char ${i}:`);
  console.log(`      expected …${JSON.stringify(expected.slice(Math.max(0, i - 40), i + 60))}`);
  console.log(`      actual   …${JSON.stringify(actual.slice(Math.max(0, i - 40), i + 60))}`);
}

const files = readdirSync(FIXTURES).filter(f => f.endsWith('.json')).sort();
if (!files.length) { console.error('no fixtures found — capture them first (see file header)'); process.exit(2); }

for (const f of files) {
  const fx = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'));
  const { call, sys, usr, inputs } = fx;
  const mod = modules[inputs.module_id];
  if (!mod) { console.error(`FAIL  ${f}: module ${inputs.module_id} not loaded`); failures++; continue; }
  const family = mod.familyByFrom[inputs.family_from];
  if (!family) { console.error(`FAIL  ${f}: family ${inputs.family_from} not found`); failures++; continue; }

  let built;
  if (call === 'route') {
    built = buildRoutePrompt(mod, family, inputs.userMessage, inputs.tail, inputs.exchanges, inputs.latencyS);
  } else if (call === 'generate') {
    const tpl = Object.values(family.templates).find(t => t.id === inputs.tpl_id);
    if (!tpl) { console.error(`FAIL  ${f}: template ${inputs.tpl_id} not found`); failures++; continue; }
    built = buildGeneratePrompt(mod, family, tpl, inputs.state, inputs.userMessage, inputs.tail, inputs.loreBlock || '');
  } else if (call === 'chat') {
    built = buildChatPrompt(mod, family, inputs.state, inputs.userMessage, inputs.tail, inputs.nudgeS ?? null, inputs.loreBlock || '');
  } else {
    console.error(`FAIL  ${f}: unknown call ${call}`); failures++; continue;
  }

  compare(f, 'sys', sys, built.sys);
  compare(f, 'usr', usr, built.usr);
}

console.log(failures === 0 ? '\nPARITY: byte-identical' : `\nPARITY BROKEN: ${failures} mismatch(es)`);
process.exit(failures === 0 ? 0 : 1);
