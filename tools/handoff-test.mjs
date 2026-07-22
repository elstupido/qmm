// Proves the cross-channel handoff (story-chat-id + register/release/activate). No LLM needed.
// A story registered on one channel, released, and activated on another continues seamlessly.
// Run: node tools/handoff-test.mjs   (backend must be running).
const BASE = process.env.QMM || 'http://127.0.0.1:8791';
const j = (r) => r.json();
let pass = true;
const chk = (label, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); if (!cond) pass = false; };
const post = (p, b) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(j);
const get = (p) => fetch(`${BASE}${p}`).then(j);

// 1. REGISTER a new cross-channel story on the android channel.
const reg = await post('/api/register', { user_id: 'handoff-u', channel: 'android' }).catch(() => null);
if (!reg) { console.error(`can't reach ${BASE} — start the backend`); process.exit(1); }
const scid = reg.story_chat_id;
chk('register mints a story-chat-id', !!scid && reg.primary_channel === 'android' && Array.isArray(reg.cold_open) && reg.cold_open.length, `scid=${scid?.slice(0, 8)}… primary=${reg.primary_channel}`);

// 2. android runs turns on-device (simulated), then RELEASES to web with the new state + history.
const rel = await post('/api/release', {
  story_chat_id: scid, channel: 'android', next_channel: 'web',
  state: { ...reg.state, current_state: 'S02_False_Lead', beat: 2, danger_level: 2, lore_fx: { last: { 'ura-knees': 3 } } },
  transcript: [{ who: 'yuki', text: 'cold open' }, { who: 'user', text: 'played on my phone' }, { who: 'yuki', text: 'i found something' }],
});
chk('release relinquishes + names next channel', rel.ok === true && rel.next_channel === 'web', `next=${rel.next_channel}`);

// 3. a non-targeted channel (telegram) cannot steal it.
const wrong = await get(`/api/activate?story_chat_id=${scid}&channel=telegram`);
chk('non-targeted channel denied', wrong.activated === false && wrong.reason === 'not_targeted', `reason=${wrong.reason} next=${wrong.next_channel}`);

// 4. web ACTIVATES → inherits the shipped state + history (incl. nested lore_fx), becomes primary.
const act = await get(`/api/activate?story_chat_id=${scid}&channel=web`);
chk('web activates + inherits the story', act.activated === true && act.state?.current_state === 'S02_False_Lead' && act.transcript?.length === 3 && act.state?.lore_fx?.last?.['ura-knees'] === 3, `state=${act.state?.current_state} transcript=${act.transcript?.length} lore_fx_kept=${!!act.state?.lore_fx}`);

// 5. the story is now primary on web, not released.
const pull = await get(`/api/story?story_chat_id=${scid}`);
chk('story is now primary on web', pull.exists && pull.primary_channel === 'web' && pull.released === false, `primary=${pull.primary_channel} released=${pull.released}`);

// 6. re-activating an unreleased story is denied.
const dbl = await get(`/api/activate?story_chat_id=${scid}&channel=web`);
chk('re-activate of an unreleased story denied', dbl.activated === false && dbl.reason === 'not_released', `reason=${dbl.reason}`);

console.log(pass ? '\nPASS — register / release / activate baton-pass works across channels.' : '\nFAIL');
process.exit(pass ? 0 : 1);
