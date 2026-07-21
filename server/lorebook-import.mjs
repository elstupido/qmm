// SillyTavern lorebook -> QMM lore-doc conversion, shared by the studio import endpoint and the
// tools/import-lorebook.mjs CLI. The authoring bridge: write/playtest lore in SillyTavern's
// World Info editor (same gemma model via ollama), export the book, import here.
//
// ST field mapping (world-info.js entry template -> our lore engine):
//   key[]        -> keys[]        comment -> comment (+ slug source for id)
//   content      -> content       constant -> constant
//   order        -> order         probability/useProbability -> probability
//   delay        -> delay         cooldown -> cooldown        sticky -> sticky
//   group        -> group         caseSensitive -> case_sensitive
//   disable      -> enabled:false scanDepth -> scan_depth
// Unsupported ST features (secondary keys, recursion, positions) are dropped WITH A WARNING —
// silent truncation reads as "imported everything" when it didn't.

const slug = (s, i) => (String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || `entry-${i}`;

/**
 * @param {object} book        parsed SillyTavern lorebook export ({entries: {...}})
 * @param {object} [options]
 * @param {object} [options.existingDoc]  current lore.json doc to merge into
 * @param {boolean} [options.merge]       keep existing entries (imported wins on id clash)
 * @returns {{doc: object, imported: number, warnings: string[]}}
 */
export function convertLorebook(book, { existingDoc, merge = false } = {}) {
  const entries = book?.entries ? Object.values(book.entries) : [];
  if (!entries.length) throw Object.assign(new Error('no entries found — is this a SillyTavern lorebook export?'), { code: 'bad_book' });

  const warnings = [];
  const out = [];
  const seen = new Set();

  entries.forEach((e, i) => {
    if (!e || typeof e.content !== 'string' || !e.content.trim()) return;
    let id = slug(e.comment, i);
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);

    if (Array.isArray(e.keysecondary) && e.keysecondary.length) warnings.push(`${id}: secondary keys dropped (unsupported v1)`);
    if (e.selectiveLogic) warnings.push(`${id}: selectiveLogic dropped (unsupported v1)`);
    if (e.position !== undefined && e.position !== 0) warnings.push(`${id}: ST position ignored (QMM has one lore slot)`);

    const entry = {
      id,
      keys: (Array.isArray(e.key) ? e.key : []).map(String).filter(Boolean),
      content: e.content.trim(),
    };
    if (e.comment) entry.comment = String(e.comment);
    if (e.constant) entry.constant = true;
    if (e.caseSensitive) entry.case_sensitive = true;
    if (Number(e.order)) entry.order = Number(e.order);
    if (e.useProbability && Number(e.probability) < 100) entry.probability = Number(e.probability);
    for (const f of ['delay', 'cooldown', 'sticky']) if (Number(e[f]) > 0) entry[f] = Number(e[f]);
    if (e.group) entry.group = String(e.group);
    if (Number(e.scanDepth) > 0) entry.scan_depth = Number(e.scanDepth);
    if (e.disable) entry.enabled = false;
    if (!entry.keys.length && !entry.constant) { warnings.push(`${id}: no keys and not constant — will never fire`); }
    out.push(entry);
  });

  let doc = { lore: { budget_pct: 10, scan_depth: 8, entries: out }, rails: [] };
  if (merge && existingDoc) {
    const imported = new Set(out.map(e => e.id));
    const kept = (existingDoc.lore?.entries || []).filter(e => !imported.has(e.id));
    doc = {
      lore: {
        budget_pct: existingDoc.lore?.budget_pct ?? 10,
        scan_depth: existingDoc.lore?.scan_depth ?? 8,
        entries: [...kept, ...out],
      },
      rails: existingDoc.rails || [],
    };
  }

  return { doc, imported: out.length, warnings };
}
