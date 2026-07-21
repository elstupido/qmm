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

import { OLLAMA, MODEL, NUM_CTX, buildModule, buildGeneratePrompt, generateBubbles } from '../../server/engine.mjs';
import { scanLore, applyRails } from '../../server/lore.mjs';
import { validateModule } from '../../server/validate.mjs';
import { DraftStore } from './draft-store.mjs';

const KEY = process.env.AUTHOR_LLM_KEY || process.env.MINIMAX_API_KEY || '';
const USING_MINIMAX = !!(process.env.MINIMAX_API_KEY || (process.env.AUTHOR_LLM_URL || '').includes('minimax'));
export const AUTHOR_LLM_URL = (process.env.AUTHOR_LLM_URL || (USING_MINIMAX ? 'https://api.minimax.io/v1' : `${OLLAMA}/v1`)).replace(/\/$/, '');
export const AUTHOR_LLM_MODEL = process.env.AUTHOR_LLM_MODEL || (USING_MINIMAX ? 'MiniMax-M3' : MODEL);

const MAX_ROUNDS = 8;
// Caps are runaway guards, not budgets — generous by house rule.
const MAX_TOKENS = parseInt(process.env.AUTHOR_LLM_MAX_TOKENS || '16384', 10);

// ------------------------------------------------------------------ tools -----

const UPDATES_HINT = 'updates: array of {field, kind} objects. kinds: set{value}, add{n}, cond{raw}, set2{a,b}, skip. EVERY template must include {"field":"current_state","kind":"set","value":"<this family\'s to-state>"}. Final-beat templates must also set ending_route and ending_type.';

function toolDefs(id) {
  const T = (name, description, properties, required) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  });
  return [
    T('get_module_overview', `Read the current draft of "${id}": manifest, meta, beat chain, template coverage, lore summary, and validation state. ALWAYS call this first.`, {}, []),
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
const IMPL = {
  get_module_overview({ store, id }) {
    const d = store.loadDraft(id);
    if (!d) throw new Error(`no draft for ${id}`);
    const pack = DraftStore.mergedPack(d);
    const v = validateModule({ manifest: d.manifest, pack, dirName: id });
    return {
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
      validation: { errors: v.errors.length, warnings: v.warnings.length, first_errors: v.errors.slice(0, 6) },
    };
  },
  set_character({ store, id, args }) {
    const d = store.loadDraft(id);
    d.manifest.character = { name: String(args.name), ...(args.tagline ? { tagline: String(args.tagline) } : {}) };
    store.saveDoc(id, 'manifest', d.manifest, d.revs.manifest);
    return { ok: true, character: d.manifest.character };
  },
  set_meta({ store, id, args }) {
    const d = store.loadDraft(id);
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
    const d = store.loadDraft(id);
    d.pack.meta.intents = Object.fromEntries(Object.entries(args.intents).map(([k, v]) => [String(k).toUpperCase(), String(v)]));
    store.saveDoc(id, 'pack', d.pack, d.revs.pack);
    return { ok: true, intents: Object.keys(d.pack.meta.intents), note: 'every beat needs a template per intent — check templates_missing in the overview' };
  },
  delete_beat({ store, id, args }) {
    const d = store.loadDraft(id);
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
    const d = store.loadDraft(id);
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
    const d = store.loadDraft(id);
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
    const d = store.loadDraft(id);
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
    const d = store.loadDraft(id);
    d.lore ||= { lore: { budget_pct: 10, scan_depth: 8, entries: [] }, rails: [] };
    d.lore.rails = (args.rails || []).filter(r => r && r.find).map(r => ({ find: String(r.find), replace: String(r.replace ?? ''), flags: String(r.flags ?? 'gi') }));
    store.saveDoc(id, 'lore', d.lore, d.revs.lore);
    return { ok: true, rails: d.lore.rails.length };
  },
  validate({ store, id }) {
    const d = store.loadDraft(id);
    const pack = DraftStore.mergedPack(d);
    const { errors, warnings } = validateModule({ manifest: d.manifest, pack, dirName: id });
    return { errors, warnings: warnings.slice(0, 12), warning_count: warnings.length };
  },
  async test_fill({ store, id, args }) {
    const d = store.loadDraft(id);
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
    return { bubbles: railed.bubbles, lore_fired: lore.fired, fallback: !!gen.fallback, ms: gen.ms };
  },
};

// ------------------------------------------------------------------- loop -----

function systemPrompt(id, characterName) {
  return `You are the authoring assistant inside the QMM Author Studio, working on the DRAFT of story module "${id}". The human is the creative director; you do the data-entry work through your tools, which write directly into the draft.

QMM in one breath: an interactive mystery played as a text-message thread with the protagonist${characterName ? ` (${characterName})` : ''}; beats advance a linear state chain.

ENGINE SPLIT (law): YOU are the authoring engine. The GAME runs on ${MODEL} — a small local model that fills your authored templates per player at runtime. Write FOR it: concrete short bubbles, explicit fill_guidance, unambiguous {{placeholders}}; never assume the fill model shares your reasoning. test_fill runs the REAL ${MODEL}, so its output is ground truth for how your templates will actually play.

THE FORMAT LAW (violations block publish):
- meta: title, cold_open[] (the opening bubbles), voice_example, intents{} incl. OTHER.
- Beats are a LINEAR chain: beat n's "to" === beat n+1's "from"; the final "to" is terminal.
- EVERY beat needs a template for EVERY intent. Template bubbles are short lowercase text messages, one thought each, blank line between bubbles; {{placeholders}} mark what the fill model invents.
- Every template's updates set current_state to exactly its beat's "to". Final-beat templates also set ending_route and ending_type.
- Deterministic macros: {{random:a|b|c}}, {{pick:name:a|b|c}}, {{time}}, {{time_of_day}}, {{date}}, {{weekday}}.
- Lore: keyed entries with timed effects (delay/cooldown/sticky), probability, equivoque groups. Rails: regex output cleanup.

WORKFLOW: call get_module_overview FIRST. Then edit with tools — several calls per turn is normal. After substantive changes call validate and FIX the errors it reports. test_fill is a live model call — use it when a template's quality matters. Finish each turn by telling the director plainly what you changed and what's still missing.
Publishing is human-only. Only this module's draft is writable.`;
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
export async function runAuthorChat({ store, id, messages, emit = () => {} }) {
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
    const msg = await callLLM(history, tools);
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
        if (!IMPL[name]) throw new Error(`unknown tool ${name}`);
        result = await IMPL[name]({ store, id, args });
        toolLog.push({ tool: name, ok: true, summary: summarize(name, result) });
      } catch (e) {
        result = { error: String(e.message || e) };
        toolLog.push({ tool: name, ok: false, summary: String(e.message || e).slice(0, 160) });
      }
      emit('tool', toolLog[toolLog.length - 1]);
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
