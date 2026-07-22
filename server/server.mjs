#!/usr/bin/env node
// QMM backend — zero-dependency Node. The channel-agnostic story API (no UI, no channel code).
// Stories are pluggable MODULES (modules/<id>/{manifest,pack}.json). State is SERVER-OWNED:
// a session = (user_id, module_id) held in server/sessions.mjs, shared across every channel
// (web, app, Telegram) so one logged-in user keeps a consistent story wherever they play.
//
// The turn loop itself lives in server/engine.mjs (shared with the authoring studio); this file
// is the HTTP shell: module registry (+ hot reload), sessions wiring, flight log. Channels
// (qmm-web, qmm-android, qmm-telegram) are SEPARATE programs that talk to this API — never mixed in.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadSession, saveSession, newSession, getOrCreate, clearSession } from './sessions.mjs';
import { resolveMacros } from './lore.mjs';
import { OLLAMA, MODEL, NUM_CTX, loadModules, ollamaChat, freshState, runTurn, runNudge } from './engine.mjs';
import { registerStory, releaseStory, activateStory, loadStory, stopStory, checkpointStory, listStories } from './stories.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = join(here, '..', 'modules');

const PORT = parseInt(process.env.PORT || '8791', 10);

// ------------------------------------------------------------ module registry ----
let REGISTRY = loadModules(MODULES_DIR);
if (!Object.keys(REGISTRY.modules).length) { console.error('[module] no modules loaded — check modules/'); process.exit(1); }
let DEFAULT_MODULE = Object.keys(REGISTRY.modules)[0];
const getModule = (id) => (id ? REGISTRY.modules[id] || null : REGISTRY.modules[DEFAULT_MODULE]);

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

// The engine's view of this process: live registry + the real player session store.
const playerDeps = {
  getModule,
  get defaultModule() { return DEFAULT_MODULE; },
  sessions: { loadSession, saveSession, newSession, getOrCreate, clearSession },
  qlog,
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Full-transcript sanitizer for app pushes (bounded; saveSession caps to MAX_TRANSCRIPT).
function sanitizeTranscript(t) {
  if (!Array.isArray(t)) return [];
  return t.slice(-400).map(m => ({
    who: m?.who === 'user' ? 'user' : 'yuki',
    text: String(m?.text ?? '').slice(0, 600),
  })).filter(m => m.text);
}

// NOTE deliberately NO per-key state whitelist on pushes: v0.2 engine state is NESTED
// (lore_fx = {last, stickyUntil, cooldownUntil, groupCanon}) and a flat whitelist silently
// strips it, killing equivoque canon + timed-effect clocks across channels (ENGINE_CONTRACT
// v0.2). Bounding = the 256KB body cap + MAX_TRANSCRIPT in sessions.mjs.

// Resolve (user_id, module_id) from a request body. module defaults to the only/first module.
function resolveIds(body) {
  const userId = String(body.user_id || '').slice(0, 80);
  const moduleId = String(body.module_id || '').slice(0, 80) || DEFAULT_MODULE;
  return { userId, moduleId };
}

async function health() {
  const out = { ok: false, model: MODEL, ollama: OLLAMA, num_ctx: NUM_CTX, model_present: false, model_loaded: false, modules: Object.keys(REGISTRY.modules) };
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

// Inventory a module's asset files (relative forward-slash paths) so a downloader can know
// what to fetch — the bundle and export both carry this list.
function listModuleAssets(id) {
  const base = join(MODULES_DIR, id, 'assets');
  if (!existsSync(base)) return [];
  const out = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, r);
      else out.push(r);
    }
  };
  walk(base, '');
  return out;
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
      return sendJson(res, 200, { modules: Object.values(REGISTRY.modules).filter(m => m.manifest.publish !== false).map(m => m.manifest), default: DEFAULT_MODULE });
    }
    // download a module — how the on-device app (or any client) fetches an episode:
    //   /api/modules/<id>            bundle {manifest, pack (lore merged in), assets:[paths]} — for RUNNING
    //   /api/modules/<id>/export     sideload/sync artifact: the RAW doc files verbatim (lore stays a
    //                                sidecar) + assets base64 + sha256 of every byte shipped — unpacks
    //                                back into the on-disk module format byte-identical
    //   /api/modules/<id>/assets/**  one asset
    // publish:false modules are UNLISTED (hidden from the catalog above), NOT locked: the content ships
    // in a public repo anyway, so download-gating dev modules would be theater — direct fetch by id is
    // the intended sideload path. Entitlement gating (paid episodes): TODO when paid content exists.
    if (req.method === 'GET' && path.startsWith('/api/modules/')) {
      const parts = path.slice('/api/modules/'.length).split('/').filter(Boolean);
      const id = decodeURIComponent(parts[0] || '');
      const m = getModule(id);
      if (!m) return sendJson(res, 404, { error: 'unknown_module', detail: id });
      if (parts.length === 1) return sendJson(res, 200, { manifest: m.manifest, pack: m.pack, assets: listModuleAssets(m.id) });
      if (parts.length === 2 && parts[1] === 'export') {
        const mdir = join(MODULES_DIR, m.id);
        const files = {}, sha256 = {};
        for (const f of [...new Set(['manifest.json', m.manifest.pack || 'pack.json', m.manifest.lore || 'lore.json'])]) {
          const p = join(mdir, f);
          if (!existsSync(p)) continue;
          const buf = readFileSync(p);
          files[f] = buf.toString('utf8');
          sha256[f] = createHash('sha256').update(buf).digest('hex');
        }
        if (!files['manifest.json']) return sendJson(res, 404, { error: 'module_files_missing', detail: m.id });
        const assets = {};
        for (const rel of listModuleAssets(m.id)) {
          const buf = readFileSync(join(mdir, 'assets', rel));
          assets[rel] = buf.toString('base64');
          sha256[`assets/${rel}`] = createHash('sha256').update(buf).digest('hex');
        }
        return sendJson(res, 200, { id: m.id, version: m.manifest.version || '0.0.0', files, assets, sha256 });
      }
      if (parts[1] === 'assets' && parts.length >= 3) return serveModuleAsset(res, id, parts.slice(2).map(decodeURIComponent).join('/'));
      return sendJson(res, 404, { error: 'not_found' });
    }

    // hot reload: re-read modules/ from disk and swap the registry. Studio calls this on publish.
    // Guarded by a shared token; NEVER swaps to an empty registry (a broken tree keeps the old one).
    if (req.method === 'POST' && path === '/api/reload') {
      const token = process.env.RELOAD_TOKEN || '';
      if (!token) return sendJson(res, 503, { error: 'reload_disabled', detail: 'RELOAD_TOKEN not set' });
      if (req.headers['x-qmm-reload-token'] !== token) return sendJson(res, 403, { error: 'forbidden' });
      const next = loadModules(MODULES_DIR);
      if (!Object.keys(next.modules).length) {
        qlog({ kind: 'modules_reload_rejected', errors: next.errors });
        return sendJson(res, 500, { error: 'reload_empty', errors: next.errors });
      }
      REGISTRY = next;
      DEFAULT_MODULE = Object.keys(next.modules)[0];
      qlog({ kind: 'modules_reload', modules: Object.keys(next.modules), errors: next.errors });
      console.log(`[reload] modules: ${Object.keys(next.modules).join(', ')}${next.errors.length ? ` (errors: ${next.errors.map(e => e.dir).join(', ')})` : ''}`);
      return sendJson(res, 200, { ok: true, modules: Object.keys(next.modules), errors: next.errors });
    }

    // start/reset a session for (user_id, module_id): returns the cold open + fresh state.
    if (req.method === 'GET' && path === '/api/new') {
      const userId = String(q.get('user_id') || q.get('uid') || '').slice(0, 80);
      const moduleId = String(q.get('module_id') || q.get('mid') || '').slice(0, 80) || DEFAULT_MODULE;
      if (!userId) return sendJson(res, 400, { error: 'no_user' });
      const mod = getModule(moduleId);
      if (!mod) return sendJson(res, 400, { error: 'unknown_module', detail: moduleId });
      const st = freshState(mod);
      const cold = mod.meta.cold_open.map(t => resolveMacros(t, st.macro_seed));
      const sess = newSession(userId, moduleId, st, cold);
      qlog({ kind: 'new_session', ...reqCtx(req, {}), user_id: userId, module_id: moduleId });
      return sendJson(res, 200, { state: sess.state, yuki_messages: cold, title: mod.meta.title, module_id: mod.id, seq: sess.seq });
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
      const wasConflict = !!existing && existing.seq !== baseSeq && !body.force;
      const sess = saveSession({
        user_id: userId, module_id: moduleId, state: body.state, transcript,
        seq: existing?.seq || 0, created_at: existing?.created_at || new Date().toISOString(),
      });
      qlog({
        kind: 'session_push', ...reqCtx(req, body), user_id: userId, module_id: moduleId,
        base_seq: baseSeq, was_conflict: wasConflict, force: !!body.force, transcript_len: transcript.length,
      });
      return sendJson(res, 200, { seq: sess.seq, was_conflict: wasConflict });
    }

    // ---- cross-channel handoff (story-chat-id) --------------------------------------------------
    // The fiction — not the user — moves a story between channels. One channel is primary at a time;
    // it owns the story locally, then REGISTER / RELEASE / ACTIVATE pass the baton. No per-message sync.

    // REGISTER (purple): a channel starts a new cross-channel story. Returns the scid + cold open.
    if (req.method === 'POST' && path === '/api/register') {
      const body = await readBody(req);
      const ctx = reqCtx(req, body);
      const { userId, moduleId } = resolveIds(body);
      if (!userId) return sendJson(res, 400, { error: 'no_user' });
      const mod = getModule(moduleId);
      if (!mod) return sendJson(res, 400, { error: 'unknown_module', detail: moduleId });
      // ADOPTION: a story started offline on-device can be handed an scid by passing its state
      // (+ transcript) here, instead of the server minting a fresh one. Merged over freshState so
      // a client missing v0.2 keys (turn / macro_seed / lore_fx) still gets sane defaults.
      const adopting = body.state !== undefined;
      if (adopting) {
        if (typeof body.state !== 'object' || body.state === null) return sendJson(res, 400, { error: 'bad_state' });
        if (JSON.stringify(body.state).length > 64 * 1024) return sendJson(res, 400, { error: 'state_too_large' });
      }
      const st = adopting ? { ...freshState(mod), ...body.state } : freshState(mod);
      // An adopted story is mid-flight: it already had its cold open, so don't re-send one.
      const cold = adopting ? [] : mod.meta.cold_open.map(t => resolveMacros(t, st.macro_seed));
      const transcript = adopting
        ? sanitizeTranscript(body.transcript || [])
        : cold.map(t => ({ who: 'yuki', text: t }));
      const s = registerStory({ user_id: userId, module_id: moduleId, channel: ctx.channel, state: st, transcript });
      qlog({ kind: 'story_register', ...ctx, story_chat_id: s.story_chat_id, user_id: userId, module_id: moduleId, adopted: adopting, transcript_len: transcript.length });
      return sendJson(res, 200, { story_chat_id: s.story_chat_id, state: s.state, cold_open: cold, adopted: adopting, module_id: moduleId, title: mod.meta.title, seq: s.seq, primary_channel: s.primary_channel });
    }

    // STOP (the ethics floor): end a story everywhere, terminally. Any channel may call it; the
    // scid is tombstoned so no channel can release/activate/checkpoint it again. THE WORD spans
    // keying schemes too — the (user, module) session behind the story is cleared in the same
    // move, so a stopped playthrough can't be resumed through the older session flow either.
    if (req.method === 'POST' && path === '/api/stop') {
      const body = await readBody(req);
      const ctx = reqCtx(req, body);
      const scid = String(body.story_chat_id || '').slice(0, 80);
      if (!scid) return sendJson(res, 400, { error: 'no_story_chat_id' });
      const r = stopStory(scid, { channel: ctx.channel });
      if (!r.ok) return sendJson(res, 404, { error: r.reason });
      const st = r.story;
      if (st.user_id && st.module_id) clearSession(st.user_id, st.module_id);
      qlog({ kind: 'story_stop', ...ctx, story_chat_id: scid, user_id: st.user_id, module_id: st.module_id, already: !!r.already });
      console.log(`[STOP] story=${scid} user=${st.user_id || '?'}`);
      return sendJson(res, 200, { ok: true, story_chat_id: scid, stopped: true, already: !!r.already });
    }

    // CHECKPOINT: the primary channel saves progress without releasing the baton (fire-and-forget
    // after a turn). Gives the backend visibility into a live on-device playthrough.
    if (req.method === 'POST' && path === '/api/story/checkpoint') {
      const body = await readBody(req);
      const ctx = reqCtx(req, body);
      const scid = String(body.story_chat_id || '').slice(0, 80);
      if (!scid) return sendJson(res, 400, { error: 'no_story_chat_id' });
      let state;
      if (body.state !== undefined) {
        if (typeof body.state !== 'object' || body.state === null) return sendJson(res, 400, { error: 'bad_state' });
        if (JSON.stringify(body.state).length > 64 * 1024) return sendJson(res, 400, { error: 'state_too_large' });
        state = body.state;
      }
      const transcript = body.transcript !== undefined ? sanitizeTranscript(body.transcript) : undefined;
      const r = checkpointStory(scid, { channel: ctx.channel, state, transcript });
      if (!r.ok) return sendJson(res, r.reason === 'unknown_story' ? 404 : 409, { error: r.reason, primary_channel: r.primary_channel, next_channel: r.next_channel });
      return sendJson(res, 200, { ok: true, story_chat_id: scid, seq: r.story.seq });
    }

    // DISCOVERY: a channel asks which of a user's stories exist / which it may claim. Without
    // this a channel can only activate an scid it already remembers, so a story released to a
    // channel that never saw it would be unreachable.
    if (req.method === 'GET' && path === '/api/stories') {
      const userId = String(q.get('user_id') || q.get('uid') || '').slice(0, 80);
      if (!userId) return sendJson(res, 400, { error: 'no_user' });
      const claimableBy = q.get('claimable_by') ? String(q.get('claimable_by')).slice(0, 24) : null;
      const rows = listStories({ user_id: userId, claimable_by: claimableBy });
      return sendJson(res, 200, { stories: rows.map(r => ({ ...r, title: getModule(r.module_id)?.meta.title })) });
    }

    // RELEASE (yellow): the primary channel ships its full state + history and names the next channel.
    // Also the timeout/error path (error set). Full state is stored as-is (nested lore_fx preserved),
    // size-guarded rather than key-whitelisted.
    if (req.method === 'POST' && path === '/api/release') {
      const body = await readBody(req);
      const ctx = reqCtx(req, body);
      const scid = String(body.story_chat_id || '').slice(0, 80);
      if (!scid) return sendJson(res, 400, { error: 'no_story_chat_id' });
      let state;
      if (body.state !== undefined) {
        if (typeof body.state !== 'object' || body.state === null) return sendJson(res, 400, { error: 'bad_state' });
        if (JSON.stringify(body.state).length > 64 * 1024) return sendJson(res, 400, { error: 'state_too_large' });
        state = body.state;
      }
      const transcript = body.transcript !== undefined ? sanitizeTranscript(body.transcript) : undefined;
      const next_channel = body.next_channel ? String(body.next_channel).slice(0, 24) : null;
      const error = body.error ? String(body.error).slice(0, 300) : null;
      const r = releaseStory(scid, { channel: ctx.channel, state, transcript, next_channel, error });
      if (!r.ok) return sendJson(res, 404, { error: r.reason });
      qlog({ kind: 'story_release', ...ctx, story_chat_id: scid, next_channel, error, seq: r.story.seq });
      return sendJson(res, 200, { ok: true, story_chat_id: scid, released: true, next_channel, seq: r.story.seq });
    }

    // ACTIVATE (green): a channel claims a released story and gets the state + history to continue.
    if (req.method === 'GET' && path === '/api/activate') {
      const scid = String(q.get('story_chat_id') || '').slice(0, 80);
      const channel = String(q.get('channel') || 'web').slice(0, 24);
      if (!scid) return sendJson(res, 400, { error: 'no_story_chat_id' });
      const r = activateStory(scid, channel);
      if (!r.ok) {
        qlog({ kind: 'story_activate_denied', story_chat_id: scid, channel, reason: r.reason });
        return sendJson(res, 200, { activated: false, reason: r.reason, next_channel: r.next_channel, primary_channel: r.primary_channel });
      }
      const s = r.story;
      qlog({ kind: 'story_activate', story_chat_id: scid, channel, seq: s.seq });
      return sendJson(res, 200, { activated: true, story_chat_id: scid, state: s.state, transcript: s.transcript, seq: s.seq, module_id: s.module_id, title: getModule(s.module_id)?.meta.title });
    }

    // pull a story by scid — the shared cross-channel truth (read-only).
    if (req.method === 'GET' && path === '/api/story') {
      const scid = String(q.get('story_chat_id') || '').slice(0, 80);
      if (!scid) return sendJson(res, 400, { error: 'no_story_chat_id' });
      const s = loadStory(scid);
      if (!s) return sendJson(res, 200, { exists: false });
      // A stopped story reports as terminal, never as playable state — the client polling this
      // is how a channel that wasn't holding the baton learns THE WORD was said.
      if (s.stopped) return sendJson(res, 200, { exists: true, story_chat_id: s.story_chat_id, stopped: true, stopped_at: s.stopped_at });
      return sendJson(res, 200, {
        exists: true, story_chat_id: s.story_chat_id, state: s.state, transcript: s.transcript, seq: s.seq,
        module_id: s.module_id, title: getModule(s.module_id)?.meta.title,
        primary_channel: s.primary_channel, released: s.released, next_channel: s.next_channel, updated_at: s.updated_at,
      });
    }

    if (req.method === 'POST' && path === '/api/turn') {
      const body = await readBody(req);
      const out = await runTurn(playerDeps, body, reqCtx(req, body));
      return sendJson(res, out.error ? 400 : 200, out);
    }
    if (req.method === 'POST' && path === '/api/nudge') {
      const body = await readBody(req);
      const out = await runNudge(playerDeps, body, reqCtx(req, body));
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
    // No UI here — this is the channel-agnostic backend. Channel adapters serve the player.
    if (req.method === 'GET' && path === '/') {
      return sendJson(res, 200, { service: 'qmm-backend', hint: 'channel-agnostic story API — use a channel adapter (qmm-web / qmm-android / qmm-telegram) for a UI', modules: Object.keys(REGISTRY.modules) });
    }
    return sendJson(res, 404, { error: 'not_found', path });
  } catch (e) {
    console.error(`[err] ${req.method} ${path}: ${e.stack || e}`);
    qlog({ kind: 'error', path, method: req.method, error: String(e.message || e), stack: String(e.stack || '').slice(0, 2000) });
    sendJson(res, 500, { error: 'server_error', detail: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`QMM up on http://127.0.0.1:${PORT}  (model ${MODEL} via ${OLLAMA}; modules: ${Object.keys(REGISTRY.modules).join(', ')})`);
  // Warm the model so the first player turn isn't a cold load.
  ollamaChat([{ role: 'user', content: 'say ok' }], { temperature: 0, num_predict: 8 })
    .then(r => console.log(`[warmup] model loaded in ${r.ms}ms`))
    .catch(e => console.log(`[warmup] failed: ${e.message}`));
});
