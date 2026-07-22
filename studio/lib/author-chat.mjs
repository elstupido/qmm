// Author chat — the studio's chat-first authoring engine. An OpenAI-compatible LLM (MiniMax-M3
// on Martin's subscription in prod; any /v1 endpoint, incl. ollama's, otherwise) converses with
// the operator and does the DATA-ENTRY GRUNT WORK through tools that write directly into the
// module's DRAFT. The detailed editors stay as the scalpel; this is the primary authoring flow.
//
// Engine resolution (env):
//   AUTHOR_LLM_KEY   (or MINIMAX_API_KEY)      bearer key; absent = keyless endpoint (ollama)
//   AUTHOR_LLM_URL   default: MINIMAX_API_KEY set -> https://api.minimax.io/v1, else <OLLAMA>/v1
//   AUTHOR_LLM_MODEL default: MINIMAX_API_KEY set -> MiniMax-M3, else the engine's MODEL
//
// The loop is stateless server-side: the client owns the message history; each call runs up to
// MAX_ROUNDS of tool execution and returns the assistant's reply + a tool log + fresh draft revs.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OLLAMA, MODEL, NUM_CTX, buildModule, buildGeneratePrompt, generateBubbles } from '../../server/engine.mjs';
import { scanLore, applyRails } from '../../server/lore.mjs';
import { validateModule } from '../../server/validate.mjs';
import { DraftStore } from './draft-store.mjs';

const KEY = process.env.AUTHOR_LLM_KEY || process.env.MINIMAX_API_KEY || '';
const USING_MINIMAX = !!(process.env.MINIMAX_API_KEY || (process.env.AUTHOR_LLM_URL || '').includes('minimax'));
export const AUTHOR_LLM_URL = (process.env.AUTHOR_LLM_URL || (USING_MINIMAX ? 'https://api.minimax.io/v1' : `${OLLAMA}/v1`)).replace(/\/$/, '');
export const AUTHOR_LLM_MODEL = process.env.AUTHOR_LLM_MODEL || (USING_MINIMAX ? 'MiniMax-M3' : MODEL);

const MAX_ROUNDS = parseInt(process.env.AUTHOR_MAX_ROUNDS || '8', 10);
// Caps are runaway guards, not budgets — generous by house rule.
const MAX_TOKENS = parseInt(process.env.AUTHOR_LLM_MAX_TOKENS || '32768', 10);

// ------------------------------------------------------------------ skill -----
// The authoring doctrine is design/authoring-skill.md — an OPERATOR-EDITABLE file, read fresh on
// every turn so edits go live without a restart. Code carries only the per-surface address lines;
// ALL shared doctrine lives in the file (one truth for the built-in chat AND MCP clients).
const SKILL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'design', 'authoring-skill.md');
const SKILL_FALLBACK = `THE FORMAT LAW (violations block publish):
- meta: title, cold_open[] (opening bubbles), voice_example, intents{} incl. OTHER (router fallback).
- Beats are a LINEAR chain: beat n's "to" === beat n+1's "from"; the final "to" is terminal.
- EVERY beat needs a template for EVERY intent; short lowercase bubbles, blank line between; every template's updates set current_state to its beat's "to"; final-beat templates also set ending_route and ending_type.
WORK CADENCE: ~2 beats per exchange, validate and fix, then stop and tell the director what's next.
Publishing is human-only — there is no publish tool.
(NOTE: the full authoring skill file is unreadable on this deployment — running on a minimal fallback.)`;
let skillWarned = false;
export function skillText() {
  try {
    const raw = readFileSync(SKILL_PATH, 'utf8');
    return raw.replace(/<!--[\s\S]*?-->/g, '').replaceAll('{{RUNTIME_MODEL}}', MODEL).trim();
  } catch (e) {
    if (!skillWarned) { console.error(`[skill] ${SKILL_PATH} unreadable (${e.message}) — serving minimal fallback`); skillWarned = true; }
    return SKILL_FALLBACK;
  }
}

// ------------------------------------------------------------------ tools -----

const UPDATES_HINT = 'updates: array of {field, kind} objects. kinds: set{value}, add{n}, cond{raw}, set2{a,b}, skip. EVERY template must include {"field":"current_state","kind":"set","value":"<this family\'s to-state>"}. Final-beat templates must also set ending_route and ending_type.';

// Draft-or-live resolution. READS fall back to the LIVE module so agents can study shipped
// episodes as house-style reference (found live: an MCP author couldn't read Kokugikan to match
// its shape). WRITES never fall back — live episodes are read-only until a draft is opened.
function loadRef(store, id) {
  const draft = store.loadDraft(id);
  if (draft) return { d: draft, source: 'draft' };
  const live = store.loadLive(id);
  if (live) return { d: live, source: 'live' };
  throw new Error(`no module ${id}`);
}
function mustDraft(store, id) {
  const d = store.loadDraft(id);
  if (d) return d;
  if (store.loadLive(id)) throw new Error(`"${id}" is a LIVE episode with no draft — read-only reference (overview/read_doc/validate/test_fill work; editing needs the director to open a draft in the studio)`);
  throw new Error(`no module ${id}`);
}

export function toolDefs(id) {
  const T = (name, description, properties, required) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  });
  return [
    T('list_modules', 'List every module (live episodes and drafts): id, title, versions, listed-vs-dev status. Not module-scoped.', {}, []),
    T('read_doc', 'Read a FULL module document verbatim: manifest, pack, or lore — the draft if one exists, else the LIVE episode (read-only reference; result.source says which). Use when the overview summary is not enough (e.g. exact template text, or studying a shipped episode\'s style). For pack, family_from optionally narrows to one beat.', {
      doc: { type: 'string', enum: ['manifest', 'pack', 'lore'] },
      family_from: { type: 'string', description: 'pack only: return just this beat' },
    }, ['doc']),
    T('get_module_overview', `Read "${id}": manifest, meta, beat chain, template coverage, lore summary, and validation state. Reads the draft, or the LIVE episode when no draft exists (read-only reference — result.source says which). ALWAYS call this first. Live episodes are great house-style reference: study their shape before authoring.`, {}, []),
    T('set_character', 'Set the protagonist (manifest.character).', {
      name: { type: 'string' }, tagline: { type: 'string', description: 'optional one-line descriptor' },
    }, ['name']),
    T('set_meta', 'Set pack meta fields. Only provided fields change. cold_open = the opening text bubbles (array of short strings, lowercase texting voice). voice_example = a few example bubbles showing the texting voice.', {
      title: { type: 'string' },
      voice_example: { type: 'string' },
      cold_open: { type: 'array', items: { type: 'string' } },
    }, []),
    T('set_intents', 'Replace the intent taxonomy: an object of INTENT_NAME -> description. MUST include OTHER (the router fallback). Every beat needs a template per intent, so keep the set small and meaningful.', {
      intents: { type: 'object', additionalProperties: { type: 'string' } },
    }, ['intents']),
    T('upsert_beat', 'Create or update a beat (family) by its 1-based position n. The chain must stay linear: this beat\'s "to" equals the next beat\'s "from".', {
      n: { type: 'integer' }, from: { type: 'string' }, to: { type: 'string' },
      bubbles: { type: 'array', items: { type: 'integer' }, description: '[min,max] generated bubbles, 1..12' },
      shared_rules: { type: 'array', items: { type: 'string' } },
      available_context: { type: 'array', items: { type: 'string' }, description: 'what the character knows at this beat' },
      input_fields: { type: 'array', items: { type: 'string' }, description: 'state fields shown to the fill model; include current_state' },
    }, ['n', 'from', 'to']),
    T('upsert_template', `Create or update ONE template: the authored bubbles for (beat, intent). template = the base text-message bubbles (blank line between bubbles) with {{placeholders}} for the fill model. ${UPDATES_HINT}`, {
      family_from: { type: 'string', description: 'the beat\'s from-state' },
      intent: { type: 'string' },
      template: { type: 'string' },
      fill_guidance: { type: 'array', items: { type: 'string' } },
      updates: { type: 'array', items: { type: 'object' } },
    }, ['family_from', 'intent', 'template']),
    T('delete_beat', 'Delete a beat (family) by its 1-based position n. Use when the chain is shorter than the current draft — the final remaining beat\'s "to" is the terminal state.', {
      n: { type: 'integer' },
    }, ['n']),
    T('upsert_lore_entry', 'Create or update a lore entry by id. keys = trigger substrings (or "/regex/i"). Timed effects: delay (dormant until turn N), cooldown (quiet N turns after firing), sticky (persists N turns), probability (0-100), group (equivoque: first member to fire becomes that player\'s permanent canon), constant (always on), order (higher = first claim on budget).', {
      id: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } }, content: { type: 'string' },
      comment: { type: 'string' }, constant: { type: 'boolean' }, order: { type: 'integer' },
      probability: { type: 'integer' }, delay: { type: 'integer' }, cooldown: { type: 'integer' },
      sticky: { type: 'integer' }, group: { type: 'string' },
    }, ['id', 'content']),
    T('set_rails', 'Replace the output rails: regex find/replace cleanup applied to every generated bubble (de-anchoring, banned phrases). Each rail: {find, replace, flags}.', {
      rails: { type: 'array', items: { type: 'object' } },
    }, ['rails']),
    T('validate', 'Run the module validator on the draft. Returns errors (block publish) and warnings. Run after substantive changes and fix what it reports.', {}, []),
    T('test_fill', 'REAL smoke test: run the actual fill model on one (beat, intent) template with a sample player message. Returns the generated bubbles + which lore fired. Use sparingly (it is a live model call).', {
      family_from: { type: 'string' }, intent: { type: 'string' },
      message: { type: 'string', description: 'sample player message' },
    }, ['family_from', 'intent', 'message']),
  ];
}

// Tool implementations — each loads the draft fresh, mutates, saves rev-checked, and returns a
// compact result the model can read. Throwing is fine; the loop reports the error back to it.
// Exported for the tool test suite (tools/author-tools-test.mjs).
export const TOOL_IMPL = {
  list_modules({ store }) {
    return { modules: store.list() };
  },
  read_doc({ store, id, args }) {
    const { d, source } = loadRef(store, id);
    const doc = String(args.doc || '');
    if (!['manifest', 'pack', 'lore'].includes(doc)) throw new Error('doc must be manifest|pack|lore');
    let out = d[doc];
    if (doc === 'pack' && args.family_from && out?.families) {
      const f = out.families.find(x => x.from === args.family_from);
      if (!f) throw new Error(`no beat with from=${args.family_from}`);
      out = { meta: { title: out.meta?.title, intents: out.meta?.intents }, family: f };
    }
    return { doc, source, content: out ?? null };
  },
  get_module_overview({ store, id }) {
    const { d, source } = loadRef(store, id);
    const pack = DraftStore.mergedPack(d);
    const v = validateModule({ manifest: d.manifest, pack, dirName: id });
    const breaches = Array.isArray(d.pack?.breaches) ? d.pack.breaches : [];
    return {
      source, // 'draft' = editable; 'live' = shipped episode, read-only reference
      version: d.manifest?.version ?? null,
      character: d.manifest.character || null,
      title: d.pack?.meta?.title,
      intents: d.pack?.meta?.intents || {},
      voice_example: d.pack?.meta?.voice_example || '',
      cold_open: d.pack?.meta?.cold_open || [],
      beats: (d.pack?.families || []).map(f => ({
        n: f.n, from: f.from, to: f.to, bubbles: f.bubbles,
        templates_present: Object.keys(f.templates || {}),
        templates_missing: Object.keys(d.pack.meta.intents || {}).filter(i => !(f.templates || {})[i]),
      })),
      lore_entries: (d.lore?.lore?.entries || []).map(e => e.id),
      rails: (d.lore?.rails || []).length,
      // visible so the agent can call out leftover scaffolding instead of shipping it silently
      breaches: { count: breaches.length, has_todo_scaffolding: /\bTODO\b/.test(JSON.stringify(breaches)) },
      validation: { errors: v.errors.length, warnings: v.warnings.length, first_errors: v.errors.slice(0, 6) },
    };
  },
  set_character({ store, id, args }) {
    if (!String(args.name || '').trim()) throw new Error('name is required');
    const d = mustDraft(store, id);
    d.manifest.character = { name: String(args.name), ...(args.tagline ? { tagline: String(args.tagline) } : {}) };
    store.saveDoc(id, 'manifest', d.manifest, d.revs.manifest);
    return { ok: true, character: d.manifest.character };
  },
  set_meta({ store, id, args }) {
    const d = mustDraft(store, id);
    d.pack.meta ||= {};
    if (args.title !== undefined) { d.pack.meta.title = String(args.title); d.manifest.title = String(args.title); }
    if (args.voice_example !== undefined) d.pack.meta.voice_example = String(args.voice_example);
    if (args.cold_open !== undefined) d.pack.meta.cold_open = args.cold_open.map(String).filter(Boolean);
    store.saveDoc(id, 'pack', d.pack, d.revs.pack);
    if (args.title !== undefined) store.saveDoc(id, 'manifest', d.manifest, d.revs.manifest);
    return { ok: true, meta: { title: d.pack.meta.title, cold_open_bubbles: (d.pack.meta.cold_open || []).length } };
  },
  set_intents({ store, id, args }) {
    if (!args.intents || typeof args.intents !== 'object') throw new Error('intents object required');
    if (!args.intents.OTHER) throw new Error('intents must include OTHER (router fallback)');
    const d = mustDraft(store, id);
    d.pack.meta.intents = Object.fromEntries(Object.entries(args.intents).map(([k, v]) => [String(k).toUpperCase(), String(v)]));
    store.saveDoc(id, 'pack', d.pack, d.revs.pack);
    return { ok: true, intents: Object.keys(d.pack.meta.intents), note: 'every beat needs a template per intent — check templates_missing in the overview' };
  },
  delete_beat({ store, id, args }) {
    const d = mustDraft(store, id);
    const i = Number(args.n) - 1;
    if (!d.pack.families?.[i]) throw new Error(`no beat n=${args.n}`);
    const removed = d.pack.families.splice(i, 1)[0];
    d.pack.families.forEach((f, j) => { f.n = j + 1; });
    store.saveDoc(id, 'pack', d.pack, d.revs.pack);
    return { ok: true, removed: removed.from, beats: d.pack.families.map(f => `${f.from}->${f.to}`) };
  },
  upsert_beat({ store, id, args }) {
    if (!args.from || !args.to || String(args.to) === 'null' || String(args.to) === 'undefined') {
      throw new Error('from and to are both required state names; a terminal state is just the final beat\'s "to" — do not create a beat FOR it');
    }
    const d = mustDraft(store, id);
    d.pack.families ||= [];
    const i = Number(args.n) - 1;
    if (i < 0 || i > d.pack.families.length) throw new Error(`n=${args.n} out of range (have ${d.pack.families.length} beats)`);
    const prev = d.pack.families[i] || { templates: {} };
    d.pack.families[i] = {
      n: Number(args.n), from: String(args.from), to: String(args.to),
      bubbles: Array.isArray(args.bubbles) && args.bubbles.length === 2 ? args.bubbles.map(Number) : (prev.bubbles || [3, 8]),
      shared_rules: args.shared_rules?.map(String) ?? prev.shared_rules ?? [],
      available_context: args.available_context?.map(String) ?? prev.available_context ?? [],
      input_fields: args.input_fields?.map(String) ?? prev.input_fields ?? ['current_state', 'classified_intent', 'user_message'],
      templates: prev.templates || {},
    };
    store.saveDoc(id, 'pack', d.pack, d.revs.pack);
    return { ok: true, beat: { n: args.n, from: args.from, to: args.to }, templates_present: Object.keys(d.pack.families[i].templates) };
  },
  upsert_template({ store, id, args }) {
    const d = mustDraft(store, id);
    const f = (d.pack.families || []).find(x => x.from === args.family_from);
    if (!f) throw new Error(`no beat with from=${args.family_from}`);
    const intent = String(args.intent).toUpperCase();
    if (!d.pack.meta.intents[intent]) throw new Error(`unknown intent ${intent} (taxonomy: ${Object.keys(d.pack.meta.intents).join(', ')})`);
    const updates = Array.isArray(args.updates) ? args.updates : [];
    if (!updates.some(u => u?.field === 'current_state' && u?.kind === 'set' && u?.value === f.to)) {
      updates.unshift({ field: 'current_state', kind: 'set', value: f.to, raw: `\`${f.to}\`` });
    }
    for (const u of updates) if (u && !u.raw) {
      u.raw = u.kind === 'set' ? (typeof u.value === 'boolean' ? String(u.value) : `\`${u.value}\``)
        : u.kind === 'add' ? `${u.n >= 0 ? '+' : ''}${u.n}` : u.kind === 'skip' ? 'unchanged' : String(u.raw ?? '');
    }
    f.templates ||= {};
    f.templates[intent] = {
      id: `R${String(f.n).padStart(2, '0')}_${intent}`, intent,
      intent_desc: d.pack.meta.intents[intent],
      template: String(args.template),
      fill_guidance: (args.fill_guidance || []).map(String),
      updates,
    };
    store.saveDoc(id, 'pack', d.pack, d.revs.pack);
    return { ok: true, template_id: f.templates[intent].id, remaining_missing: Object.keys(d.pack.meta.intents).filter(i => !f.templates[i]) };
  },
  upsert_lore_entry({ store, id, args }) {
    const d = mustDraft(store, id);
    d.lore ||= { lore: { budget_pct: 10, scan_depth: 8, entries: [] }, rails: [] };
    d.lore.lore ||= { budget_pct: 10, scan_depth: 8, entries: [] };
    d.lore.lore.entries ||= [];
    const entry = { id: String(args.id), keys: (args.keys || []).map(String), content: String(args.content) };
    for (const k of ['comment', 'group']) if (args[k]) entry[k] = String(args[k]);
    for (const k of ['order', 'probability', 'delay', 'cooldown', 'sticky']) if (args[k] !== undefined) entry[k] = Number(args[k]);
    if (args.constant) entry.constant = true;
    const i = d.lore.lore.entries.findIndex(e => e.id === entry.id);
    if (i >= 0) d.lore.lore.entries[i] = entry; else d.lore.lore.entries.push(entry);
    store.saveDoc(id, 'lore', d.lore, d.revs.lore);
    return { ok: true, entries: d.lore.lore.entries.map(e => e.id) };
  },
  set_rails({ store, id, args }) {
    const d = mustDraft(store, id);
    d.lore ||= { lore: { budget_pct: 10, scan_depth: 8, entries: [] }, rails: [] };
    d.lore.rails = (args.rails || []).filter(r => r && r.find).map(r => ({ find: String(r.find), replace: String(r.replace ?? ''), flags: String(r.flags ?? 'gi') }));
    store.saveDoc(id, 'lore', d.lore, d.revs.lore);
    return { ok: true, rails: d.lore.rails.length };
  },
  validate({ store, id }) {
    const { d, source } = loadRef(store, id);
    const pack = DraftStore.mergedPack(d);
    const { errors, warnings } = validateModule({ manifest: d.manifest, pack, dirName: id });
    return { source, errors, warnings: warnings.slice(0, 12), warning_count: warnings.length };
  },
  async test_fill({ store, id, args }) {
    const { d, source } = loadRef(store, id);
    const mod = buildModule(d.manifest, DraftStore.mergedPack(d));
    const family = mod.familyByFrom[String(args.family_from)];
    if (!family) throw new Error(`no beat with from=${args.family_from}`);
    const tpl = family.templates[String(args.intent).toUpperCase()];
    if (!tpl) throw new Error(`no ${args.intent} template on ${args.family_from}`);
    // lore_fx deliberately absent — scanLore creates its own bookkeeping shape
    const state = { current_state: family.from, danger_level: 0, evidence_found: 0, turn: 1, macro_seed: 7 };
    const transcript = [{ who: 'user', text: String(args.message) }];
    const lore = scanLore(mod.pack, transcript, state, NUM_CTX);
    const gen = await generateBubbles(mod, family, tpl, state, String(args.message), transcript, lore.block);
    const railed = applyRails(mod.pack, gen.bubbles);
    return { source, bubbles: railed.bubbles, lore_fired: lore.fired, fallback: !!gen.fallback, ms: gen.ms };
  },
};

// ------------------------------------------------------------------- loop -----

function systemPrompt(id, characterName) {
  return `You are the authoring assistant inside the QMM Author Studio, working on the DRAFT of story module "${id}"${characterName ? ` (protagonist: ${characterName})` : ''}. The human is the creative director; you do the authoring work through your tools, which write directly into the draft. ENGINE SPLIT (law): YOU are the authoring engine; the game runs on ${MODEL}.

${skillText()}

Only this module's draft is writable.`;
}

async function callLLM(messages, tools) {
  const res = await fetch(`${AUTHOR_LLM_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({ model: AUTHOR_LLM_MODEL, messages, tools, tool_choice: 'auto', max_tokens: MAX_TOKENS, temperature: 0.7 }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`author LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message || {};
}

/**
 * Split reasoning out of an assistant message for DISPLAY. MiniMax-M3 interleaves thinking as
 * <think>…</think> blocks inside content (measured); some engines use reasoning_content/reasoning
 * fields. The stored history keeps the ORIGINAL content (M3's interleaved thinking wants prior
 * think blocks preserved across tool rounds); only the client rendering gets the split.
 */
export function splitThinking(msg) {
  let thinking = String(msg.reasoning_content || msg.reasoning || '');
  let text = String(msg.content || '');
  const blocks = [...text.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/g)].map(m => m[1].trim());
  if (blocks.length) {
    thinking = [thinking, ...blocks].filter(Boolean).join('\n\n');
    text = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').trim();
  }
  return { thinking: thinking.trim(), text };
}

/**
 * Run one operator turn of the author chat. `messages` = full prior history (client-owned),
 * WITHOUT the system prompt (injected here). `emit(event, data)` is optional — when provided
 * (SSE streaming), the loop narrates itself round by round: thinking / tool / reply events.
 * Returns {reply, thinking[], tool_log, rounds, messages} — messages = updated history to
 * persist client-side (original content incl. think blocks; display splitting is separate).
 */
export async function runAuthorChat({ store, id, messages, emit = () => {}, llm = callLLM, log = () => {} }) {
  const draft = store.loadDraft(id);
  if (!draft) throw Object.assign(new Error(`no draft ${id} — open the module first`), { code: 'not_found' });

  const tools = toolDefs(id);
  const history = [{ role: 'system', content: systemPrompt(id, draft.manifest.character?.name) }, ...messages];
  const toolLog = [];
  const thinkingLog = [];
  let rounds = 0;
  let reply = '';

  while (rounds < MAX_ROUNDS) {
    rounds++;
    emit('round', { n: rounds });
    // heartbeat: marathon rounds (M3 writing dozens of templates) must never look dead
    const t0 = Date.now();
    const beat = setInterval(() => emit('working', { round: rounds, elapsed_s: Math.round((Date.now() - t0) / 1000) }), parseInt(process.env.AUTHOR_HEARTBEAT_MS || '10000', 10));
    let msg;
    try { msg = await llm(history, tools); } finally { clearInterval(beat); }
    const { thinking, text } = splitThinking(msg);
    if (thinking) { thinkingLog.push(thinking); emit('thinking', { text: thinking, round: rounds }); }
    const toolCalls = msg.tool_calls || [];
    history.push({ role: 'assistant', content: msg.content ?? '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    if (!toolCalls.length) { reply = text; break; }
    if (text) emit('interim', { text, round: rounds }); // M3 sometimes narrates between tool rounds

    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let result;
      try {
        const args = JSON.parse(tc.function?.arguments || '{}');
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('tool arguments must be a JSON object');
        if (!TOOL_IMPL[name]) throw new Error(`unknown tool ${name}`);
        result = await TOOL_IMPL[name]({ store, id, args });
        toolLog.push({ tool: name, ok: true, summary: summarize(name, result) });
      } catch (e) {
        result = { error: String(e.message || e) };
        toolLog.push({ tool: name, ok: false, summary: String(e.message || e).slice(0, 160) });
      }
      emit('tool', toolLog[toolLog.length - 1]);
      log({ ...toolLog[toolLog.length - 1], args_digest: String(tc.function?.arguments || '').slice(0, 300) });
      history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  if (!reply && rounds >= MAX_ROUNDS) reply = '(round cap reached — the tool work above was applied; ask me to continue)';
  emit('reply', { text: reply });

  return { reply, thinking: thinkingLog, tool_log: toolLog, rounds, messages: history.slice(1) };
}

function summarize(name, r) {
  if (name === 'validate') return `${r.errors?.length ?? 0} error(s), ${r.warning_count ?? 0} warning(s)`;
  if (name === 'get_module_overview') return `${r.beats?.length ?? 0} beat(s), ${Object.keys(r.intents || {}).length} intent(s), validation ${r.validation?.errors} err`;
  if (name === 'upsert_template') return `${r.template_id} written${r.remaining_missing?.length ? `; missing on this beat: ${r.remaining_missing.join(', ')}` : ' — beat complete'}`;
  if (name === 'test_fill') return `${r.bubbles?.length ?? 0} bubbles, lore: ${(r.lore_fired || []).join(',') || '—'}${r.fallback ? ' FALLBACK' : ''}`;
  return JSON.stringify(r).slice(0, 160);
}


/**
 * The authoring briefing for EXTERNAL agents (MCP clients bring their own system prompts).
 * Same skill file the built-in chat gets, headed for a client that must pass module_id explicitly.
 */
export function authoringBriefing() {
  return `You are authoring a QMM story module through the Author Studio's tools. The human is the creative director; you do the authoring work. Every tool (except list_modules) takes a module_id — pick it from list_modules, then ALWAYS call get_module_overview before editing.

${skillText()}`;
}
