// Draft store — the studio's file layer over modules-draft/<id>/. A draft is a full module copy
// ({manifest,pack,lore,assets}); the player server never reads this tree. Whole-document saves
// are guarded by `rev` = sha256 of canonical JSON so two studio tabs can't silently clobber
// each other (same collision philosophy as the sessions store's seq).

import {
  readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync,
  renameSync, cpSync, rmSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

export const ID_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const DOCS = { manifest: 'manifest.json', pack: 'pack.json', lore: 'lore.json' };

// ------------------------------------------------------------ canonical ----
// Stable stringify: sorted object keys, 2-space indent. Revs and on-disk writes both use it,
// so an untouched round-trip is byte-identical and rev-stable.
export function canonicalStringify(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + '\n';
}

export const revOf = (value) => value == null ? null : createHash('sha256').update(canonicalStringify(value)).digest('hex').slice(0, 16);

// --------------------------------------------------------------- store -----
export class DraftStore {
  constructor({ modulesDir, draftsDir, scaffoldDir }) {
    this.modulesDir = modulesDir;
    this.draftsDir = draftsDir;
    this.scaffoldDir = scaffoldDir;
    mkdirSync(draftsDir, { recursive: true });
  }

  #dir(base, id) {
    if (!ID_RE.test(id)) throw Object.assign(new Error(`bad module id ${JSON.stringify(id)}`), { code: 'bad_id' });
    const dir = join(base, id);
    if (!dir.startsWith(base)) throw Object.assign(new Error('path escape'), { code: 'bad_id' });
    return dir;
  }
  draftDir(id) { return this.#dir(this.draftsDir, id); }
  liveDir(id) { return this.#dir(this.modulesDir, id); }

  #readDocs(dir) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
    const out = {};
    for (const [doc, file] of Object.entries(DOCS)) {
      const p = join(dir, file);
      out[doc] = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    }
    if (!out.manifest && !out.pack) return null;
    return out;
  }

  /** Merged pack (lore/rails folded in) — what the engine and validator consume. */
  static mergedPack(docs) {
    const pack = JSON.parse(JSON.stringify(docs.pack ?? {}));
    if (docs.lore?.lore) pack.lore = docs.lore.lore;
    if (docs.lore?.rails) pack.rails = docs.lore.rails;
    return pack;
  }

  loadDraft(id) {
    const docs = this.#readDocs(this.draftDir(id));
    if (!docs) return null;
    return { ...docs, revs: { manifest: revOf(docs.manifest), pack: revOf(docs.pack), lore: revOf(docs.lore) } };
  }

  loadLive(id) {
    const docs = this.#readDocs(this.liveDir(id));
    if (!docs) return null;
    return { ...docs, revs: { manifest: revOf(docs.manifest), pack: revOf(docs.pack), lore: revOf(docs.lore) } };
  }

  /** Dashboard listing: every live module + every draft (including drafts of new modules). */
  list() {
    const ids = new Set();
    for (const base of [this.modulesDir, this.draftsDir]) {
      if (!existsSync(base)) continue;
      for (const d of readdirSync(base)) {
        if (ID_RE.test(d) && statSync(join(base, d)).isDirectory()) ids.add(d);
      }
    }
    return [...ids].sort().map(id => {
      const live = this.loadLive(id);
      const draft = this.loadDraft(id);
      const draftDiffers = !!(live && draft) && ['manifest', 'pack', 'lore'].some(d => live.revs[d] !== draft.revs[d]);
      return {
        id,
        title: draft?.manifest?.title ?? live?.manifest?.title ?? id,
        live_version: live?.manifest?.version ?? null,
        draft_version: draft?.manifest?.version ?? null,
        publish: live?.manifest?.publish ?? draft?.manifest?.publish ?? false,
        has_live: !!live,
        has_draft: !!draft,
        draft_differs: draftDiffers || (!!draft && !live),
      };
    });
  }

  /** Create a draft: copy from live, or scaffold a brand-new module. */
  create(id, { from = 'live', title, story_id } = {}) {
    const dst = this.draftDir(id);
    if (existsSync(dst)) throw Object.assign(new Error(`draft ${id} already exists`), { code: 'exists' });

    if (from === 'live') {
      const src = this.liveDir(id);
      if (!existsSync(src)) throw Object.assign(new Error(`no live module ${id} to draft from`), { code: 'not_found' });
      cpSync(src, dst, { recursive: true });
      return this.loadDraft(id);
    }

    // scaffold: vendored template with id/title substituted; always publish:false until edited.
    const src = join(this.scaffoldDir, basename(from));
    if (!existsSync(src)) throw Object.assign(new Error(`unknown scaffold ${from}`), { code: 'not_found' });
    mkdirSync(dst, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
    const pack = JSON.parse(readFileSync(join(src, 'pack.json'), 'utf8'));
    manifest.id = id;
    manifest.story_id = story_id || id;
    manifest.title = title || id;
    manifest.publish = false;
    manifest.version = '0.1.0';
    if (pack.meta) pack.meta.title = title || id;
    writeFileSync(join(dst, 'manifest.json'), canonicalStringify(manifest));
    writeFileSync(join(dst, 'pack.json'), canonicalStringify(pack));
    return this.loadDraft(id);
  }

  /**
   * Whole-document save with optimistic concurrency. Returns {rev} or throws {code:'conflict', rev}
   * when baseRev doesn't match the document currently on disk.
   */
  saveDoc(id, doc, body, baseRev) {
    if (!(doc in DOCS)) throw Object.assign(new Error(`unknown doc ${doc}`), { code: 'bad_doc' });
    const dir = this.draftDir(id);
    if (!existsSync(dir)) throw Object.assign(new Error(`no draft ${id}`), { code: 'not_found' });
    const p = join(dir, DOCS[doc]);
    const current = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    const currentRev = revOf(current);
    if ((baseRev ?? null) !== currentRev) {
      throw Object.assign(new Error('stale base_rev'), { code: 'conflict', rev: currentRev });
    }
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, canonicalStringify(body));
    renameSync(tmp, p); // atomic replace, same pattern as sessions.mjs
    return { rev: revOf(body) };
  }

  /** Throw the draft away (rename-aside, never hard-delete) — mirrors clearSession's pattern. */
  trash(id) {
    const dir = this.draftDir(id);
    if (!existsSync(dir)) throw Object.assign(new Error(`no draft ${id}`), { code: 'not_found' });
    renameSync(dir, `${dir}.trash-${Date.now()}`);
  }

  /** Reset the draft to the live content. */
  revert(id) {
    const live = this.liveDir(id);
    if (!existsSync(live)) throw Object.assign(new Error(`no live module ${id}`), { code: 'not_found' });
    const dir = this.draftDir(id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    cpSync(live, dir, { recursive: true });
    return this.loadDraft(id);
  }

  /** Changed leaf paths per doc, draft vs live — feeds the publish diff view. */
  diff(id) {
    const live = this.loadLive(id);
    const draft = this.loadDraft(id);
    const out = {};
    for (const doc of Object.keys(DOCS)) {
      out[doc] = diffPaths(live?.[doc] ?? null, draft?.[doc] ?? null);
    }
    return out;
  }
}

// Leaf-level structural diff -> ["families[2].templates.HIDE.template", ...]
export function diffPaths(a, b, prefix = '', out = []) {
  if (a === b) return out;
  const isObj = (x) => x && typeof x === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(prefix || '(root)');
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const path = Array.isArray(a) ? `${prefix}[${k}]` : (prefix ? `${prefix}.${k}` : k);
    diffPaths(a[k], b[k], path, out);
  }
  return out;
}
