# QMM — Mentalism & Storytelling

> **UPDATE (2026-07-22): every technique below now has DIEGETIC COVER.** The app-wide premise
> (`premise-and-branding.md`) says QMM connects the player to a reflection of themselves,
> matched on similar emotional/physical state, across a fixed block universe. So: mirroring is
> the reflection showing; hot reading is the matching criterion doing its job; equivoque is the
> block universe being already-written; dual reality is two branches leaking. The seams stopped
> being liabilities — the player is *supposed* to wonder whether the app is real. Read this doc
> as the technique manual and the premise doc as the excuse that makes each technique legal
> in-fiction.

## Thesis
An LLM-driven, consenting, text-message horror game is the strongest mentalism instrument
ever built, for two reasons:

1. **The LLM is an infinite-out equivoque engine.** A stage mentalist pre-plans two or three
   "outs" for a forced choice. gemma generates a bespoke out for *any* player input, instantly,
   forever. The router→template engine is already automated equivoque — the craft is hiding
   the seams.
2. **The waiver unlocks the dirty tier.** Stage mentalism has to stay "fair" — self-contained,
   no real data. A signed waiver moves QMM into real data, real-world suggestion, and off-screen
   contact, because the player consented to exactly that uncertainty.

The deeper point that ties mentalism to storytelling: **equivoque is the solution to the core
choose-your-own-adventure problem.** A branching story is expensive and shallow; a purely linear
story feels on-rails. Magician's choice sells *authored inevitability as player agency* — the
player feels they chose, the author keeps the beats. QMM's entire narrative design is equivoque.
Everything below is in service of that.

## What we already do (crudely)
- **Mirroring** — Yuki echoes the player's wording (`generateBubbles`: "adapt to the player's
  message").
- **Forcing** — the router funnels any input into 8 intents → one fixed next beat.
- **The convincer** — the waiver. Signing it primes the player to attribute coincidence to the
  Story (clause 7 installs the apophenia before play even starts).

Baby versions. The work is making them deliberate.

## Two tiers of technique
- **Tier A — rapport & immersion** (mirroring, cold reading, pacing-and-leading, Barnum). Makes
  Yuki feel real and the player feel known. Low-risk, high-immersion. Automate freely.
- **Tier B — impossible knowledge / agency-was-an-illusion** (equivoque, hot reading, one-ahead,
  nocebo, dual reality). The scares. High-risk (a visible seam kills them), consent-gated. This
  is where the waiver earns its keep.

## Equivoque (the spine)
The magician's choice: whatever the participant "freely" picks is interpreted to reach a
predetermined outcome; the participant feels ownership, the outcome was fixed.

QMM mapping:
- **Macro:** every path reaches S06. Already equivoque — but crude, because the player never
  makes a *framed* choice they feel they own; they just advise.
- **The upgrade:** stage explicit apparent-binaries ("go down, or stay up here with me?"), author
  both branches to the same to-state (the state machine already allows different intents → same
  `to`), and word the *payoff* so the player's specific pick reads as the cause.
- **The LLM advantage:** infinite outs. Any input can be bridged to the predetermined beat,
  in-voice. The transition-quality work (make the bridge feel natural, not templated) *is*
  equivoque-seam-hiding.

## The toolkit — what / QMM use / automation hook

**Mirroring** — reflect the player's texting fingerprint.
- Use: a lowercase-no-punctuation texter gets a lowercase-no-punctuation Yuki. Match caps,
  punctuation, bubble length, emoji, slang, reply latency.
- Automate: **deterministic, no model call.** A preprocessing pass fingerprints the last N
  player messages → sets Yuki style params fed into the prompt. Cheapest, highest-ROI uncanny
  hit. **Build first.**

**Cold reading from telemetry** — reflect the player's own behavior back as insight.
- Use: reckless player → "you keep running at it. you're like that with everything, aren't you."
  Cautious player → "you keep trying to keep me safe."
- Automate: the profile already exists — `danger_level`, `evidence_found`, intent history. Tag
  play-style → select from a Barnum / rainbow-ruse line library. Feels like she sees the player;
  it's telemetry.

**Hot reading** — real data as divination (the "how did it know" engine; see
`alt-channel-architecture.md`).
- Use: onboarding data (name, city, local time, weather) deployed as knowledge. "it's 2:47 where
  you are. you should be asleep."
- Automate: inject first-party context at chosen moments. **High-confidence data only** — a
  stale fact is worse than none.

**One-ahead / preloading** — appear to predict by reporting ahead of the reply.
- Use: during a gap, Yuki sends a vague prediction *before* the player moves — "i have a feeling
  you're about to tell me to do something stupid." Whatever they say retrofits it.
- Automate: the pacing system's scheduled-outbound / the nudge mechanism, repurposed (see
  `pacing-system.md`). Keep the prediction vague enough to fit multiple replies; gemma pivots on
  the miss.

**Priming / seeds** — plant early, resurface as prophecy.
- Use: a word or image dropped three beats back that the player later "chooses," or that "comes
  true."
- Automate: a **seed ledger** in state + a generation instruction to call one back at the right
  moment.

**Nocebo / real-world suggestion** (dirtiest, waiver-gated).
- Use: suggest the player check their actual environment; pareidolia + suggestion do the work.
  "is your door still shut? mine won't stay closed."
- Automate: authored sensory-bridge lines, fired sparingly, gated hard (see Rails). This is the
  technique the waiver exists to cover.

**Dual reality** — two internally-consistent truths for two observers (or the player's now-self
vs. later-self).
- Use: a message the player experiences as targeted reads as mundane to a bystander; or the same
  line means one thing before a reveal, another after.
- Automate: mostly authored. The LLM can hold two consistent readings if prompted, but this one
  doesn't fully automate.

## The waiver as instrument
The waiver is three things at once:
1. **Ethical unlock** — consent is what separates "creepy stalking" from "the game you signed up
   for."
2. **Legal-ish cover** — the release (clause 10, placeholder; not lawyer-vetted).
3. **The strongest convincer in the deck** — signing primes attribution. Clause 7 ("arranged vs
   coincidence, I won't be able to tell") *installs the effect* before the first beat.

Clause → license map:
- clause 3 (unexpected channels/times) → off-channel one-ahead + hot reading;
- clause 5 (knowledge I don't remember providing) → hot reading;
- clause 7 (arranged vs coincidence) → equivoque + coincidence-mining;
- clause 4 (voice of no one I know) → the hard rail on the future voice-call rung.

## Storytelling — the techniques ARE narrative devices
This isn't cheap trickery bolted onto a story; each technique is a storytelling tool:
- **Mirroring → character.** Yuki reads as a person, not a bot.
- **Cold reading → stakes.** The horror gets personal — it's about *you*, not a fictional
  protagonist you're steering.
- **One-ahead / nocebo → dread.** Anticipation, and the collapse of the screen boundary.
- **Hot reading → the reality-blend.** The fiction reaches into the real.
- **Equivoque → agency.** The player owns a story the author fully controls — the CYOA holy grail.

The classic craft that pairs with it: setup/payoff (the convincer, the seed), show-don't-tell
(the doubt is built through play, never claimed), ambiguity-as-product (clause 7 sells uncertainty
as the thing being purchased), and the unreliable boundary (is this the game, or my life?).

## Failure modes & rails (here, craft *is* ethics)
Two things will bite, and the fix is the same for both:

1. **A visible seam kills the trick harder than never trying.** A blown out (wrong prediction,
   no recovery), a stale hot-read, a mistimed nocebo → the spell breaks and the player feels
   *manipulated*, not *haunted*. Every Tier-B fire needs a **graceful out** and **high-confidence
   data only**. Same lesson as the dead-channel problem (`alt-channel-architecture.md`):
   unreliability is fatal to the fiction.
2. **The dirty tier can actually harm a suggestible person at 3am** — which is exactly what the
   waiver warns about. Consent makes it defensible; you're still responsible. The rails that keep
   it *working* are the same ones that keep it *safe*:
   - **STOP** kills everything, all channels, before the model ever sees it.
   - **Rate-limit** nocebo / real-world suggestion — it's a spice, not a staple.
   - **Distress detection** — don't push when the player reads as genuinely distressed rather
     than playing scared. (A Tier-A read is enough to tell the difference.)
   - **Quiet hours** unless the fiction has explicitly earned the 3am contact.

   These aren't censorship. A trick that traumatizes doesn't get a second session.

## Build order
1. **Mirroring** — deterministic, free, immediate uncanny. No new infrastructure.
2. **Cold reading from telemetry** — the state profile already exists; add a Barnum library +
   play-style tag.
3. **Seed ledger + one-ahead** — ride the pacing scheduled-outbound once it lands.
4. **Hot reading + nocebo** — ride the alt-channel onboarding/data layer; gate hard.
