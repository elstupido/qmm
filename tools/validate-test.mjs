#!/usr/bin/env node
// Executable spec for server/validate.mjs: loads the real yuki module, then breaks in-memory
// clones one rule at a time and asserts each produces its coded error. Run: node tools/validate-test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateModule } from '../server/validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'modules', 'yuki-kokugikan-ep1');

function loadMerged() {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const pack = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8'));
  const lorePath = join(dir, 'lore.json');
  if (existsSync(lorePath)) {
    const doc = JSON.parse(readFileSync(lorePath, 'utf8'));
    if (doc.lore) pack.lore = doc.lore;
    if (doc.rails) pack.rails = doc.rails;
  }
  return { manifest, pack };
}

const clone = (x) => JSON.parse(JSON.stringify(x));
let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

// --- 0. the shipping module has zero errors --------------------------------
{
  const { manifest, pack } = loadMerged();
  const { errors, warnings } = validateModule({ manifest, pack, dirName: 'yuki-kokugikan-ep1' });
  ok(`yuki module: no errors (got ${errors.length})`, errors.length === 0);
  console.log(`      (warnings: ${warnings.map(w => w.code).join(', ') || 'none'})`);
}

// --- broken variants -------------------------------------------------------
function expectCode(name, mutate, code, level = 'errors') {
  const { manifest, pack } = loadMerged();
  const m = { manifest: clone(manifest), pack: clone(pack) };
  mutate(m);
  const result = validateModule({ ...m, dirName: 'yuki-kokugikan-ep1' });
  ok(`${name} -> ${code}`, result[level].some(e => e.code === code));
}

expectCode('bad lore regex key', (m) => { m.pack.lore.entries[1].keys = ['/[unclosed/i']; }, 'lore-regex');
expectCode('dangling to', (m) => { m.pack.families[2].to = 'S99_Nowhere'; }, 'family-dangling-to');
expectCode('keyless non-constant lore', (m) => { m.pack.lore.entries[1].keys = []; }, 'lore-never-fires');
expectCode('absolute cap key', (m) => { m.pack.lore.budget_tokens = 800; }, 'lore-absolute-cap');
expectCode('missing OTHER intent', (m) => { delete m.pack.meta.intents.OTHER; }, 'meta-intents-other');
expectCode('safety stop off', (m) => { m.manifest.safety_profile.stop = false; }, 'safety-stop');
expectCode('min_age below 18', (m) => { m.manifest.safety_profile.min_age = 16; }, 'safety-min-age');
expectCode('wrong current_state target', (m) => {
  const f = m.pack.families[0];
  const tpl = Object.values(f.templates)[0];
  const u = tpl.updates.find(u => u.field === 'current_state');
  u.value = 'S99_Wrong';
}, 'update-current-state');
expectCode('blanket-blanking rail', (m) => { (m.pack.rails ||= []).push({ find: '[\\s\\S]*', replace: '', flags: 'g' }); }, 'rail-blanket');
expectCode('duplicate from', (m) => { m.pack.families[1].from = m.pack.families[0].from; }, 'family-from-dup');
expectCode('bad version', (m) => { m.manifest.version = 'v1'; }, 'manifest-version');
expectCode('template missing for intent', (m) => { delete m.pack.families[0].templates.INVESTIGATE; }, 'template-missing');
expectCode('probability zero warns', (m) => { m.pack.lore.entries[1].probability = 0; }, 'lore-probability-zero', 'warnings');
expectCode('single-member group warns', (m) => { m.pack.lore.entries = m.pack.lore.entries.filter(e => e.id !== 'coldspot-breath'); }, 'lore-group-single', 'warnings');
expectCode('dropped live state warns', (m) => {
  // liveModule has a beat the draft lost
  const live = { pack: { families: [...m.pack.families.map(f => ({ from: f.from })), { from: 'S0X_Gone' }] } };
  m.liveModule = live;
}, 'publish-dropped-state', 'warnings');

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
