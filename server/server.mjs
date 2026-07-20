#!/usr/bin/env node
// QMM demo server — zero-dependency Node. Serves the phone UI + /api/turn.
// Each turn: (1) gemma4:e4b classifies the player's text into one of 8 intents,
// (2) the matching template is populated by the same model into Yuki's bubbles,
// (3) state updates from the story pack are applied mechanically.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACK = JSON.parse(readFileSync(join(here, 'story-pack.json'), 'utf8'));
const PUBLIC = join(here, '..', 'public');

const PORT = parseInt(process.env.PORT || '8791', 10);
const OLLAMA = process.env.OLLAMA || 'http://127.0.0.1:11434';
const MODEL = process.env.MODEL || 'gemma4:e4b';
const KEEP_ALIVE = '60m';

const INTENTS = Object.keys(PACK.meta.intents);
const FAMILY_BY_FROM = Object.fromEntries(PACK.families.map(f => [f.from, f]));

// ------------------------------------------------------------ flight log ----
// Everything a session does lands in logs/qmm-YYYY-MM-DD.jsonl for post-hoc debugging:
// verbatim player messages, router decisions incl. model thinking, bubbles, state, errors.
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
      options: { temperature, num_ctx: 32768, num_predict, top_p: 0.95 },
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
async function routeMessage(userMessage, family, tail, exchanges, latencyS) {
  const defs = INTENTS.map(i => `- ${i}: ${PACK.meta.intents[i]}`).join('\n');
  const recentYuki = tail.filter(m => m.who === 'yuki').slice(-6).map(m => `  ${m.text.replace(/\n/g, ' / ')}`).join('\n');
  const sys = 'You are the pacing director for a text-message mystery game. The player texts advice to Yuki, the protagonist. Decide whether the newest player message should ADVANCE the story to its next beat, or whether Yuki should just CHAT back inside the current scene. Output JSON only.';
  const usr = `Intent categories (always pick the best fit for the newest message; used when advancing):
${defs}

Story beat: ${family.from} (beat ${family.n} of 6)${family.n === 6 ? " — FINAL BEAT: any actionable instruction is the player's ending choice, prefer advance" : ''}.
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
      intent: { type: 'string', enum: INTENTS },
    },
    required: ['action', 'intent'],
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { content, thinking, ms } = await ollamaChat(
      [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      { format, temperature: 0 },
    );
    const parsed = parseJsonLoose(content);
    if (parsed && ['chat', 'advance'].includes(parsed.action) && INTENTS.includes(parsed.intent)) {
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

async function generateBubbles(family, tpl, state, userMessage, tail) {
  const [minB, maxB] = family.bubbles;
  const rules = family.shared_rules.map(r => `- ${r}`).join('\n');
  const ctx = family.available_context.map(c => `- ${c}`).join('\n');
  const ending = family.n === 6;
  const fillLines = [...tpl.fill_guidance];
  if (ending) {
    fillLines.push(`player_moment: the player's final message was ${JSON.stringify(userMessage.slice(0, 220))} — write 2-3 bubbles where Yuki says or does exactly that (quote or closely paraphrase the player's key words) and Ura visibly reacts to that SPECIFIC thing in his own voice. This replaces any generic confrontation lines.`);
  }
  const fill = fillLines.map(g => `- ${g}`).join('\n');
  const convo = tail.slice(-16).map(m => `${m.who === 'user' ? 'player' : 'yuki'}: ${m.text.replace(/\n/g, ' / ')}`).join('\n');

  const sys = `You write Yuki's next text messages in "Quantum Murder Mysteries", an interactive horror mystery told entirely as a text-message conversation. The player texts advice to Yuki; you reply as Yuki only.

Voice: immediate, scared, intimate. Short bubbles, like real texting. lowercase where natural. Never narrate, never summarize the plot, never mention templates, intents, or the game. Yuki writes like this:
${PACK.meta.voice_example}

How Yuki opens and how she feels is yours to vary — keep the template's EVENTS, not its mood or its opening words:
- Do not reflexively open by agreeing with or thanking the player ("okay", "good call", "yeah you're right", "like you said"). Sometimes she just acts; sometimes fear, anger, or a blank kind of calm comes first. Acknowledge the player only when it is natural, and not the same way each time.
- Let her emotional register shift from turn to turn: scared, yes, but also sometimes angry, cold and clipped, numb, over-talkative, or darkly joking to hold herself together. Do not recycle the same fear images ("hands shaking", "barely breathing").
- Make clues feel stumbled into, not handed over. Prefer something sensory and wrong over an object conveniently labeled with the plot; do not have props spell out names or instructions unless the scene truly calls for it.

Rules for this story beat:
${rules}

Your reply MUST land the same story beat as the base template: whatever clue, discovery, or reveal the template's final lines deliver, your final bubbles must deliver it too. Never stop before the clue lands.

Never output {{placeholder}} braces or snake_case_labels — always write the actual concrete detail in Yuki's own words.

Output JSON only: {"yuki_messages": [ ... ]} with ${minB} to ${maxB} strings. Each string is one text bubble; a bubble may contain a line break for a beat pause. Most bubbles stay under 140 characters.`;

  const usr = `STORY CONTEXT:
${ctx}

CURRENT STATE:
${stateForPrompt(family, state) || '- (start of story)'}

CONVERSATION SO FAR:
${convo}

PLAYER'S LATEST MESSAGE (advice to Yuki — let her wording react to it):
${JSON.stringify(userMessage)}

BASE TEMPLATE for this reply (keep its story beats, clue, and reveal exactly; fill any {{placeholders}}; adapt the wording so it flows from the player's message):
${ending ? `{{player_moment}}\n\n${tpl.template}` : tpl.template}

FILL GUIDANCE:
${fill}

IMPORTANT: keep ALL of the template's concrete events, in order, ending on the same
discovery/reveal its final lines deliver — rewrite the wording, never drop the content.
${family.n === 6 ? `
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
async function chatAsYuki(family, state, userMessage, tail, nudgeS) {
  const donts = family.shared_rules.filter(r => /^do not/i.test(r)).map(r => `- ${r}`).join('\n');
  const ctx = family.available_context.map(c => `- ${c}`).join('\n');
  const examples = INTENTS.map(i => `--- (if the story advanced via ${i}) ---\n${family.templates[i].template}`).join('\n\n');
  const convo = tail.slice(-16).map(m => `${m.who === 'user' ? 'player' : 'yuki'}: ${m.text.replace(/\n/g, ' / ')}`).join('\n');

  const sys = `You are Yuki in "Quantum Murder Mysteries", an interactive horror mystery told entirely as a text-message conversation. The player is Yuki's friend, texting with her in real time.

Voice: immediate, scared, intimate. Short bubbles, like real texting. lowercase where natural. Never narrate, never summarize the plot, never mention the game. Yuki writes like this:
${PACK.meta.voice_example}

Don't reflexively open by agreeing with or thanking the player, and don't answer the same way each time — her mood can shift: scared, but also sometimes angry, clipped, numb, or darkly joking to hold herself together. Don't recycle the same fear images ("hands shaking", "barely breathing").

RIGHT NOW you are between story beats: just chat. React, feel, describe what you can currently see or hear, answer the player, wonder, ask what to do. Stay physically where you are. Do NOT make new discoveries, do NOT move somewhere new, and do NOT deliver anything from the UPCOMING BEAT EXAMPLES — those things have not happened yet and only happen when the story advances.
${donts}

Reply with ONE short text message. Send two only if you are completing a thought. Output JSON only: {"yuki_messages": [ ... ]} with 1 or 2 strings.`;

  const usr = `CURRENT SITUATION:
${ctx}

CURRENT STATE:
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

function freshState() {
  return { current_state: 'S00_Cold_Open', danger_level: 0, evidence_found: 0, beat: 0, exchanges_in_beat: 0 };
}

// ------------------------------------------------------------------- turns --
function sanitizeTail(tail) {
  if (!Array.isArray(tail)) return [];
  return tail.slice(-24).map(m => ({
    who: m?.who === 'user' ? 'user' : 'yuki',
    text: String(m?.text ?? '').slice(0, 600),
  })).filter(m => m.text);
}

const MAX_CHAT_PER_BEAT = 4; // hard cap: the next message after this many chats must advance

async function handleTurn(body, ctx) {
  const state = (body.state && typeof body.state === 'object') ? body.state : freshState();
  const userMessage = String(body.user_message ?? '').trim().slice(0, 1000);
  const tail = sanitizeTail(body.transcript_tail);
  if (!userMessage) return { error: 'empty_message' };
  // THE WORD: bare "stop" as its own message ends everything, before the model
  // ever sees it. The fiction gets no say in this.
  if (/^stop[\s.!?…]*$/i.test(userMessage)) {
    qlog({ kind: 'stop_word', ...ctx, current_state: state.current_state, user_message: userMessage });
    console.log(`[STOP] sid=${ctx.sid} at ${state.current_state}`);
    return { mode: 'stopped' };
  }

  const family = FAMILY_BY_FROM[state.current_state];
  if (!family) {
    qlog({ kind: 'turn_rejected', ...ctx, reason: 'story_over', current_state: state.current_state, user_message: userMessage });
    return { error: 'story_over', detail: `no transitions from ${state.current_state}` };
  }

  const exchanges = state.exchanges_in_beat || 0;
  const latencyS = Math.round(Math.max(0, Math.min(3600, Number(body.reply_latency_s) || 0)));
  const route = await routeMessage(userMessage, family, tail, exchanges, latencyS);
  const forced = route.action !== 'advance' && exchanges >= MAX_CHAT_PER_BEAT;
  const base = {
    ...ctx, from_state: family.from, beat: family.n, exchanges_before: exchanges,
    reply_latency_s: latencyS, user_message: userMessage,
    route: { action: route.action, intent: route.intent, ms: route.ms, fallback: !!route.fallback, thinking: route.thinking || '' },
    forced,
  };

  if (route.action !== 'advance' && !forced) {
    const chat = await chatAsYuki(family, state, userMessage, tail, null);
    const newState = { ...state, exchanges_in_beat: exchanges + 1 };
    console.log(`[turn] ${family.from} CHAT ${exchanges + 1}/${MAX_CHAT_PER_BEAT} route=${route.ms}ms gen=${chat.ms}ms bubbles=${chat.bubbles.length}${route.fallback || chat.fallback ? ' FALLBACK' : ''}`);
    qlog({ kind: 'turn', mode: 'chat', ...base, bubbles: chat.bubbles, gen_ms: chat.ms, gen_fallback: !!chat.fallback, gen_thinking: chat.thinking || '', state_after: newState });
    return {
      mode: 'chat', yuki_messages: chat.bubbles, state: newState,
      meta: { mode: 'chat', intent: route.intent, exchanges_in_beat: newState.exchanges_in_beat, route_ms: route.ms, generate_ms: chat.ms, route_fallback: !!route.fallback, generate_fallback: !!chat.fallback },
    };
  }

  const tpl = family.templates[route.intent];
  const gen = await generateBubbles(family, tpl, state, userMessage, tail);
  const newState = applyUpdates(tpl, state);
  newState.beat = family.n;
  newState.exchanges_in_beat = 0;

  const out = {
    mode: 'advance',
    yuki_messages: gen.bubbles,
    state: newState,
    meta: {
      mode: 'advance', forced, intent: route.intent, template_id: tpl.id, from: family.from, to: family.to,
      route_ms: route.ms, generate_ms: gen.ms,
      route_fallback: !!route.fallback, generate_fallback: !!gen.fallback,
    },
  };
  if (family.n === 6) {
    out.ending = {
      route: newState.ending_route, type: newState.ending_type,
      kenji_rescued: newState.kenji_rescued ?? false,
      yuki_status: newState.yuki_status ?? 'unknown',
      ura_status: newState.ura_status ?? 'unknown',
      evidence_status: newState.evidence_status ?? 'uncertain',
    };
  }
  console.log(`[turn] ${family.from} --${route.intent}--> ${family.to} tpl=${tpl.id}${forced ? ' (forced advance)' : ''} route=${route.ms}ms gen=${gen.ms}ms bubbles=${gen.bubbles.length}${route.fallback || gen.fallback ? ' FALLBACK' : ''}`);
  qlog({ kind: 'turn', mode: 'advance', ...base, template_id: tpl.id, bubbles: gen.bubbles, gen_ms: gen.ms, gen_fallback: !!gen.fallback, gen_thinking: gen.thinking || '', state_after: newState, ending: out.ending || null });
  return out;
}

async function handleNudge(body, ctx) {
  const state = (body.state && typeof body.state === 'object') ? body.state : null;
  if (!state) return { error: 'no_state' };
  const family = FAMILY_BY_FROM[state.current_state];
  if (!family) return { error: 'story_over' };
  const tail = sanitizeTail(body.transcript_tail);
  const quietS = Math.round(Math.max(10, Math.min(600, Number(body.quiet_s) || 30)));
  const chat = await chatAsYuki(family, state, '', tail, quietS);
  console.log(`[nudge] ${family.from} quiet=${quietS}s gen=${chat.ms}ms${chat.fallback ? ' FALLBACK' : ''}`);
  qlog({ kind: 'nudge', ...ctx, from_state: family.from, quiet_s: quietS, bubbles: chat.bubbles, gen_ms: chat.ms, gen_fallback: !!chat.fallback, gen_thinking: chat.thinking || '' });
  return { mode: 'nudge', yuki_messages: chat.bubbles, meta: { mode: 'nudge', generate_ms: chat.ms } };
}

async function health() {
  const out = { ok: false, model: MODEL, ollama: OLLAMA, model_present: false, model_loaded: false };
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
    ip: fwd || req.socket.remoteAddress || 'unknown',
    ua: String(req.headers['user-agent'] || '').slice(0, 160),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/api/health') return sendJson(res, 200, await health());
    if (req.method === 'GET' && path === '/api/new') {
      const ctx = reqCtx(req, { session_id: url.searchParams.get('sid') });
      qlog({ kind: 'new_session', ...ctx });
      return sendJson(res, 200, { state: freshState(), yuki_messages: PACK.meta.cold_open, title: PACK.meta.title });
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
  console.log(`QMM demo up on http://127.0.0.1:${PORT}  (model ${MODEL} via ${OLLAMA})`);
  // Warm the model so the first player turn isn't a cold load.
  ollamaChat([{ role: 'user', content: 'say ok' }], { temperature: 0, num_predict: 8 })
    .then(r => console.log(`[warmup] model loaded in ${r.ms}ms`))
    .catch(e => console.log(`[warmup] failed: ${e.message}`));
});
