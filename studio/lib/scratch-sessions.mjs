// Playtest scratch sessions — same API surface as server/sessions.mjs, different directory
// (studio-sessions/), so the studio's full-engine playtests NEVER touch the player's sessions/.
// File-backed with atomic writes, zero dependencies.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '..', '..', 'studio-sessions');
mkdirSync(DIR, { recursive: true });

const MAX_TRANSCRIPT = 300;
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
  renameSync(tmp, f); // atomic replace
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

export function clearSession(userId, moduleId) {
  const f = fileFor(userId, moduleId);
  try { if (existsSync(f)) renameSync(f, `${f}.stopped-${Date.now()}`); } catch { /* ignore */ }
}

/** Studio extra: enumerate playtest runs for the reopen list. */
export function listSessions() {
  return readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
    try {
      const s = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
      return { user_id: s.user_id, module_id: s.module_id, seq: s.seq, updated_at: s.updated_at, turns: s.state?.turn ?? 0 };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}
