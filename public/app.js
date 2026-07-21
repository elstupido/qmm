/* QMM — web client. State is SERVER-OWNED now (server/sessions.mjs): this channel identifies with a
   persistent user_id, pulls the shared session on load, and advances it via the API. The same session
   is reachable from the app and Telegram, so a player moves between channels and keeps one story. */
'use strict';

const $ = (id) => document.getElementById(id);
const chat = $('chat'), input = $('input'), sendBtn = $('send'), composer = $('composer');

const USER_KEY = 'qmm_user';        // persistent per-browser identity (stub for real login)
const PREFS_KEY = 'qmm_prefs';      // { module_id, soundOn, debug }
const WAIVER_KEY = 'qmm_waiver_v1'; // consent record (per story)

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

let S = null;          // in-memory view: {user_id, module_id, state, transcript, seq, soundOn, debug, clockOffset}
let busy = false;
let audioCtx = null;
let lastYukiAt = 0;    // when Yuki's last bubble landed (reply-latency + nudge timing)
let nudgeTimer = null; // silence timer

/* ------------------------------------------------------- identity / prefs -- */
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `u-${Date.now()}-${Math.random().toString(36).slice(2)}`);
function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } }
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ module_id: S.module_id, soundOn: S.soundOn, debug: S.debug })); } catch { } }

function ensureUser() {
  let u = null;
  try { u = localStorage.getItem(USER_KEY); } catch { }
  if (!u) { u = newId(); try { localStorage.setItem(USER_KEY, u); } catch { } }
  const prefs = loadPrefs();
  S = S || {};
  S.user_id = u;
  S.module_id = S.module_id || prefs.module_id || null;
  S.soundOn = prefs.soundOn ?? true;
  S.debug = prefs.debug ?? new URLSearchParams(location.search).has('debug');
  S.transcript = S.transcript || [];
  S.state = S.state || {};
  S.seq = S.seq || 0;
  S.clockOffset = S.clockOffset || 0;
}
async function ensureModule() {
  if (S.module_id) return;
  try { const cat = await fetch('api/modules').then(r => r.json()); S.module_id = cat.default || cat.modules?.[0]?.id; } catch { }
  if (!S.module_id) S.module_id = 'yuki-kokugikan-ep1';
  savePrefs();
}
const sessionUrl = () => `api/session?user_id=${encodeURIComponent(S.user_id)}&module_id=${encodeURIComponent(S.module_id)}`;

/* ------------------------------------------------------------- utilities -- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const beat = () => S?.state?.beat ?? 0;
const isEnded = () => { const cs = S?.state?.current_state || ''; return /_Ending$/.test(cs) || !!S?.state?.ending_type; };

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
  $('contact-status').textContent = isEnded() ? '…' :
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
  return `${meta.template_id} · ${meta.intent}${meta.forced ? ' · forced' : ''}${meta.lore_fired?.length ? ' · lore:' + meta.lore_fired.join(',') : ''}`;
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
  }
  setTypingHeader(false);
  lastYukiAt = Date.now();
}

/* --------------------------------------------------- cross-channel sync ---- */
// On focus, catch up if another channel (app / Telegram) advanced the shared session.
async function syncFromServer() {
  if (busy || !S?.user_id || !S?.module_id) return;
  try {
    const p = await fetch(sessionUrl()).then(r => r.json());
    if (p?.exists && (p.seq || 0) > (S.seq || 0)) {
      S.state = p.state; S.transcript = p.transcript || []; S.seq = p.seq || 0;
      hideTyping(); setTypingHeader(false);
      renderAll();
      if (isEnded()) { setBusy(true); input.disabled = true; }
    }
  } catch { }
}

/* ---------------------------------------------------------------- nudges --- */
function clearNudge() { if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; } }
function armNudge() {
  clearNudge();
  if (!S || isEnded()) return;
  nudgeTimer = setTimeout(fireNudge, 25000 + Math.random() * 20000);
}
async function fireNudge() {
  nudgeTimer = null;
  if (busy || !S || isEnded()) return;
  if (input.value.trim()) { nudgeTimer = setTimeout(fireNudge, 20000); return; } // they're typing
  const quiet = Math.round((Date.now() - (lastYukiAt || Date.now())) / 1000);
  try {
    const r = await fetch('api/nudge', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: S.user_id, module_id: S.module_id, quiet_s: quiet, channel: 'web' }),
    });
    const data = await r.json();
    if (data?.yuki_messages && !busy && !input.value.trim()) {
      if (data.seq) S.seq = data.seq;
      await revealYuki(data.yuki_messages, data.meta);
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

async function newStory() {
  setBusy(true);
  $('ending').classList.add('hidden');
  const r = await fetch(`api/new?user_id=${encodeURIComponent(S.user_id)}&module_id=${encodeURIComponent(S.module_id)}`)
    .then(r => r.json()).catch(() => null);
  if (!r || r.error) {
    chat.innerHTML = '';
    addBubble('system', '⚠ can\'t reach the story server — tap to retry', { onclick: newStory });
    setBusy(false); return;
  }
  S.state = r.state; S.seq = r.seq ?? 0; S.transcript = []; S.clockOffset = 0;
  renderAll();
  await revealYuki(r.yuki_messages, null);
  setBusy(false);
  armNudge();
}

async function performTurn(text) {
  setBusy(true);
  const latency = lastYukiAt ? Math.round((Date.now() - lastYukiAt) / 1000) : 0;
  await sleep(700);
  chat.appendChild(el('div', 'receipt', `Read ${clockStr()}`)); scrollDown();
  await sleep(650);
  showTyping();
  let data;
  try {
    const res = await fetch('api/turn', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: S.user_id, module_id: S.module_id, user_message: text, reply_latency_s: latency, channel: 'web' }),
    });
    data = await res.json();
  } catch { data = null; }
  if (data && data.mode === 'stopped') { endStopped(); return; }
  if (!data || data.error) {
    hideTyping(); setTypingHeader(false);
    addBubble('system', '⚠ message didn\'t send — tap to retry', { onclick: () => performTurn(text) });
    setBusy(false);
    return;
  }
  S.state = data.state; if (data.seq) S.seq = data.seq;
  S.clockOffset = (S.clockOffset || 0) + (data.mode === 'chat' ? 1 + Math.floor(Math.random() * 2) : 4 + Math.floor(Math.random() * 5));
  await revealYuki(data.yuki_messages, data.meta);
  updateChrome();
  if (data.ending) { await sleep(1800); showEnding(data.ending); }
  else { setBusy(false); armNudge(); }
}

/* -------------------------------------------------------------- the word -- */
const isTheWord = (t) => /^stop[\s.!?…]*$/i.test(t.trim());

function endStopped() {
  clearNudge();
  hideTyping(); setTypingHeader(false);
  try { localStorage.removeItem(WAIVER_KEY); } catch { } // consent is per story; re-entry re-signs
  $('stopped').classList.remove('hidden');
}

async function theWord(word) {
  clearNudge(); setBusy(true); input.value = '';
  S.transcript.push({ who: 'user', text: word });
  addBubble('user', word);
  try {
    await fetch('api/turn', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: S.user_id, module_id: S.module_id, user_message: word, channel: 'web' }),
    });
  } catch { }
  await sleep(1600);
  endStopped();
}

function sendMessage(text) {
  if (busy || !text.trim()) return;
  if (isTheWord(text)) { theWord(text.trim()); return; }
  clearNudge();
  swishOut();
  S.transcript.push({ who: 'user', text });
  addBubble('user', text);
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
  if (act === 'restart' && confirm('start a new story? this one will be lost.')) newStory();
  if (act === 'sound') { S.soundOn = !S.soundOn; savePrefs(); updateChrome(); }
  if (act === 'debug') { S.debug = !S.debug; savePrefs(); renderAll(); }
  if (act === 'state') { $('state-pre').textContent = JSON.stringify(S.state, null, 2); $('state-overlay').classList.remove('hidden'); }
  if (act === 'reload') location.reload();
});

// Size the phone to the VISUAL viewport so the composer rides above the mobile keyboard.
if (window.visualViewport) {
  const setVvh = () => {
    document.documentElement.style.setProperty('--vvh', `${Math.round(window.visualViewport.height)}px`);
    scrollDown();
  };
  window.visualViewport.addEventListener('resize', setVvh);
  setVvh();
}
$('state-close').addEventListener('click', () => $('state-overlay').classList.add('hidden'));
$('ending-restart').addEventListener('click', newStory);
// Catch up to another channel when the tab regains focus.
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncFromServer(); });

/* ----------------------------------------------------------------- waiver -- */
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
      body: JSON.stringify({ user_id: S.user_id, ...record }),
    }).catch(() => { });
    setTimeout(() => {
      $('waiver').classList.add('fading');
      setTimeout(() => $('waiver').classList.add('hidden'), 950);
      proceedBoot();
    }, 900);
  });
}

/* ------------------------------------------------------------------- boot -- */
async function proceedBoot() {
  ensureUser();
  await ensureModule();
  setBusy(true);
  let p = null;
  try { p = await fetch(sessionUrl()).then(r => r.json()); } catch { }
  if (!p) {
    chat.innerHTML = '';
    addBubble('system', '⚠ can\'t reach the story server — tap to retry', { onclick: proceedBoot });
    setBusy(false); return;
  }
  if (p.exists) {
    S.state = p.state; S.transcript = p.transcript || []; S.seq = p.seq || 0;
    S.clockOffset = 6 * (S.state.beat || 0);
    renderAll();
    if (isEnded()) { setBusy(true); input.disabled = true; return; }
    setBusy(false);
    lastYukiAt = Date.now();
    armNudge();
  } else {
    await newStory();
  }
}

(function boot() {
  ensureUser();                       // user_id ready before the waiver POST
  if (waiverSigned()) proceedBoot();
  else showWaiver();
})();
