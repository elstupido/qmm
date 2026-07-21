// Publish pipeline: validate -> semver bump -> immutable snapshot -> atomic install into
// modules/<id>/ -> hot-reload the player. Git-free by design (prod ~/qmm is not a git repo);
// the snapshot dir IS the on-box audit trail, and local git remains a second net where it exists.

import {
  readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, renameSync, cpSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateModule } from '../../server/validate.mjs';
import { DraftStore, canonicalStringify } from './draft-store.mjs';

const DOC_FILES = ['manifest.json', 'pack.json', 'lore.json'];

function bumpVersion(v, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '0.0.0')) || [null, 0, 0, 0];
  let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === 'major') { maj++; min = 0; pat = 0; }
  else if (bump === 'minor') { min++; pat = 0; }
  else pat++;
  return `${maj}.${min}.${pat}`;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Atomic file install: write tmp beside the target, rename over it. */
function installFile(dstDir, name, content) {
  const p = join(dstDir, name);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, p);
}

async function callReload(playerUrl, reloadToken) {
  if (!reloadToken) return { ok: false, error: 'reload_token_missing' };
  try {
    const res = await fetch(`${playerUrl}/api/reload`, {
      method: 'POST', headers: { 'x-qmm-reload-token': reloadToken }, signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...data } : { ok: false, status: res.status, ...data };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export class Publisher {
  constructor({ store, versionsDir, playerUrl, reloadToken, log }) {
    this.store = store;
    this.versionsDir = versionsDir;
    this.playerUrl = playerUrl;
    this.reloadToken = reloadToken;
    this.log = log || (() => {});
    mkdirSync(versionsDir, { recursive: true });
  }

  /**
   * Publish the draft of `id`. Returns one of:
   *   { status:'blocked', errors, warnings }
   *   { status:'needs_confirm', warnings }          (warnings present, accept_warnings not set)
   *   { status:'published', version, snapshot, reload, warnings }
   */
  async publish(id, { bump = 'patch', note = '', acceptWarnings = false } = {}) {
    const draft = this.store.loadDraft(id);
    if (!draft) throw Object.assign(new Error(`no draft ${id}`), { code: 'not_found' });
    const live = this.store.loadLive(id);

    // 1. validate (draft merged, with publish-time live comparison)
    const { errors, warnings } = validateModule({
      manifest: draft.manifest, pack: DraftStore.mergedPack(draft), dirName: id,
      liveModule: live ? { pack: DraftStore.mergedPack(live) } : undefined,
    });
    if (errors.length) return { status: 'blocked', errors, warnings };
    if (warnings.length && !acceptWarnings) return { status: 'needs_confirm', warnings };

    // 2. version bump over LIVE (a fresh module bumps over its own draft version)
    const fromVersion = live?.manifest?.version ?? draft.manifest.version ?? '0.0.0';
    const version = bumpVersion(fromVersion, bump);
    draft.manifest.version = version;
    this.store.saveDoc(id, 'manifest', draft.manifest, draft.revs.manifest);

    // 3. immutable snapshot of the as-published draft
    const draftDir = this.store.draftDir(id);
    const snapDir = join(this.versionsDir, id, version);
    if (existsSync(snapDir)) throw Object.assign(new Error(`snapshot ${version} already exists`), { code: 'exists' });
    cpSync(draftDir, snapDir, { recursive: true });
    const files_sha256 = {};
    for (const f of DOC_FILES) {
      const p = join(snapDir, f);
      if (existsSync(p)) files_sha256[f] = sha256(readFileSync(p));
    }
    writeFileSync(join(snapDir, 'publish.json'), canonicalStringify({
      published_at: new Date().toISOString(), note: String(note || ''), from_version: fromVersion, version, files_sha256,
    }));

    // 4. atomic install into the live tree (docs; assets copied whole; a doc absent from the
    //    draft is removed from live — the draft is the whole truth)
    const liveDir = this.store.liveDir(id);
    mkdirSync(liveDir, { recursive: true });
    for (const f of DOC_FILES) {
      const src = join(draftDir, f);
      if (existsSync(src)) installFile(liveDir, f, readFileSync(src));
      else if (existsSync(join(liveDir, f))) rmSync(join(liveDir, f));
    }
    const draftAssets = join(draftDir, 'assets');
    if (existsSync(draftAssets)) cpSync(draftAssets, join(liveDir, 'assets'), { recursive: true });

    // 5. hot-reload the player (files are live on disk either way; a failed reload is a
    //    warning with a retry path, not a rollback)
    const reload = await callReload(this.playerUrl, this.reloadToken);

    this.log({ kind: 'publish', id, version, from_version: fromVersion, note, reload_ok: reload.ok, files_sha256 });
    return { status: 'published', version, from_version: fromVersion, snapshot: `${id}/${version}`, reload, warnings };
  }

  /** Roll live back to any snapshot. The draft is left alone. */
  async rollback(id, version) {
    const snapDir = join(this.versionsDir, id, String(version));
    if (!existsSync(snapDir)) throw Object.assign(new Error(`no snapshot ${id}/${version}`), { code: 'not_found' });
    const liveDir = this.store.liveDir(id);
    mkdirSync(liveDir, { recursive: true });
    for (const f of DOC_FILES) {
      const src = join(snapDir, f);
      if (existsSync(src)) installFile(liveDir, f, readFileSync(src));
      else if (existsSync(join(liveDir, f))) rmSync(join(liveDir, f));
    }
    const snapAssets = join(snapDir, 'assets');
    if (existsSync(snapAssets)) cpSync(snapAssets, join(liveDir, 'assets'), { recursive: true });
    const reload = await callReload(this.playerUrl, this.reloadToken);
    this.log({ kind: 'rollback', id, version, reload_ok: reload.ok });
    return { status: 'rolled_back', version, reload };
  }

  reloadPlayer() { return callReload(this.playerUrl, this.reloadToken); }

  listVersions(id) {
    const dir = join(this.versionsDir, id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(v => statSync(join(dir, v)).isDirectory())
      .map(v => {
        let meta = null;
        try { meta = JSON.parse(readFileSync(join(dir, v, 'publish.json'), 'utf8')); } catch { /* pre-meta snapshot */ }
        return { version: v, ...meta };
      })
      .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
  }
}
