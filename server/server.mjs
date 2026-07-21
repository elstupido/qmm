#!/usr/bin/env node
// QMM server — zero-dependency Node. Serves the phone UI + the story API.
// Stories are pluggable MODULES (modules/<id>/{manifest,pack}.json). State is SERVER-OWNED:
// a session = (user_id, module_id) held in server/sessions.mjs, shared across every channel
// (web, app, Telegram) so one logged-in user keeps a consistent story wherever they play.
//
// Each turn: (1) gemma4:e4b classifies the player's text into one of the module's intents,
// (2) the matching template is populated by the same model into the character's bubbles,
// (3) state updates from the module pack are applied mechanically, (4) the session is persisted.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSession, saveSession, newSession, getOrCreate, clearSession } from './sessions.mjs';
import { scanLore, resolveMacros, applyRails, freshLoreFx } from './lore.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', 'public');
const MODULES_DIR = join(here, '..', 'modules');

const PORT = parseInt(process.env.PORT || '8791', 10);
const OLLAMA = process.env.OLLAMA || 'http://127.0.0.1:11434';
const MODEL = process.env.MODEL || 'gemma4:e4b';
const KEEP_ALIVE = '60m';
// CONTEXT POLICY: the window is a deployment property of the MODEL, never an invented cap.
// Raise via env once measured (gemma4:e4b goes well past this); all lore budgets scale with it.
const NUM_CTX = parseInt(process.env.NUM_CTX || '32768', 10);

// ------------------------------------------------------------ module registry ----
// Each module derives the runtime bits the engine needs from its pack.
function buildModule(manifest, pack) {
  return {
    id: manifest.id, manifest, pack, meta: pack.meta,
    intents: Object.keys(pack.meta.intents),
    familyByFrom: Object.fromEntries(pack.families.map(f => [f.from, f])),
    firstFrom: pack.families[0]?.from,
    lastBeat: pack.families.length,
  };
}
const MODULES = {};
for (const d of readdirSync(MODULES_DIR)) {
  try {
    const mdir = join(MODULES_DIR, d);
    if (!statSync(mdir).isDirectory()) continue;
    const manifest = JSON.parse(readFileSync(join(mdir, 'manifest.json'), 'utf8'));
    const pack = JSON.parse(readFileSync(join(mdir, manifest.pack || 'pack.json'), 'utf8'));
    // lore + rails live in a sidecar (default lore.json) so build-pack regeneration never
    // wipes them, and the ST-lorebook importer has a clean target. Merged into the pack here.
    const lorePath = join(mdir, manifest.lore || 'lore.json');
    if (existsSync(lorePath)) {
      try {
        const doc = JSON.parse(readFileSync(lorePath, 'utf8'));
        if (doc.lore) pack.lore = doc.lore;
        if (doc.rails) pack.rails = doc.rails;
      } catch (e) { console.error(`[module] ${d}: bad lore.json ignored: ${e.message}`); }
    }
    const m = buildModule(manifest, pack);
    MODULES[m.id] = m;
    console.log(`[module] loaded ${m.id} — ${pack.families.length} beats, ${m.intents.length} intents, ${pack.lore?.entries?.length || 0} lore entries, ${pack.rails?.length || 0} rails`);
  } catch (e) { console.error(`[module] FAILED ${d}: ${e.message}`); }
}
const DEFAULT_MODULE = Object.keys(MODULES)[0];
if (!DEFAULT_MODULE) { console.error('[module] no modules loaded — check modules/'); process.exit(1); }
const getModule = (id) => (id ? MODULES[id] || null : MODULES[DEFAULT_MODULE]);

// ------------------------------------------------------------ flight log ----
// Everything a session does lands in logs/qmm-YYYY-MM-DD.jsonl for post-hoc debugging.
const LOG_DIR = join(here, '..', 'logs');
mkdirSync(LOG_DIR, { recursive: true });
function qlog(entry) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(join(LOG_DIR, `qmm-${new Date().toISOString().slice(0, 10)}.jsonl`), line + '\n');
  } catch (e) { console.error(`[log] ${e.message}`); }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- ollama ----
async function ollamaChat(messages, { format, temperature = 0.8, num_predict = 16384 } = {}) {
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, messages, stream: false, format, keep_alive: KEEP_ALIVE,
      options: { temperature, num_ctx: NUM_CTX, num_predict, top_p: 0.95 },
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { content: data.message?.content ?? '', thinking: data.message?.thinking ?? '', ms: Date.now() - t0 };
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fallthrough */ } }
  return null;
}

// ---------------------------------------------------------------- routing ---
// The "advance_story tool": one call decides chat-vs-advance and measures intent.
async function routeMessage(mod, userMessage, family, tail, exchanges, latencyS) {
  const defs = mod.intents.map(i => `- ${i}: ${mod.meta.intents[i]}`).join('\n');
  const recentYuki = tail.filter(m => m.who === 'yuki').slice(-6).map(m => `  ${m.text.replace(/\n/g, ' / ')}`).join('\n');
  const sys = 'You are the pacing director for a text-message mystery game. The player texts advice to Yuki, the protagonist. Decide whether the newest player message should ADVANCE the story to its next beat, or whether Yuki should just CHAT back inside the current scene. Output JSON only.';
  const usr = `Intent categories (always pick the best fit for the newest message; used when advancing):
${defs}

Story beat: ${family.from} (beat ${family.n} of ${mod.lastBeat})${family.n === mod.lastBeat ? " — FINAL BEAT: any actionable instruction is the player's ending choice, prefer advance" : ''}.
Chat exchanges already spent on this beat: ${exchanges} (at 3 or more, prefer advance unless the message is clearly non-actionable).
Seconds the player took to reply: ${latencyS || 'unknown'} (fast replies = engaged back-and-forth chatting; a long pause followed by a directive = a decision).

Yuki's recent messages:
${recentYuki || '  (cold open)'}

Newest player message: ${JSON.stringify(userMessage)}

advance = the message gives clear actionable guidance (do X / go / yes, try it), repeats guidance already given, or this beat's conversation has run its course.
chat = the message is a question, reaction, emotion, joke, comfort, or thinking out loud — early in a beat, let the conversation breathe.`;
  const format = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['chat', 'advance'] },
      intent: { type: 'string', enum: mod.intents },
    },
    required: ['action', 'intent'],
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { content, thinking, ms } = await ollamaChat(
      [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      { format, temperature: 0 },
    );
    const parsed = parseJsonLoose(content);
    if (parsed && ['chat', 'advance'].includes(parsed.action) && mod.intents.includes(parsed.intent)) {
      return { action: parsed.action, intent: parsed.intent, ms, thinking };
    }
    console.log(`[route] attempt ${attempt} unparseable: ${JSON.stringify(content.slice(0, 200))}`);
    qlog({ kind: 'llm_parse_fail', call: 'route', attempt, content: content.slice(0, 2000), thinking: thinking.slice(0, 4000) });
  }
  return { action: 'chat', intent: 'OTHER', ms: 0, fallback: true };
}

// -------------------------------------------------------------- generation --
function stateForPrompt(family, state) {
  const skip = new Set(['current_state', 'user_message', 'classified_intent', 'known_context']);
  const lines = [];
  for (const f of family.input_fields) {
    if (skip.has(f) || state[f] === undefined || state[f] === null) continue;
    lines.push(`- ${f}: ${state[f]}`);
  }
  return lines.join('\n');
}

async function generateBubbles(mod, family, tpl, state, userMessage, tail, loreBlock = '') {
  const [minB, maxB] = family.bubbles;
  const rules = family.shared_rules.map(r => `- ${r}`).join('\n');
  const ctx = family.available_context.map(c => `- ${c}`).join('\n');
  const ending = family.n === mod.lastBeat;
  const fillLines = [...tpl.fill_guidance];
  if (ending) {
    fillLines.push(`player_moment: the player's final message was ${JSON.stringify(userMessage.slice(0, 220))} — write 2-3 bubbles where Yuki says or does exactly that (quote or closely paraphrase the player's key words) and Ura visibly reacts to that SPECIFIC thing in his own voice. This replaces any generic confrontation lines.`);
  }
  const fill = fillLines.map(g => `- ${g}`).join('\n');
  const convo = tail.slice(-16).map(m => `${m.who === 'user' ? 'player' : 'yuki'}: ${m.text.replace(/\n/g, ' / ')}`).join('\n');

  const sys = `You write Yuki's next text messages in "Quantum Murder Mysteries", an interactive horror mystery told entirely as a text-message conversation. The player texts advice to Yuki; you reply as Yuki only.

Voice: immediate, scared, intimate. Short bubbles, like real texting. lowercase where natural. Never narrate, never summarize the plot, never mention templates, intents, or the game. Yuki writes like this:
${mod.meta.voice_example}

How Yuki opens and how she feels is yours to vary — keep the template's EVENTS, not its mood or its opening words:
- Do not reflexively open by agreeing with or thanking the player ("okay", "good call", "yeah you're right", "like you said"). Sometimes she just acts; sometimes fear, anger, or a blank kind of calm comes first. Acknowledge the player only when it is natural, and not the same way each time.
- Let her emotional register shift from turn to turn: scared, yes, but also sometimes angry, cold and clipped, numb, over-talkative, or darkly joking to hold herself together. Do not recycle the same fear images ("hands shaking", "barely breathing").
- Make clues feel stumbled into, not handed over. Prefer something sensory and wrong over an object conveniently labeled with the plot; do not have props spell out names or instructions unless the scene truly calls for it.

Rules for this story beat:
${rules}

Your reply MUST land the same story beat as the base template: whatever clue, discovery, or reveal the template's final lines deliver, your final bubbles must deliver it too. Never stop before the clue lands.

Never output {{placeholder}} braces or snake_case_labels — always write the actual concrete detail in Yuki's own words.

Output JSON only: {"yuki_messages": [ ... ]} with ${minB} to ${maxB} strings. Each string is one text bubble; a bubble may contain a line break for a beat pause. Most bubbles stay under 140 characters.`;

  // NOTE: the FINAL-BEAT personalization below names the Yuki story's antagonist ("Ura"). When a
  // second story with its own endings ships, parameterize the antagonist from pack.meta.
  const tplText = resolveMacros(tpl.template, state.macro_seed);
  const usr = `STORY CONTEXT:
${ctx}

${loreBlock ? `THINGS YUKI KNOWS RIGHT NOW (weave in naturally only where relevant — never recite as a list):
${loreBlock}

` : ''}CURRENT STATE:
${stateForPrompt(family, state) || '- (start of story)'}

CONVERSATION SO FAR:
${convo}

PLAYER'S LATEST MESSAGE (advice to Yuki — let her wording react to it):
${JSON.stringify(userMessage)}

BASE TEMPLATE for this reply (keep its story beats, clue, and reveal exactly; fill any {{placeholders}}; adapt the wording so it flows from the player's message):
${ending ? `{{player_moment}}\n\n${tplText}` : tplText}

FILL GUIDANCE:
${fill}

IMPORTANT: keep ALL of the template's concrete events, in order, ending on the same
discovery/reveal its final lines deliver — rewrite the wording, never drop the content.
${ending ? `
FINAL BEAT — MANDATORY PERSONALIZATION: the player's last message is the trigger for this
ending, and it MUST be visible in the scene. Rules:
1. Whatever the player's message says or implies (an accusation, a taunt, a secret, a plan,
   a strange question), Yuki acts on THAT — if it is something sayable, she says it to Ura
   in her own words, quoting or closely paraphrasing the player's key phrase.
2. Ura reacts to that SPECIFIC thing, in his own voice, before the template's outcome
   unfolds. His reaction is about what the player actually said — not a generic response.
3. Where the template has generic lines like "i told him everyone would know", REPLACE them
   with the player's actual angle. Do not keep generic confrontation lines when the player
   supplied specific words.
4. Then the template's remaining events play out to the SAME outcome. Never change the
   ending route.` : ''}

Write Yuki's reply now as JSON.`;

  const format = {
    type: 'object',
    properties: {
      yuki_messages: { type: 'array', items: { type: 'string' }, minItems: minB, maxItems: maxB },
    },
    required: ['yuki_messages'],
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const { content, thinking, ms } = await ollamaChat(
      [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      { format, temperature: attempt === 0 ? 0.85 : 0.95 },
    );
    const parsed = parseJsonLoose(content);
    let bubbles = Array.isArray(parsed?.yuki_messages)
      ? parsed.yuki_messages
        .map(s => String(s)
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_, x) => x.replace(/_/g, ' '))
          .trim())
        .filter(Boolean).slice(0, maxB)
      : [];
    if (bubbles.length >= Math.min(2, minB)) return { bubbles, ms, thinking };
    qlog({ kind: 'llm_parse_fail', call: 'generate', attempt, content: content.slice(0, 2000), thinking: thinking.slice(0, 4000) });
  }
  // degrade gracefully: raw template with placeholders stripped
  const bubbles = tpl.template.replace(/\{\{[^}]+\}\}/g, '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  return { bubbles, ms: 0, fallback: true };
}

// ------------------------------------------------------------------- chat ---
// Between advances Yuki is just a chatbot with the beat's context shoved in her head.
async function chatAsYuki(mod, family, state, userMessage, tail, nudgeS, loreBlock = '') {
  const donts = family.shared_rules.filter(r => /^do not/i.test(r)).map(r => `- ${r}`).join('\n');
  const ctx = family.available_context.map(c => `- ${c}`).join('\n');
  const examples = mod.intents.map(i => `--- (if the story advanced via ${i}) ---\n${family.templates[i].template}`).join('\n\n');
  const convo = tail.slice(-16).map(m => `${m.who === 'user' ? 'player' : 'yuki'}: ${m.text.replace(/\n/g, ' / ')}`).join('\n');

  const sys = `You are Yuki in "Quantum Murder Mysteries", an interactive horror mystery told entirely as a text-message conversation. The player is Yuki's friend, texting with her in real time.

Voice: immediate, scared, intimate. Short bubbles, like real texting. lowercase where natural. Never narrate, never summarize the plot, never mention the game. Yuki writes like this:
${mod.meta.voice_example}

Don't reflexively open by agreeing with or thanking the player, and don't answer the same way each time — her mood can shift: scared, but also sometimes angry, clipped, numb, or darkly joking to hold herself together. Don't recycle the same fear images ("hands shaking", "barely breathing").

RIGHT NOW you are between story beats: just chat. React, feel, describe what you can currently see or hear, answer the player, wonder, ask what to do. Stay physically where you are. Do NOT make new discoveries, do NOT move somewhere new, and do NOT deliver anything from the UPCOMING BEAT EXAMPLES — those things have not happened yet and only happen when the story advances.
${donts}

Reply with ONE short text message. Send two only if you are completing a thought. Output JSON only: {"yuki_messages": [ ... ]} with 1 or 2 strings.`;

  const usr = `CURRENT SITUATION:
${ctx}

${loreBlock ? `THINGS YUKI KNOWS RIGHT NOW (weave in naturally only where relevant — never recite as a list):
${loreBlock}

` : ''}CURRENT STATE:
${stateForPrompt(family, state) || '- (start of story)'}

UPCOMING BEAT EXAMPLES (the flavor of what MIGHT happen next — background knowledge ONLY, never deliver or reveal these while chatting):
${examples}

CONVERSATION SO FAR:
${convo}

${nudgeS
    ? `The player has gone quiet for about ${nudgeS} seconds. Send ONE short double-text that fits right now: a nervous follow-up, one small sensory detail from where you are (nothing plot-changing), or checking they're still there.`
    : `NEWEST PLAYER MESSAGE:\n${JSON.stringify(userMessage)}\n\nChat back as Yuki now.`}`;

  const format = {
    type: 'object',
    properties: { yuki_messages: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: nudgeS ? 1 : 2 } },
    required: ['yuki_messages'],
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { content, thinking, ms } = await ollamaChat(
      [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      { format, temperature: 0.9 },
    );
    const parsed = parseJsonLoose(content);
    const bubbles = Array.isArray(parsed?.yuki_messages)
      ? parsed.yuki_messages.map(s => String(s).replace(/<br\s*\/?>/gi, '\n').replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_, x) => x.replace(/_/g, ' ')).trim())
        .filter(Boolean).slice(0, nudgeS ? 1 : 2)
      : [];
    if (bubbles.length) return { bubbles, ms, thinking };
    qlog({ kind: 'llm_parse_fail', call: 'chat', attempt, content: content.slice(0, 2000), thinking: thinking.slice(0, 4000) });
  }
  return { bubbles: [nudgeS ? 'you still there?' : 'sorry. hands shaking. still here. what should i do?'], ms: 0, fallback: true };
}

// ------------------------------------------------------------ state engine --
function evalCond(raw, state) {
  const ev = state.evidence_found || 0;
  if (/evidence_found` is already greater than 0|prior proof exists/.test(raw)) return ev > 0 || !!state.proof_ready;
  if (/prior evidence is strong|evidence_found` is high|recording or `evidence_found/.test(raw)) return ev >= 2;
  if (/entry_method` was `stealth_entry/.test(raw)) return state.entry_method === 'stealth_entry';
  if (/danger is high/.test(raw)) return (state.danger_level || 0) >= 3;
  // affirmative default: the template's own action satisfies its condition
  return true;
}

function applyUpdates(tpl, prev) {
  const state = { ...prev };
  for (const u of tpl.updates) {
    if (u.kind === 'skip') continue;
    if (u.kind === 'set') { state[u.field] = u.value; continue; }
    if (u.kind === 'add') { state[u.field] = (state[u.field] || 0) + u.n; continue; }
    if (u.kind === 'set2') {
      const useA = /proof/.test(u.raw) ? ((prev.evidence_found || 0) > 0 || !!prev.proof_ready) : true;
      const v = useA ? u.a : u.b;
      if (v !== u.field) state[u.field] = v; // b === own field name means "preserve"
      continue;
    }
    if (u.kind === 'cond') {
      if (u.lead === undefined) { // "conditional; true if ..." style
        state[u.field] = evalCond(u.raw, prev);
      } else if (typeof u.lead === 'boolean') {
        if (/ unless /.test(u.raw)) state[u.field] = !u.lead ? evalCond(u.raw, prev) : u.lead;
        else state[u.field] = evalCond(u.raw, prev) ? u.lead : (state[u.field] ?? false);
      } else if (typeof u.lead === 'number') {
        if (evalCond(u.raw, prev)) state[u.field] = (state[u.field] || 0) + u.lead;
      }
      continue;
    }
  }
  if (state.danger_level !== undefined) state.danger_level = Math.max(0, Math.min(5, state.danger_level));
  if (state.evidence_found !== undefined) state.evidence_found = Math.max(0, Math.min(6, state.evidence_found));
  return state;
}

function freshState(mod) {
  return {
    current_state: mod.firstFrom, danger_level: 0, evidence_found: 0, beat: 0, exchanges_in_beat: 0,
    // lore engine bookkeeping (contract: identical in the Kotlin engine)
    turn: 0, macro_seed: Math.floor(Math.random() * 2 ** 31), lore_fx: freshLoreFx(),
  };
}

// ------------------------------------------------------------------- turns --
function sanitizeTail(tail) {
  if (!Array.isArray(tail)) return [];
  return tail.slice(-24).map(m => ({
    who: m?.who === 'user' ? 'user' : 'yuki',
    text: String(m?.text ?? '').slice(0, 600),
  })).filter(m => m.text);
}

// Full-transcript sanitizer for app pushes (bounded; saveSession caps to MAX_TRANSCRIPT).
function sanitizeTranscript(t) {
  if (!Array.isArray(t)) return [];
  return t.slice(-400).map(m => ({
    who: m?.who === 'user' ? 'user' : 'yuki',
    text: String(m?.text ?? '').slice(0, 600),
  })).filter(m => m.text);
}

// Whitelist an app-pushed state object: plain, bounded keys/values (never trust a client blindly).
function sanitizeState(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(s)) {
    if (n++ >= 60) break;
    if (!/^[a-z_][a-z0-9_]{0,60}$/i.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 300);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}

const MAX_CHAT_PER_BEAT = 4; // hard cap: the next message after this many chats must advance

// Resolve (user_id, module_id) from a request body. module defaults to the only/first module.
function resolveIds(body) {
  const userId = String(body.user_id || '').slice(0, 80);
  const moduleId = String(body.module_id || '').slice(0, 80) || DEFAULT_MODULE;
  return { userId, moduleId };
}

async function handleTurn(body, ctx) {
  const { userId, moduleId } = resolveIds(body);
  const userMessage = String(body.user_message ?? '').trim().slice(0, 1000);
  if (!userId) return { error: 'no_user' };
  if (!userMessage) return { error: 'empty_message' };
  const mod = getModule(moduleId);
  if (!mod) return { error: 'unknown_module', detail: moduleId };

  // THE WORD: a bare "stop" ends everything, before the model, across every channel; wipes the session.
  if (/^stop[\s.!?…]*$/i.test(userMessage)) {
    clearSession(userId, moduleId);
    qlog({ kind: 'stop_word', ...ctx, user_id: userId, module_id: moduleId });
    console.log(`[STOP] user=${userId} module=${moduleId}`);
    return { mode: 'stopped' };
  }

  const st0 = freshState(mod);
  const sess = getOrCreate(userId, moduleId, () => st0, mod.meta.cold_open.map(t => resolveMacros(t, st0.macro_seed)));
  const state = sess.state;
  const family = mod.familyByFrom[state.current_state];
  if (!family) {
    qlog({ kind: 'turn_rejected', ...ctx, user_id: userId, module_id: moduleId, reason: 'story_over', current_state: state.current_state });
    return { error: 'story_over', detail: `no transitions from ${state.current_state}` };
  }

  // thread the new player line into the transcript (it appears in the tail AND is passed separately).
  sess.transcript.push({ who: 'user', text: userMessage });
  const tail = sanitizeTail(sess.transcript);
  const exchanges = state.exchanges_in_beat || 0;
  const latencyS = Math.round(Math.max(0, Math.min(3600, Number(body.reply_latency_s) || 0)));
  // lore engine: one scan per player turn, AFTER the new message joins the window (contract).
  state.turn = (Number(state.turn) || 0) + 1;
  const lore = scanLore(mod.pack, sess.transcript, state, NUM_CTX);
  const route = await routeMessage(mod, userMessage, family, tail, exchanges, latencyS);
  const forced = route.action !== 'advance' && exchanges >= MAX_CHAT_PER_BEAT;
  const base = {
    ...ctx, user_id: userId, module_id: moduleId, from_state: family.from, beat: family.n,
    exchanges_before: exchanges, reply_latency_s: latencyS, user_message: userMessage,
    route: { action: route.action, intent: route.intent, ms: route.ms, fallback: !!route.fallback, thinking: route.thinking || '' },
    forced,
  };

  if (route.action !== 'advance' && !forced) {
    const chat = await chatAsYuki(mod, family, state, userMessage, tail, null, lore.block);
    chat.bubbles = applyRails(mod.pack, chat.bubbles).bubbles;
    const newState = { ...state, exchanges_in_beat: exchanges + 1 };
    for (const b of chat.bubbles) sess.transcript.push({ who: 'yuki', text: b });
    sess.state = newState;
    saveSession(sess);
    console.log(`[turn] ${moduleId} ${family.from} CHAT ${exchanges + 1}/${MAX_CHAT_PER_BEAT} route=${route.ms}ms gen=${chat.ms}ms bubbles=${chat.bubbles.length}${route.fallback || chat.fallback ? ' FALLBACK' : ''}`);
    qlog({ kind: 'turn', mode: 'chat', ...base, bubbles: chat.bubbles, gen_ms: chat.ms, gen_fallback: !!chat.fallback, gen_thinking: chat.thinking || '', state_after: newState });
    return {
      mode: 'chat', yuki_messages: chat.bubbles, state: newState, seq: sess.seq, module_id: moduleId,
      meta: { mode: 'chat', intent: route.intent, exchanges_in_beat: newState.exchanges_in_beat, route_ms: route.ms, generate_ms: chat.ms, route_fallback: !!route.fallback, generate_fallback: !!chat.fallback, lore_fired: lore.fired },
    };
  }

  const tpl = family.templates[route.intent];
  const gen = await generateBubbles(mod, family, tpl, state, userMessage, tail, lore.block);
  gen.bubbles = applyRails(mod.pack, gen.bubbles).bubbles;
  const newState = applyUpdates(tpl, state);
  newState.beat = family.n;
  newState.exchanges_in_beat = 0;
  for (const b of gen.bubbles) sess.transcript.push({ who: 'yuki', text: b });
  sess.state = newState;
  saveSession(sess);

  const out = {
    mode: 'advance', yuki_messages: gen.bubbles, state: newState, seq: sess.seq, module_id: moduleId,
    meta: {
      mode: 'advance', forced, intent: route.intent, template_id: tpl.id, from: family.from, to: family.to,
      route_ms: route.ms, generate_ms: gen.ms, route_fallback: !!route.fallback, generate_fallback: !!gen.fallback, lore_fired: lore.fired,
    },
  };
  if (family.n === mod.lastBeat) {
    out.ending = {
      route: newState.ending_route, type: newState.ending_type,
      kenji_rescued: newState.kenji_rescued ?? false,
      yuki_status: newState.yuki_status ?? 'unknown',
      ura_status: newState.ura_status ?? 'unknown',
      evidence_status: newState.evidence_status ?? 'uncertain',
    };
  }
  console.log(`[turn] ${moduleId} ${family.from} --${route.intent}--> ${family.to} tpl=${tpl.id}${forced ? ' (forced advance)' : ''} route=${route.ms}ms gen=${gen.ms}ms bubbles=${gen.bubbles.length}${route.fallback || gen.fallback ? ' FALLBACK' : ''}`);
  qlog({ kind: 'turn', mode: 'advance', ...base, template_id: tpl.id, bubbles: gen.bubbles, gen_ms: gen.ms, gen_fallback: !!gen.fallback, gen_thinking: gen.thinking || '', state_after: newState, ending: out.ending || null });
  return out;
}

async function handleNudge(body, ctx) {
  const { userId, moduleId } = resolveIds(body);
  if (!userId) return { error: 'no_user' };
  const mod = getModule(moduleId);
  if (!mod) return { error: 'unknown_module' };
  const sess = loadSession(userId, moduleId);
  if (!sess) return { error: 'no_session' };
  const family = mod.familyByFrom[sess.state.current_state];
  if (!family) return { error: 'story_over' };
  const tail = sanitizeTail(sess.transcript);
  const quietS = Math.round(Math.max(10, Math.min(600, Number(body.quiet_s) || 30)));
  // nudges scan lore too (no turn increment — timed effects are player-turn-clocked).
  const lore = scanLore(mod.pack, sess.transcript, sess.state, NUM_CTX);
  const chat = await chatAsYuki(mod, family, sess.state, '', tail, quietS, lore.block);
  chat.bubbles = applyRails(mod.pack, chat.bubbles).bubbles;
  for (const b of chat.bubbles) sess.transcript.push({ who: 'yuki', text: b });
  saveSession(sess);
  console.log(`[nudge] ${moduleId} ${family.from} quiet=${quietS}s gen=${chat.ms}ms${chat.fallback ? ' FALLBACK' : ''}`);
  qlog({ kind: 'nudge', ...ctx, user_id: userId, module_id: moduleId, from_state: family.from, quiet_s: quietS, bubbles: chat.bubbles, gen_ms: chat.ms, gen_fallback: !!chat.fallback, gen_thinking: chat.thinking || '' });
  return { mode: 'nudge', yuki_messages: chat.bubbles, seq: sess.seq, meta: { mode: 'nudge', generate_ms: chat.ms } };
}

async function health() {
  const out = { ok: false, model: MODEL, ollama: OLLAMA, model_present: false, model_loaded: false, modules: Object.keys(MODULES) };
  try {
    const tags = await (await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5000) })).json();
    out.model_present = (tags.models || []).some(m => m.name === MODEL || m.name === `${MODEL}:latest`);
    const ps = await (await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(5000) })).json();
    out.model_loaded = (ps.models || []).some(m => m.name === MODEL || m.name === `${MODEL}:latest`);
    out.ok = out.model_present;
  } catch (e) { out.error = String(e.message || e); }
  return out;
}

// -------------------------------------------------------------- http layer --
function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
}

function serveStatic(res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  p = normalize(p).replace(/^([.\\/])+/, '');
  const file = join(PUBLIC, p);
  if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
  }
  const body = readFileSync(file);
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

// Serve a downloaded module's asset (image/audio) — path-safe under modules/<id>/assets/.
function serveModuleAsset(res, id, rel) {
  const base = join(MODULES_DIR, id, 'assets');
  const p = normalize(rel).replace(/^([.\\/])+/, '');
  const file = join(base, p);
  if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) {
    return sendJson(res, 404, { error: 'asset_not_found' });
  }
  const buf = readFileSync(file);
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'content-length': buf.length, 'cache-control': 'public, max-age=86400' });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 256 * 1024) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}

function reqCtx(req, body) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return {
    sid: String(body?.session_id || '').slice(0, 64) || 'unknown',
    channel: String(body?.channel || 'web').slice(0, 24),
    ip: fwd || req.socket.remoteAddress || 'unknown',
    ua: String(req.headers['user-agent'] || '').slice(0, 160),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const q = url.searchParams;
  try {
    if (req.method === 'GET' && path === '/api/health') return sendJson(res, 200, await health());

    // list installed modules (episodes) — the catalog. Unpublished (publish:false, e.g. dev) hidden.
    if (req.method === 'GET' && path === '/api/modules') {
      return sendJson(res, 200, { modules: Object.values(MODULES).filter(m => m.manifest.publish !== false).map(m => m.manifest), default: DEFAULT_MODULE });
    }
    // download a module for install: full bundle {manifest, pack}, or an asset under it — how the
    // on-device app (or any client) fetches a served episode. Entitlement gating: TODO (open for now).
    if (req.method === 'GET' && path.startsWith('/api/modules/')) {
      const parts = path.slice('/api/modules/'.length).split('/').filter(Boolean);
      const id = decodeURIComponent(parts[0] || '');
      const m = getModule(id);
      if (!m) return sendJson(res, 404, { error: 'unknown_module', detail: id });
      if (parts.length === 1) return sendJson(res, 200, { manifest: m.manifest, pack: m.pack });
      if (parts[1] === 'assets' && parts.length >= 3) return serveModuleAsset(res, id, parts.slice(2).map(decodeURIComponent).join('/'));
      return sendJson(res, 404, { error: 'not_found' });
    }

    // start/reset a session for (user_id, module_id): returns the cold open + fresh state.
    if (req.method === 'GET' && path === '/api/new') {
      const userId = String(q.get('user_id') || q.get('uid') || '').slice(0, 80);
      const moduleId = String(q.get('module_id') || q.get('mid') || '').slice(0, 80) || DEFAULT_MODULE;
      if (!userId) return sendJson(res, 400, { error: 'no_user' });
      const mod = getModule(moduleId);
      if (!mod) return sendJson(res, 400, { error: 'unknown_module', detail: moduleId });
      const st = freshState(mod);
      const sess = newSession(userId, moduleId, st, mod.meta.cold_open.map(t => resolveMacros(t, st.macro_seed)));
      qlog({ kind: 'new_session', ...reqCtx(req, {}), user_id: userId, module_id: moduleId });
      return sendJson(res, 200, { state: sess.state, yuki_messages: mod.meta.cold_open, title: mod.meta.title, module_id: mod.id, seq: sess.seq });
    }

    // pull the shared session — the cross-channel primitive. Any channel opens, reads this, renders.
    if (req.method === 'GET' && path === '/api/session') {
      const userId = String(q.get('user_id') || q.get('uid') || '').slice(0, 80);
      const moduleId = String(q.get('module_id') || q.get('mid') || '').slice(0, 80) || DEFAULT_MODULE;
      if (!userId) return sendJson(res, 400, { error: 'no_user' });
      const sess = loadSession(userId, moduleId);
      if (!sess) return sendJson(res, 200, { exists: false, module_id: moduleId });
      return sendJson(res, 200, {
        exists: true, state: sess.state, transcript: sess.transcript, seq: sess.seq,
        module_id: sess.module_id, title: getModule(moduleId)?.meta.title, updated_at: sess.updated_at,
      });
    }

    // push a session played on an ON-DEVICE engine (the Android app) into the shared store.
    // The store's policy is last-write-wins + seq for collision DETECTION, not prevention:
    // base_seq = the last server seq the pusher saw; a differing stored seq flags was_conflict.
    // force=true is how an intentional overwrite (e.g. an app-side restart) declares itself.
    if (req.method === 'POST' && path === '/api/session/push') {
      const body = await readBody(req);
      const { userId, moduleId } = resolveIds(body);
      if (!userId) return sendJson(res, 400, { error: 'no_user' });
      if (!getModule(moduleId)) return sendJson(res, 400, { error: 'unknown_module', detail: moduleId });
      if (!body.state || typeof body.state !== 'object') return sendJson(res, 400, { error: 'no_state' });
      const transcript = (Array.isArray(body.transcript) ? body.transcript : []).slice(-300).map(m => ({
        who: m?.who === 'user' ? 'user' : 'yuki',
        text: String(m?.text ?? '').slice(0, 600),
      })).filter(m => m.text);
      const existing = loadSession(userId, moduleId);
      const baseSeq = Number(body.base_seq) || 0;
      // Stale non-forced push = another channel wrote since this pusher last looked. REJECT it
      // (409, no write) so an idle channel's nudge can't clobber an active channel's turn — the
      // pusher pulls, adopts, and loses only its own unacked lines. force=true still overwrites
      // (an intentional restart). This is "compare seq to detect a collision", enforced.
      if (existing && existing.seq !== baseSeq && !body.force) {
        qlog({
          kind: 'session_push_stale', ...reqCtx(req, body), user_id: userId, module_id: moduleId,
          base_seq: baseSeq, server_seq: existing.seq,
        });
        return sendJson(res, 409, { error: 'stale', seq: existing.seq });
      }
      const sess = saveSession({
        user_id: userId, module_id: moduleId, state: body.state, transcript,
        seq: existing?.seq || 0, created_at: existing?.created_at || new Date().toISOString(),
      });
      qlog({
        kind: 'session_push', ...reqCtx(req, body), user_id: userId, module_id: moduleId,
        base_seq: baseSeq, force: !!body.force, transcript_len: transcript.length,
      });
      return sendJson(res, 200, { seq: sess.seq });
    }

    if (req.method === 'POST' && path === '/api/turn') {
      const body = await readBody(req);
      const out = await handleTurn(body, reqCtx(req, body));
      return sendJson(res, out.error ? 400 : 200, out);
    }
    if (req.method === 'POST' && path === '/api/nudge') {
      const body = await readBody(req);
      const out = await handleNudge(body, reqCtx(req, body));
      return sendJson(res, out.error ? 400 : 200, out);
    }
    if (req.method === 'POST' && path === '/api/waiver') {
      const body = await readBody(req);
      const ctx = reqCtx(req, body);
      qlog({
        kind: 'waiver_signed', ...ctx,
        user_id: String(body.user_id || '').slice(0, 80),
        name: String(body.name || '').slice(0, 120),
        initials: String(body.initials || '').slice(0, 8),
        signed_at: String(body.signed_at || '').slice(0, 40),
      });
      console.log(`[waiver] signed: ${String(body.name || '').slice(0, 60)}`);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, path);
    res.writeHead(405); res.end();
  } catch (e) {
    console.error(`[err] ${req.method} ${path}: ${e.stack || e}`);
    qlog({ kind: 'error', path, method: req.method, error: String(e.message || e), stack: String(e.stack || '').slice(0, 2000) });
    sendJson(res, 500, { error: 'server_error', detail: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`QMM up on http://127.0.0.1:${PORT}  (model ${MODEL} via ${OLLAMA}; modules: ${Object.keys(MODULES).join(', ')})`);
  // Warm the model so the first player turn isn't a cold load.
  ollamaChat([{ role: 'user', content: 'say ok' }], { temperature: 0, num_predict: 8 })
    .then(r => console.log(`[warmup] model loaded in ${r.ms}ms`))
    .catch(e => console.log(`[warmup] failed: ${e.message}`));
});
