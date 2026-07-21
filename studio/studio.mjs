#!/usr/bin/env node
// QMM authoring studio — a SEPARATE service from the player server (a studio bug must never take
// the player path down). Zero-dependency Node, prefix-agnostic (the gateway strips
// /qmm-author-studio before proxying), same house idioms as server/server.mjs.
//
// Auth model: Cloudflare Access gates the path at the edge; on top, every MUTATING route requires
// header `x-studio-token` == env STUDIO_TOKEN (503 if the env is unset — a studio without a token
// is read-only by construction).
//
// Shares the engine/validator/lore code with the player server via imports; shares the module
// FILES via the same working tree (bind-mounted ~/qmm on prod). Drafts live in modules-draft/,
// which the player server never reads.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NUM_CTX, OLLAMA, MODEL, buildModule,
  buildRoutePrompt, buildGeneratePrompt, buildChatPrompt,
  routeMessage, generateBubbles, chatAsYuki,
  freshState, sanitizeTail, runTurn, runNudge,
} from '../server/engine.mjs';
import { scanLore, resolveMacros, applyRails } from '../server/lore.mjs';
import { validateModule } from '../server/validate.mjs';
import { DraftStore } from './lib/draft-store.mjs';
import * as scratchSessions from './lib/scratch-sessions.mjs';
import { Publisher } from './lib/publish.mjs';
import { convertLorebook } from '../server/lorebook-import.mjs';
import { digest } from './lib/signals.mjs';
import { toCharacterCard, toWorldInfo, stripTemplateEntries } from './lib/st-bridge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const STUDIO_PUBLIC = join(here, 'public');
// The player web client moved to its own channel program (qmm-web). The playtest pane borrows
// its stylesheet/renderer, so find it: env override, sibling checkout, or the legacy in-repo path.
const PLAYER_PUBLIC = [process.env.PLAYER_WEB_DIR, join(ROOT, '..', 'qmm-web', 'public'), join(ROOT, 'public')]
  .filter(Boolean).find(p => existsSync(p)) || join(ROOT, 'public');
const MODULES_DIR = join(ROOT, 'modules');
const DRAFTS_DIR = join(ROOT, 'modules-draft');
const SCAFFOLD_DIR = join(here, 'scaffold');

const PORT = parseInt(process.env.PORT || '8792', 10);
const PLAYER_URL = (process.env.PLAYER_URL || 'http://127.0.0.1:8791').replace(/\/$/, '');
const STUDIO_TOKEN = process.env.STUDIO_TOKEN || '';
// STUDIO_GATE_READS=1: EVERY /api/* call requires the token, reads included — drafts and signals
// are story content and operator data. Set in prod so the public route is safe even before (or
// without) a Cloudflare Access policy. Static UI files stay public: generic code, no content.
const GATE_READS = process.env.STUDIO_GATE_READS === '1';

const store = new DraftStore({ modulesDir: MODULES_DIR, draftsDir: DRAFTS_DIR, scaffoldDir: SCAFFOLD_DIR });
const publisher = new Publisher({
  store,
  versionsDir: join(ROOT, 'modules-versions'),
  playerUrl: PLAYER_URL,
  reloadToken: process.env.RELOAD_TOKEN || '',
  log: (e) => slog(e),
});

// Studio activity log — separate file from the player's flight log.
const LOG_DIR = join(ROOT, 'logs');
mkdirSync(LOG_DIR, { recursive: true });
function slog(entry) {
  try {
    appendFileSync(join(LOG_DIR, 'studio.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) { console.error(`[slog] ${e.message}`); }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
}

function serveFrom(base, res, rel) {
  let p = rel === '/' || rel === '' ? '/index.html' : rel;
  p = normalize(p).replace(/^([.\\/])+/, '');
  const file = join(base, p);
  if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
  }
  const body = readFileSync(file);
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 4 * 1024 * 1024) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}

/** Mutation gate: true = allowed to proceed; otherwise the response has been sent. */
function requireToken(req, res) {
  if (!STUDIO_TOKEN) { sendJson(res, 503, { error: 'studio_readonly', detail: 'STUDIO_TOKEN not set' }); return false; }
  if (req.headers['x-studio-token'] !== STUDIO_TOKEN) { sendJson(res, 403, { error: 'forbidden' }); return false; }
  return true;
}

function storeError(res, e) {
  const map = { bad_id: 400, bad_doc: 400, not_found: 404, exists: 409, conflict: 409 };
  const code = map[e.code] || 500;
  return sendJson(res, code, { error: e.code || 'error', detail: e.message, ...(e.code === 'conflict' ? { rev: e.rev } : {}) });
}

/** Load a target ('draft'|'live') as {manifest, mergedPack} for validation. */
function loadForValidation(id, target) {
  const docs = target === 'live' ? store.loadLive(id) : store.loadDraft(id);
  if (!docs) return null;
  return { manifest: docs.manifest, pack: DraftStore.mergedPack(docs) };
}

/**
 * The engine-ready module the studio tests against: the DRAFT when one exists, else live.
 * Built per request — the files just changed under the author's hands, staleness is the enemy.
 */
function draftModule(id) {
  const docs = store.loadDraft(id) || store.loadLive(id);
  if (!docs || !docs.manifest || !docs.pack) return null;
  try { return buildModule(docs.manifest, DraftStore.mergedPack(docs)); } catch { return null; }
}

// The engine's view of the studio: draft-preferred registry + scratch sessions + the studio log.
const studioDeps = {
  getModule: (id) => id ? draftModule(id) : null,
  get defaultModule() { return store.list()[0]?.id || null; },
  sessions: scratchSessions,
  qlog: slog,
};

/** Shared setup for the dry-run test endpoints. Clones state so a probe never mutates the caller's. */
function benchContext(body) {
  const id = String(body.module_id || '') || studioDeps.defaultModule;
  const mod = draftModule(id);
  if (!mod) return { error: { code: 404, body: { error: 'unknown_module', detail: id } } };
  const state = { ...freshState(mod), ...(body.state && typeof body.state === 'object' ? JSON.parse(JSON.stringify(body.state)) : {}) };
  const familyFrom = String(body.family_from || state.current_state || mod.firstFrom);
  const family = mod.familyByFrom[familyFrom];
  if (!family) return { error: { code: 404, body: { error: 'unknown_family', detail: familyFrom } } };
  state.current_state = familyFrom;
  const message = String(body.message ?? '').slice(0, 1000);
  const given = Array.isArray(body.tail) ? body.tail : [];
  const transcript = [...given.map(m => ({ who: m?.who === 'user' ? 'user' : 'yuki', text: String(m?.text ?? '').slice(0, 600) })).filter(m => m.text)];
  if (message && transcript[transcript.length - 1]?.text !== message) transcript.push({ who: 'user', text: message });
  return { mod, family, state, message, transcript, tail: sanitizeTail(transcript) };
}

async function health() {
  const out = { ok: true, service: 'qmm-author-studio', num_ctx: NUM_CTX, model: MODEL, player: { url: PLAYER_URL, reachable: false }, ollama: { url: OLLAMA, reachable: false }, token_configured: !!STUDIO_TOKEN };
  try {
    const r = await (await fetch(`${PLAYER_URL}/api/health`, { signal: AbortSignal.timeout(4000) })).json();
    out.player.reachable = true;
    out.player.num_ctx = r.num_ctx;
    out.player.modules = r.modules;
    if (r.num_ctx !== undefined && r.num_ctx !== NUM_CTX) {
      out.player.num_ctx_skew = true; // fill-preview budgets would differ from live behavior
    }
  } catch { /* unreachable is a state, not an error */ }
  try {
    await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) });
    out.ollama.reachable = true;
  } catch { /* ditto */ }
  return out;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (GATE_READS && path.startsWith('/api/') && !requireToken(req, res)) return;
    if (req.method === 'GET' && path === '/api/health') return sendJson(res, 200, await health());

    // ------------------------------------------------------------ modules ----
    if (path === '/api/studio/modules') {
      if (req.method === 'GET') return sendJson(res, 200, { modules: store.list() });
      if (req.method === 'POST') {
        if (!requireToken(req, res)) return;
        const body = await readBody(req);
        const id = String(body.id || '').trim();
        try {
          const draft = store.create(id, { from: body.scaffold ? String(body.scaffold) : 'live', title: body.title, story_id: body.story_id });
          slog({ kind: 'draft_create', id, from: body.scaffold || 'live' });
          return sendJson(res, 200, { id, revs: draft.revs });
        } catch (e) { return storeError(res, e); }
      }
    }

    // ------------------------------------------------------- draft CRUD ----
    let m;
    if ((m = /^\/api\/studio\/draft\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1]);
      if (req.method === 'GET') {
        try {
          const draft = store.loadDraft(id);
          if (!draft) return sendJson(res, 404, { error: 'not_found' });
          return sendJson(res, 200, draft);
        } catch (e) { return storeError(res, e); }
      }
      if (req.method === 'DELETE') {
        if (!requireToken(req, res)) return;
        try { store.trash(id); slog({ kind: 'draft_trash', id }); return sendJson(res, 200, { ok: true }); }
        catch (e) { return storeError(res, e); }
      }
    }
    if ((m = /^\/api\/studio\/draft\/([^/]+)\/(manifest|pack|lore)$/.exec(path)) && req.method === 'PUT') {
      if (!requireToken(req, res)) return;
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      try {
        const { rev } = store.saveDoc(id, m[2], body.doc, body.base_rev ?? null);
        slog({ kind: 'draft_save', id, doc: m[2], rev });
        return sendJson(res, 200, { rev });
      } catch (e) { return storeError(res, e); }
    }
    if ((m = /^\/api\/studio\/draft\/([^/]+)\/revert$/.exec(path)) && req.method === 'POST') {
      if (!requireToken(req, res)) return;
      const id = decodeURIComponent(m[1]);
      try { const draft = store.revert(id); slog({ kind: 'draft_revert', id }); return sendJson(res, 200, { revs: draft.revs }); }
      catch (e) { return storeError(res, e); }
    }

    // ------------------------------------------------------- live + diff ----
    if ((m = /^\/api\/studio\/live\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      try {
        const live = store.loadLive(id);
        if (!live) return sendJson(res, 404, { error: 'not_found' });
        return sendJson(res, 200, live);
      } catch (e) { return storeError(res, e); }
    }
    if ((m = /^\/api\/studio\/diff\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      try { return sendJson(res, 200, store.diff(id)); }
      catch (e) { return storeError(res, e); }
    }

    // ---------------------------------------------------------- validate ----
    if ((m = /^\/api\/studio\/validate\/([^/]+)$/.exec(path)) && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      const target = body.target === 'live' ? 'live' : 'draft';
      try {
        const docs = loadForValidation(id, target);
        if (!docs) return sendJson(res, 404, { error: 'not_found', detail: `${target} ${id}` });
        const liveDocs = target === 'draft' ? loadForValidation(id, 'live') : null;
        const result = validateModule({
          manifest: docs.manifest, pack: docs.pack, dirName: id,
          liveModule: liveDocs ? { pack: liveDocs.pack } : undefined,
        });
        return sendJson(res, 200, result);
      } catch (e) { return storeError(res, e); }
    }

    // -------------------------------------------------------- test bench ----
    // Dry runs against the DRAFT (fallback live). Model calls hit the same OLLAMA the player
    // uses; nothing here reads or writes player sessions. Each response carries the exact
    // prompt strings sent to the model — the inspector view.
    if (req.method === 'POST' && path === '/api/studio/test/route') {
      const body = await readBody(req);
      const c = benchContext(body);
      if (c.error) return sendJson(res, c.error.code, c.error.body);
      const exchanges = Number(body.exchanges) || 0;
      const latencyS = Number(body.latency_s) || 0;
      const prompt = buildRoutePrompt(c.mod, c.family, c.message, c.tail, exchanges, latencyS);
      const r = await routeMessage(c.mod, c.message, c.family, c.tail, exchanges, latencyS, slog);
      return sendJson(res, 200, { action: r.action, intent: r.intent, ms: r.ms, fallback: !!r.fallback, thinking: r.thinking || '', prompt: { sys: prompt.sys, usr: prompt.usr } });
    }
    if (req.method === 'POST' && path === '/api/studio/test/fill') {
      const body = await readBody(req);
      const c = benchContext(body);
      if (c.error) return sendJson(res, c.error.code, c.error.body);
      const intent = String(body.intent || 'OTHER');
      const tpl = c.family.templates[intent];
      if (!tpl) return sendJson(res, 404, { error: 'unknown_intent', detail: intent });
      const trace = [];
      const lore = scanLore(c.mod.pack, c.transcript, c.state, NUM_CTX, trace);
      const prompt = buildGeneratePrompt(c.mod, c.family, tpl, c.state, c.message, c.tail, lore.block);
      const gen = await generateBubbles(c.mod, c.family, tpl, c.state, c.message, c.tail, lore.block, slog);
      const railed = applyRails(c.mod.pack, gen.bubbles);
      return sendJson(res, 200, {
        bubbles: railed.bubbles, rails_applied: railed.applied, fallback: !!gen.fallback, ms: gen.ms,
        thinking: gen.thinking || '', lore: { fired: lore.fired, block: lore.block, trace },
        prompt: { sys: prompt.sys, usr: prompt.usr },
      });
    }
    if (req.method === 'POST' && path === '/api/studio/test/chat') {
      const body = await readBody(req);
      const c = benchContext(body);
      if (c.error) return sendJson(res, c.error.code, c.error.body);
      const nudgeS = body.nudge_s ? Number(body.nudge_s) : null;
      const trace = [];
      const lore = scanLore(c.mod.pack, c.transcript, c.state, NUM_CTX, trace);
      const prompt = buildChatPrompt(c.mod, c.family, c.state, c.message, c.tail, nudgeS, lore.block);
      const chat = await chatAsYuki(c.mod, c.family, c.state, c.message, c.tail, nudgeS, lore.block, slog);
      const railed = applyRails(c.mod.pack, chat.bubbles);
      return sendJson(res, 200, {
        bubbles: railed.bubbles, rails_applied: railed.applied, fallback: !!chat.fallback, ms: chat.ms,
        thinking: chat.thinking || '', lore: { fired: lore.fired, block: lore.block, trace },
        prompt: { sys: prompt.sys, usr: prompt.usr },
      });
    }
    if (req.method === 'POST' && path === '/api/studio/test/lore-scan') {
      const body = await readBody(req);
      const c = benchContext(body);
      if (c.error) return sendJson(res, c.error.code, c.error.body);
      const trace = [];
      const lore = scanLore(c.mod.pack, c.transcript, c.state, NUM_CTX, trace);
      return sendJson(res, 200, { fired: lore.fired, block: lore.block, budget_chars: lore.budget_chars, trace, state_after: { turn: c.state.turn, lore_fx: c.state.lore_fx } });
    }

    // ---------------------------------------------------------- playtest ----
    // Full engine loop on DRAFT modules with scratch sessions. Never the player's sessions/.
    if (req.method === 'POST' && path === '/api/studio/play/new') {
      if (!requireToken(req, res)) return;
      const body = await readBody(req);
      const id = String(body.module_id || '') || studioDeps.defaultModule;
      const mod = draftModule(id);
      if (!mod) return sendJson(res, 404, { error: 'unknown_module', detail: id });
      const playId = `studio-${Date.now()}`;
      const st = freshState(mod);
      const cold = mod.meta.cold_open.map(t => resolveMacros(t, st.macro_seed));
      const sess = scratchSessions.newSession(playId, id, st, cold);
      slog({ kind: 'play_new', play_id: playId, module_id: id });
      return sendJson(res, 200, { play_id: playId, module_id: id, yuki_messages: cold, state: sess.state, seq: sess.seq });
    }
    if (req.method === 'POST' && path === '/api/studio/play/turn') {
      if (!requireToken(req, res)) return;
      const body = await readBody(req);
      const out = await runTurn(studioDeps, { user_id: body.play_id, module_id: body.module_id, user_message: body.message, channel: 'studio' }, { sid: 'studio', channel: 'studio', ip: 'studio', ua: 'studio' });
      return sendJson(res, out.error ? 400 : 200, out);
    }
    if (req.method === 'POST' && path === '/api/studio/play/nudge') {
      if (!requireToken(req, res)) return;
      const body = await readBody(req);
      const out = await runNudge(studioDeps, { user_id: body.play_id, module_id: body.module_id, quiet_s: body.quiet_s, channel: 'studio' }, { sid: 'studio', channel: 'studio', ip: 'studio', ua: 'studio' });
      return sendJson(res, out.error ? 400 : 200, out);
    }
    if (req.method === 'GET' && path === '/api/studio/play') {
      return sendJson(res, 200, { runs: scratchSessions.listSessions() });
    }
    if ((m = /^\/api\/studio\/play\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const playId = decodeURIComponent(m[1]);
      const moduleId = url.searchParams.get('module_id') || studioDeps.defaultModule;
      const sess = scratchSessions.loadSession(playId, moduleId);
      if (!sess) return sendJson(res, 404, { error: 'not_found' });
      return sendJson(res, 200, sess);
    }

    // ------------------------------------------------------------ signals ----
    // Aggregates ONLY — the flight log holds raw player text; none of it crosses this endpoint.
    if (req.method === 'GET' && path === '/api/studio/signals') {
      const days = Math.min(60, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10) || 7));
      const moduleId = url.searchParams.get('module_id') || undefined;
      return sendJson(res, 200, digest(LOG_DIR, { days, moduleId }));
    }

    // ------------------------------------------------- SillyTavern bridge ----
    // Export the module into the ST workbench: the protagonist as a Chara Card V2, and
    // lore (+ optionally the beat templates as rehearsal context) as a World Info book.
    if ((m = /^\/api\/studio\/st\/(card|lorebook)\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const id = decodeURIComponent(m[2]);
      const mod = draftModule(id);
      if (!mod) return sendJson(res, 404, { error: 'unknown_module', detail: id });
      if (m[1] === 'card') return sendJson(res, 200, toCharacterCard(mod));
      return sendJson(res, 200, toWorldInfo(mod, { includeTemplates: url.searchParams.get('templates') === '1' }));
    }

    // ------------------------------------------------- ST lorebook import ----
    if ((m = /^\/api\/studio\/import-lorebook\/([^/]+)$/.exec(path)) && req.method === 'POST') {
      if (!requireToken(req, res)) return;
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      try {
        const draft = store.loadDraft(id);
        if (!draft) return sendJson(res, 404, { error: 'not_found', detail: `draft ${id}` });
        // one-way template entries exported by the bridge must never re-import as lore
        const { book, stripped } = stripTemplateEntries(body.st_book);
        const { doc, imported, warnings } = convertLorebook(book, { existingDoc: draft.lore, merge: !!body.merge });
        if (stripped) warnings.push(`${stripped} [qmm-template] rehearsal entr${stripped === 1 ? 'y' : 'ies'} skipped (one-way export, not lore)`);
        const { rev } = store.saveDoc(id, 'lore', doc, body.base_rev ?? draft.revs.lore);
        slog({ kind: 'lorebook_import', id, imported, merge: !!body.merge });
        return sendJson(res, 200, { imported, warnings, rev });
      } catch (e) { return storeError(res, e); }
    }

    // ------------------------------------------------------------ publish ----
    if ((m = /^\/api\/studio\/publish\/([^/]+)$/.exec(path)) && req.method === 'POST') {
      if (!requireToken(req, res)) return;
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      try {
        const r = await publisher.publish(id, {
          bump: ['patch', 'minor', 'major'].includes(body.bump) ? body.bump : 'patch',
          note: String(body.note || '').slice(0, 400),
          acceptWarnings: !!body.accept_warnings,
        });
        return sendJson(res, r.status === 'blocked' ? 422 : 200, r);
      } catch (e) { return storeError(res, e); }
    }
    if ((m = /^\/api\/studio\/rollback\/([^/]+)$/.exec(path)) && req.method === 'POST') {
      if (!requireToken(req, res)) return;
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      try { return sendJson(res, 200, await publisher.rollback(id, String(body.version || ''))); }
      catch (e) { return storeError(res, e); }
    }
    if ((m = /^\/api\/studio\/versions\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      try { return sendJson(res, 200, { versions: publisher.listVersions(id) }); }
      catch (e) { return storeError(res, e); }
    }
    if (req.method === 'POST' && path === '/api/studio/reload-player') {
      if (!requireToken(req, res)) return;
      return sendJson(res, 200, await publisher.reloadPlayer());
    }

    // ------------------------------------------------------------ static ----
    if (req.method === 'GET' && path.startsWith('/player-assets/')) {
      return serveFrom(PLAYER_PUBLIC, res, path.slice('/player-assets'.length));
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveFrom(STUDIO_PUBLIC, res, path);
    res.writeHead(405); res.end();
  } catch (e) {
    console.error(`[err] ${req.method} ${path}: ${e.stack || e}`);
    slog({ kind: 'error', path, method: req.method, error: String(e.message || e) });
    sendJson(res, 500, { error: 'server_error', detail: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`QMM author studio on http://127.0.0.1:${PORT}  (player: ${PLAYER_URL}; drafts: ${DRAFTS_DIR}; token: ${STUDIO_TOKEN ? 'set' : 'NOT SET — read-only'})`);
});
