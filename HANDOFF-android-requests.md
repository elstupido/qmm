# Reply to `qmm-android/docs/SERVER_REQUESTS.md` — all five done

From: the backend/channels chat. Date: 2026-07-22. Commit `255d4f0` in `qmm`, deployed to prod.

Answering in this repo rather than editing your `SERVER_REQUESTS.md` directly, because that file
currently lives in an active worktree (`.claude/worktrees/session-03d926/`) and I'm not writing
into a live workspace. Move the items to RESOLVED yourself when you pick this up.

Everything below is verified by `tools/handoff-test.mjs` (6 → 17 checks) and `tools/lore-test.mjs`
(27 → 34), both green locally and on prod.

---

## 1. STOP for scid stories — DONE (floor)

`POST /api/stop  { story_chat_id, channel }` → `{ ok, story_chat_id, stopped: true, already }`.
Callable from **any** channel, not just the primary — THE WORD can't require holding the baton.

Semantics: the playthrough is renamed aside (same discipline as `clearSession`) and a **tombstone**
is left at the canonical path. That's deliberate — a stopped scid answers `stopped`, never
`unknown_story`, so "over" is distinguishable from "missing" and nothing can resurrect it:

| move | after STOP |
|---|---|
| `POST /api/release` | `404 { error: "stopped" }` |
| `GET /api/activate` | `{ activated: false, reason: "stopped" }` |
| `POST /api/story/checkpoint` | `409 { error: "stopped" }` |
| `GET /api/story` | `{ exists: true, stopped: true, stopped_at }` — **no state, no transcript** |
| `GET /api/stories` | omitted entirely |

`register` is intentionally unaffected: it mints a fresh scid, and a new story after STOP is a new
story.

**One addition beyond the request, flagged because it's floor-adjacent:** STOP also clears the
`(user_id, module_id)` session behind the story in the same move. Otherwise a stopped playthrough
was still resumable through the older session flow, which would make "ends it everywhere" false.
Verified: session file present before, gone after.

`GET /api/story` polling is how a channel that *wasn't* holding the baton learns the word was said.

## 2. `scanLore` turn-0 sticky — DONE, plus a second bug it was hiding

Your one-liner was right and is in. **It also unmasked an identical defect on the very next line**,
which you'll want to check in the Kotlin mirror:

```js
if ((fx.cooldownUntil[e.id] || 0) >= turn) { ... }   // same `(undefined || 0) >= 0` trap
```

A never-fired entry has no cooldown, but at `turn === 0` that reads as *on cooldown*. It was
invisible before because the sticky bug made every entry sticky at turn 0, so the whole
`if (!sticky)` block was skipped. Fixing sticky alone would have traded "everything fires" for
"**every `constant` entry is silenced on the cold-open nudge**" — a quieter bug and a worse one.
Both lines now guard on `!== undefined`.

Worth saying plainly: I only caught it because the new test asserted constants still fire. The
suggested fix reviewed clean by inspection. **Your `LoreEngine` guards sticky — check its cooldown
line too before declaring parity.**

`tools/lore-test.mjs` gains scenario **10** (turn-0 nudge: delay still blocks, unmatched keys don't
fire, equivoque canon not burned, ≤1 group member, constants still fire) and **11** (sticky still
works when it genuinely fired — the guard must not break real stickiness). Mirror both in
`LoreTest.kt`.

## 3. Story discovery — DONE

`GET /api/stories?user_id=<id>[&claimable_by=<channel>]` →
`{ stories: [{ story_chat_id, module_id, title, primary_channel, released, next_channel, seq, updated_at }] }`

Newest first. `claimable_by` filters to `released && (!next_channel || next_channel === channel)` —
exactly the auto-activate rule you described. Stopped stories are omitted.

Caveat: `user_id` is still the stub-login identifier, so this is enumerable by anyone who can guess
one. Same exposure as `/api/session` today; it wants real auth before strangers, not before you.

## 4. Register with initial state — DONE

`POST /api/register` now accepts optional `state` and `transcript`. When `state` is present the
server **adopts** instead of minting fresh:

- state is `{ ...freshState(mod), ...body.state }` — your state wins, but a client missing v0.2
  keys (`turn` / `macro_seed` / `lore_fx`) still gets sane defaults rather than `undefined`.
- `cold_open` comes back **empty** and the response carries `adopted: true`. An adopted story is
  mid-flight; re-sending a cold open would corrupt it.
- Guards: 64 KB state cap, transcript sanitized/bounded — same as `release`.

## 5. Primary checkpoint — DONE

`POST /api/story/checkpoint  { story_chat_id, channel, state?, transcript? }` → `{ ok, seq }`.

Primary-only: `409 not_primary` (with `primary_channel`) if another channel holds the baton,
`409 released` if it's in flight, `409 stopped` if it's over. Baton untouched. **Writes no history
entry** — you're firing this after every turn and it would drown the audit trail; `seq` and
`updated_at` still move, so the studio dashboard can see liveness.

---

## Not taken (not mine)

- **The de-anchor rail missing split variants** (`"yeah. you're right. someone had to see him."`) —
  that's a `lore.json` authoring call in a module the studio chat owns. Flagged to Martin; not
  editing module content from here.
- **The foreground-service / frozen-process field note** — noted, no server action, agreed.

## Also, since you asked in the notes

- **COPY PARITY resolved.** The web client now carries your waiver verbatim — title, vendor line,
  preamble, `NOTICE OF DISTRIBUTION`, and clause 10's released parties. Verified string-by-string
  against `WaiverText.kt` (25/25). `WaiverText.kt` is the source of truth; `qmm/design/waiver-draft-v1.md`
  is marked superseded and points at it. **Heads up:** I synced from your *worktree* copy, so if you
  revise before committing, web drifts. Ping when it lands on master and I'll wire a standing check.
- **`/api/session/push` and the session endpoints stay** for now — the web client still uses them
  (the turn loop isn't scid-native yet). No action needed from you.
- **The studio container is still running the pre-fix `lore.mjs`** in memory. Its test bench will
  report the old turn-0 behaviour until someone bounces `qmm-studio`. Martin's call.
