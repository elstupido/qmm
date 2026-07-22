// server/stories.mjs — the STORY-CHAT-ID registry.
//
// A story-chat-id (scid) is the first-class, cross-channel identity for a WHOLE playthrough — it
// supersedes the (user_id, module_id) session key. A story is PRIMARY on exactly one channel at a
// time; channels pass the baton with three moves, all driven by the FICTION (never the user):
//
//   REGISTER (purple)  a channel mints a new scid and becomes its first primary.
//   RELEASE  (yellow)  the primary channel ships its full state + history and gives up control,
//                      naming the next channel the fiction chose (or flagging a timeout/error).
//   ACTIVATE (green)   a channel claims a released story, becomes primary, and inherits the shipped
//                      state + history so it continues exactly where the released channel left off.
//
// No engine, no LLM, no channel specifics live here — this is pure handoff state. File-backed with
// atomic writes, zero dependencies. On timeout the backend just HOLDS the released story: there is
// no auto-reroute (a dead channel is designed silence, not a system routing around it).

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '..', 'stories');
mkdirSync(DIR, { recursive: true });

const MAX_TRANSCRIPT = 400;
const MAX_HISTORY = 100;
const safe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
const fileFor = (scid) => join(DIR, `${safe(scid)}.json`);

export function loadStory(scid) {
  const f = fileFor(scid);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

export function saveStory(s) {
  s.updated_at = new Date().toISOString();
  s.seq = (s.seq || 0) + 1;
  if (Array.isArray(s.transcript) && s.transcript.length > MAX_TRANSCRIPT) s.transcript = s.transcript.slice(-MAX_TRANSCRIPT);
  if (Array.isArray(s.history) && s.history.length > MAX_HISTORY) s.history = s.history.slice(-MAX_HISTORY);
  const f = fileFor(s.story_chat_id);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, f);                             // atomic replace
  return s;
}

function note(s, event, channel, extra) {
  (s.history ||= []).push({ event, channel: channel || null, at: new Date().toISOString(), ...(extra || {}) });
}

// REGISTER (purple): mint a new scid, owned by the registering channel as its first primary.
export function registerStory({ user_id, module_id, channel, state, transcript }) {
  const now = new Date().toISOString();
  const s = {
    story_chat_id: randomUUID(), user_id: user_id || null, module_id: module_id || null,
    state: state || {}, transcript: transcript || [],
    primary_channel: channel || null, released: false, next_channel: null, last_error: null,
    history: [], seq: 0, created_at: now, updated_at: now,
  };
  note(s, 'register', channel);
  return saveStory(s);
}

// RELEASE (yellow): the primary channel ships everything and gives up control. next_channel is the
// fiction's chosen target; error marks a timeout/failure release. Re-releasing just updates the payload.
export function releaseStory(scid, { channel, state, transcript, next_channel, error }) {
  const s = loadStory(scid);
  if (!s) return { ok: false, reason: 'unknown_story' };
  if (state !== undefined) s.state = state;
  if (Array.isArray(transcript)) s.transcript = transcript;
  s.primary_channel = null;
  s.released = true;
  s.next_channel = next_channel || null;
  s.last_error = error || null;
  note(s, error ? 'release_timeout' : 'release', channel, { next_channel: next_channel || null, error: error || null });
  return { ok: true, story: saveStory(s) };
}

// ACTIVATE (green): a channel claims a released story to become primary and continue it. Succeeds
// only if the story is released AND either targeted at this channel or untargeted. Never reroutes.
export function activateStory(scid, channel) {
  const s = loadStory(scid);
  if (!s) return { ok: false, reason: 'unknown_story' };
  if (!s.released) return { ok: false, reason: 'not_released', primary_channel: s.primary_channel };
  if (s.next_channel && s.next_channel !== channel) return { ok: false, reason: 'not_targeted', next_channel: s.next_channel };
  s.primary_channel = channel;
  s.released = false;
  s.next_channel = null;
  note(s, 'activate', channel);
  return { ok: true, story: saveStory(s) };
}
