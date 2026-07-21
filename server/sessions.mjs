// Server-side per-(user, module) session store — the SOURCE OF TRUTH for a player's story state
// across ALL channels (web, app, Telegram). File-backed with atomic writes. Zero dependencies.
//
// A session = one persistent record per (user_id, module_id):
//   { user_id, module_id, state, transcript: [{who,text}], seq, created_at, updated_at }
// Any channel loads it, advances it, and saves it back — that's how a logged-in user moves
// between web/app/Telegram and keeps one consistent story. Concurrency: last-write-wins + seq
// (real collisions are rare in a slow async text game; a channel can compare seq to detect one).

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '..', 'sessions');
mkdirSync(DIR, { recursive: true });

const MAX_TRANSCRIPT = 300;                       // cap stored history per session
const safe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
const fileFor = (userId, moduleId) => join(DIR, `${safe(userId)}__${safe(moduleId)}.json`);

export function loadSession(userId, moduleId) {
  const f = fileFor(userId, moduleId);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

export function saveSession(s) {
  s.updated_at = new Date().toISOString();
  s.seq = (s.seq || 0) + 1;
  if (s.transcript.length > MAX_TRANSCRIPT) s.transcript = s.transcript.slice(-MAX_TRANSCRIPT);
  const f = fileFor(s.user_id, s.module_id);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, f);                             // atomic replace
  return s;
}

export function newSession(userId, moduleId, state, coldOpen) {
  const now = new Date().toISOString();
  return saveSession({
    user_id: userId, module_id: moduleId, state,
    transcript: (coldOpen || []).map(t => ({ who: 'yuki', text: t })),
    seq: 0, created_at: now, updated_at: now,
  });
}

export function getOrCreate(userId, moduleId, freshState, coldOpen) {
  return loadSession(userId, moduleId) || newSession(userId, moduleId, freshState(), coldOpen);
}

// STOP / consent-withdrawal: remove the session from play. Renamed aside (not hard-deleted) so a
// stopped session leaves a trace off-path; a hard purge for data-deletion requests is a later concern.
export function clearSession(userId, moduleId) {
  const f = fileFor(userId, moduleId);
  try { if (existsSync(f)) renameSync(f, `${f}.stopped-${Date.now()}`); } catch { /* ignore */ }
}
