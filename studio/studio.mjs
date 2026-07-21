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
import { NUM_CTX, OLLAMA, MODEL } from '../server/engine.mjs';
import { validateModule } from '../server/validate.mjs';
import { DraftStore } from './lib/draft-store.mjs';

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

const store = new DraftStore({ modulesDir: MODULES_DIR, draftsDir: DRAFTS_DIR, scaffoldDir: SCAFFOLD_DIR });

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
