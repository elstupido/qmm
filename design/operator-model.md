# QMM — Operator Model (human-in-the-loop)

> **STATUS (2026-07-22): LIVE TEMPLATING IS SHELVED — Martin's call.** The live-edit-while-running
> surface described below (showrunner cockpit, live authoring into the delivery pool, operator
> injects, population dashboard) is off for now. Authoring is offline and agent-assisted (Author
> Studio + MCP), shipping through the draft → validate → publish → hot-reload ceremony. What
> SURVIVES unchanged: the tier split itself (Martin authors frames at the content tier; the machine
> fills each frame per player), the fill-time mentalism automation as the load-bearing
> personalization layer, and the safety autopilot. The authoring doctrine distilled from this suite
> lives in `design/authoring-skill.md` (runtime-loaded, operator-editable). The rest of this doc is
> kept as the design record for if/when live operation is revisited.

## Decision
QMM's intelligence is **Martin, not gemma — at the content tier, not the message tier.** Martin is
the DM/showrunner: he authors and live-edits the templates, scenarios, beats, and world-moves; the
automation instantiates them for each player, personalized. **He rarely if ever messages a player
directly** — a DM works the world, not the phones.

The split is by TIER:
- **Martin authors the frames** (live templating).
- **The machine fills each frame** with the individual player's reality and delivers it.

Author a beat once, land it on hundreds. That's the leverage, and it's how DMs actually run tables.

Three reasons it's right, not a retreat:
1. **A live human is the gold-standard mentalism instrument** — the LLM only approximates it
   (`mentalism-and-storytelling.md`).
2. **A human in the loop is a safety asset** — but see the honest caveat below; at the content tier
   this benefit is thinner than in a per-player model.
3. **It's Martin's core competency** — he runs tables and builds GM cockpits (GM-Helper, Amanuensis).

It also retro-confirms the "Big Brain updates the templates before the player enters the next room"
instinct from the Model_Interactions sketch. The big brain was never a cloud model — it's Martin,
live.

## The split — by tier, not by player
- **Machine (per-player delivery + personalization):** routing, chat/filler, nudges, scheduling, and
  — crucially — the personalization *fill*: mirroring, hot reading, cold-reads from telemetry,
  equivoque outs (`mentalism-and-storytelling.md`). It takes Martin's frames and makes each feel
  written for that one player. Plus the safety autopilot.
- **Martin (content tier — DM/showrunner):** authors and live-edits templates, scenarios, beats,
  world-moves, news-anchors; reads the population and adjusts the playbook while it runs. Reaches a
  single player directly only rarely (edge-case safety, a truly special situation).
- **The bet:** great human-authored frames + solid automated personal-fill beats hand-crafting each
  player (which doesn't scale). **Consequence: the mentalism automation is now load-bearing** — it
  carries ALL the "how did it know *me*," because Martin isn't hand-noticing player #47; the machine
  is, using his frames. A weak fill engine = generic templates with no personal bite.

## The console — a showrunner's cockpit (not an answering station)
1. **Population dashboard** — read the room at scale: where every player sits in the story, what's
   landing, what's breaking, emergent situations forming, safety flags across the population.
2. **Live template/scenario authoring** — the core surface. Edit beats, author new branches / moves /
   anchors, push them into the live delivery pool with version + hot-reload so changes reach
   downstream players. This is "live templating."
3. **The safety autopilot** — automated, instant, always-on, runs WITHOUT Martin: STOP, distress
   circuit-breaker, crisis resources, intensity governor (`ethics-and-safety.md`, Pile B). The rare
   direct human intervention flows through here.

The old "needs-you queue" becomes an **alert feed**, not a per-player inbox: population signals ("this
beat is failing across 20 players — come look"), authoring prompts ("a news event worth an anchor just
landed"), and safety escalations past autopilot.

## Architectural implications (a real rethink of the demo)
- **Server-side per-player state.** The demo is client-holds-state / stateless server
  (`server/server.mjs`, `public/app.js`). Human-in-the-loop REQUIRES the server to own per-player
  state + history so the console can observe and the machine can act. Biggest change from the demo.
- **Out-of-app, async, multi-channel delivery.** "DM from the backend" *is* the alt-channel model
  (SMS/Telegram/push) — the console is the operator side of `alt-channel-architecture.md`; the pacing
  system's scheduled-outbound is the send primitive (`pacing-system.md`).
- **The console is a showrunner's *desk* tool** (authoring + observability), so 3am phone-reachability
  matters less than first framed — direct intervention is rare and safety is autopiloted. WPF (his
  usual cockpit stack) is back in play alongside web.
- **gemma's job = the fill engine.** It personalizes and delivers Martin's frames; it never has to be
  autonomously brilliant. Keeps it local/on-device; de-prioritizes the transition-quality grind.

## What this changes about earlier decisions
- **Transition-quality rules-pass:** Martin authors the signature frames live; gemma does the fill.
  The de-anchor grind stays parked.
- **Pacing system stays essential** — async gaps make one-showrunner-many-players possible; its
  scheduled-outbound is the delivery primitive.
- **Mentalism toolkit is now central, not optional** — it IS the per-player personalization layer.
  Tier-A (mirroring, cold reads) + the automatable Tier-B fills (hot reading) carry the intimacy.
- **Ethics — honest reversion:** human-in-the-loop was sold as the fix for concerns 1/2 (capacity +
  distress) *because a human reads the messages.* At the content tier, Martin mostly does NOT read
  individual streams. So the **automated distress circuit-breaker has to carry concerns 1/2 after
  all**, backed by the population dashboard. The "human natively catches the person coming apart"
  benefit dilutes; the autopilot gets more load, not less. Do not treat 1/2 as solved by this model.

## Open questions
- **Console platform:** web vs WPF — reopened; it's a desk authoring tool now, phone-reach less critical.
- **How live is "live templating"?** Hot-reload granularity: does a template edit hit in-flight
  players, only those who haven't reached that beat, or the next cohort?
- **Distress coverage under this model:** with Martin off the per-message loop, do the automated
  circuit-breaker + population dashboard actually catch the vulnerable player? Re-open concerns 1/2.
- **Authoring throughput** (the new volume question): how many live templates/scenarios/anchors can
  one showrunner keep *good* across N players and M concurrent stories? Measure before widening rings.
- **One → few operators:** does it ever allow trusted co-authors (more content = more players), and
  how does that hit intimacy and consistency?

## Build (follow-on)
Server-side-state refactor → the fill/personalization engine (mentalism automation) → the showrunner
console (population dashboard + live authoring + safety autopilot) → an authoring-throughput
reality-check before widening past friends.
