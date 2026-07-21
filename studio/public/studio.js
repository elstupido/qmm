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
const routes = { dash: renderDash, story: renderStory, beats: renderBeats, lore: renderLore, test: renderStub, play: renderStub, publish: renderStub };

function nav() {
  const h = location.hash || '#/';
  let m;
  if ((m = /^#\/m\/([^/]+)\/(\w+)$/.exec(h))) return openModule(decodeURIComponent(m[1]), m[2]);
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
  document.querySelectorAll('nav a[data-nav]').forEach(a => {
    a.classList.toggle('active', a.dataset.nav === panel);
  });
  const inModule = !!S.id && panel !== 'dash';
  $('nav-mod').style.display = S.id ? '' : 'none';
  $('nav-mod').textContent = S.id || 'module';
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
  main.append(el('h1', '', 'Modules'), el('p', 'sub', 'live episodes and working drafts'));
  let list;
  try { list = (await api('GET', 'api/studio/modules')).modules; S.modules = list; }
  catch (e) { main.append(el('p', 'boot', `cannot list modules: ${e.message}`)); return; }

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
    const open = el('button', 'primary', mod.has_draft ? 'Open draft' : 'Edit (creates draft)');
    open.onclick = () => { location.hash = `#/m/${encodeURIComponent(mod.id)}/story`; };
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
      location.hash = `#/m/${encodeURIComponent(idIn.value.trim())}/story`;
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

  main.append(el('h2', '', 'Validation'));
  main.append(Object.assign(el('div', 'lint'), { id: 'lint-panel' }));
  renderLintInto($('lint-panel'));
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

/* ------------------------------------------------------- stubs (later phases) */
function renderLore() { renderStub('Lore workbench lands in Phase 7.'); }
function renderStub(msg) {
  main.innerHTML = '';
  main.append(el('h1', '', 'Coming soon'), el('p', 'sub', typeof msg === 'string' ? msg : 'this panel lands in a later phase'));
}

/* ------------------------------------------------------------------- boot */
async function boot() {
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
