# QMMPS — QMM Pacing System

## The problem
Yuki texts back at typing speed even when her words describe an action that takes real
time. "ok. i'll call the police" and the result — "they said an hour. an HOUR." — land two
seconds apart. We are emulating *texting a real person*; a real person who says she's
calling the cops goes quiet for a few minutes first. Right now there is **typing time but no
action time**: `revealYuki` in `public/app.js` waits `min(2400, 620 + len*22)` ms per bubble
and nothing else.

Requirement: actions take a realistic amount of time, computed **systematically and
automatically** — never hardcoded per line, and **gemma never reasons about timing**. It
writes Yuki's words; a separate layer decides how long the world takes.

## Locked decisions
1. **Two-layer duration.** An automatic deterministic heuristic covers everything with zero
   authoring; **injectable waits** let the scripting override it when an author wants precise
   control. Both are pure data into one estimator — not separate code paths.
2. **The model is never in the timing loop.** Every wait source is deterministic. Even a wait
   the *writing* implies is parsed from the text, never *reasoned about* by the model.
3. **Real-time-native.** The system computes and schedules REAL durations. A **debug clock**
   swaps the real wait for a log line (`waiting 4m (call)…`) so the whole flow is testable
   instantly. We are building the SYSTEM — not inserting literal multi-minute gaps into the
   current 6-beat demo, which can run on a compressed/scaled clock.
4. **Text into the void.** During a gap the input stays open. Player messages sent while Yuki
   is "away" queue and are answered when her timeline drains. No blocking, no "she's busy."
5. **Separation of concerns.** Generation emits only Yuki's words. A downstream **pacing
   pass** annotates those words with timing. The two never mix.

## Architecture — a pacing pass downstream of generation

### 1. Action taxonomy → duration bands
One tunable table in `pacing.mjs`, sampled with jitter. Starting bands:

| class           | band      | when                                            |
|-----------------|-----------|-------------------------------------------------|
| `reply`         | ~0        | pure conversation, no off-screen action (chat)  |
| `observe`       | 10–60 s   | look closer, read a note, listen                |
| `move_local`    | 1–3 m     | cross a room, go to a gate, duck away           |
| `descend/enter` | 1–4 m     | stairs, freight elevator, threshold             |
| `travel`        | 2–6 m     | change zones (scaled by zone distance)          |
| `search`        | 2–10 m    | dig through, hunt, find                         |
| `call`          | 3–8 m     | phone someone, wait on hold                     |
| `wait`          | open/long | deliberately waiting — the long-silence weapon  |

The table is the single knob surface; tuning happens here, not in scattered constants.

### 2. Signal fusion → class (the automatic layer)
Deterministic, in priority order:
- **Injectable author wait** (§4) — wins outright when present.
- **intent** → class prior: CALL_HELP→`call`, INVESTIGATE→`search`/`observe`,
  ESCAPE/HIDE→`move_local`, RESCUE_KENJI→`descend`/`search`, RECORD_EVIDENCE→`observe`,
  CONFRONT→`move_local`, OTHER→`reply`.
- **scene change** (`scene_anchor` from→to) via a coarse zone-distance table seeded from the
  `SCENES` map already in `app.js` → `travel`/`descend` + distance-scaled time.
- **text cues** — light regex over the generated bubbles ("calling", "on my way", "walking",
  "heading", "searching", "waiting", "i'm here", "he said") to confirm/adjust the class and
  locate the boundary.
- **chat vs advance** — a `chat` turn is almost always `reply` (~0). Only an `advance` — or an
  injected wait — opens a real gap.

### 3. Announcement→result boundary (where the gap goes)
A turn often has an **announcement** ("ok. calling them now.") then a **result** ("they said
an hour."). The gap belongs BETWEEN them. Resolution order:
- author boundary hint (§4), else
- cue flip: gap after the last announcement-cue bubble ("i'll", "going to", "calling"),
  before the first result-cue bubble ("they said", "i'm here", "it's"), else
- default: gap before the FINAL bubble — the shared generation rules already force the
  clue/reveal to land last, so the last bubble *is* the result, else
- pure `reply`/`chat`: no gap.

### 4. Injectable waits — the scripting/prompt lever
The heuristic is the floor. Three ways to inject an explicit wait, **all deterministic, none
asking the model to think about time**:

**(a) Author `### Pacing` block** — the primary scripting lever. A subsection in the template
block of `response-0X.md`, read by the existing `sub()` helper in `parseTemplateBlock`, stored
as `tpl.pacing`. The model never sees it (it lives outside the fenced template text):

```
### Pacing
- class: call
- duration: 4-8m          # a band, or a fixed 5m / 300s
- boundary: before-result # before-result | before-first | after "calling"
```

A per-family `## Pacing` block gives a beat-wide default for any template that omits its own.

**(b) Inline boundary pin** — an author drops a bare marker (`⟨gap⟩`) on its own line in the
fenced template text at the exact announcement→result seam. `build-pack` records "a boundary
is intended here" and **strips the marker** so gemma never sees it. Because the model reflows
bubbles, this sets *intent* only; the runtime still resolves the actual bubble index by the
§3 cue rule. Degrades gracefully to `before-result`.

**(c) Organic duration cues** — if the *writing itself* names a time ("give me an hour",
"twenty minutes", "gimme a sec"), the cue parser reads that duration out of the generated text
and honors it, overriding the coarse band. This is the "from the prompts" source: when the
model organically implies a specific wait, we obey the words — **without ever asking the model
to reason about pacing.** The model stays dumb about time; the parser does the work.

Precedence: **explicit author wait (a) > organic text duration (c) > intent/scene/cue
heuristic (§2) > default `reply`.** (b) only pins the boundary, not the duration.

### 5. Timeline builder
`bubbles + class + duration + boundary` → ordered entries:

```
{ pre_delay_ms,   // action/wait gap BEFORE this bubble (0 for most)
  type_ms,        // typing time from length — the existing app.js formula, moved server-side
  text,
  class }         // for the debug chip / log
```

Also emits `fiction_clock_delta_min` — the in-fiction minutes the turn consumed. This
**replaces the current random `clockOffset` bump** so the phone clock tracks real action time
(Yuki waits 5 minutes → the status-bar clock moves ~5 minutes).

### 6. Pacer + injectable clock
A `Pacer` plays a timeline through an injected `wait(ms, meta)`:
- **real** — `await sleep(ms)`
- **debug** — log `waiting <humanized> (<class>, <from>→<to>)`, return immediately
- **scaled** (extensible) — `ms × PACING_SCALE` for demos

Mode from env `PACING=real|debug|scaled` (+ `PACING_SCALE`). The in-browser demo defaults to a
compressed/scaled clock so it still plays fast, with real durations logged for tuning.

### 7. Delivery + catch-up seam (real-time transport)
Real gaps mean one HTTP response can't hold all the bubbles open. Generalize the **existing
client poll** — the nudge timer already polls `/api/nudge` — into a scheduled-outbound poll
(or SSE): the server holds the turn's timeline and releases each bubble at its scheduled time;
the client renders as they arrive (typing indicator during `type_ms`, silent gap during
`pre_delay_ms`, input open throughout). Player messages sent during a gap **enqueue
server-side** and process when the timeline drains — "text into the void, she catches up."

Build the estimator + timeline + Pacer + debug fully now (P0). The full async transport is the
larger follow-on (P1) and **shares its primitive with the alt-channel out-of-app reach** — "a
message scheduled to arrive later, delivered on a poll" is the same mechanism whether Yuki is a
few minutes late in-app or texts your real phone after you've closed the tab.

## Reuse (don't reinvent)
- typing-time formula `min(2400, 620 + len*22)` — moved from `revealYuki` into `pacing.mjs`.
- nudge poll (`armNudge`/`fireNudge` + `/api/nudge`) — the template for scheduled outbound.
- `clockOffset` (`app.js`) — driven by `fiction_clock_delta_min` instead of random.
- `SCENES` zone map (`app.js`) — seeds the zone-distance table.
- `sub()` / bullet parser (`build-pack.mjs`) — hosts the `### Pacing` authoring block.
- `qlog` flight log (`server.mjs`) — logs each turn's schedule for tuning.

## Files (implementation follow-on)
- **New `server/pacing.mjs`** — taxonomy table, signal fusion, boundary detection, timeline
  builder, Pacer + clock. Pure, unit-testable.
- **New `tools/pace-check.mjs`** — sibling to `tools/play.mjs`; runs scripted turns in debug
  mode and prints the schedule (`[type 1.2s] "…" / [wait 4m — call] / [type 0.9s] "…"`).
- `server/server.mjs` — call the pacing pass in `handleTurn`/`handleNudge` after
  `generateBubbles`; attach the timeline to the response; honor `PACING`; (P1) the
  scheduled-outbound seam + server-side player queue.
- `tools/build-pack.mjs` — parse `### Pacing` (template) + `## Pacing` (family), strip the
  inline `⟨gap⟩` pin; store `tpl.pacing` / `family.pacing`.
- `public/app.js` — `revealYuki` consumes server `pre_delay_ms`/`type_ms`; input stays open
  during gaps; `clockOffset` driven by `fiction_clock_delta_min`.

## Verification
- `node tools/pace-check.mjs` (debug): default playthrough + targeted cases — "call the
  police"→`call`, gap before the result; "go to the west entrance"→`travel`, distance-scaled;
  pure chat→no gap; a template with an author `### Pacing` block→its explicit duration wins; a
  bubble that says "give me an hour"→~1h honored. No real waiting.
- Unit table: `(intent, scene_from→to, cues, author_pacing?) → assert class + range + boundary`.
- Live debug: `PACING=debug` server, play in-browser, confirm it behaves ~as today and the log
  shows `waiting 4m… (call)` at the right seam.
- Real transport: verified when the P1 async seam lands.

## Phasing
- **P0 (buildable now):** `pacing.mjs` estimator + timeline + Pacer + debug clock +
  `pace-check.mjs` + `### Pacing` authoring in `build-pack`. Wire into `handleTurn`; `app.js`
  consumes `pre_delay_ms`/`type_ms`; demo runs on a compressed/scaled clock. Fully testable, no
  real minute-waits, model untouched.
- **P1 (follow-on):** scheduled-outbound transport (poll/SSE) + server-side player-message
  queue → true real-time gaps + text-into-void. Shares the primitive with alt-channel reach.
