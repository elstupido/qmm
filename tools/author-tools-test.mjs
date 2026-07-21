#!/usr/bin/env node
// Executable spec for the author-chat TOOLS — the hands MiniMax uses on the draft. Two layers:
//   1. TOOL_IMPL unit tests against a scratch draft store (every tool, happy + guard paths)
//   2. runAuthorChat loop tests with a MOCK LLM (tool dispatch, error feedback, round cap,
//      history shape, event order) + splitThinking cases (M3's inline <think> and friends)
// No live model calls (test_fill's live path is exercised in sessions, not here).
// Run: node tools/author-tools-test.mjs

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DraftStore } from '../studio/lib/draft-store.mjs';
import { TOOL_IMPL, runAuthorChat, splitThinking } from '../studio/lib/author-chat.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const draftsDir = mkdtempSync(join(tmpdir(), 'qmm-tools-test-'));
const store = new DraftStore({
  modulesDir: join(here, '..', 'modules'),
  draftsDir,
  scaffoldDir: join(here, '..', 'studio', 'scaffold'),
});
const ID = 'suite-test';

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };
const throws = (name, fn, msgPart) => {
  try { fn(); ok(name, false); }
  catch (e) { ok(name + (msgPart ? ` (${msgPart})` : ''), !msgPart || String(e.message).includes(msgPart)); }
};
const run = (tool, args) => TOOL_IMPL[tool]({ store, id: ID, args: args || {} });

// ---------------------------------------------------------------- setup -----
store.create(ID, { from: 'dark-demo', title: 'Suite Test', story_id: 'suite' });
ok('scaffold draft created', !!store.loadDraft(ID));

// ------------------------------------------------------------- overview -----
{
  const o = run('get_module_overview');
  ok('overview: beats + intents shaped', o.beats.length === 1 && Object.keys(o.intents).length === 3);
  ok('overview: templates_missing lists uncovered intents', o.beats[0].templates_missing.length === 2);
  ok('overview: breaches visible with TODO flag', o.breaches.count === 1 && o.breaches.has_todo_scaffolding === true);
  ok('overview: validation errors surfaced', o.validation.errors > 0);
}

// ---------------------------------------------------------- set_* tools -----
{
  const r = run('set_character', { name: 'Testa', tagline: 'suite protagonist' });
  ok('set_character writes manifest', r.ok && store.loadDraft(ID).manifest.character.name === 'Testa');
  run('set_meta', { title: 'Suite!', cold_open: ['hi', 'there'] });
  const d = store.loadDraft(ID);
  ok('set_meta partial update (title + cold_open, voice untouched)',
    d.pack.meta.title === 'Suite!' && d.manifest.title === 'Suite!' && d.pack.meta.cold_open.length === 2 && !!d.pack.meta.voice_example);
  throws('set_intents without OTHER rejected', () => run('set_intents', { intents: { GO: 'go' } }), 'OTHER');
  run('set_intents', { intents: { go: 'move on', STAY: 'hold', OTHER: 'fallback' } });
  ok('set_intents uppercases names (canonical storage sorts keys)', JSON.stringify(Object.keys(store.loadDraft(ID).pack.meta.intents).sort()) === JSON.stringify(['GO', 'OTHER', 'STAY']));
}

// -------------------------------------------------------------- beats -------
{
  throws('upsert_beat null "to" rejected', () => run('upsert_beat', { n: 2, from: 'S01_X', to: null }), 'terminal');
  throws('upsert_beat out-of-range n rejected', () => run('upsert_beat', { n: 9, from: 'A', to: 'B' }), 'out of range');
  run('upsert_beat', { n: 1, from: 'S00_Open', to: 'S01_Mid', bubbles: [2, 5] });
  run('upsert_beat', { n: 2, from: 'S01_Mid', to: 'S02_End' });
  const d = store.loadDraft(ID);
  ok('upsert_beat creates + updates (chain of 2)', d.pack.families.length === 2 && d.pack.families[0].to === 'S01_Mid');
  ok('upsert_beat preserves existing templates on update', Object.keys(d.pack.families[0].templates).length === 1);
  run('upsert_beat', { n: 3, from: 'S02_End', to: 'S03_Extra' });
  const del = run('delete_beat', { n: 3 });
  ok('delete_beat removes + renumbers', del.ok && store.loadDraft(ID).pack.families.every((f, i) => f.n === i + 1));
  throws('delete_beat missing n rejected', () => run('delete_beat', { n: 9 }), 'no beat');
}

// ----------------------------------------------------------- templates ------
{
  throws('upsert_template unknown intent rejected', () => run('upsert_template', { family_from: 'S00_Open', intent: 'NOPE', template: 'x' }), 'unknown intent');
  throws('upsert_template unknown beat rejected', () => run('upsert_template', { family_from: 'S99', intent: 'GO', template: 'x' }), 'no beat');
  const r = run('upsert_template', { family_from: 'S00_Open', intent: 'go', template: 'walk on\n\n{{detail}}', fill_guidance: ['keep it short'], updates: [{ field: 'danger_level', kind: 'add', n: 1 }] });
  const tpl = store.loadDraft(ID).pack.families[0].templates.GO;
  ok('upsert_template lowercased intent accepted + id derived', r.ok && tpl.id === 'R01_GO');
  ok('upsert_template auto-adds current_state -> family.to', tpl.updates.some(u => u.field === 'current_state' && u.kind === 'set' && u.value === 'S01_Mid'));
  ok('upsert_template synthesizes raw DSL (add -> "+1")', tpl.updates.find(u => u.field === 'danger_level')?.raw === '+1');
  ok('upsert_template reports remaining_missing', r.remaining_missing.includes('STAY'));
  const r2 = run('upsert_template', { family_from: 'S00_Open', intent: 'GO', template: 'replaced', updates: [{ field: 'current_state', kind: 'set', value: 'S01_Mid', raw: '`S01_Mid`' }] });
  ok('upsert_template idempotent update (no dup current_state)', store.loadDraft(ID).pack.families[0].templates.GO.updates.filter(u => u.field === 'current_state').length === 1 && r2.ok);
}

// ----------------------------------------------------------- lore + rails ---
{
  const r = run('upsert_lore_entry', { id: 'hum', content: 'the hum.', keys: ['hum'], sticky: 2, group: 'g1' });
  ok('lore entry created (doc auto-initialized)', r.ok && store.loadDraft(ID).lore.lore.entries[0].sticky === 2);
  run('upsert_lore_entry', { id: 'hum', content: 'the hum, louder.', keys: ['hum', 'noise'] });
  const e = store.loadDraft(ID).lore.lore.entries[0];
  ok('lore entry update by id replaces (dropped fields gone)', e.content === 'the hum, louder.' && e.sticky === undefined && store.loadDraft(ID).lore.lore.entries.length === 1);
  run('set_rails', { rails: [{ find: '^ok[,.\\s]+' }, { find: '' }, null] });
  ok('set_rails filters invalid + defaults', store.loadDraft(ID).lore.rails.length === 1 && store.loadDraft(ID).lore.rails[0].flags === 'gi');
}

// ------------------------------------------------------------- validate -----
{
  const v = run('validate');
  ok('validate passthrough (errors present on incomplete module)', Array.isArray(v.errors) && v.errors.length > 0);
  ok('validate surfaces TODO scaffolding as warnings', (v.warnings || []).some(w => w.code === 'todo-placeholder') || v.warning_count > (v.warnings || []).length);
}

// --------------------------------------------------------- loop (mock LLM) --
function mockLLM(script) {
  let i = 0;
  return async (history, tools) => {
    const step = script[Math.min(i++, script.length - 1)];
    return typeof step === 'function' ? step(history, tools) : step;
  };
}
const tc = (name, args, cid) => ({ id: cid || `c${Math.floor(Math.random() * 1e6)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

{
  const events = [];
  const ledger = [];
  const out = await runAuthorChat({
    store, id: ID,
    messages: [{ role: 'user', content: 'set the character' }],
    emit: (ev) => events.push(ev),
    log: (t) => ledger.push(t),
    llm: mockLLM([
      { content: '<think>plan it</think>doing it', tool_calls: [tc('set_character', { name: 'LoopTest' }, 'call1')] },
      { content: '<think>done thinking</think>all set.' },
    ]),
  });
  ok('loop: tool executed against the draft', store.loadDraft(ID).manifest.character.name === 'LoopTest');
  ok('loop: reply is think-stripped', out.reply === 'all set.');
  ok('loop: thinking captured per round', out.thinking.length === 2 && out.thinking[0] === 'plan it');
  ok('loop: tool result message carries tool_call_id', out.messages.some(m => m.role === 'tool' && m.tool_call_id === 'call1'));
  ok('loop: history keeps think blocks verbatim', out.messages.some(m => m.role === 'assistant' && String(m.content).includes('<think>plan it</think>')));
  ok('loop: ledger hook fired with args digest', ledger.length === 1 && ledger[0].tool === 'set_character' && ledger[0].args_digest.includes('LoopTest'));
  ok('loop: event order round->thinking->interim->tool->reply', ['round', 'thinking', 'interim', 'tool', 'round', 'thinking', 'reply'].every((e, i) => events[i] === e));
}
{
  const out = await runAuthorChat({
    store, id: ID, messages: [{ role: 'user', content: 'x' }],
    llm: mockLLM([
      { content: '', tool_calls: [tc('no_such_tool', {})] },
      { content: '', tool_calls: [{ id: 'cbad', type: 'function', function: { name: 'set_character', arguments: 'not-json{{{' } }] },
      { content: 'recovered.' },
    ]),
  });
  ok('loop: unknown tool -> ok:false, loop continues', out.tool_log[0].ok === false && out.reply === 'recovered.');
  ok('loop: malformed args -> ok:false with message', out.tool_log[1].ok === false && /JSON|Unexpected|position/i.test(out.tool_log[1].summary));
  ok('loop: errors fed back to the model as tool messages', out.messages.filter(m => m.role === 'tool').every(m => JSON.parse(m.content).error));
}
{
  const out = await runAuthorChat({
    store, id: ID, messages: [{ role: 'user', content: 'x' }],
    llm: mockLLM([{ content: '', tool_calls: [tc('validate', {})] }]), // never stops calling tools
  });
  ok('loop: round cap reached -> capped reply, work preserved', out.rounds === 8 && out.reply.includes('round cap'));
}
{
  const seen = { sys: null };
  await runAuthorChat({
    store, id: ID, messages: [{ role: 'user', content: 'hello' }],
    llm: mockLLM([(history) => { seen.sys = history[0]; seen.n = history.length; return { content: 'hi' }; }]),
  });
  ok('loop: system prompt injected first, client history untouched', seen.sys.role === 'system' && seen.sys.content.includes('FORMAT LAW') && seen.n === 2);
}

// --------------------------------------------------------- splitThinking ----
{
  ok('split: closed think', JSON.stringify(splitThinking({ content: '<think>a</think>b' })) === JSON.stringify({ thinking: 'a', text: 'b' }));
  ok('split: unclosed think (stream cut)', splitThinking({ content: '<think>partial' }).text === '' && splitThinking({ content: '<think>partial' }).thinking === 'partial');
  const multi = splitThinking({ content: '<think>one</think>mid<think>two</think>end' });
  ok('split: multiple blocks joined', multi.thinking === 'one\n\ntwo' && multi.text === 'midend');
  ok('split: reasoning_content field engines', splitThinking({ reasoning_content: 'r', content: 'c' }).thinking === 'r');
  ok('split: field + inline combined', splitThinking({ reasoning_content: 'r', content: '<think>i</think>c' }).thinking === 'r\n\ni');
  ok('split: plain content untouched', splitThinking({ content: 'just text' }).text === 'just text');
}

// ---------------------------------------------------------------- cleanup ---
rmSync(draftsDir, { recursive: true, force: true });
ok('scratch drafts cleaned', !existsSync(join(draftsDir, ID)));

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
