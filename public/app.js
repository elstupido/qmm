/* QMM — client logic. State lives here (round-tripped through the stateless server). */
'use strict';

const $ = (id) => document.getElementById(id);
const chat = $('chat'), input = $('input'), sendBtn = $('send'), composer = $('composer');
const LS_KEY = 'qmm_v1';

const SCENES = {
  outside: 'outside', chanko_stall: 'east side — chanko stall', service_entrance: 'service entrance',
  loading_dock: 'loading dock', loading_dock_edge: 'loading dock', restricted_gate: 'restricted gate',
  staff_entrance: 'staff entrance', ticket_window: 'ticket windows', west_entrance: 'west entrance',
  public_concourse: 'public concourse', shadowed_concourse: 'shadowed concourse',
  security_desk_or_phone_call: 'security desk', security_desk: 'security desk', posted_roster: 'roster board',
  public_exit: 'public exit', freight_elevator: 'freight elevator', basement_door: 'basement door',
  west_stairs_sign: 'west stairs', hidden_practice_hall: 'hidden practice hall',
  hidden_practice_hall_threshold: 'hidden hall — doorway',
};

let S = null;          // session: {transcript, state, snapshots, soundOn, debug, coldOpenDone}
let busy = false;
let audioCtx = null;
let lastYukiAt = 0;    // when Yuki's last bubble landed (reply-latency + nudge timing)
let nudgeTimer = null; // silence timer: Yuki double-texts if the player goes quiet

/* ------------------------------------------------------------- utilities -- */
function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch { } }
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && Array.isArray(s.transcript) && s.state && s.state.current_state) return s;
  } catch { }
  return null;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const beat = () => S?.state?.beat ?? 0;

function clockStr() {
  const mins = 23 * 60 + 47 + (S.clockOffset || 0);
  const h = Math.floor(mins / 60) % 24, m = mins % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
function battery() { return Math.max(4, 91 - 6 * beat()); }

function beep(freq, dur = 0.09, gain = 0.05, type = 'sine') {
  if (!S.soundOn) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(gain, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch { }
}
const popIn = () => beep(920, 0.08, 0.045);
const swishOut = () => { beep(520, 0.06, 0.04); setTimeout(() => beep(760, 0.07, 0.04), 45); };

/* --------------------------------------------------------------- chrome ---- */
function updateChrome() {
  $('sb-time').textContent = clockStr();
  const b = battery();
  $('sb-batt-pct').textContent = b + '%';
  const fill = $('sb-batt-fill');
  fill.style.width = b + '%';
  fill.classList.toggle('low', b <= 20);
  const barsOn = beat() <= 1 ? 4 : beat() === 2 ? 3 : beat() === 3 ? 2 : 1;
  [...$('sb-signal').children].forEach((el, i) => el.classList.toggle('off', i >= barsOn));
  const anchor = S.state.scene_anchor;
  const done = S.state.current_state === 'S06_Ending';
  $('contact-status').textContent = done ? '…' :
    'Kokugikan — ' + (SCENES[anchor] || (anchor ? anchor.replace(/_/g, ' ') : 'outside'));
  $('menu-sound').textContent = S.soundOn ? 'on' : 'off';
  $('menu-debug').textContent = S.debug ? 'on' : 'off';
}

function setTypingHeader(on) {
  const el = $('contact-status');
  el.classList.toggle('typing', on);
  if (on) { el.dataset.prev = el.textContent; el.textContent = 'yuki is typing…'; }
  else if (el.dataset.prev) { el.textContent = el.dataset.prev; delete el.dataset.prev; updateChrome(); }
}

/* --------------------------------------------------------------- render ---- */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function scrollDown() { chat.scrollTop = chat.scrollHeight; }

function chipLabel(meta) {
  if (meta.mode === 'chat') return `chat ${meta.exchanges_in_beat ?? '?'}/4 · ${meta.intent}`;
  if (meta.mode === 'nudge') return 'nudge';
  return `${meta.template_id} · ${meta.intent}${meta.forced ? ' · forced' : ''}`;
}

function addBubble(who, text, opts = {}) {
  if (opts.meta && S.debug) {
    const row = el('div', 'chip-row');
    row.appendChild(el('span', 'chip', chipLabel(opts.meta)));
    chat.appendChild(row);
  }
  const b = el('div', `bubble ${who}`, text);
  if (opts.onclick) b.addEventListener('click', opts.onclick, { once: true });
  chat.appendChild(b);
  scrollDown();
  return b;
}

let typingEl = null;
function showTyping() {
  if (typingEl) return;
  typingEl = el('div', 'typing');
  typingEl.append(el('i'), el('i'), el('i'));
  chat.appendChild(typingEl);
  scrollDown();
}
function hideTyping() { typingEl?.remove(); typingEl = null; }

function renderAll() {
  chat.innerHTML = '';
  chat.appendChild(el('div', 'divider', 'Today 23:47'));
  let prevWho = null;
  for (const m of S.transcript) {
    addBubble(m.who, m.text, { meta: m.who === 'yuki' && prevWho !== 'yuki' ? m.meta : null });
    prevWho = m.who;
  }
  updateChrome();
  scrollDown();
}

async function revealYuki(bubbles, meta) {
  setTypingHeader(true);
  for (let i = 0; i < bubbles.length; i++) {
    showTyping();
    const wait = Math.min(2400, 620 + bubbles[i].length * 22) + Math.random() * 280;
    await sleep(i === 0 ? Math.min(wait, 1500) : wait);
    hideTyping();
    S.transcript.push({ who: 'yuki', text: bubbles[i], meta: i === 0 ? meta : undefined });
    addBubble('yuki', bubbles[i], { meta: i === 0 ? meta : null });
    popIn();
    save();
  }
  setTypingHeader(false);
  lastYukiAt = Date.now();
}

/* ---------------------------------------------------------------- nudges --- */
function clearNudge() { if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; } }
function armNudge() {
  clearNudge();
  if (!S || S.state.current_state === 'S06_Ending') return;
  nudgeTimer = setTimeout(fireNudge, 25000 + Math.random() * 20000);
}
async function fireNudge() {
  nudgeTimer = null;
  if (busy || !S || S.state.current_state === 'S06_Ending') return;
  if (input.value.trim()) { nudgeTimer = setTimeout(fireNudge, 20000); return; } // they're typing
  const quiet = Math.round((Date.now() - (lastYukiAt || Date.now())) / 1000);
  try {
    const r = await fetch('api/nudge', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        state: S.state, quiet_s: quiet, session_id: S.sid,
        transcript_tail: S.transcript.slice(-24).map(m => ({ who: m.who, text: m.text })),
      }),
    });
    const data = await r.json();
    if (data?.yuki_messages && !busy && !input.value.trim()) {
      await revealYuki(data.yuki_messages, data.meta);
      save();
    }
  } catch { }
  // one nudge per lull — re-arms on the next player message
}

/* ---------------------------------------------------------------- turns ---- */
function setBusy(on) {
  busy = on;
  input.disabled = on;
  sendBtn.disabled = on || !input.value.trim();
  if (!on) input.focus();
}

const newSid = () => (crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function newStory() {
  setBusy(true);
  const sid = newSid();
  const r = await fetch(`api/new?sid=${sid}`).then(r => r.json()).catch(() => null);
  if (!r) { addBubble('system', '⚠ can\'t reach the story server — tap to retry', { onclick: newStory }); setBusy(false); return; }
  S = {
    sid, transcript: [], state: r.state, snapshots: [], soundOn: S?.soundOn ?? true,
    debug: S?.debug ?? new URLSearchParams(location.search).has('debug'),
    clockOffset: 0, coldOpenDone: false,
  };
  $('ending').classList.add('hidden');
  renderAll();
  await revealYuki(r.yuki_messages, null);
  S.coldOpenDone = true;
  save();
  setBusy(false);
  armNudge();
}

async function performTurn(text) {
  setBusy(true);
  const latency = lastYukiAt ? Math.round((Date.now() - lastYukiAt) / 1000) : 0;
  await sleep(700);
  const receipt = el('div', 'receipt', `Read ${clockStr()}`);
  chat.appendChild(receipt); scrollDown();
  await sleep(650);
  showTyping();
  let res, data;
  try {
    res = await fetch('api/turn', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        state: S.state, user_message: text, reply_latency_s: latency, session_id: S.sid,
        transcript_tail: S.transcript.slice(-24).map(m => ({ who: m.who, text: m.text })),
      }),
    });
    data = await res.json();
  } catch { data = null; }
  if (data && data.mode === 'stopped') {
    hideTyping(); setTypingHeader(false);
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(WAIVER_KEY);
    $('stopped').classList.remove('hidden');
    return;
  }
  if (!data || data.error) {
    hideTyping(); setTypingHeader(false);
    addBubble('system', '⚠ message didn\'t send — tap to retry', { onclick: () => { performTurn(text); } });
    setBusy(false);
    return;
  }
  S.state = data.state;
  S.clockOffset = (S.clockOffset || 0) + (data.mode === 'chat' ? 1 + Math.floor(Math.random() * 2) : 4 + Math.floor(Math.random() * 5));
  await revealYuki(data.yuki_messages, data.meta);
  updateChrome();
  save();
  if (data.ending) {
    await sleep(1800);
    showEnding(data.ending);
  } else {
    setBusy(false);
    armNudge();
  }
}

/* -------------------------------------------------------------- the word -- */
const isTheWord = (t) => /^stop[\s.!?…]*$/i.test(t.trim());

async function theWord(word) {
  clearNudge();
  setBusy(true);
  input.value = '';
  S.transcript.push({ who: 'user', text: word });
  addBubble('user', word);
  try {
    await fetch('api/turn', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: S.state, user_message: word, session_id: S.sid, transcript_tail: [] }),
    });
  } catch { }
  await sleep(1600);
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(WAIVER_KEY);
  $('stopped').classList.remove('hidden');
}

function sendMessage(text) {
  if (busy || !text.trim()) return;
  if (isTheWord(text)) { theWord(text.trim()); return; }
  clearNudge();
  swishOut();
  S.snapshots.push({
    state: JSON.parse(JSON.stringify(S.state)),
    tlen: S.transcript.length, clockOffset: S.clockOffset || 0,
  });
  S.transcript.push({ who: 'user', text });
  addBubble('user', text);
  save();
  input.value = '';
  performTurn(text);
}

/* --------------------------------------------------------------- ending ---- */
function showEnding(e) {
  const badge = $('ending-badge');
  const fam = (e.type || '').startsWith('good') ? 'good' : (e.type || '').startsWith('mixed') ? 'mixed' : 'bad';
  badge.className = 'ending-badge ' + fam;
  badge.textContent = (e.type || 'ending').replace(/_/g, ' ').toUpperCase();
  $('ending-route').textContent = (e.route || '').replace(/_/g, ' ');
  const facts = $('ending-facts');
  facts.innerHTML = '';
  const li = (k, v) => { const n = el('li', null, k + ' '); n.appendChild(el('b', null, v)); facts.appendChild(n); };
  li('kenji rescued', e.kenji_rescued ? 'yes' : 'no');
  li('yuki', String(e.yuki_status).replace(/_/g, ' '));
  li('ura', String(e.ura_status).replace(/_/g, ' '));
  li('evidence', String(e.evidence_status).replace(/_/g, ' '));
  $('ending').classList.remove('hidden');
  setBusy(true);
  input.disabled = true;
}

function rewind() {
  const snap = S.snapshots.pop();
  if (!snap) return;
  S.state = snap.state;
  S.transcript.length = snap.tlen;
  S.clockOffset = snap.clockOffset;
  $('ending').classList.add('hidden');
  hideTyping(); setTypingHeader(false);
  renderAll();
  save();
  setBusy(false);
  armNudge();
}

/* ------------------------------------------------------------------ wiring - */
composer.addEventListener('submit', (ev) => { ev.preventDefault(); sendMessage(input.value); });
input.addEventListener('input', () => { sendBtn.disabled = busy || !input.value.trim(); });

$('menu-btn').addEventListener('click', () => $('menu').classList.toggle('hidden'));
document.addEventListener('click', (ev) => {
  if (!$('menu').contains(ev.target) && ev.target !== $('menu-btn')) $('menu').classList.add('hidden');
});
$('menu').addEventListener('click', (ev) => {
  const act = ev.target.closest('button')?.dataset.act;
  $('menu').classList.add('hidden');
  if (act === 'restart' && confirm('start a new story? this one will be lost.')) {
    localStorage.removeItem(LS_KEY); localStorage.removeItem(WAIVER_KEY); location.reload();
  }
  if (act === 'rewind') rewind();
  if (act === 'sound') { S.soundOn = !S.soundOn; save(); updateChrome(); }
  if (act === 'debug') { S.debug = !S.debug; save(); renderAll(); }
  if (act === 'state') { $('state-pre').textContent = JSON.stringify(S.state, null, 2); $('state-overlay').classList.remove('hidden'); }
  if (act === 'reload') location.reload();
});

// Size the phone to the VISUAL viewport so the composer rides above the mobile
// keyboard and the chat re-pins to the newest bubble when it opens.
if (window.visualViewport) {
  const setVvh = () => {
    document.documentElement.style.setProperty('--vvh', `${Math.round(window.visualViewport.height)}px`);
    scrollDown();
  };
  window.visualViewport.addEventListener('resize', setVvh);
  setVvh();
}
$('state-close').addEventListener('click', () => $('state-overlay').classList.add('hidden'));
$('ending-restart').addEventListener('click', () => {
  localStorage.removeItem(LS_KEY); localStorage.removeItem(WAIVER_KEY); location.reload();
});
$('ending-rewind').addEventListener('click', rewind);

/* ----------------------------------------------------------------- waiver -- */
const WAIVER_KEY = 'qmm_waiver_v1';
const CLAUSES = [
  'I am at least 18 years of age, of sound mind, and I am doing this freely. No one is doing this to me. I am doing this to me.',
  'I understand that the Story is fiction. I understand that I will not always believe that. Everything I say to the Story is kept, and is used to build what comes next.',
  'I understand that the Story may contact me through channels I did not expect, at times I did not expect, including hours when I would prefer to be asleep.',
  'The Story will not use the voice of anyone I know.',
  'I understand that the Story may demonstrate knowledge of me that I do not remember providing, and that I will not always be able to determine how it was obtained.',
  'I understand that no schedule will be given to me. The Story may be silent for days. Silence is not an ending.',
  'I understand that during the course of the Story, some events in my life will have been arranged, and some will be coincidence, and I will not be able to tell which. I consent to this uncertainty. I understand that this uncertainty is the product I am purchasing.',
  'I accept that my telephone may display the Story\'s messages where other people can see them. I will not present the Story to people who have not consented. What my household believes is my responsibility.',
  'I understand that the Story is not a therapist, a crisis line, or a friend. It is a story that can hurt me.',
  'I release, waive, and forever discharge the Story from any and all claims arising from my participation, whether by negligence or otherwise, to the fullest extent permitted by law.',
];

function waiverSigned() {
  try { const w = JSON.parse(localStorage.getItem(WAIVER_KEY)); return !!(w && w.name); } catch { return false; }
}

function showWaiver() {
  const list = $('w-clauses');
  const initialsInput = $('w-initials'), nameInput = $('w-name'), signBtn = $('w-sign');
  $('w-date').textContent = new Date().toLocaleDateString();
  let stamped = 0;
  const refresh = () => {
    $('w-count').textContent = `Initials: ${stamped} of ${CLAUSES.length}`;
    signBtn.disabled = !(stamped === CLAUSES.length && nameInput.value.trim().length >= 2);
  };
  CLAUSES.forEach((text, i) => {
    const li = document.createElement('li');
    const num = el('span', 'num', `${i + 1}.`);
    const slot = el('span', 'slot', '');
    const body = el('span', 'text', text);
    li.append(num, slot, body);
    li.addEventListener('click', () => {
      if (li.classList.contains('stamped')) return;
      const ini = initialsInput.value.trim();
      if (ini.length < 2) { initialsInput.focus(); $('w-hint').textContent = '— initials first (at least 2 letters)'; return; }
      slot.textContent = ini;
      li.classList.add('stamped');
      stamped++;
      refresh();
    });
    list.appendChild(li);
  });
  nameInput.addEventListener('input', refresh);
  refresh();
  $('waiver').classList.remove('hidden');
  signBtn.addEventListener('click', () => {
    if (signBtn.disabled) return;
    signBtn.disabled = true;
    signBtn.textContent = '…';
    const record = { name: nameInput.value.trim().slice(0, 120), initials: initialsInput.value.trim().slice(0, 8), signed_at: new Date().toISOString() };
    try { localStorage.setItem(WAIVER_KEY, JSON.stringify(record)); } catch { }
    fetch('api/waiver', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
    }).catch(() => { });
    setTimeout(() => {
      $('waiver').classList.add('fading');
      setTimeout(() => $('waiver').classList.add('hidden'), 950);
      proceedBoot();
    }, 900);
  });
}

/* ------------------------------------------------------------------- boot -- */
function proceedBoot() {
  const saved = load();
  if (!saved) { newStory(); return; }
  S = saved;
  if (!S.sid) S.sid = newSid();
  renderAll();
  if (S.state.current_state === 'S06_Ending') { setBusy(true); input.disabled = true; return; }
  // If the last message is the player's (refresh mid-turn), offer a retry.
  const last = S.transcript[S.transcript.length - 1];
  if (last && last.who === 'user') {
    addBubble('system', '⚠ interrupted mid-reply — tap to resend', { onclick: () => performTurn(last.text) });
  }
  setBusy(false);
  lastYukiAt = Date.now();
  armNudge();
}

(function boot() {
  if (waiverSigned()) proceedBoot();
  else showWaiver();
})();
