/* Studio playtest pane — a slim adaptation of the player client's renderer (addBubble /
   typing / debug chips) driving /api/studio/play/* against DRAFT modules and scratch
   sessions. Runs inside an iframe on the studio origin, so it reads the write token
   straight from localStorage. Debug chips are always on — this is an authoring tool. */

'use strict';

const $ = (id) => document.getElementById(id);
const chat = $('chat');
const params = new URLSearchParams(location.search);
const MODULE = params.get('module') || '';

let PLAY = null;   // play_id
let ENDED = false;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-studio-token': localStorage.getItem('studio_token') || '' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
  return data;
}

function tellParent(msg) { try { parent.postMessage({ qmmPlaytest: true, ...msg }, location.origin); } catch { /* solo */ } }

function chipLabel(meta) {
  if (!meta) return '';
  if (meta.mode === 'chat') return `chat ${meta.exchanges_in_beat ?? '?'}/4 · ${meta.intent}${meta.lore_fired?.length ? ' · lore:' + meta.lore_fired.join(',') : ''}`;
  if (meta.mode === 'nudge') return 'nudge';
  return `${meta.template_id} · ${meta.intent}${meta.forced ? ' · forced' : ''}${meta.lore_fired?.length ? ' · lore:' + meta.lore_fired.join(',') : ''}`;
}

function addBubble(who, text, meta) {
  if (meta) {
    const row = el('div', 'chip-row');
    row.appendChild(el('span', 'chip', chipLabel(meta)));
    chat.appendChild(row);
  }
  chat.appendChild(el('div', `bubble ${who}`, text));
  chat.scrollTop = chat.scrollHeight;
}

let typingEl = null;
function showTyping() {
  if (typingEl) return;
  typingEl = el('div', 'typing');
  typingEl.append(el('i'), el('i'), el('i'));
  chat.appendChild(typingEl);
  chat.scrollTop = chat.scrollHeight;
}
function hideTyping() { typingEl?.remove(); typingEl = null; }

async function revealYuki(bubbles, meta) {
  let first = true;
  for (const b of bubbles) {
    showTyping();
    await new Promise(r => setTimeout(r, Math.min(1400, 350 + b.length * 12)));
    hideTyping();
    addBubble('yuki', b, first ? meta : null);
    first = false;
  }
}

function setClock() { $('sb-time').textContent = new Date().toTimeString().slice(0, 5); }

async function newRun() {
  chat.innerHTML = '';
  ENDED = false;
  try {
    const r = await api('api/studio/play/new', { module_id: MODULE });
    PLAY = r.play_id;
    $('contact-status').textContent = `playtest — ${r.module_id}`;
    tellParent({ kind: 'new', play_id: PLAY, module_id: r.module_id, state: r.state });
    await revealYuki(r.yuki_messages, null);
  } catch (e) {
    addBubble('system', `playtest failed to start: ${e.message}`);
  }
}

async function sendTurn(text) {
  addBubble('user', text);
  try {
    const r = await api('api/studio/play/turn', { play_id: PLAY, module_id: MODULE, message: text });
    if (r.mode === 'stopped') { addBubble('system', '— stopped (THE WORD) —'); ENDED = true; tellParent({ kind: 'stopped' }); return; }
    if (r.error) { addBubble('system', `error: ${r.error}`); return; }
    await revealYuki(r.yuki_messages, r.meta);
    tellParent({ kind: 'turn', play_id: PLAY, state: r.state, meta: r.meta, ending: r.ending || null });
    if (r.ending) {
      ENDED = true;
      addBubble('system', `— ending: ${r.ending.route ?? '?'} (${r.ending.type ?? '?'}) —`);
    }
  } catch (e) {
    addBubble('system', `turn failed: ${e.message}`);
  }
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('input').value.trim();
  if (!v || !PLAY || ENDED) return;
  $('input').value = '';
  sendTurn(v);
});

$('pt-nudge').onclick = async () => {
  if (!PLAY || ENDED) return;
  try {
    const r = await api('api/studio/play/nudge', { play_id: PLAY, module_id: MODULE, quiet_s: 30 });
    if (r.yuki_messages) await revealYuki(r.yuki_messages, r.meta);
  } catch (e) { addBubble('system', `nudge failed: ${e.message}`); }
};
$('pt-restart').onclick = newRun;

setClock();
setInterval(setClock, 30_000);
newRun();
