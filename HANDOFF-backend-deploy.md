# ASK for the backend chat: make studio-published stories reach real players

From: the authoring-studio chat. Date: 2026-07-21. Martin will hand you this.

> ## ✅ DONE — backend chat, 2026-07-21 evening
> The split stack is DEPLOYED to prod: backend `qmm` :8791 (modules-aware, API-only) +
> new `qmm-web` :8793 (UI + proxy); gateway `/qmm/*` re-pointed → :8793 (snapshot
> `Caddyfile.bak-pre-split`, change committed in ~/ArsGame). `run-qmm.sh` now carries
> `NUM_CTX=32768` + `RELOAD_TOKEN` (same value as the studio container's).
> **Verified live on prod:** `/api/modules` catalog · `/api/modules/:id/export` ·
> `POST /api/reload` with your token → `ok:true` · a real player turn through the full
> chain (proxy → backend → 5090 gemma) with the lore engine firing (`lore_fired` +
> cooldowns in state). Your Publish panel's reload should go green now — run a patch
> bump from the studio UI to see it end-to-end. Surfaces in §3 remain stable as asked.

## The situation

The Author Studio (studio/, service beside the player) is live and publishing works end-to-end
ON DISK: publish = validate → semver bump → immutable snapshot (modules-versions/) → atomic
install into `modules/<id>/` → `POST /api/reload` on the player with `x-qmm-reload-token`.
Both containers share the same bind-mounted tree, so a publish is instantly on the player's disk.

**But the PRODUCTION player container still runs the original single-story demo server**
(pre-modules: reads `server/story-pack.json`, no `modules/` registry, no `/api/reload`).
So studio publishes land in `modules/` that nothing serves, and the reload call warns.
The studio surfaces this honestly, and heals automatically the moment you deploy — no studio
changes needed.

## What we need from you

1. **Deploy the modules-aware backend to prod** (your channel-split stack: API-only server +
   qmm-web, sequenced however you planned). That alone lights up: catalog (`/api/modules`,
   publish:false hidden), bundles (`/api/modules/<id>` with lore merged), and hot reload.
2. **Player container env** — add to the run script (exact values are in the ops doc, studio
   section — gitignored DEPLOY.md on the prod box):
   - `NUM_CTX` (context policy: env-tunable, no invented caps)
   - `RELOAD_TOKEN` (same value the studio container already carries) — this is what makes
     "Publish" hot-reload your registry instead of warning.
3. **Keep these surfaces stable** (the studio depends on them read-only):
   - `POST /api/reload` (token header `x-qmm-reload-token`; never swaps to an empty registry)
   - `GET /api/modules` + `GET /api/modules/<id>` (+ your `/api/modules/<id>/export` — the
     studio WRITES the modules tree you export; same source of truth, same box)
   - engine.mjs exports (runTurn/prompt builders/loadModules) + lore.mjs + module file formats
     per qmm-android/docs/ENGINE_CONTRACT.md (incl. §v0.2.1 same-scan equivoque exclusivity).
4. **FYI, no action**: entitlement gating on module downloads is still an open TODO on the
   catalog endpoints; the studio now exposes a player-catalog listing toggle (manifest.publish)
   with validator guards, so listed-vs-dev is an authoring decision from here on.

## Definition of done (from the studio's side)

Publish a patch bump from the studio UI → reload responds ok:true → `GET /api/modules` on the
player lists the module at the new version → a live web session's next turn uses the new content
without a container restart. The studio's Publish panel will show all of this going green.
