// QMM lore engine — a port of SillyTavern's World Info activation core (world-info.js,
// AGPL-3.0, same license as this project) reduced to what the fill engine needs.
// Three subsystems, shared verbatim with the Kotlin engine (net.stuped.qmm.lore):
//
//   scanLore()      keyword/regex-triggered injection of per-story + per-player lore into the
//                   prompt, with timed effects (delay / cooldown / sticky), probability, and
//                   equivoque GROUP LOCKS (first member of a group to fire becomes that group's
//                   canon forever — mutually-exclusive explanations, mentalism-style).
//   resolveMacros() deterministic {{...}} fills that never cost model tokens:
//                   {{random:a|b|c}} {{pick:name:a|b|c}} {{time}} {{time_of_day}} {{date}} {{weekday}}
//   applyRails()    regex post-processing of generated bubbles (mechanical de-anchoring: the
//                   prompt-only "vary your openers" fix is partial; rails are deterministic).
//
// CONTEXT POLICY (non-negotiable): no absolute token caps in this file. The lore budget is a
// PERCENTAGE of the engine's context window, passed in by the caller. The engine's window comes
// from the model (env-tunable on the server, probed at init on-device) — never invented.
//
// Pack format (see qmm-android/docs/MODULE_FORMAT.md):
//   pack.lore  = { budget_pct, scan_depth, entries: [ { id, keys[], content, comment?, constant?,
//                  case_sensitive?, order?, probability?, delay?, cooldown?, sticky?, group?,
//                  scan_depth? } ] }
//   pack.rails = [ { find, replace, flags?, scope? } ]
//
// Timed-effect bookkeeping lives in session state (state.lore_fx) so it syncs across channels:
//   { last: {id: turn}, stickyUntil: {id: turn}, cooldownUntil: {id: turn}, groupCanon: {group: id} }
// state.turn = player-turn counter (incremented once per player message, before routing).

// ------------------------------------------------------------------ macros ----

const TIME_OF_DAY = (h) =>
  h < 5 ? 'the middle of the night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'late night';

// Deterministic 32-bit hash for {{pick}} stability (same algorithm in Kotlin).
function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Resolve deterministic macros in authored text. `seed` is the session's macro_seed (set once at
 * newSession) so {{pick}} is stable for one player and different across players.
 * @param {string} text
 * @param {number} seed
 * @param {Date} [now]
 */
export function resolveMacros(text, seed, now = new Date()) {
  if (!text || !text.includes('{{')) return text;
  return text.replace(/\{\{\s*(random|pick|time_of_day|time|date|weekday)\s*(?::([^}]*))?\}\}/gi, (_, kind, arg) => {
    switch (kind.toLowerCase()) {
      case 'random': {
        const opts = String(arg || '').split('|').map(s => s.trim()).filter(Boolean);
        return opts.length ? opts[Math.floor(Math.random() * opts.length)] : '';
      }
      case 'pick': {
        // {{pick:name:a|b|c}} — stable for this session: same name -> same choice, every time.
        const m = /^([^:]*):([\s\S]*)$/.exec(String(arg || ''));
        const name = m ? m[1].trim() : '';
        const opts = (m ? m[2] : String(arg || '')).split('|').map(s => s.trim()).filter(Boolean);
        return opts.length ? opts[hash32(`${seed}:${name}`) % opts.length] : '';
      }
      case 'time': return now.toTimeString().slice(0, 5);
      case 'time_of_day': return TIME_OF_DAY(now.getHours());
      case 'date': return now.toISOString().slice(0, 10);
      case 'weekday': return now.toLocaleDateString('en-US', { weekday: 'long' });
      default: return '';
    }
  });
}

// ------------------------------------------------------------------- lore -----

const DEFAULTS = { budget_pct: 10, scan_depth: 8 };
const CHARS_PER_TOKEN = 4; // budget heuristic; both engines use the same constant

function loreConfig(pack) {
  const l = pack.lore || {};
  return {
    budget_pct: Number(l.budget_pct) > 0 ? Number(l.budget_pct) : DEFAULTS.budget_pct,
    scan_depth: Number(l.scan_depth) > 0 ? Number(l.scan_depth) : DEFAULTS.scan_depth,
    entries: Array.isArray(l.entries) ? l.entries : [],
  };
}

export function freshLoreFx() {
  return { last: {}, stickyUntil: {}, cooldownUntil: {}, groupCanon: {} };
}

// A key of the form "/pattern/flags" is a regex; anything else is a case-per-flag substring match.
function keyMatches(key, windowText, windowTextLower, caseSensitive) {
  const m = /^\/(.+)\/([a-z]*)$/i.exec(key);
  if (m) {
    try { return new RegExp(m[1], m[2].replace('g', '')).test(windowText); }
    catch { return false; }
  }
  return caseSensitive ? windowText.includes(key) : windowTextLower.includes(key.toLowerCase());
}

/**
 * One scan per player turn. Mutates state.lore_fx bookkeeping; returns the prompt block + audit.
 * @param {object} pack        the module pack (pack.lore section is used)
 * @param {Array}  transcript  [{who,text}] full transcript INCLUDING the newest player message
 * @param {object} state       session state (state.turn, state.lore_fx read/written)
 * @param {number} ctxTokens   the ENGINE's context window in tokens (model-derived, never invented)
 * @param {Array}  [trace]     optional: per-entry gate outcomes are pushed here (studio "explain";
 *                             pure-additive — passing nothing changes nothing)
 * @returns {{block: string, fired: string[], budget_chars: number}}
 */
export function scanLore(pack, transcript, state, ctxTokens, trace = null) {
  const cfg = loreConfig(pack);
  const note = (id, outcome, extra) => { if (trace) trace.push({ id, outcome, ...(extra || {}) }); };
  if (!cfg.entries.length) return { block: '', fired: [], budget_chars: 0 };

  const fx = state.lore_fx || (state.lore_fx = freshLoreFx());
  const turn = Number(state.turn) || 0;
  const budgetChars = Math.max(0, Math.floor((Number(ctxTokens) || 0) * (cfg.budget_pct / 100) * CHARS_PER_TOKEN));

  const active = [];
  const viaSticky = new Set();
  for (const e of cfg.entries) {
    if (!e || e.enabled === false || !e.id || !e.content) continue;

    // sticky: fired recently enough that it stays active regardless of keys
    const sticky = (fx.stickyUntil[e.id] || 0) >= turn;
    if (sticky) viaSticky.add(e.id);

    if (!sticky) {
      if ((Number(e.delay) || 0) > turn) { note(e.id, 'blocked:delay', { until_turn: Number(e.delay) }); continue; }
      if ((fx.cooldownUntil[e.id] || 0) >= turn) { note(e.id, 'blocked:cooldown', { until_turn: fx.cooldownUntil[e.id] }); continue; }
      if (e.group && fx.groupCanon[e.group] && fx.groupCanon[e.group] !== e.id) { note(e.id, 'blocked:group', { canon: fx.groupCanon[e.group] }); continue; } // lost the equivoque

      if (!e.constant) {
        const depth = Number(e.scan_depth) > 0 ? Number(e.scan_depth) : cfg.scan_depth;
        const windowText = transcript.slice(-depth).map(m => m.text).join('\n');
        const windowTextLower = windowText.toLowerCase();
        const keys = Array.isArray(e.keys) ? e.keys : [];
        const matched = keys.find(k => keyMatches(String(k), windowText, windowTextLower, !!e.case_sensitive));
        if (matched === undefined) { note(e.id, 'blocked:keys'); continue; }
        if (trace) note(e.id, 'matched', { key: String(matched) });
      }

      const prob = e.probability === undefined ? 100 : Number(e.probability);
      if (prob < 100 && Math.random() * 100 >= prob) { note(e.id, 'blocked:probability', { probability: prob }); continue; }
    }

    active.push(e);
  }

  // Higher order = more important: first claim on budget, listed first in the prompt.
  active.sort((a, b) => (Number(b.order) || 0) - (Number(a.order) || 0));

  const fired = [];
  const lines = [];
  let spent = 0;
  const scanGroupTaken = new Set(); // equivoque: one member per SCAN too, not just per canon-lock
  for (const e of active) {
    const content = String(e.content);
    if (e.group && scanGroupTaken.has(e.group)) { note(e.id, 'blocked:group', { taken_this_scan: true }); continue; }
    if (spent + content.length > budgetChars && fired.length > 0) { note(e.id, 'blocked:budget', { budget_chars: budgetChars }); continue; } // budget: skip, don't truncate
    if (e.group) scanGroupTaken.add(e.group);
    note(e.id, 'fired', { sticky: viaSticky.has(e.id) || undefined });
    spent += content.length;
    fired.push(e.id);
    lines.push(content);

    // bookkeeping — ONLY a fresh trigger sets the clocks; sticky re-activation must not
    // self-extend (or sticky never expires). Cooldown counts from fire THROUGH the sticky
    // window: sticky S + cooldown C = active S turns, then quiet C turns.
    fx.last[e.id] = turn;
    if (!viaSticky.has(e.id)) {
      if ((Number(e.sticky) || 0) > 0) fx.stickyUntil[e.id] = turn + Number(e.sticky);
      if ((Number(e.cooldown) || 0) > 0) fx.cooldownUntil[e.id] = turn + (Number(e.sticky) || 0) + Number(e.cooldown);
    }
    if (e.group && !fx.groupCanon[e.group]) fx.groupCanon[e.group] = e.id; // equivoque lock: first to fire IS the canon
  }

  return { block: lines.map(l => `- ${l}`).join('\n'), fired, budget_chars: budgetChars };
}

// ------------------------------------------------------------------- rails ----

/**
 * Regex post-processing of generated bubbles. Never rails into silence: if every bubble dies,
 * the originals are returned (a bad rule must not blank the character).
 * @param {object} pack
 * @param {string[]} bubbles
 * @returns {{bubbles: string[], applied: number}}
 */
export function applyRails(pack, bubbles) {
  const rules = Array.isArray(pack.rails) ? pack.rails : [];
  if (!rules.length || !bubbles.length) return { bubbles, applied: 0 };
  let applied = 0;
  const out = bubbles.map(b => {
    let s = b;
    for (const r of rules) {
      if (!r || !r.find) continue;
      try {
        const re = new RegExp(r.find, r.flags === undefined ? 'gi' : r.flags);
        const next = s.replace(re, r.replace ?? '');
        if (next !== s) applied++;
        s = next;
      } catch { /* bad authored regex: skip the rule, never the turn */ }
    }
    return s.replace(/\s{2,}/g, ' ').trim();
  }).filter(Boolean);
  return out.length ? { bubbles: out, applied } : { bubbles, applied: 0 };
}
