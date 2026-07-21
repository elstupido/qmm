#!/usr/bin/env node
// QMM player server — zero-dependency Node. Serves the phone UI + the story API.
// Stories are pluggable MODULES (modules/<id>/{manifest,pack}.json). State is SERVER-OWNED:
// a session = (user_id, module_id) held in server/sessions.mjs, shared across every channel
// (web, app, Telegram) so one logged-in user keeps a consistent story wherever they play.
//
// The turn loop itself lives in server/engine.mjs (shared with the authoring studio); this file
// is the HTTP shell: module registry (+ hot reload), sessions wiring, flight log, static files.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSession, saveSession, newSession, getOrCreate, clearSession } from './sessions.mjs';
import { resolveMacros } from './lore.mjs';
import { OLLAMA, MODEL, NUM_CTX, loadModules, ollamaChat, freshState, runTurn, runNudge } from './engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', 'public');
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
      return sendJson(res, 200, { modules: Object.values(REGISTRY.modules).filter(m => m.manifest.publish !== false).map(m => m.manifest), default: DEFAULT_MODULE });
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
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, path);
    res.writeHead(405); res.end();
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
