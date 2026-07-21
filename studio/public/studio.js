/* QMM Author Studio — one-page app, hash-routed panels, no build step.
   All URLs relative (the gateway strips /qmm-author-studio). Write auth = x-studio-token,
   kept in localStorage and attached to every mutating call. */

'use strict';

const $ = (id) => document.getElementById(id);
const main = $('main');

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const esc = (s) => String(s ?? '');

/* ------------------------------------------------------------------ state */
const S = {
  health: null,
  modules: [],
  id: null,          // open module id
  draft: null,       // {manifest, pack, lore, revs}
  dirty: new Set(),  // 'manifest' | 'pack' | 'lore'
  lint: null,        // {errors, warnings}
  beat: 0,           // index into pack.families
  intent: null,      // active intent tab
};

/* -------------------------------------------------------------------- api */
async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  const token = localStorage.getItem('studio_token') || '';
  if (token) headers['x-studio-token'] = token;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.detail || data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

let toastTimer = null;
function toast(msg, isErr) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = el('div', 'toast' + (isErr ? ' err' : ''), msg);
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), isErr ? 7000 : 3200);
}

/* ------------------------------------------------------------------ strip */
function refreshStrip() {
  const strip = $('strip');
  if (!S.id || !S.draft) { strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  const bits = [`${S.id}`];
  bits.push(S.dirty.size ? `unsaved: ${[...S.dirty].join(', ')}` : 'saved');
  if (S.lint) bits.push(`${S.lint.errors.length} error(s), ${S.lint.warnings.length} warning(s)`);
  $('strip-text').innerHTML = '';
  $('strip-text').append(...bits.map((b, i) => {
    const s = el('span', i === 1 && S.dirty.size ? 'dirty' : '', (i ? '  ·  ' : '') + b);
    return s;
  }));
  $('btn-save').disabled = !S.dirty.size;
}

function markDirty(doc) { S.dirty.add(doc); refreshStrip(); }

async function saveAll() {
  if (!S.dirty.size) return;
  for (const doc of [...S.dirty]) {
    try {
      const { rev } = await api('PUT', `api/studio/draft/${S.id}/${doc}`, { doc: S.draft[doc], base_rev: S.draft.revs[doc] });
      S.draft.revs[doc] = rev;
      S.dirty.delete(doc);
    } catch (e) {
      if (e.status === 409) {
        toast(`${doc}: edited elsewhere (rev conflict). Reload the draft or overwrite via revert.`, true);
      } else if (e.status === 403 || e.status === 503) {
        toast(`${doc}: not saved — ${e.message}. Set the write token (bottom left).`, true);
      } else {
        toast(`${doc}: save failed — ${e.message}`, true);
      }
      refreshStrip();
      return;
    }
  }
  toast('saved');
  refreshStrip();
}

async function runValidate() {
  if (!S.id) return;
  try {
    S.lint = await api('POST', `api/studio/validate/${S.id}`, { target: 'draft' });
    refreshStrip();
    renderLintInto($('lint-panel'));
    toast(S.lint.errors.length ? `${S.lint.errors.length} error(s)` : 'no errors', !!S.lint.errors.length);
  } catch (e) { toast(`validate failed: ${e.message}`, true); }
}

function renderLintInto(host) {
  if (!host) return;
  host.innerHTML = '';
  if (!S.lint) return;
  for (const [level, items] of [['err', S.lint.errors], ['warn', S.lint.warnings]]) {
    for (const it of items) {
      const d = el('div', `item ${level}`);
      d.append(el('div', 'path', `${it.code} @ ${it.path}`), el('div', '', it.msg));
      host.appendChild(d);
    }
  }
  if (!host.children.length) host.appendChild(el('div', 'item', 'clean — no findings'));
}

/* ----------------------------------------------------------------- router */
const routes = { dash: renderDash, author: renderAuthor, story: renderStory, beats: renderBeats, lore: renderLore, test: renderTest, play: renderPlay, publish: renderPublish, signals: renderSignals };

function nav() {
  const h = location.hash || '#/';
  let m;
  if ((m = /^#\/m\/([^/]+)(?:\/(\w+))?$/.exec(h))) return openModule(decodeURIComponent(m[1]), m[2] || 'author');
  return show('dash');
}

async function openModule(id, panel) {
  if (S.id !== id || !S.draft) {
    try {
      S.draft = await api('GET', `api/studio/draft/${id}`);
    } catch (e) {
      if (e.status === 404) {
        // no draft yet — create one from live on first open
        try {
          await api('POST', 'api/studio/modules', { id });
          S.draft = await api('GET', `api/studio/draft/${id}`);
          toast('draft created from live');
        } catch (e2) { toast(`cannot open ${id}: ${e2.message}`, true); return show('dash'); }
      } else { toast(`cannot open ${id}: ${e.message}`, true); return show('dash'); }
    }
    S.id = id;
    S.dirty = new Set();
    S.lint = null;
    S.beat = 0;
    S.intent = null;
  }
  show(panel);
}

function show(panel) {
  document.body.classList.remove('drawer-open');
  const mt = $('mobilebar-title');
  if (mt) mt.textContent = S.id ? `${S.id} · ${panel === 'author' ? 'chat' : panel}` : 'QMM Studio';
  document.querySelectorAll('nav a[data-nav]').forEach(a => {
    a.classList.toggle('active', a.dataset.nav === panel);
  });
  $('nav-mod').style.display = S.id ? '' : 'none';
  $('nav-mod').textContent = S.id || 'module';
  $('nav-tweak').style.display = S.id ? '' : 'none';
  for (const a of document.querySelectorAll('nav a[data-nav]')) {
    if (a.dataset.nav === 'dash') continue;
    a.style.display = S.id ? '' : 'none';
    a.href = `#/m/${encodeURIComponent(S.id || '')}/${a.dataset.nav}`;
  }
  (routes[panel] || renderDash)();
  refreshStrip();
}

/* -------------------------------------------------------------- dashboard */
async function renderDash() {
  main.innerHTML = '';
  main.append(el('h1', '', 'Modules'), el('p', 'sub', 'pick a story to work on — you land in its Author chat; editors are one click away for tweaking'));
  let list;
  try { list = (await api('GET', 'api/studio/modules')).modules; S.modules = list; }
  catch (e) {
    main.append(el('p', 'boot', `cannot list modules: ${e.message}`));
    if (e.status === 403 || e.status === 503) main.append(el('p', 'boot', 'this studio gates ALL reads — set the write token (bottom left), then reload.'));
    return;
  }

  const cards = el('div', 'cards');
  for (const mod of list) {
    const c = el('div', 'card');
    c.append(el('h3', '', mod.title));
    const meta = el('div', 'meta');
    meta.textContent = `${mod.id} · live ${mod.live_version ?? '—'} · draft ${mod.draft_version ?? '—'}`;
    c.append(meta);
    const row = el('div', 'row');
    if (mod.has_live) row.append(badge(mod.publish ? 'live' : 'dev-only', mod.publish ? 'live' : 'warn'));
    if (mod.has_draft) row.append(badge(mod.draft_differs ? 'draft differs' : 'draft = live', mod.draft_differs ? 'warn' : 'ok'));
    const open = el('button', 'primary', 'Open chat');
    open.onclick = () => { location.hash = `#/m/${encodeURIComponent(mod.id)}`; };
    row.append(open);
    if (mod.has_draft && mod.has_live) {
      const rv = el('button', '', 'Discard draft');
      rv.className = 'danger';
      rv.onclick = async () => {
        if (!confirm(`Trash the draft of ${mod.id}? (kept aside, not deleted)`)) return;
        try { await api('DELETE', `api/studio/draft/${mod.id}`); if (S.id === mod.id) { S.id = null; S.draft = null; } renderDash(); }
        catch (e) { toast(e.message, true); }
      };
      row.append(rv);
    }
    c.append(row);
    cards.appendChild(c);
  }
  main.append(cards);

  main.append(el('h2', '', 'New module'));
  const form = el('div', 'card');
  form.style.maxWidth = '460px';
  const idIn = Object.assign(el('input'), { type: 'text', placeholder: 'module-id (slug)' });
  const titleIn = Object.assign(el('input'), { type: 'text', placeholder: 'Title' });
  const btn = el('button', 'primary', 'Create from scaffold');
  btn.onclick = async () => {
    try {
      await api('POST', 'api/studio/modules', { id: idIn.value.trim(), title: titleIn.value.trim() || idIn.value.trim(), scaffold: 'dark-demo' });
      location.hash = `#/m/${encodeURIComponent(idIn.value.trim())}`;
    } catch (e) { toast(e.message, true); }
  };
  form.append(labeled('id', idIn), labeled('title', titleIn), el('div', 'hint', 'scaffold = the dark-demo stub: fill every TODO before it validates'), btn);
  main.append(form);
}

function badge(text, cls) { return el('span', `badge ${cls || ''}`, text); }
function labeled(text, input) { const w = el('div'); w.append(el('label', '', text), input); return w; }

/* ------------------------------------------------------------------ story */
function renderStory() {
  const pack = S.draft.pack;
  const manifest = S.draft.manifest;
  main.innerHTML = '';
  main.append(el('h1', '', 'Story'), el('p', 'sub', 'meta, cold open, intents, voice'));

  const g = el('div', 'grid2');
  g.append(
    labeled('title (pack.meta)', bind(input(pack.meta.title), v => { pack.meta.title = v; markDirty('pack'); })),
    labeled('manifest title', bind(input(manifest.title), v => { manifest.title = v; markDirty('manifest'); })),
    labeled('version (managed by publish)', Object.assign(input(manifest.version), { disabled: true })),
    labeled('entitlement', selectInput(['free', 'paid', 'dev'], manifest.entitlement, v => { manifest.entitlement = v; markDirty('manifest'); })),
  );
  main.append(g);

  main.append(el('h2', '', 'Cold open'), el('p', 'hint', 'one bubble per line-box; macros allowed ({{time}}, {{pick:name:a|b|c}}…) — unknown {{braces}} reach players literally'));
  main.append(bulletEditor(pack.meta.cold_open, () => markDirty('pack')));

  main.append(el('h2', '', 'Voice example'));
  const voice = el('textarea', 'tpl');
  voice.value = esc(pack.meta.voice_example);
  voice.oninput = () => { pack.meta.voice_example = voice.value; markDirty('pack'); };
  main.append(voice);

  main.append(el('h2', '', 'Intents'), el('p', 'hint', 'the router taxonomy — every beat needs a template per intent; OTHER is the mandatory fallback'));
  const tbl = el('table', 'updates');
  tbl.innerHTML = '<thead><tr><th>intent</th><th>description</th><th></th></tr></thead>';
  const tb = el('tbody');
  for (const [name, desc] of Object.entries(pack.meta.intents)) {
    const tr = el('tr');
    const nameTd = el('td'); nameTd.append(el('code', '', name));
    const descTd = el('td');
    descTd.append(bind(input(desc), v => { pack.meta.intents[name] = v; markDirty('pack'); }));
    const rmTd = el('td');
    if (name !== 'OTHER') {
      const rm = el('button', 'danger', '×');
      rm.onclick = () => { delete pack.meta.intents[name]; markDirty('pack'); renderStory(); };
      rmTd.append(rm);
    }
    tr.append(nameTd, descTd, rmTd);
    tb.appendChild(tr);
  }
  tbl.append(tb);
  main.append(tbl);
  const addRow = el('div', 'row');
  const newName = Object.assign(input(''), { placeholder: 'NEW_INTENT' });
  const add = el('button', '', 'Add intent');
  add.onclick = () => {
    const n = newName.value.trim().toUpperCase().replace(/[^A-Z_]/g, '');
    if (!n || pack.meta.intents[n]) return;
    pack.meta.intents[n] = '';
    markDirty('pack');
    renderStory();
    toast(`added ${n} — every beat now needs a ${n} template (validate will hold you to it)`);
  };
  addRow.append(newName, add);
  addRow.style.marginTop = '8px';
  main.append(addRow);

  main.append(el('h2', '', 'SillyTavern bridge'), el('p', 'hint', 'take the module into the ST workbench: the protagonist as a character card, lore (+ beat templates) as a World Info book. Edits in ST flow back via lorebook export → Lore panel import; template entries are one-way and auto-skipped on re-import.'));
  const stRow = el('div', 'row');
  const dlCard = el('button', '', `Download ${manifest.character?.name || 'character'} card (.json)`);
  dlCard.onclick = () => downloadJson(`api/studio/st/card/${S.id}`, `${(manifest.character?.name || 'character').toLowerCase()}-card.json`);
  let withTpl = true;
  const tplToggle = el('button', '', 'templates: on');
  tplToggle.onclick = () => { withTpl = !withTpl; tplToggle.textContent = `templates: ${withTpl ? 'on' : 'off'}`; };
  const dlBook = el('button', '', 'Download World Info (.json)');
  dlBook.onclick = () => downloadJson(`api/studio/st/lorebook/${S.id}?templates=${withTpl ? 1 : 0}`, `QMM — ${S.id}.json`);
  stRow.append(dlCard, dlBook, tplToggle);
  main.append(stRow);

  main.append(el('h2', '', 'Validation'));
  main.append(Object.assign(el('div', 'lint'), { id: 'lint-panel' }));
  renderLintInto($('lint-panel'));
}

async function downloadJson(path, filename) {
  try {
    const data = await api('GET', path);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { toast(`download failed: ${e.message}`, true); }
}

function input(v) { const i = el('input'); i.type = 'text'; i.value = esc(v); return i; }
function bind(inputEl, set) { inputEl.oninput = () => set(inputEl.value); return inputEl; }
function selectInput(opts, val, set) {
  const s = el('select');
  for (const o of opts) s.append(Object.assign(el('option', '', o), { value: o, selected: o === val }));
  s.onchange = () => set(s.value);
  return s;
}

function bulletEditor(arr, onChange) {
  const host = el('div', 'bullets');
  const render = () => {
    host.innerHTML = '';
    arr.forEach((v, i) => {
      const row = el('div', 'b');
      const t = el('textarea');
      t.value = esc(v);
      t.oninput = () => { arr[i] = t.value; onChange(); };
      const up = el('button', '', '↑');
      up.disabled = i === 0;
      up.onclick = () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; onChange(); render(); };
      const rm = el('button', 'danger', '×');
      rm.onclick = () => { arr.splice(i, 1); onChange(); render(); };
      row.append(t, up, rm);
      host.appendChild(row);
    });
    const add = el('button', '', '+ add');
    add.onclick = () => { arr.push(''); onChange(); render(); };
    host.appendChild(add);
  };
  render();
  return host;
}

/* ------------------------------------------------------------------ beats */
function renderBeats() {
  const pack = S.draft.pack;
  main.innerHTML = '';
  main.append(el('h1', '', 'Beats'), el('p', 'sub', 'the family chain — each beat is a from → to transition with one template per intent'));

  const chain = el('div', 'chain');
  pack.families.forEach((f, i) => {
    const b = el('div', 'beat' + (i === S.beat ? ' beat active' : ''));
    b.classList.add('beat');
    if (i === S.beat) b.classList.add('active');
    b.append(el('span', 'n', String(f.n)), document.createTextNode(f.from));
    b.onclick = () => { S.beat = i; S.intent = null; renderBeats(); };
    chain.append(b);
    if (i < pack.families.length - 1) chain.append(el('span', 'arrow', '→'));
  });
  main.append(chain);

  const f = pack.families[S.beat];
  if (!f) { main.append(el('p', 'boot', 'no beats')); return; }

  const g = el('div', 'grid3');
  g.append(
    labeled('from', bind(input(f.from), v => { f.from = v; markDirty('pack'); })),
    labeled('to', bind(input(f.to), v => { f.to = v; markDirty('pack'); })),
    labeled('bubbles [min,max]', bind(input(f.bubbles.join(',')), v => {
      const m = v.split(',').map(x => parseInt(x, 10));
      if (m.length === 2 && m.every(Number.isInteger)) { f.bubbles = m; markDirty('pack'); }
    })),
  );
  main.append(g);

  main.append(el('h2', '', 'Shared rules'));
  main.append(bulletEditor(f.shared_rules, () => markDirty('pack')));
  main.append(el('h2', '', 'Available context'));
  main.append(bulletEditor(f.available_context, () => markDirty('pack')));
  main.append(el('h2', '', 'Input fields'));
  main.append(labeled('comma-separated state fields shown to the model', bind(input(f.input_fields.join(', ')), v => {
    f.input_fields = v.split(',').map(s => s.trim()).filter(Boolean);
    markDirty('pack');
  })));

  // intent tabs
  const intents = Object.keys(pack.meta.intents);
  if (!S.intent || !intents.includes(S.intent)) S.intent = intents[0];
  const tabs = el('div', 'tabs');
  for (const it of intents) {
    const t = el('div', 'tab' + (it === S.intent ? ' active' : ''), it + (f.templates[it] ? '' : ' ∅'));
    t.onclick = () => { S.intent = it; renderBeats(); };
    tabs.append(t);
  }
  main.append(el('h2', '', 'Templates'), tabs);

  let tpl = f.templates[S.intent];
  if (!tpl) {
    const mk = el('button', 'primary', `Create ${S.intent} template for this beat`);
    mk.onclick = () => {
      f.templates[S.intent] = {
        id: `R${String(f.n).padStart(2, '0')}_${S.intent}`, intent: S.intent, intent_desc: pack.meta.intents[S.intent] || '',
        template: '', fill_guidance: [], updates: [{ field: 'current_state', kind: 'set', value: f.to, raw: `\`${f.to}\`` }],
      };
      markDirty('pack');
      renderBeats();
    };
    main.append(mk);
  } else {
    const tg = el('div', 'grid2');
    tg.append(
      labeled('template id', bind(input(tpl.id), v => { tpl.id = v; markDirty('pack'); })),
      labeled('intent description (router-facing)', bind(input(tpl.intent_desc), v => { tpl.intent_desc = v; markDirty('pack'); })),
    );
    main.append(tg);

    main.append(el('label', '', 'template — {{placeholders}} are model-filled; {{random/pick/time…}} resolve mechanically'));
    const ta = el('textarea', 'tpl');
    ta.value = esc(tpl.template);
    ta.oninput = () => { tpl.template = ta.value; markDirty('pack'); };
    main.append(ta);

    main.append(el('h2', '', 'Fill guidance'));
    main.append(bulletEditor(tpl.fill_guidance, () => markDirty('pack')));

    main.append(el('h2', '', 'State updates'), el('p', 'hint', 'mechanical — applied verbatim by the engine; cond raws outside the recognized patterns silently default to true (validator warns)'));
    main.append(updatesEditor(tpl, f));
  }

  main.append(el('h2', '', 'Validation'));
  main.append(Object.assign(el('div', 'lint'), { id: 'lint-panel' }));
  renderLintInto($('lint-panel'));
}

function updatesEditor(tpl, family) {
  const host = el('div');
  const render = () => {
    host.innerHTML = '';
    const tbl = el('table', 'updates');
    tbl.innerHTML = '<thead><tr><th>field</th><th>kind</th><th>value</th><th>raw</th><th></th></tr></thead>';
    const tb = el('tbody');
    tpl.updates.forEach((u, i) => {
      const tr = el('tr');
      const fieldTd = el('td');
      fieldTd.append(bind(input(u.field), v => { u.field = v; markDirty('pack'); }));
      const kindTd = el('td');
      kindTd.append(selectInput(['set', 'add', 'cond', 'set2', 'skip'], u.kind, v => { u.kind = v; markDirty('pack'); render(); }));
      const valTd = el('td');
      if (u.kind === 'set') {
        valTd.append(bind(input(u.value === true ? 'true' : u.value === false ? 'false' : esc(u.value)), v => {
          u.value = v === 'true' ? true : v === 'false' ? false : v;
          u.raw = typeof u.value === 'boolean' ? String(u.value) : `\`${u.value}\``;
          markDirty('pack'); render();
        }));
      } else if (u.kind === 'add') {
        const n = el('input'); n.type = 'number'; n.value = u.n ?? 1;
        n.oninput = () => { u.n = parseInt(n.value, 10) || 0; u.raw = (u.n >= 0 ? '+' : '') + u.n; markDirty('pack'); render(); };
        valTd.append(n);
      } else if (u.kind === 'set2') {
        valTd.append(
          bind(Object.assign(input(u.a), { placeholder: 'a (if)' }), v => { u.a = v; markDirty('pack'); }),
          bind(Object.assign(input(u.b), { placeholder: 'b (otherwise)' }), v => { u.b = v; markDirty('pack'); }),
        );
      } else if (u.kind === 'cond') {
        valTd.append(bind(Object.assign(input(u.raw), { placeholder: 'condition text (see evalCond patterns)' }), v => { u.raw = v; markDirty('pack'); }));
      } else {
        valTd.append(el('span', 'raw', '(preserved)'));
      }
      const rawTd = el('td', 'raw', u.kind === 'cond' ? '' : esc(u.raw));
      const rmTd = el('td');
      const rm = el('button', 'danger', '×');
      rm.onclick = () => { tpl.updates.splice(i, 1); markDirty('pack'); render(); };
      rmTd.append(rm);
      tr.append(fieldTd, kindTd, valTd, rawTd, rmTd);
      tb.appendChild(tr);
    });
    tbl.append(tb);
    host.append(tbl);
    const add = el('button', '', '+ add update');
    add.style.marginTop = '6px';
    add.onclick = () => { tpl.updates.push({ field: '', kind: 'set', value: '', raw: '``' }); markDirty('pack'); render(); };
    host.append(add);
  };
  render();
  return host;
}

/* ------------------------------------------------------------- test bench */
function renderTest() {
  const pack = S.draft.pack;
  main.innerHTML = '';
  main.append(el('h1', '', 'Test bench'), el('p', 'sub', 'dry-runs against the DRAFT — the prompt inspector shows exactly what the model gets'));

  const g = el('div', 'grid3');
  const beatSel = selectInput(pack.families.map(f => f.from), pack.families[S.beat]?.from ?? pack.families[0].from, () => {});
  const intentSel = selectInput(Object.keys(pack.meta.intents), S.intent || Object.keys(pack.meta.intents)[0], () => {});
  const msgIn = Object.assign(input('go check the vending machine'), { placeholder: 'player message' });
  g.append(labeled('beat (family from)', beatSel), labeled('intent (for fill)', intentSel), labeled('player message', msgIn));
  main.append(g);

  main.append(el('label', '', 'state JSON (merged over a fresh state; turn drives lore delay/cooldown)'));
  const stateTa = el('textarea');
  stateTa.style.minHeight = '70px';
  stateTa.value = '{"turn": 1, "danger_level": 0, "evidence_found": 0}';
  main.append(stateTa);

  const row = el('div', 'row');
  row.style.marginTop = '12px';
  const btnRoute = el('button', '', 'Route probe');
  const btnFill = el('button', 'primary', 'Fill preview');
  const btnChat = el('button', '', 'Chat probe');
  const btnScan = el('button', '', 'Lore scan (no model)');
  row.append(btnRoute, btnFill, btnChat, btnScan);
  main.append(row);

  const out = el('div');
  out.style.marginTop = '16px';
  main.append(out);

  const readState = () => { try { return JSON.parse(stateTa.value || '{}'); } catch { toast('state JSON does not parse', true); return null; } };
  const busy = (b) => [btnRoute, btnFill, btnChat, btnScan].forEach(x => x.disabled = b);

  async function run(kind) {
    const state = readState();
    if (!state) return;
    const body = {
      module_id: S.id, family_from: beatSel.value, intent: intentSel.value,
      message: msgIn.value, state,
    };
    busy(true);
    out.innerHTML = '';
    out.append(el('p', 'hint', kind === 'lore-scan' ? 'scanning…' : 'generating on the live model…'));
    try {
      const r = await api('POST', `api/studio/test/${kind}`, body);
      out.innerHTML = '';
      if (kind === 'route') {
        out.append(el('h2', '', `→ ${r.action} · ${r.intent} (${r.ms}ms${r.fallback ? ' · FALLBACK' : ''})`));
      } else if (kind !== 'lore-scan') {
        out.append(el('h2', '', `${r.bubbles.length} bubble(s) · ${r.ms}ms · rails applied: ${r.rails_applied}${r.fallback ? ' · FALLBACK' : ''}`));
        for (const b of r.bubbles) {
          const d = el('div', 'card', b);
          d.style.margin = '6px 0';
          d.style.maxWidth = '420px';
          out.append(d);
        }
      }
      if (r.lore) {
        out.append(el('h2', '', `lore fired: ${r.lore.fired.join(', ') || 'none'}`));
        out.append(loreTraceTable(r.lore.trace || r.trace || []));
      }
      if (kind === 'lore-scan' && r.trace) {
        out.append(el('h2', '', `lore fired: ${r.fired.join(', ') || 'none'} (budget ${r.budget_chars} chars)`));
        out.append(loreTraceTable(r.trace));
      }
      if (r.prompt) {
        const det = el('details');
        det.append(el('summary', '', 'prompt inspector — exactly what the model received'));
        const sys = el('pre', 'mono'); sys.textContent = 'SYSTEM\n──────\n' + r.prompt.sys;
        const usr = el('pre', 'mono'); usr.textContent = 'USER\n────\n' + r.prompt.usr;
        for (const p of [sys, usr]) { p.style.whiteSpace = 'pre-wrap'; p.style.background = 'var(--panel)'; p.style.padding = '10px'; p.style.borderRadius = '8px'; p.style.marginTop = '8px'; }
        det.append(sys, usr);
        out.append(det);
      }
      if (r.thinking) {
        const det = el('details');
        det.append(el('summary', '', 'model thinking'));
        const t = el('pre', 'mono'); t.textContent = r.thinking; t.style.whiteSpace = 'pre-wrap'; t.style.color = 'var(--muted)';
        det.append(t);
        out.append(det);
      }
    } catch (e) { out.innerHTML = ''; out.append(el('p', 'boot', `failed: ${e.message}`)); }
    busy(false);
  }

  btnRoute.onclick = () => run('route');
  btnFill.onclick = () => run('fill');
  btnChat.onclick = () => run('chat');
  btnScan.onclick = () => run('lore-scan');
}

function loreTraceTable(trace) {
  const tbl = el('table', 'updates');
  tbl.innerHTML = '<thead><tr><th>entry</th><th>outcome</th><th>detail</th></tr></thead>';
  const tb = el('tbody');
  for (const t of trace) {
    const tr = el('tr');
    tr.append(el('td', 'mono', t.id), el('td', '', t.outcome),
      el('td', 'raw', Object.entries(t).filter(([k]) => !['id', 'outcome'].includes(k)).map(([k, v]) => `${k}=${v}`).join(' ')));
    tb.appendChild(tr);
  }
  tbl.append(tb);
  return tbl;
}

/* --------------------------------------------------------------- playtest */
function renderPlay() {
  main.innerHTML = '';
  main.append(el('h1', '', 'Playtest'), el('p', 'sub', 'a real run of the DRAFT on the full engine — scratch sessions, never player data'));

  const wrap = el('div');
  wrap.style.display = 'grid';
  wrap.style.gridTemplateColumns = 'minmax(320px, 420px) 1fr';
  wrap.style.gap = '18px';

  const frame = el('iframe');
  frame.src = `playtest.html?module=${encodeURIComponent(S.id)}`;
  frame.style.width = '100%';
  frame.style.height = '720px';
  frame.style.border = '1px solid var(--line)';
  frame.style.borderRadius = '12px';
  frame.style.background = 'var(--bg)';
  wrap.append(frame);

  const side = el('div');
  side.append(el('h2', '', 'State inspector'));
  const statePre = el('pre', 'mono', '(state appears after the first turn)');
  statePre.style.whiteSpace = 'pre-wrap';
  statePre.style.background = 'var(--panel)';
  statePre.style.padding = '10px';
  statePre.style.borderRadius = '8px';
  side.append(statePre);
  side.append(el('h2', '', 'Turn log'));
  const log = el('div', 'lint');
  side.append(log);
  wrap.append(side);
  main.append(wrap);

  window.onmessage = (e) => {
    if (!e.data?.qmmPlaytest) return;
    if (e.data.state) statePre.textContent = JSON.stringify(e.data.state, null, 2);
    if (e.data.kind === 'turn' && e.data.meta) {
      const it = el('div', 'item', `${e.data.meta.mode} · ${e.data.meta.intent ?? ''} ${e.data.meta.template_id ?? ''} · lore: ${(e.data.meta.lore_fired || []).join(',') || '—'}`);
      log.prepend(it);
    }
    if (e.data.ending) log.prepend(el('div', 'item warn', `ENDING: ${e.data.ending.route} (${e.data.ending.type})`));
  };
}

/* ---------------------------------------------------------------- publish */
async function renderPublish() {
  main.innerHTML = '';
  main.append(el('h1', '', 'Publish'), el('p', 'sub', 'draft → validate → version bump → snapshot → live install → player hot-reload'));

  // diff
  main.append(el('h2', '', 'Draft vs live'));
  const diffHost = el('div', 'lint');
  main.append(diffHost);
  try {
    const diff = await api('GET', `api/studio/diff/${S.id}`);
    let any = false;
    for (const [doc, paths] of Object.entries(diff)) {
      for (const p of paths) { any = true; diffHost.append(el('div', 'item', `${doc}: ${p}`)); }
    }
    if (!any) diffHost.append(el('div', 'item', 'draft is identical to live — nothing to publish'));
  } catch (e) { diffHost.append(el('div', 'item err', `diff failed: ${e.message}`)); }

  // validation
  main.append(el('h2', '', 'Validation'));
  const lintHost = Object.assign(el('div', 'lint'), { id: 'lint-panel' });
  main.append(lintHost);
  try {
    S.lint = await api('POST', `api/studio/validate/${S.id}`, { target: 'draft' });
    renderLintInto(lintHost);
    refreshStrip();
  } catch (e) { lintHost.append(el('div', 'item err', `validate failed: ${e.message}`)); }

  // player-catalog listing — the switch that makes a published story REAL for players
  main.append(el('h2', '', 'Player catalog'));
  const listed = S.draft.manifest.publish === true;
  const listRow = el('div', 'row');
  listRow.append(badge(listed ? 'LISTED — players can get this story' : 'dev-only — hidden from players', listed ? 'live' : 'warn'));
  const flip = el('button', listed ? 'danger' : 'primary', listed ? 'Make dev-only (delist)' : 'List for players');
  flip.onclick = async () => {
    const manifest = S.draft.manifest;
    if (!listed && !confirm(`List "${manifest.title}" in the player catalog? After the next publish, real players can play it.`)) return;
    manifest.publish = !listed;
    try {
      const { rev } = await api('PUT', `api/studio/draft/${S.id}/manifest`, { doc: manifest, base_rev: S.draft.revs.manifest });
      S.draft.revs.manifest = rev;
      toast(manifest.publish ? 'listed — publish to make it live' : 'delisted — publish to hide it');
      renderPublish();
    } catch (e) { toast(e.message, true); }
  };
  listRow.append(flip);
  main.append(listRow, el('p', 'hint', 'the flag ships with the next publish. The live player hides dev-only modules from its catalog; playtest here sees everything.'));

  // publish controls
  main.append(el('h2', '', 'Publish'));
  const g = el('div', 'grid3');
  const bumpSel = selectInput(['patch', 'minor', 'major'], 'patch', () => {});
  const noteIn = Object.assign(input(''), { placeholder: 'publish note (optional)' });
  g.append(labeled('version bump', bumpSel), labeled('note', noteIn));
  main.append(g);
  const pubBtn = el('button', 'primary', 'Publish to live');
  pubBtn.style.marginTop = '10px';
  pubBtn.disabled = !!S.lint?.errors?.length || !!S.dirty.size;
  if (S.dirty.size) main.append(el('p', 'hint', 'save your changes first — publish reads the draft from disk'));
  const result = el('div', 'lint');
  result.style.marginTop = '10px';
  main.append(pubBtn, result);

  pubBtn.onclick = async (ev, accepted) => {
    result.innerHTML = '';
    try {
      const r = await api('POST', `api/studio/publish/${S.id}`, { bump: bumpSel.value, note: noteIn.value, accept_warnings: !!accepted });
      if (r.status === 'needs_confirm') {
        result.append(el('div', 'item warn', `${r.warnings.length} warning(s) — review above, then confirm`));
        pubBtn.textContent = 'Publish despite warnings';
        pubBtn.onclick = async () => {
          try {
            const r2 = await api('POST', `api/studio/publish/${S.id}`, { bump: bumpSel.value, note: noteIn.value, accept_warnings: true });
            showPublishResult(result, r2);
            if (r2.status === 'published') { toast(`published ${r2.version}`); S.draft = await api('GET', `api/studio/draft/${S.id}`); renderPublish(); }
          } catch (e2) { result.append(el('div', 'item err', `publish failed: ${e2.message}`)); }
        };
        return;
      }
      showPublishResult(result, r);
      if (r.status === 'published') { toast(`published ${r.version}`); S.draft = await api('GET', `api/studio/draft/${S.id}`); renderPublish(); }
    } catch (e) {
      if (e.status === 422 && e.data?.errors) {
        result.append(el('div', 'item err', `publish blocked: ${e.data.errors.length} error(s) — see validation above`));
      } else result.append(el('div', 'item err', `publish failed: ${e.message}`));
    }
  };

  // versions / rollback
  main.append(el('h2', '', 'Published versions'));
  const vh = el('div', 'lint');
  main.append(vh);
  try {
    const { versions } = await api('GET', `api/studio/versions/${S.id}`);
    if (!versions.length) vh.append(el('div', 'item', 'no snapshots yet'));
    for (const v of versions) {
      const it = el('div', 'item');
      it.style.display = 'flex';
      it.style.alignItems = 'center';
      it.style.gap = '10px';
      const txt = el('span', '', `${v.version}  ·  ${v.published_at ? v.published_at.slice(0, 16).replace('T', ' ') : '(no meta)'}  ${v.note ? '· ' + v.note : ''}`);
      txt.style.flex = '1';
      const rb = el('button', 'danger', 'Roll back to this');
      rb.onclick = async () => {
        if (!confirm(`Roll LIVE back to ${v.version}?`)) return;
        try {
          const r = await api('POST', `api/studio/rollback/${S.id}`, { version: v.version });
          toast(`rolled back to ${v.version}${r.reload?.ok ? ' (player reloaded)' : ' — PLAYER RELOAD FAILED'}`, !r.reload?.ok);
          renderPublish();
        } catch (e) { toast(e.message, true); }
      };
      it.append(txt, rb);
      vh.append(it);
    }
  } catch (e) { vh.append(el('div', 'item err', `versions: ${e.message}`)); }
}

function showPublishResult(host, r) {
  host.innerHTML = '';
  if (r.status === 'published') {
    host.append(el('div', 'item', `published ${r.from_version} → ${r.version} (snapshot ${r.snapshot})`));
    if (r.reload?.ok) host.append(el('div', 'item', `player reloaded: ${(r.reload.modules || []).join(', ')}`));
    else {
      const it = el('div', 'item err', `PLAYER RELOAD FAILED (${r.reload?.error || r.reload?.status || '?'}) — files are live on disk; retry:`);
      const retry = el('button', '', 'Retry reload');
      retry.style.marginLeft = '8px';
      retry.onclick = async () => {
        const rr = await api('POST', 'api/studio/reload-player');
        toast(rr.ok ? 'player reloaded' : `still failing: ${rr.error || rr.status}`, !rr.ok);
      };
      it.append(retry);
      host.append(it);
    }
  }
}

/* ------------------------------------------------------------------- lore */
function renderLore() {
  main.innerHTML = '';
  main.append(el('h1', '', 'Lore workbench'), el('p', 'sub', 'keyed lore with timed effects + equivoque groups, and the de-anchor rails'));

  if (!S.draft.lore) {
    const mk = el('button', 'primary', 'Create the lore sidecar for this module');
    mk.onclick = () => { S.draft.lore = { lore: { budget_pct: 10, scan_depth: 8, entries: [] }, rails: [] }; markDirty('lore'); renderLore(); };
    main.append(mk);
    return;
  }
  const doc = S.draft.lore;
  doc.lore ||= { budget_pct: 10, scan_depth: 8, entries: [] };
  doc.lore.entries ||= [];
  doc.rails ||= [];
  const dirty = () => markDirty('lore');

  // header knobs — budget is a PERCENT of the context window, never an absolute
  const g = el('div', 'grid3');
  const bp = el('input'); bp.type = 'number'; bp.min = 1; bp.max = 100; bp.value = doc.lore.budget_pct ?? 10;
  bp.oninput = () => { doc.lore.budget_pct = parseInt(bp.value, 10) || 10; dirty(); };
  const sd = el('input'); sd.type = 'number'; sd.min = 1; sd.value = doc.lore.scan_depth ?? 8;
  sd.oninput = () => { doc.lore.scan_depth = parseInt(sd.value, 10) || 8; dirty(); };
  const budgetHint = el('div', 'hint', `≈ ${Math.floor((S.health?.num_ctx || 32768) * ((doc.lore.budget_pct ?? 10) / 100) * 4)} chars at the current window (${S.health?.num_ctx || 32768} ctx)`);
  bp.addEventListener('input', () => budgetHint.textContent = `≈ ${Math.floor((S.health?.num_ctx || 32768) * ((parseInt(bp.value, 10) || 10) / 100) * 4)} chars at the current window`);
  const bpw = labeled('budget (% of context window)', bp); bpw.append(budgetHint);
  g.append(bpw, labeled('scan depth (messages)', sd));
  main.append(g);

  // entries table
  main.append(el('h2', '', `Entries (${doc.lore.entries.length})`));
  const host = el('div');
  main.append(host);
  const renderEntries = () => {
    host.innerHTML = '';
    doc.lore.entries.forEach((e, i) => {
      const c = el('div', 'card');
      c.style.marginBottom = '10px';
      const top = el('div', 'grid3');
      top.append(
        labeled('id', bind(input(e.id), v => { e.id = v; dirty(); })),
        labeled('keys (comma-sep; /regex/i allowed)', bind(input((e.keys || []).join(', ')), v => { e.keys = v.split(',').map(s => s.trim()).filter(Boolean); dirty(); })),
        labeled('group (equivoque lock)', bind(input(e.group || ''), v => { if (v) e.group = v; else delete e.group; dirty(); })),
      );
      c.append(top);
      c.append(el('label', '', 'content (injected line; macros allowed)'));
      const ta = el('textarea'); ta.style.minHeight = '48px'; ta.value = esc(e.content);
      ta.oninput = () => { e.content = ta.value; dirty(); };
      c.append(ta);
      const nums = el('div', 'grid3');
      const numField = (name, hint) => {
        const n = el('input'); n.type = 'number'; n.min = 0; n.value = e[name] ?? (name === 'probability' ? 100 : name === 'order' ? 0 : 0);
        n.oninput = () => { const val = parseInt(n.value, 10); if (name === 'probability' ? val < 100 : val > 0) e[name] = val; else delete e[name]; dirty(); };
        return labeled(hint, n);
      };
      nums.append(numField('order', 'order (higher = first claim on budget)'), numField('probability', 'probability %'), numField('delay', 'delay (turns dormant)'));
      const nums2 = el('div', 'grid3');
      nums2.append(numField('cooldown', 'cooldown (turns quiet after fire)'), numField('sticky', 'sticky (turns it persists)'), (() => {
        const w = el('div');
        w.append(el('label', '', 'flags'));
        const row = el('div', 'row');
        const cb = (name, label) => {
          const b = el('button', '', `${label}: ${e[name] ? 'on' : 'off'}`);
          b.onclick = () => { if (e[name]) delete e[name]; else e[name] = true; dirty(); renderEntries(); };
          return b;
        };
        const en = el('button', '', `enabled: ${e.enabled === false ? 'NO' : 'yes'}`);
        en.onclick = () => { if (e.enabled === false) delete e.enabled; else e.enabled = false; dirty(); renderEntries(); };
        row.append(cb('constant', 'constant'), cb('case_sensitive', 'case'), en);
        const rm = el('button', 'danger', 'delete');
        rm.onclick = () => { doc.lore.entries.splice(i, 1); dirty(); renderLore(); };
        row.append(rm);
        w.append(row);
        return w;
      })());
      c.append(nums, nums2);
      host.appendChild(c);
    });
    const add = el('button', '', '+ add entry');
    add.onclick = () => { doc.lore.entries.push({ id: `entry-${doc.lore.entries.length + 1}`, keys: [], content: '' }); dirty(); renderLore(); };
    host.append(add);
  };
  renderEntries();

  // ST import
  main.append(el('h2', '', 'Import a SillyTavern lorebook'));
  const imp = el('div', 'card');
  imp.style.maxWidth = '520px';
  const file = el('input'); file.type = 'file'; file.accept = '.json,application/json';
  const mergeBtn = el('button', '', 'merge: on');
  let mergeOn = true;
  mergeBtn.onclick = () => { mergeOn = !mergeOn; mergeBtn.textContent = `merge: ${mergeOn ? 'on' : 'off'}`; };
  const go = el('button', 'primary', 'Import');
  go.onclick = async () => {
    const f = file.files?.[0];
    if (!f) return toast('pick an exported lorebook .json first', true);
    if (S.dirty.has('lore')) return toast('save (or discard) your lore edits first — import writes the sidecar directly', true);
    try {
      const st_book = JSON.parse(await f.text());
      const r = await api('POST', `api/studio/import-lorebook/${S.id}`, { st_book, merge: mergeOn, base_rev: S.draft.revs.lore });
      S.draft = await api('GET', `api/studio/draft/${S.id}`);
      toast(`imported ${r.imported} entries${r.warnings.length ? ` — ${r.warnings.length} warning(s)` : ''}`);
      if (r.warnings.length) console.warn('[import]', r.warnings);
      renderLore();
      const warnHost = $('import-warnings');
      if (warnHost) { warnHost.innerHTML = ''; r.warnings.forEach(w => warnHost.append(el('div', 'item warn', w))); }
    } catch (e) { toast(`import failed: ${e.message}`, true); }
  };
  imp.append(labeled('SillyTavern World Info export (.json)', file), el('div', 'row'));
  imp.lastChild.append(mergeBtn, go);
  main.append(imp);
  main.append(Object.assign(el('div', 'lint'), { id: 'import-warnings' }));

  // rails
  main.append(el('h2', '', `Rails (${doc.rails.length})`), el('p', 'hint', 'regex post-processing of generated bubbles — the mechanical de-anchor. A rail can never blank the character (all-dead → originals kept).'));
  const rh = el('div');
  main.append(rh);
  const renderRails = () => {
    rh.innerHTML = '';
    const tbl = el('table', 'updates');
    tbl.innerHTML = '<thead><tr><th>find (regex)</th><th>replace</th><th>flags</th><th></th></tr></thead>';
    const tb = el('tbody');
    doc.rails.forEach((r, i) => {
      const tr = el('tr');
      const f1 = el('td'); f1.append(bind(input(r.find), v => { r.find = v; dirty(); testRail(); }));
      const f2 = el('td'); f2.append(bind(input(r.replace ?? ''), v => { r.replace = v; dirty(); testRail(); }));
      const f3 = el('td'); f3.append(bind(input(r.flags ?? 'gi'), v => { r.flags = v; dirty(); testRail(); }));
      const f4 = el('td');
      const rm = el('button', 'danger', '×');
      rm.onclick = () => { doc.rails.splice(i, 1); dirty(); renderRails(); };
      f4.append(rm);
      tr.append(f1, f2, f3, f4);
      tb.appendChild(tr);
    });
    tbl.append(tb);
    rh.append(tbl);
    const add = el('button', '', '+ add rail');
    add.style.marginTop = '6px';
    add.onclick = () => { doc.rails.push({ find: '', replace: '', flags: 'gi' }); dirty(); renderRails(); };
    rh.append(add);
  };
  renderRails();

  main.append(el('h2', '', 'Rail tester'));
  const testIn = el('textarea');
  testIn.style.minHeight = '44px';
  testIn.value = "okay. i'll check the storeroom. my hands shaking so bad";
  const testOut = el('pre', 'mono');
  testOut.style.cssText = 'white-space:pre-wrap;background:var(--panel);padding:10px;border-radius:8px;margin-top:8px;';
  const testRail = () => {
    let s = testIn.value;
    for (const r of doc.rails) {
      if (!r.find) continue;
      try { s = s.replace(new RegExp(r.find, r.flags ?? 'gi'), r.replace ?? ''); } catch { /* bad regex: skip */ }
    }
    s = s.replace(/\s{2,}/g, ' ').trim();
    testOut.textContent = s || '(blanked — the engine would keep the original)';
  };
  testIn.oninput = testRail;
  testRail();
  main.append(testIn, testOut);
}

/* ------------------------------------------------------------ author chat */
/* Agent-style: the default, top-level surface. The engine is "an agent with a story-building
   skill" — live tool chips + thinking folds stream in; mic in, voice out; history persists
   per module in localStorage. */

const chatStoreKey = (id) => `qmm_author_chat_${id}`;
const stripThink = (s) => String(s || '').replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').trim();
const thinkOf = (s) => [...String(s || '').matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/g)].map(x => x[1].trim()).filter(Boolean).join('\n\n');

function loadChat(id) {
  try { return { id, busy: false, ...JSON.parse(localStorage.getItem(chatStoreKey(id)) || '{}'), busy: false }; }
  catch { return { id, messages: [], busy: false }; }
}
function persistChat(chat) {
  try {
    const msgs = chat.messages.slice(-80); // cap growth; the draft is the real record
    localStorage.setItem(chatStoreKey(chat.id), JSON.stringify({ messages: msgs }));
  } catch { /* quota — drop persistence silently */ }
}

function renderAuthor() {
  main.innerHTML = '';
  const name = S.draft?.manifest?.character?.name;
  const wrap = el('div', 'agent-wrap');
  main.append(wrap);

  const head = el('div', 'agent-head');
  head.append(
    el('div', 'agent-avatar', '✍'),
    (() => {
      const w = el('div');
      w.append(el('div', 'agent-name', `Story agent — ${S.id}`), Object.assign(el('div', 'hint'), { id: 'agent-engines', textContent: 'engines: …' }));
      return w;
    })(),
  );
  wrap.append(head);

  api('GET', 'api/studio/author-info').then(i => {
    S.ttsEngine = i.tts?.engine || 'browser';
    const eng = $('agent-engines');
    if (eng) eng.textContent = `writes with ${i.model}${i.keyed ? '' : ' (keyless local)'} · the game runs on ${i.game_engine?.model || '?'} (tests hit the game engine)`;
  }).catch(() => {});

  if (!S.chat || S.chat.id !== S.id) S.chat = loadChat(S.id);
  if (!Array.isArray(S.chat.messages)) S.chat.messages = [];
  const chat = S.chat;

  const thread = el('div', 'agent-thread');
  wrap.append(thread);

  const addFold = (host, label, text, cls) => {
    const det = el('details', `fold ${cls || ''}`);
    det.append(el('summary', '', label));
    const pre = el('div', 'fold-body', text);
    det.append(pre);
    host.append(det);
    return det;
  };

  async function tryRecover() {
    try {
      const last = await api('GET', `api/studio/author-chat/${S.id}/last`);
      if (!last?.messages?.length || last.messages.length <= chat.messages.length) return false;
      const lastLocalUser = [...chat.messages].reverse().find(m => m.role === 'user')?.content;
      if (chat.messages.length && !last.messages.some(m => m.role === 'user' && m.content === lastLocalUser)) return false;
      chat.messages = last.messages;
      chat.lastLog = last.tool_log;
      persistChat(chat);
      S.draft = await api('GET', `api/studio/draft/${S.id}`);
      refreshStrip();
      return true;
    } catch { return false; }
  }

  const renderThread = () => {
    thread.innerHTML = '';
    if (!chat.messages.length) {
      thread.append(el('div', 'agent-empty', `direct the story in plain words — ${name ? name + ' and ' : ''}the whole module get built through this conversation. the editors in the sidebar are for tweaking my output by hand.`));
    }
    for (const m of chat.messages) {
      if (m.role === 'user') thread.append(el('div', 'msg user', m.content));
      else if (m.role === 'assistant') {
        const think = thinkOf(m.content);
        if (think) addFold(thread, 'thought', think, 'think');
        if (m.tool_calls?.length) {
          const row = el('div', 'chiprow');
          for (const tc of m.tool_calls) row.append(el('span', 'toolchip', tc.function?.name || 'tool'));
          thread.append(row);
        }
        const text = stripThink(m.content);
        if (text) thread.append(el('div', 'msg agent', text));
      }
    }
    thread.scrollTop = thread.scrollHeight;
  };
  renderThread();

  // a dangling user message with no reply = we probably lost a finished turn (phone lock,
  // dropped stream) — ask the server for it
  if (chat.messages.length && chat.messages[chat.messages.length - 1].role === 'user' && !chat.busy) {
    tryRecover().then(got => { if (got) { toast('recovered a finished turn from the server'); renderAuthor(); } });
  }

  // live area appended below history during a streamed turn
  const live = el('div', 'agent-thread live');
  wrap.append(live);

  // ---- composer -----------------------------------------------------------
  const composer = el('div', 'agent-composer');
  const ta = el('textarea');
  ta.placeholder = name ? `direct the story of ${name}…` : 'direct the story…';
  ta.rows = 2;
  const micBtn = el('button', 'iconbtn', '🎤');
  micBtn.title = 'hold a thought, tap, talk';
  const speakBtn = el('button', 'iconbtn', localStorage.getItem('studio_speak') === '1' ? '🔊' : '🔇');
  speakBtn.title = 'speak replies';
  const send = el('button', 'primary', 'Send');
  const stop = el('button', 'danger', 'Stop');
  stop.style.display = 'none';
  const reset = el('button', 'iconbtn', '🗑');
  reset.title = 'reset conversation (draft keeps everything already written)';
  composer.append(micBtn, ta, speakBtn, send, stop, reset);
  wrap.append(composer);

  reset.onclick = () => {
    if (!confirm('Reset this conversation? The draft keeps everything already written.')) return;
    localStorage.removeItem(chatStoreKey(S.id));
    S.chat = { id: S.id, messages: [], busy: false };
    renderAuthor();
  };

  // ---- voice out ----------------------------------------------------------
  speakBtn.onclick = () => {
    const on = localStorage.getItem('studio_speak') === '1';
    localStorage.setItem('studio_speak', on ? '0' : '1');
    speakBtn.textContent = on ? '🔇' : '🔊';
    if (on) { speechSynthesis?.cancel?.(); S.audioEl?.pause?.(); }
  };
  async function speak(text) {
    if (localStorage.getItem('studio_speak') !== '1' || !text) return;
    const clean = text.replace(/[*_`#>]|\[[^\]]*\]/g, '').slice(0, 2400);
    try {
      const token = localStorage.getItem('studio_token') || '';
      const r = await fetch('api/studio/tts', { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-token': token }, body: JSON.stringify({ text: clean }) });
      if (r.ok && (r.headers.get('content-type') || '').startsWith('audio/')) {
        const blob = await r.blob();
        S.audioEl?.pause?.();
        S.audioEl = new Audio(URL.createObjectURL(blob));
        S.audioEl.play();
        return;
      }
    } catch { /* fall through to browser voice */ }
    if ('speechSynthesis' in window) {
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(clean));
    }
  }

  // ---- voice in -----------------------------------------------------------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) micBtn.style.display = 'none';
  else {
    let rec = null;
    let baseText = '';
    micBtn.onclick = () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      baseText = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
      micBtn.classList.add('listening');
      rec.onresult = (ev) => {
        let finals = '', interim = '';
        for (const res of ev.results) (res.isFinal ? (finals += res[0].transcript + ' ') : (interim += res[0].transcript));
        if (finals) { baseText += finals; }
        ta.value = (baseText + interim).replace(/\s+/g, ' ');
      };
      rec.onend = () => { micBtn.classList.remove('listening'); rec = null; ta.focus(); };
      rec.onerror = () => { micBtn.classList.remove('listening'); rec = null; };
      rec.start();
    };
  }

  // ---- send (streamed) ----------------------------------------------------
  let aborter = null;
  async function sendTurn() {
    const text = ta.value.trim();
    if (!text || chat.busy) return;
    ta.value = '';
    chat.messages.push({ role: 'user', content: text });
    chat.busy = true;
    persistChat(chat);
    renderThread();
    live.innerHTML = '';
    send.style.display = 'none';
    stop.style.display = '';
    const status = el('div', 'agent-status', 'thinking…');
    live.append(status);

    aborter = new AbortController();
    try {
      const token = localStorage.getItem('studio_token') || '';
      const res = await fetch(`api/studio/author-chat/${S.id}?stream=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-studio-token': token },
        body: JSON.stringify({ messages: chat.messages }),
        signal: aborter.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let finalReply = '';
      let done = false;
      while (!done) {
        const { value, done: rdone } = await reader.read();
        if (rdone) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const evM = /^event: (.+)$/m.exec(frame);
          const dataM = /^data: (.+)$/m.exec(frame);
          if (!evM || !dataM) continue;
          const ev = evM[1];
          let data = {};
          try { data = JSON.parse(dataM[1]); } catch { continue; }
          if (ev === 'round') status.textContent = `working — round ${data.n}…`;
          else if (ev === 'working') status.textContent = `round ${data.round} — engine writing… ${data.elapsed_s}s (big builds take a while; work lands even if you leave)`;
          else if (ev === 'thinking') addFold(live, 'thinking', data.text, 'think');
          else if (ev === 'interim' && data.text) live.append(el('div', 'msg agent dim', data.text));
          else if (ev === 'tool') {
            const chip = el('span', `toolchip ${data.ok ? '' : 'bad'}`, `${data.tool}`);
            chip.title = data.summary;
            (live.lastElementChild?.classList?.contains('chiprow') ? live.lastElementChild : live.appendChild(el('div', 'chiprow'))).append(chip);
          } else if (ev === 'reply') finalReply = data.text || '';
          else if (ev === 'error') throw new Error(data.detail || data.error);
          else if (ev === 'done') {
            chat.messages = data.messages || chat.messages;
            done = true;
          }
          thread.scrollTop = thread.scrollHeight;
          live.scrollIntoView({ block: 'end' });
        }
      }
      persistChat(chat);
      S.draft = await api('GET', `api/studio/draft/${S.id}`);
      S.dirty = new Set();
      refreshStrip();
      speak(finalReply);
    } catch (e) {
      if (e.name !== 'AbortError') {
        const got = await tryRecover();
        if (got) toast('stream dropped but the turn finished — recovered from the server');
        else toast(`author chat failed: ${e.message}`, true);
      } else toast('stopped — tool work already done stays done');
    }
    aborter = null;
    chat.busy = false;
    live.innerHTML = '';
    send.style.display = '';
    stop.style.display = 'none';
    renderThread();
  }
  send.onclick = sendTurn;
  stop.onclick = () => aborter?.abort();
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTurn(); }
  });
  ta.focus();
}

/* ---------------------------------------------------------------- signals */
async function renderSignals() {
  main.innerHTML = '';
  main.append(el('h1', '', 'Signals'), el('p', 'sub', 'flight-log digest — aggregates only, no player text ever crosses this panel'));
  let d;
  try { d = await api('GET', `api/studio/signals?days=14&module_id=${encodeURIComponent(S.id)}`); }
  catch (e) { main.append(el('p', 'boot', `signals failed: ${e.message}`)); return; }

  const t = d.totals;
  const cards = el('div', 'cards');
  const stat = (label, value, cls) => {
    const c = el('div', 'card');
    c.append(el('div', 'meta', label), el('h3', cls || '', String(value)));
    return c;
  };
  cards.append(
    stat('turns (14d)', t.turns),
    stat('chat / advance', `${t.chat} / ${t.advance}`),
    stat('forced advances', t.forced, t.forced ? 'warn' : ''),
    stat('fallbacks (route/gen)', `${t.route_fallback} / ${t.gen_fallback}`),
    stat('parse fails', t.parse_fail, t.parse_fail ? 'warn' : ''),
    stat('BRACES incidents', t.braces, t.braces ? 'err' : ''),
    stat('sessions started', t.new_sessions),
    stat('STOP words', t.stop_words, t.stop_words ? 'warn' : ''),
  );
  main.append(cards);

  main.append(el('h2', '', 'Lore firing (14d)'));
  const lt = el('table', 'updates');
  lt.innerHTML = '<thead><tr><th>entry</th><th>fired</th></tr></thead>';
  const ltb = el('tbody');
  const fired = Object.entries(t.lore_fired).sort((a, b) => b[1] - a[1]);
  if (!fired.length) ltb.innerHTML = '<tr><td colspan=2 class="raw">no lore fired in range</td></tr>';
  for (const [id, n] of fired) {
    const tr = el('tr');
    tr.append(el('td', 'mono', id), el('td', '', String(n)));
    ltb.appendChild(tr);
  }
  lt.append(ltb);
  main.append(lt);

  if (Object.keys(t.endings).length) {
    main.append(el('h2', '', 'Endings (14d)'));
    const et = el('table', 'updates');
    et.innerHTML = '<thead><tr><th>ending</th><th>count</th></tr></thead>';
    const etb = el('tbody');
    for (const [k, n] of Object.entries(t.endings).sort((a, b) => b[1] - a[1])) {
      const tr = el('tr');
      tr.append(el('td', 'mono', k), el('td', '', String(n)));
      etb.appendChild(tr);
    }
    et.append(etb);
    main.append(et);
  }

  main.append(el('h2', '', 'By day'));
  const dt = el('table', 'updates');
  dt.innerHTML = '<thead><tr><th>day</th><th>turns</th><th>chat/adv</th><th>forced</th><th>fallbacks</th><th>route p50/p95</th><th>gen p50/p95</th><th>nudges</th></tr></thead>';
  const dtb = el('tbody');
  if (!d.days.length) dtb.innerHTML = '<tr><td colspan=8 class="raw">no flight-log entries in range</td></tr>';
  for (const s of d.days) {
    const tr = el('tr');
    tr.append(
      el('td', 'mono', s.day), el('td', '', String(s.turns)), el('td', '', `${s.chat}/${s.advance}`),
      el('td', '', String(s.forced)), el('td', '', `${s.route_fallback}/${s.gen_fallback}`),
      el('td', 'raw', s.route_ms.p50 == null ? '—' : `${s.route_ms.p50}/${s.route_ms.p95}ms`),
      el('td', 'raw', s.gen_ms.p50 == null ? '—' : `${s.gen_ms.p50}/${s.gen_ms.p95}ms`),
      el('td', '', String(s.nudges)),
    );
    dtb.appendChild(tr);
  }
  dt.append(dtb);
  main.append(dt);
}

/* ------------------------------------------------------- stubs (later phases) */
function renderStub(msg) {
  main.innerHTML = '';
  main.append(el('h1', '', 'Coming soon'), el('p', 'sub', typeof msg === 'string' ? msg : 'this panel lands in a later phase'));
}

/* ------------------------------------------------------------------- boot */
async function boot() {
  $('burger').onclick = () => document.body.classList.toggle('drawer-open');
  $('drawer-backdrop').onclick = () => document.body.classList.remove('drawer-open');
  $('token').value = localStorage.getItem('studio_token') || '';
  $('token').onchange = () => localStorage.setItem('studio_token', $('token').value.trim());
  $('btn-save').onclick = saveAll;
  $('btn-validate').onclick = runValidate;
  window.addEventListener('hashchange', nav);
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveAll(); }
  });
  try {
    S.health = await api('GET', 'api/health');
    $('dot-player').classList.toggle('ok', !!S.health.player?.reachable);
    $('dot-ollama').classList.toggle('ok', !!S.health.ollama?.reachable);
    if (S.health.player?.num_ctx_skew) toast('NUM_CTX skew: studio and player disagree — fill-preview budgets differ from live', true);
  } catch { /* offline studio still renders */ }
  nav();
}
boot();
