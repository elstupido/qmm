#!/usr/bin/env node
// Executable spec for studio/lib/st-bridge.mjs: card shape, world-info round-trip through the
// real importer, and the one-way template guard. Run: node tools/st-bridge-test.mjs

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModules } from '../server/engine.mjs';
import { convertLorebook } from '../server/lorebook-import.mjs';
import { toCharacterCard, toWorldInfo, stripTemplateEntries, TEMPLATE_MARK } from '../studio/lib/st-bridge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { modules } = loadModules(join(here, '..', 'modules'));
const yuki = modules['yuki-kokugikan-ep1'];

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

// --- character card ---------------------------------------------------------
{
  const card = toCharacterCard(yuki);
  ok('card is chara_card_v2', card.spec === 'chara_card_v2' && card.spec_version === '2.0');
  ok('card name from manifest.character', card.data.name === 'Yuki');
  ok('first_mes is the cold open', card.data.first_mes === yuki.meta.cold_open.join('\n\n'));
  ok('mes_example carries the voice', card.data.mes_example.startsWith('<START>') && card.data.mes_example.includes('{{char}}:'));
  ok('description carries beat-1 context', card.data.description.includes(yuki.pack.families[0].available_context[0]));
  ok('provenance in extensions', card.data.extensions.qmm.module_id === 'yuki-kokugikan-ep1');
  for (const req of ['description', 'personality', 'scenario', 'creator_notes', 'tags', 'creator', 'character_version']) {
    ok(`card field ${req} present`, card.data[req] !== undefined && card.data[req] !== '');
  }
}

// --- world info round-trip --------------------------------------------------
{
  const book = toWorldInfo(yuki, { includeTemplates: false });
  const n = Object.keys(book.entries).length;
  ok(`lore-only book has ${yuki.pack.lore.entries.length} entries`, n === yuki.pack.lore.entries.length);

  const { doc, warnings } = convertLorebook(book, {});
  const back = Object.fromEntries(doc.lore.entries.map(e => [e.id, e]));
  let semantic = true;
  for (const orig of yuki.pack.lore.entries) {
    // importer re-slugs ids from comment; our comment embeds [id] so the slug contains it
    const found = doc.lore.entries.find(e => e.id.includes(orig.id) || (e.comment || '').includes(orig.id));
    if (!found) { semantic = false; console.log(`      lost: ${orig.id}`); continue; }
    if (found.content !== orig.content) { semantic = false; console.log(`      content drift: ${orig.id}`); }
    for (const f of ['delay', 'cooldown', 'sticky', 'group']) {
      const a = orig[f] ?? (f === 'group' ? undefined : undefined);
      const b = found[f];
      if (String(a ?? '') !== String(b ?? '')) { semantic = false; console.log(`      ${f} drift on ${orig.id}: ${a} vs ${b}`); }
    }
    const keysMatch = JSON.stringify(found.keys) === JSON.stringify(orig.keys || []);
    if (!keysMatch && !(orig.constant && !found.keys.length)) { semantic = false; console.log(`      keys drift: ${orig.id}`); }
  }
  ok('round-trip preserves content, keys, timed effects, groups', semantic);
  ok('round-trip has no unexpected warnings', warnings.every(w => w.includes('never fire') === false || w.includes('always-on')));
}

// --- template entries: one-way guard ---------------------------------------
{
  const book = toWorldInfo(yuki, { includeTemplates: true });
  const total = Object.keys(book.entries).length;
  const tplCount = Object.values(book.entries).filter(e => e.comment.includes(TEMPLATE_MARK)).length;
  ok(`templates included (${tplCount} = 6 beats × 8 intents)`, tplCount === 48);
  ok('lore + templates total', total === yuki.pack.lore.entries.length + 48);
  const { book: stripped, stripped: nStripped } = stripTemplateEntries(book);
  ok('stripTemplateEntries removes exactly the templates', nStripped === 48 && Object.keys(stripped.entries).length === total - 48);
  const { doc } = convertLorebook(stripped.book ?? stripped, {});
  ok('post-strip import yields only lore', doc.lore.entries.length === yuki.pack.lore.entries.length);
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
