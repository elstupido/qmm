#!/usr/bin/env node
// CLI over server/validate.mjs: node tools/validate-module.mjs <module-dir> [module-dir...]
// Loads manifest + pack + lore sidecar (same merge as the engine's loadModules), validates,
// prints errors/warnings, exits 1 if any module has errors.

import { readFileSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { validateModule } from '../server/validate.mjs';

const dirs = process.argv.slice(2);
if (!dirs.length) { console.error('usage: node tools/validate-module.mjs <module-dir> [...]'); process.exit(2); }

let anyErrors = false;
for (const d of dirs) {
  const dir = resolve(d);
  const dirName = basename(dir);
  let manifest, pack;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    pack = JSON.parse(readFileSync(join(dir, manifest.pack || 'pack.json'), 'utf8'));
    const lorePath = join(dir, manifest.lore || 'lore.json');
    if (existsSync(lorePath)) {
      const doc = JSON.parse(readFileSync(lorePath, 'utf8'));
      if (doc.lore) pack.lore = doc.lore;
      if (doc.rails) pack.rails = doc.rails;
    }
  } catch (e) {
    console.error(`${dirName}: cannot load module: ${e.message}`);
    anyErrors = true;
    continue;
  }
  const { errors, warnings } = validateModule({ manifest, pack, dirName });
  console.log(`\n${dirName}: ${errors.length} error(s), ${warnings.length} warning(s)`);
  for (const e of errors) console.log(`  ERROR ${e.code} @ ${e.path}\n        ${e.msg}`);
  for (const w of warnings) console.log(`  warn  ${w.code} @ ${w.path}\n        ${w.msg}`);
  if (errors.length) anyErrors = true;
}
process.exit(anyErrors ? 1 : 0);
