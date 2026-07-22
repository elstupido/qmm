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

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
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
  if (s.stopped) return { ok: false, reason: 'stopped' };
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
  if (s.stopped) return { ok: false, reason: 'stopped' };
  if (!s.released) return { ok: false, reason: 'not_released', primary_channel: s.primary_channel };
  if (s.next_channel && s.next_channel !== channel) return { ok: false, reason: 'not_targeted', next_channel: s.next_channel };
  s.primary_channel = channel;
  s.released = false;
  s.next_channel = null;
  note(s, 'activate', channel);
  return { ok: true, story: saveStory(s) };
}

// STOP — THE WORD, and the ethics floor. Terminal and irreversible.
//
// The playthrough is renamed aside (same discipline as clearSession: off the live path, not
// hard-deleted) and a TOMBSTONE is left at the canonical path carrying no state and no
// transcript. The tombstone is why every later move answers `stopped` instead of
// `unknown_story` — a stopped scid must be unmistakably OVER rather than merely missing, so no
// channel can release, activate, or checkpoint it back into play. Register is unaffected by
// design: it mints a fresh scid, and a new story after STOP is a new story.
export function stopStory(scid, { channel } = {}) {
  const s = loadStory(scid);
  if (!s) return { ok: false, reason: 'unknown_story' };
  if (s.stopped) return { ok: true, already: true, story: s };
  const f = fileFor(scid);
  // Move the record aside FIRST: if this process dies mid-stop the story is already out of play.
  try { if (existsSync(f)) renameSync(f, `${f}.stopped-${Date.now()}`); } catch { /* ignore */ }
  const tomb = {
    story_chat_id: s.story_chat_id, user_id: s.user_id || null, module_id: s.module_id || null,
    state: {}, transcript: [],
    primary_channel: null, released: false, next_channel: null, last_error: null,
    stopped: true, stopped_at: new Date().toISOString(), stopped_by_channel: channel || null,
    history: s.history || [], seq: s.seq || 0, created_at: s.created_at || null,
  };
  note(tomb, 'stop', channel);
  return { ok: true, story: saveStory(tomb) };
}

// CHECKPOINT: the PRIMARY channel updates state + transcript in place without giving up the
// baton, so the backend can see a live playthrough between handoffs. Deliberately writes no
// history entry — the app fires this after every turn and it would drown the audit trail.
export function checkpointStory(scid, { channel, state, transcript }) {
  const s = loadStory(scid);
  if (!s) return { ok: false, reason: 'unknown_story' };
  if (s.stopped) return { ok: false, reason: 'stopped' };
  if (s.released) return { ok: false, reason: 'released', next_channel: s.next_channel };
  if (channel && s.primary_channel && channel !== s.primary_channel) {
    return { ok: false, reason: 'not_primary', primary_channel: s.primary_channel };
  }
  if (state !== undefined) s.state = state;
  if (Array.isArray(transcript)) s.transcript = transcript;
  return { ok: true, story: saveStory(s) };
}

// DISCOVERY: which stories does this user have, and which can a given channel claim? A channel
// can only activate an scid it already knows, so a story released TO a channel that has never
// seen it would otherwise be invisible. Stopped stories are omitted — not claimable, not
// playable. (Aside files don't end in .json, so they're skipped for free.)
export function listStories({ user_id, claimable_by } = {}) {
  let names;
  try { names = readdirSync(DIR).filter(n => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    let s;
    try { s = JSON.parse(readFileSync(join(DIR, n), 'utf8')); } catch { continue; }
    if (!s || s.stopped) continue;
    if (user_id && s.user_id !== user_id) continue;
    if (claimable_by && !(s.released && (!s.next_channel || s.next_channel === claimable_by))) continue;
    out.push({
      story_chat_id: s.story_chat_id, module_id: s.module_id, primary_channel: s.primary_channel,
      released: !!s.released, next_channel: s.next_channel || null, seq: s.seq || 0, updated_at: s.updated_at,
    });
  }
  return out.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}
