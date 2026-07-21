// Verifies the module-download methods + the app-sync (push/pull/conflict) surface. No LLM needed.
// Run: node tools/download-sync-test.mjs   (server must be running).
const BASE = process.env.QMM || 'http://127.0.0.1:8791';
const USER = 'dl-sync-test';
const j = (r) => r.json();
let pass = true;
const chk = (label, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); if (!cond) pass = false; };

// --- module download ---
const cat = await fetch(`${BASE}/api/modules`).then(j).catch(() => null);
if (!cat) { console.error(`can't reach ${BASE} — start the server`); process.exit(1); }
const mid = cat.default;
chk('catalog lists modules', Array.isArray(cat.modules) && cat.modules.length >= 1, `default=${mid}`);
chk('catalog hides unpublished', cat.modules.every(m => m.publish !== false));

const bundle = await fetch(`${BASE}/api/modules/${mid}`).then(j);
chk('download bundle', bundle.manifest?.id === mid && Array.isArray(bundle.pack?.families) && bundle.pack.families.length > 0, `beats=${bundle.pack?.families?.length}`);

const missingStatus = await fetch(`${BASE}/api/modules/nope-nope-nope`).then(r => r.status);
chk('unknown module -> 404', missingStatus === 404, `status=${missingStatus}`);

const assetStatus = await fetch(`${BASE}/api/modules/${mid}/assets/none.png`).then(r => r.status);
chk('missing asset -> 404', assetStatus === 404, `status=${assetStatus}`);

// --- app sync (push/pull/conflict) ---
const s0 = await fetch(`${BASE}/api/new?user_id=${USER}&module_id=${mid}`).then(j);
chk('new session', s0.seq >= 1, `seq=${s0.seq}`);

const push = await fetch(`${BASE}/api/session/push`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    user_id: USER, module_id: mid, base_seq: s0.seq, channel: 'app',
    state: { ...s0.state, current_state: 'S01_First_Clue', beat: 1 },
    transcript: [{ who: 'yuki', text: 'cold open' }, { who: 'user', text: 'app-side turn' }, { who: 'yuki', text: 'i moved' }],
  }),
}).then(j);
chk('app push accepted', typeof push.seq === 'number' && push.seq > s0.seq, `seq ${s0.seq}->${push.seq}`);

const pull = await fetch(`${BASE}/api/session?user_id=${USER}&module_id=${mid}`).then(j);
chk('pull reflects app push', pull.state?.current_state === 'S01_First_Clue' && pull.seq === push.seq, `state=${pull.state?.current_state} seq=${pull.seq}`);

// pushing from a stale base_seq should flag was_conflict (collision DETECTION).
const stale = await fetch(`${BASE}/api/session/push`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user_id: USER, module_id: mid, base_seq: s0.seq, state: pull.state, transcript: pull.transcript }),
}).then(j);
chk('stale push flags was_conflict', stale.was_conflict === true, `was_conflict=${stale.was_conflict}`);

console.log(pass ? '\nPASS — module download + app sync (pull / push / conflict-flag) all work.' : '\nFAIL');
process.exit(pass ? 0 : 1);
