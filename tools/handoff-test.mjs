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

// 7. CHECKPOINT: the primary channel saves progress without giving up the baton.
const cp = await post('/api/story/checkpoint', {
  story_chat_id: scid, channel: 'web',
  state: { ...act.state, beat: 3 },
  transcript: [...act.transcript, { who: 'user', text: 'still on web' }],
});
const afterCp = await get(`/api/story?story_chat_id=${scid}`);
chk('checkpoint saves without releasing', cp.ok === true && afterCp.state?.beat === 3 && afterCp.primary_channel === 'web' && afterCp.released === false, `beat=${afterCp.state?.beat} primary=${afterCp.primary_channel}`);

// 8. a NON-primary channel cannot checkpoint over the primary's story.
const cpWrong = await post('/api/story/checkpoint', { story_chat_id: scid, channel: 'telegram', state: { beat: 99 } });
const afterWrong = await get(`/api/story?story_chat_id=${scid}`);
chk('non-primary checkpoint rejected', cpWrong.error === 'not_primary' && afterWrong.state?.beat === 3, `err=${cpWrong.error} beat=${afterWrong.state?.beat}`);

// 9. DISCOVERY: the user's stories are listable, and claimable-filtering works.
const mine = await get('/api/stories?user_id=handoff-u');
chk('discovery lists the user\'s story', Array.isArray(mine.stories) && mine.stories.some(s => s.story_chat_id === scid), `n=${mine.stories?.length}`);
const claimable = await get('/api/stories?user_id=handoff-u&claimable_by=android');
chk('unreleased story is not claimable by another channel', !claimable.stories?.some(s => s.story_chat_id === scid), `n=${claimable.stories?.length}`);

// 10. ADOPTION: a story played offline on-device can be handed an scid with its state intact.
const adopted = await post('/api/register', {
  user_id: 'handoff-u2', channel: 'android',
  state: { current_state: 'S03_Reveal', beat: 7, lore_fx: { groupCanon: { coldspot: 'cold-draft' } } },
  transcript: [{ who: 'yuki', text: 'played entirely offline' }, { who: 'user', text: 'yeah' }],
});
chk('register adopts offline state (no cold open, lore_fx kept)',
  adopted.adopted === true && adopted.cold_open?.length === 0 && adopted.state?.beat === 7
  && adopted.state?.lore_fx?.groupCanon?.coldspot === 'cold-draft' && adopted.state?.turn !== undefined,
  `beat=${adopted.state?.beat} canon=${adopted.state?.lore_fx?.groupCanon?.coldspot} turn_defaulted=${adopted.state?.turn}`);
await post('/api/stop', { story_chat_id: adopted.story_chat_id, channel: 'android' });

// 11. STOP — the ethics floor. Terminal on every move, from any channel.
const stopped = await post('/api/stop', { story_chat_id: scid, channel: 'android' });
chk('stop succeeds from a non-primary channel', stopped.ok === true && stopped.stopped === true);
const pullStopped = await get(`/api/story?story_chat_id=${scid}`);
chk('story reads as stopped, with no state or transcript', pullStopped.stopped === true && pullStopped.state === undefined && pullStopped.transcript === undefined, `stopped_at=${pullStopped.stopped_at}`);
const relAfter = await post('/api/release', { story_chat_id: scid, channel: 'web', next_channel: 'android' });
chk('release after stop is refused', relAfter.error === 'stopped', `err=${relAfter.error}`);
const actAfter = await get(`/api/activate?story_chat_id=${scid}&channel=android`);
chk('activate after stop is refused', actAfter.activated === false && actAfter.reason === 'stopped', `reason=${actAfter.reason}`);
const cpAfter = await post('/api/story/checkpoint', { story_chat_id: scid, channel: 'web', state: { beat: 4 } });
chk('checkpoint after stop is refused', cpAfter.error === 'stopped', `err=${cpAfter.error}`);
const listAfter = await get('/api/stories?user_id=handoff-u');
chk('stopped story disappears from discovery', !listAfter.stories?.some(s => s.story_chat_id === scid), `n=${listAfter.stories?.length}`);

console.log(pass ? '\nPASS — baton-pass, checkpoint, discovery, adoption, and a terminal STOP.' : '\nFAIL');
process.exit(pass ? 0 : 1);
