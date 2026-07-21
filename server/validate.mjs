// Module validator — the studio's lint layer, shared by the studio API, the publish gate, and
// tools/validate-module.mjs. Generalizes build-pack.mjs's checks (which were hardcoded to the
// Yuki story's 8 intents / 6 families) into rules any module must satisfy.
//
// validateModule({ manifest, pack, dirName?, liveModule?, ctxTokens? })
//   -> { errors: [{code, path, msg}], warnings: [{code, path, msg}] }
//
// `pack` is the MERGED pack (lore/rails sidecar already folded in, as loadModules does).
// Errors block publish; warnings inform. Pure function: no filesystem, no network.

import { NUM_CTX } from './engine.mjs';

const SEMVER = /^\d+\.\d+\.\d+$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,60}$/;
const FIELD = /^[a-z_][a-z0-9_]*$/;
const ENTITLEMENTS = new Set(['free', 'paid', 'dev']);
const UPDATE_KINDS = new Set(['set', 'add', 'cond', 'set2', 'skip']);
const BREACH_TYPES = new Set(['hot_reading', 'nocebo', 'dual_reality']);
const BREACH_FIELDS = ['source', 'gate', 'transform', 'attribution', 'separation', 'out', 'fire_condition'];
const KNOWN_MACROS = new Set(['random', 'pick', 'time', 'time_of_day', 'date', 'weekday']);
// Mechanical enforcement of the context policy: budgets are % of the window, never absolutes.
const ABSOLUTE_CAP_KEYS = /^(budget_tokens|max_tokens|token_cap|context_cap|budget_chars|max_context)$/i;
// Mirrors evalCond in engine.mjs — a `cond` raw matching none of these silently defaults to true.
const EVALCOND_PATTERNS = [
  /evidence_found` is already greater than 0|prior proof exists/,
  /prior evidence is strong|evidence_found` is high|recording or `evidence_found/,
  /entry_method` was `stealth_entry/,
  /danger is high/,
];

const CHARS_PER_TOKEN = 4; // same heuristic as lore.mjs

export function validateModule({ manifest, pack, dirName, liveModule, ctxTokens = NUM_CTX }) {
  const errors = [];
  const warnings = [];
  const err = (code, path, msg) => errors.push({ code, path, msg });
  const warn = (code, path, msg) => warnings.push({ code, path, msg });

  // ------------------------------------------------------------ manifest ----
  if (!manifest || typeof manifest !== 'object') {
    err('manifest-missing', 'manifest', 'manifest.json missing or not an object');
    return { errors, warnings };
  }
  if (!SLUG.test(String(manifest.id || ''))) err('manifest-id', 'manifest.id', `id must match ${SLUG} (got ${JSON.stringify(manifest.id)})`);
  if (dirName && manifest.id !== dirName) err('manifest-id-dir', 'manifest.id', `id "${manifest.id}" != directory name "${dirName}"`);
  if (!manifest.story_id) warn('manifest-story-id', 'manifest.story_id', 'story_id missing');
  if (!Number.isInteger(manifest.episode) || manifest.episode < 1) err('manifest-episode', 'manifest.episode', 'episode must be an integer >= 1');
  if (!SEMVER.test(String(manifest.version || ''))) err('manifest-version', 'manifest.version', `version must be semver (got ${JSON.stringify(manifest.version)})`);
  if (!SEMVER.test(String(manifest.engine_min_version || ''))) err('manifest-engine-version', 'manifest.engine_min_version', 'engine_min_version must be semver');
  if (!manifest.title) err('manifest-title', 'manifest.title', 'title missing');
  if (!ENTITLEMENTS.has(manifest.entitlement)) err('manifest-entitlement', 'manifest.entitlement', `entitlement must be one of ${[...ENTITLEMENTS].join('/')}`);
  if (typeof manifest.publish !== 'boolean') err('manifest-publish', 'manifest.publish', 'publish must be boolean');
  const sp = manifest.safety_profile;
  if (!sp || typeof sp !== 'object') err('safety-profile', 'manifest.safety_profile', 'safety_profile missing');
  else {
    if (sp.stop !== true) err('safety-stop', 'manifest.safety_profile.stop', 'the STOP rail is non-negotiable: safety_profile.stop must be true');
    if (!Number.isInteger(sp.min_age) || sp.min_age < 18) err('safety-min-age', 'manifest.safety_profile.min_age', 'no minors: min_age must be an integer >= 18');
  }
  if (manifest.publish === true && manifest.entitlement === 'dev') {
    warn('listed-dev-entitlement', 'manifest.entitlement', 'listed for players but entitlement is "dev" — pick free/paid before it goes live');
  }
  const bc = manifest.breach_config;
  if (!bc || typeof bc !== 'object') err('breach-config', 'manifest.breach_config', 'breach_config missing');
  else for (const k of ['hot_reading', 'nocebo', 'dual_reality']) {
    if (typeof bc[k] !== 'boolean') err('breach-config-flag', `manifest.breach_config.${k}`, `${k} must be boolean`);
  }

  // ---------------------------------------------------------------- pack ----
  if (!pack || typeof pack !== 'object' || !pack.meta || !Array.isArray(pack.families)) {
    err('pack-shape', 'pack', 'pack must have meta and families[]');
    return { errors, warnings };
  }
  const meta = pack.meta;
  if (!meta.title) err('meta-title', 'pack.meta.title', 'title missing');
  if (!Array.isArray(meta.cold_open) || !meta.cold_open.length || meta.cold_open.some(b => !String(b || '').trim())) {
    err('meta-cold-open', 'pack.meta.cold_open', 'cold_open must be a non-empty array of non-empty strings');
  }
  if (!meta.voice_example) err('meta-voice', 'pack.meta.voice_example', 'voice_example missing');
  const intents = meta.intents && typeof meta.intents === 'object' ? Object.keys(meta.intents) : [];
  if (!intents.length) err('meta-intents', 'pack.meta.intents', 'intents map missing or empty');
  if (intents.length && !intents.includes('OTHER')) {
    err('meta-intents-other', 'pack.meta.intents', 'intents must include OTHER — the router falls back to it, and a missing OTHER template crashes the turn loop');
  }
  for (const [k, v] of Object.entries(meta.intents || {})) {
    if (!String(v || '').trim()) err('intent-desc', `pack.meta.intents.${k}`, 'intent description empty');
  }

  // macros in cold_open: unknown {{names}} there reach the PLAYER verbatim (no model fill pass).
  for (const [i, b] of (meta.cold_open || []).entries()) {
    for (const m of String(b).matchAll(/\{\{\s*([a-z_]+)\s*(?::[^}]*)?\}\}/gi)) {
      if (!KNOWN_MACROS.has(m[1].toLowerCase())) warn('cold-open-brace', `pack.meta.cold_open[${i}]`, `{{${m[1]}}} is not a macro; it will reach players literally`);
    }
  }

  // ------------------------------------------------------------ families ----
  const fams = pack.families;
  if (!fams.length) { err('families-empty', 'pack.families', 'no families'); return { errors, warnings }; }
  const fromSeen = new Set();
  const tplIds = new Set();
  const fromSet = new Set(fams.map(f => f.from));
  fams.forEach((f, i) => {
    const p = `pack.families[${i}]`;
    if (f.n !== i + 1) err('family-n', `${p}.n`, `n must be contiguous 1..N (expected ${i + 1}, got ${f.n})`);
    if (!f.from) err('family-from', `${p}.from`, 'from missing');
    if (fromSeen.has(f.from)) err('family-from-dup', `${p}.from`, `duplicate from state "${f.from}" — familyByFrom would clobber silently`);
    fromSeen.add(f.from);
    if (!f.to) err('family-to', `${p}.to`, 'to missing');
    const isFinal = i === fams.length - 1;
    if (!isFinal) {
      if (!fromSet.has(f.to)) err('family-dangling-to', `${p}.to`, `to "${f.to}" matches no family's from — the story dead-ends`);
      else if (fams[i + 1] && f.to !== fams[i + 1].from) warn('family-nonlinear', `${p}.to`, `chain is not linear here (${f.from} -> ${f.to}, but next family is ${fams[i + 1].from})`);
    } else if (fromSet.has(f.to)) {
      err('family-terminal', `${p}.to`, `final to "${f.to}" is also a from — the story never terminates`);
    }
    if (!Array.isArray(f.bubbles) || f.bubbles.length !== 2 || !Number.isInteger(f.bubbles[0]) || !Number.isInteger(f.bubbles[1])
      || f.bubbles[0] < 1 || f.bubbles[0] > f.bubbles[1] || f.bubbles[1] > 12) {
      err('family-bubbles', `${p}.bubbles`, 'bubbles must be [min,max] ints with 1 <= min <= max <= 12');
    }
    for (const key of ['shared_rules', 'available_context', 'input_fields']) {
      if (!Array.isArray(f[key])) err('family-array', `${p}.${key}`, `${key} must be an array`);
    }
    if (Array.isArray(f.input_fields) && !f.input_fields.includes('current_state')) {
      warn('family-input-fields', `${p}.input_fields`, 'input_fields does not include current_state');
    }

    // templates: one per intent, matching ids/intents, updates well-formed
    const tpls = f.templates && typeof f.templates === 'object' ? f.templates : {};
    for (const intent of intents) {
      if (!tpls[intent]) err('template-missing', `${p}.templates.${intent}`, `no template for intent ${intent}`);
    }
    for (const [key, tpl] of Object.entries(tpls)) {
      const tp = `${p}.templates.${key}`;
      if (!intents.includes(key)) warn('template-unknown-intent', tp, `template for unknown intent ${key}`);
      if (!tpl || typeof tpl !== 'object') { err('template-shape', tp, 'template must be an object'); continue; }
      if (tpl.intent !== key) err('template-intent-mismatch', `${tp}.intent`, `intent field "${tpl.intent}" != key "${key}"`);
      if (!String(tpl.template || '').trim()) err('template-empty', `${tp}.template`, 'template text empty');
      if (!tpl.id) err('template-id', `${tp}.id`, 'id missing');
      else if (tplIds.has(tpl.id)) err('template-id-dup', `${tp}.id`, `duplicate template id ${tpl.id}`);
      tplIds.add(tpl.id);
      if (!Array.isArray(tpl.fill_guidance)) err('template-fill', `${tp}.fill_guidance`, 'fill_guidance must be an array');

      const updates = Array.isArray(tpl.updates) ? tpl.updates : [];
      if (!Array.isArray(tpl.updates)) err('updates-shape', `${tp}.updates`, 'updates must be an array');
      let setsCurrentState = null;
      updates.forEach((u, ui) => {
        const up = `${tp}.updates[${ui}]`;
        if (!u || typeof u !== 'object') { err('update-shape', up, 'update must be an object'); return; }
        if (!FIELD.test(String(u.field || ''))) err('update-field', `${up}.field`, `bad field name ${JSON.stringify(u.field)}`);
        if (!UPDATE_KINDS.has(u.kind)) { err('update-kind', `${up}.kind`, `kind must be one of ${[...UPDATE_KINDS].join('/')}`); return; }
        if (u.kind === 'set' && u.value === undefined) err('update-set-value', up, 'set requires value');
        if (u.kind === 'add' && !Number.isInteger(u.n)) err('update-add-n', up, 'add requires integer n');
        if (u.kind === 'set2' && (u.a === undefined || u.b === undefined)) err('update-set2', up, 'set2 requires a and b');
        if (u.kind === 'cond') {
          if (!String(u.raw || '').trim()) err('update-cond-raw', up, 'cond requires raw condition text');
          else if (!EVALCOND_PATTERNS.some(re => re.test(u.raw))) {
            warn('update-cond-unrecognized', up, `cond raw matches no evalCond pattern — it will silently default to true: ${JSON.stringify(String(u.raw).slice(0, 80))}`);
          }
        }
        if (u.field === 'current_state' && u.kind === 'set') setsCurrentState = u.value;
      });
      if (setsCurrentState !== f.to) {
        err('update-current-state', `${tp}.updates`, `template must set current_state to exactly "${f.to}" (found ${JSON.stringify(setsCurrentState)})`);
      }
      if (isFinal) {
        for (const need of ['ending_route', 'ending_type']) {
          if (!updates.some(u => u.field === need && (u.kind === 'set' || u.kind === 'set2'))) {
            err('ending-fields', `${tp}.updates`, `final-beat template must set ${need}`);
          }
        }
      }
    }
  });

  // ---------------------------------------------------------------- lore ----
  const lore = pack.lore;
  if (lore) {
    const lp = 'pack.lore';
    for (const k of Object.keys(lore)) {
      if (ABSOLUTE_CAP_KEYS.test(k)) err('lore-absolute-cap', `${lp}.${k}`, `absolute caps are forbidden — budgets are % of the context window (budget_pct)`);
    }
    if (lore.budget_pct !== undefined && !(Number(lore.budget_pct) > 0 && Number(lore.budget_pct) <= 100)) {
      err('lore-budget-pct', `${lp}.budget_pct`, 'budget_pct must be in (0, 100]');
    }
    if (lore.scan_depth !== undefined && !(Number.isInteger(lore.scan_depth) && lore.scan_depth > 0)) {
      err('lore-scan-depth', `${lp}.scan_depth`, 'scan_depth must be a positive integer');
    }
    const ids = new Set();
    const groups = {};
    let constantChars = 0;
    for (const [i, e] of (lore.entries || []).entries()) {
      const ep = `${lp}.entries[${i}]`;
      if (!e || typeof e !== 'object') { err('lore-entry-shape', ep, 'entry must be an object'); continue; }
      for (const k of Object.keys(e)) {
        if (ABSOLUTE_CAP_KEYS.test(k)) err('lore-absolute-cap', `${ep}.${k}`, 'absolute caps are forbidden — budgets are % of the context window');
      }
      if (!String(e.id || '').trim()) err('lore-id', `${ep}.id`, 'id missing');
      else if (ids.has(e.id)) err('lore-id-dup', `${ep}.id`, `duplicate lore id ${e.id}`);
      ids.add(e.id);
      if (!String(e.content || '').trim()) err('lore-content', `${ep}.content`, 'content empty');
      const keys = Array.isArray(e.keys) ? e.keys : [];
      if (!keys.length && !e.constant) err('lore-never-fires', ep, 'entry has no keys and is not constant — it can never fire');
      if (keys.length && e.constant) warn('lore-constant-keys', ep, 'constant entry with keys — the keys are ignored');
      for (const k of keys) {
        const m = /^\/(.+)\/([a-z]*)$/i.exec(String(k));
        if (m) { try { new RegExp(m[1], m[2].replace('g', '')); } catch (ex) { err('lore-regex', ep, `regex key ${k} does not compile: ${ex.message}`); } }
      }
      if (e.probability !== undefined) {
        if (!(Number(e.probability) >= 0 && Number(e.probability) <= 100)) err('lore-probability', `${ep}.probability`, 'probability must be 0..100');
        else if (Number(e.probability) === 0) warn('lore-probability-zero', `${ep}.probability`, 'probability 0 — entry can never fire');
      }
      for (const k of ['delay', 'cooldown', 'sticky', 'order', 'scan_depth']) {
        if (e[k] !== undefined && !(Number.isInteger(e[k]) && e[k] >= 0)) err('lore-int', `${ep}.${k}`, `${k} must be a non-negative integer`);
      }
      if ((Number(e.delay) || 0) >= 40) warn('lore-delay-huge', `${ep}.delay`, `delay ${e.delay} is longer than most stories — likely never in play`);
      if (e.group) (groups[e.group] ||= []).push(e.id);
      if (e.constant) constantChars += String(e.content || '').length;
    }
    for (const [g, members] of Object.entries(groups)) {
      if (members.length === 1) warn('lore-group-single', `${lp}`, `group "${g}" has a single member (${members[0]}) — an equivoque of one`);
    }
    const budgetChars = Math.floor(ctxTokens * ((Number(lore.budget_pct) || 10) / 100) * CHARS_PER_TOKEN);
    if (constantChars > budgetChars) {
      warn('lore-budget-overflow', lp, `constant entries alone (${constantChars} chars) exceed the budget (${budgetChars} chars at ${ctxTokens} ctx) — keyed entries will always be budget-skipped`);
    }
  }

  // --------------------------------------------------------------- rails ----
  if (pack.rails) {
    const probes = [
      ...(meta.cold_open || []),
      ...fams.flatMap(f => Object.values(f.templates || {}).flatMap(t => String(t.template || '').split(/\n+/))),
    ].map(s => s.trim()).filter(Boolean);
    pack.rails.forEach((r, i) => {
      const rp = `pack.rails[${i}]`;
      if (!r || !r.find) { err('rail-find', rp, 'rail missing find'); return; }
      let re;
      try { re = new RegExp(r.find, (r.flags === undefined ? 'gi' : r.flags)); } catch (ex) { err('rail-regex', rp, `find does not compile: ${ex.message}`); return; }
      if (probes.length) {
        const survivors = probes.filter(s => s.replace(re, r.replace ?? '').replace(/\s{2,}/g, ' ').trim());
        if (!survivors.length) err('rail-blanket', rp, 'this rail empties EVERY probe line (cold open + all templates) — it would blank the character');
      }
    });
  }

  // ------------------------------------------------------------- breaches ---
  if (Array.isArray(pack.breaches)) {
    pack.breaches.forEach((b, i) => {
      const bp = `pack.breaches[${i}]`;
      if (!BREACH_TYPES.has(b?.type)) warn('breach-type', `${bp}.type`, `unknown breach type ${JSON.stringify(b?.type)}`);
      else if (bc && bc[b.type] === false) warn('breach-flag-off', bp, `breach of type ${b.type} but manifest.breach_config.${b.type} is false`);
      for (const f of BREACH_FIELDS) {
        if (!String(b?.[f] || '').trim()) warn('breach-anatomy', `${bp}.${f}`, `breach missing ${f}`);
      }
    });
  }

  // ------------------------------------------------- placeholder residue ----
  // Scaffold TODO text is a non-empty string, so field-presence checks bless it. Hunt it
  // explicitly: "ready to publish" must never be true with scaffolding still aboard.
  {
    const hits = [];
    const walk = (o, path) => {
      if (hits.length >= 12) return;
      if (typeof o === 'string') { if (/\bTODO\b/.test(o)) hits.push({ path, snippet: o.slice(0, 60) }); return; }
      if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    walk(manifest, 'manifest');
    walk(pack, 'pack');
    for (const h of hits) warn('todo-placeholder', h.path, `placeholder text still aboard: ${JSON.stringify(h.snippet)}`);
  }

  // -------------------------------------------------- publish-time (live) ---
  if (liveModule) {
    const liveFroms = new Set(liveModule.pack.families.map(f => f.from));
    const draftFroms = new Set(fams.map(f => f.from));
    for (const s of liveFroms) {
      if (!draftFroms.has(s)) {
        warn('publish-dropped-state', 'pack.families', `live beat "${s}" no longer exists in the draft — in-flight sessions sitting on it will hit story_over`);
      }
    }
  }

  return { errors, warnings };
}
