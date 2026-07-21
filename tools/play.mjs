#!/usr/bin/env node
// Scripted playthrough for smoke-testing: node tools/play.mjs [msg1|msg2|...]
// Default run mixes chatty texts (should stay in-beat) with directives (should advance).
const BASE = process.env.QMM || 'http://127.0.0.1:8791';

const DEFAULT_RUN = [
  ['omg ok i\'m here. are you safe right now??', 'chat'],
  ['this is freaking me out, it\'s so late', 'chat'],
  ['ok. ask the vendors, someone must have seen him', 'advance'],
  ['wait what did the owner look like?', 'chat'],
  ['hide somewhere and listen, don\'t let them see you', 'advance'],
  ['what are they saying??', 'chat'],
  ['ok call arena security right now', 'advance'],
  ['i don\'t trust that guard either tbh', 'chat'],
  ['film everything before you go further', 'advance'],
  ['be so careful. i\'m right here with you', 'chat'],
  ['stay hidden and watch who comes in', 'advance'],
  ['oh my god. ura?? THE ura???', 'chat'],
  ['you have to get kenji out. dig him out NOW', 'advance'],
];

const run = process.argv[2]
  ? process.argv[2].split('|').map(m => [m, '?'])
  : DEFAULT_RUN;

// Server-side sessions: each run is a fresh (user_id, module) session; the server owns the
// transcript, so the client no longer threads state/tail.
const USER = process.env.QMM_USER || `play-${Date.now()}`;
const j = (r) => r.json();
let first;
try {
  first = await fetch(`${BASE}/api/new?user_id=${encodeURIComponent(USER)}`).then(j);
} catch {
  console.error(`Can't reach ${BASE}. Start the server first (node server/server.mjs, or start-qmm.ps1 on Windows), or set QMM to point at a running one.`);
  process.exit(1);
}
if (first.error) { console.error(`!! /api/new error: ${first.error} ${first.detail || ''}`); process.exit(1); }
let { state, yuki_messages } = first;
console.log(`COLD OPEN (${yuki_messages.length} bubbles) -> ${state.current_state}  [user ${USER}, module ${first.module_id}]`);

let fails = 0, chats = 0, advances = 0;
for (const [msg, expect] of run) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/turn`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: USER, user_message: msg, reply_latency_s: 4, channel: 'play' }),
  }).then(j);
  if (res.error === 'story_over') { console.log(`\n== "${msg}"\n   (story already over)`); break; }
  if (res.error) { console.log(`!! ERROR: ${res.error} ${res.detail || ''}`); fails++; break; }
  state = res.state;

  const m = res.meta;
  if (m.mode === 'chat') chats++; else advances++;
  const modeNote = expect === '?' || m.mode === expect ? m.mode : `${m.mode} (wanted ${expect})`;
  const braces = res.yuki_messages.some(b => b.includes('{{'));
  const nb = res.yuki_messages.length;
  const flags = [
    m.route_fallback && 'ROUTE-FALLBACK', m.generate_fallback && 'GEN-FALLBACK',
    braces && 'BRACES', m.mode === 'chat' && nb > 2 && `CHAT-BUBBLES=${nb}`, m.forced && 'FORCED',
  ].filter(Boolean);
  if (m.route_fallback || m.generate_fallback || braces || (m.mode === 'chat' && nb > 2)) fails++;
  console.log(`\n== "${msg}"`);
  if (m.mode === 'chat') {
    console.log(`   ${state.current_state} [${modeNote} ${m.exchanges_in_beat}/4 intent=${m.intent}] ${Date.now() - t0}ms ${flags.join(' ')}`);
  } else {
    console.log(`   ${m.from} --${m.intent}--> ${state.current_state} [${modeNote} ${m.template_id}] ${Date.now() - t0}ms ${flags.join(' ')}`);
  }
  for (const b of res.yuki_messages) console.log(`   | ${b.replace(/\n/g, '\n   | ')}`);
  if (res.ending) console.log(`   ENDING: ${res.ending.route} (${res.ending.type}) kenji_rescued=${res.ending.kenji_rescued}`);
}
console.log(`\n${fails ? `DONE WITH ${fails} FLAG(S)` : 'DONE CLEAN'} — final ${state.current_state} (${chats} chat / ${advances} advance)`);
if (!process.argv[2] && state.current_state !== 'S06_Ending') console.log('NOTE: default run did not reach the ending');
