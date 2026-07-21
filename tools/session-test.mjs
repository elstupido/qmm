// Cross-channel session smoke test: proves a (user, module) story lives server-side and is shared
// across "channels" — a turn made as web is visible to telegram, and telegram continues the SAME
// story. Run: node tools/session-test.mjs   (needs the server running).
const BASE = process.env.QMM || 'http://127.0.0.1:8791';
const USER = 'xchannel-test-user';
const j = (r) => r.json();

const turn = (msg, channel) => fetch(`${BASE}/api/turn`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user_id: USER, user_message: msg, channel, reply_latency_s: 4 }),
}).then(j);

const pull = () => fetch(`${BASE}/api/session?user_id=${encodeURIComponent(USER)}`).then(j);

// 1. fresh session
const start = await fetch(`${BASE}/api/new?user_id=${encodeURIComponent(USER)}`).then(j).catch(() => null);
if (!start) { console.error(`can't reach ${BASE} — start the server first`); process.exit(1); }
console.log(`NEW   module=${start.module_id} state=${start.state.current_state} seq=${start.seq} coldOpen=${start.yuki_messages.length}`);

// 2. channel A (web) advances the story
const a = await turn("ok. ask the vendors, someone must have seen him", 'web');
if (a.error) { console.error('turn A error:', a); process.exit(1); }
console.log(`WEB   ${a.mode} -> ${a.state.current_state} seq=${a.seq} bubbles=${a.yuki_messages.length}`);

// 3. channel B (telegram) PULLS the same session and sees A's advance
const p = await pull();
console.log(`PULL  exists=${p.exists} state=${p.state?.current_state} seq=${p.seq} transcript=${p.transcript?.length}`);
const consistent = p.exists && p.state.current_state === a.state.current_state && p.seq === a.seq;

// 4. channel B continues from the shared state
const b = await turn("hide and listen, don't let them see you", 'telegram');
if (b.error) { console.error('turn B error:', b); process.exit(1); }
console.log(`TG    ${b.mode} -> ${b.state.current_state} seq=${b.seq} bubbles=${b.yuki_messages.length}`);

// 5. final pull: both channels' player lines are in ONE transcript
const f = await pull();
const userLines = f.transcript.filter(m => m.who === 'user').map(m => m.text);
console.log(`FINAL state=${f.state.current_state} seq=${f.seq} transcript=${f.transcript.length}`);
console.log(`      player lines in the shared session: ${JSON.stringify(userLines)}`);

const ok = consistent && f.seq >= b.seq && userLines.length === 2 && f.state.current_state !== start.state.current_state;
console.log(ok
  ? '\nPASS — one session, shared across web + telegram, state advanced by both.'
  : '\nFAIL — session not consistent across channels.');
process.exit(ok ? 0 : 1);
