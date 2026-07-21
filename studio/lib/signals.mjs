// Flight-log digest — AGGREGATES ONLY. The logs contain raw player messages; the studio's
// signals surface must never carry them. This module reads logs/qmm-YYYY-MM-DD.jsonl and
// returns counts, histograms, and latency percentiles keyed by day + module. No user_message,
// no bubbles, no thinking text — numbers and enum-ish labels only.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;

function freshDay(day, moduleId) {
  return {
    day, module_id: moduleId,
    turns: 0, chat: 0, advance: 0, forced: 0,
    route_fallback: 0, gen_fallback: 0, parse_fail: 0, braces: 0,
    nudges: 0, stop_words: 0, new_sessions: 0, reloads: 0,
    intents: {}, beats: {}, lore_fired: {}, endings: {},
    _route_ms: [], _gen_ms: [],
  };
}

/**
 * @param {string} logDir
 * @param {object} opts {days: number, moduleId?: string}
 * @returns {{days: object[], totals: object}}
 */
export function digest(logDir, { days = 7, moduleId } = {}) {
  const byKey = new Map();
  const today = new Date();
  for (let i = 0; i < Math.min(60, Math.max(1, days)); i++) {
    const d = new Date(today.getTime() - i * 86400_000);
    const day = d.toISOString().slice(0, 10);
    const file = join(logDir, `qmm-${day}.jsonl`);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const mid = e.module_id || '(none)';
      if (moduleId && mid !== moduleId) continue;
      const key = `${day}|${mid}`;
      if (!byKey.has(key)) byKey.set(key, freshDay(day, mid));
      const s = byKey.get(key);

      if (e.kind === 'turn') {
        s.turns++;
        if (e.mode === 'chat') s.chat++; else if (e.mode === 'advance') s.advance++;
        if (e.forced) s.forced++;
        if (e.route?.fallback) s.route_fallback++;
        if (e.gen_fallback) s.gen_fallback++;
        if (Array.isArray(e.bubbles) && e.bubbles.some(b => String(b).includes('{{'))) s.braces++;
        const intent = e.route?.intent;
        if (intent) s.intents[intent] = (s.intents[intent] || 0) + 1;
        if (e.from_state) s.beats[e.from_state] = (s.beats[e.from_state] || 0) + 1;
        // lore_fired lives in the turn meta on responses; the flight log carries state_after +
        // route; fired ids ride meta on newer log lines — accept both shapes.
        const fired = e.lore_fired || e.meta?.lore_fired || [];
        for (const id of fired) s.lore_fired[id] = (s.lore_fired[id] || 0) + 1;
        if (e.ending?.route) s.endings[`${e.ending.route} (${e.ending.type || '?'})`] = (s.endings[`${e.ending.route} (${e.ending.type || '?'})`] || 0) + 1;
        if (Number(e.route?.ms) > 0) s._route_ms.push(Number(e.route.ms));
        if (Number(e.gen_ms) > 0) s._gen_ms.push(Number(e.gen_ms));
      } else if (e.kind === 'nudge') {
        s.nudges++;
        if (Number(e.gen_ms) > 0) s._gen_ms.push(Number(e.gen_ms));
      } else if (e.kind === 'stop_word') s.stop_words++;
      else if (e.kind === 'new_session') s.new_sessions++;
      else if (e.kind === 'llm_parse_fail') s.parse_fail++;
      else if (e.kind === 'modules_reload') s.reloads++;
    }
  }

  const daysOut = [...byKey.values()].map(s => {
    const route = s._route_ms.sort((a, b) => a - b);
    const gen = s._gen_ms.sort((a, b) => a - b);
    const { _route_ms, _gen_ms, ...rest } = s;
    return {
      ...rest,
      route_ms: { p50: pct(route, 0.5), p95: pct(route, 0.95), n: route.length },
      gen_ms: { p50: pct(gen, 0.5), p95: pct(gen, 0.95), n: gen.length },
    };
  }).sort((a, b) => b.day.localeCompare(a.day) || a.module_id.localeCompare(b.module_id));

  const totals = daysOut.reduce((t, s) => {
    for (const k of ['turns', 'chat', 'advance', 'forced', 'route_fallback', 'gen_fallback', 'parse_fail', 'braces', 'nudges', 'stop_words', 'new_sessions']) t[k] += s[k];
    for (const [k, v] of Object.entries(s.lore_fired)) t.lore_fired[k] = (t.lore_fired[k] || 0) + v;
    for (const [k, v] of Object.entries(s.endings)) t.endings[k] = (t.endings[k] || 0) + v;
    return t;
  }, { turns: 0, chat: 0, advance: 0, forced: 0, route_fallback: 0, gen_fallback: 0, parse_fail: 0, braces: 0, nudges: 0, stop_words: 0, new_sessions: 0, lore_fired: {}, endings: {} });

  return { days: daysOut, totals };
}
