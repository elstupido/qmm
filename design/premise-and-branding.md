# QMM — Premise & Branding (the app-wide frame)

> **STATUS: this is the top-level fiction for the whole product (2026-07-22, Martin).** Every
> story ships inside it. Individual modules are *content*; this document is the *platform*.
> QMM now expands to **Quantum Media Messenger** — "Quantum Murder Mysteries" is retired as the
> product name and survives only as a genre label for the murder-mystery modules.

## The pitch (what the player believes they installed)

You downloaded **QMM — Quantum Media Messenger**, by **ACME Co.** It is a messenger app. It
connects you to another person who is *in a similar emotional or physical state* to you.

The fine print says it more precisely, and worse: what you are connected to is **"a reflection
transformed over the eigenvector embeddings of the block universe."**

The other person is not in your world. They are somewhere sideways — another branch, another
history, something other. **The government that developed QMM does not know it has been
released.** There is no support. There is no version history. There is an EULA nobody read.

## Three diegetic layers — know which one you are writing

1. **The app (ACME QMM).** Corporate, chipper, mid-century-cheerful, and wrong. Install flow,
   EULA, connection chrome ("establishing reflection…", "counterpart state drift"), the
   silences. Consistent across every story. NOT the author's surface.
2. **The connection.** The match: why *this* person, *now*. Established at session start, and
   the source of every "how did it know me" beat.
3. **The story.** What is happening on the other person's end — the module. Beats, templates,
   lore. **This is the only layer an author writes.**

An author's module is layer 3. Layers 1–2 are platform chrome and must not be re-invented per
module (see "What changes where").

## The physics, unpacked (and what each clause licenses)

The block universe (eternalism) holds that all of time — past, present, future — exists at once
and is fixed. The "eigenvector embedding" dressing says QMM finds a person whose state vector
aligns with yours under some transform. They are you, rotated.

| The fiction says | Which licenses |
|---|---|
| It matched you on **similar emotional/physical state** | **Hot reading.** Of course they know it's 2:47am where you are — that similarity is the *matching criterion*. |
| They are a **reflection** of you | **Mirroring.** Texting like you isn't a trick, it's evidence the match is real. Cold reads = the transform showing through. |
| The universe is a **block** — already written | **Equivoque.** Authored inevitability IS the setting's physics. Every intent converging on one beat is not a seam to hide; it is the truth of the world, and a story may flirt with saying so. |
| The transform is **lossy and unstable** | **Breaches.** Signal degradation, bleed-through, the other side arriving where it shouldn't. |
| It reaches **sideways** (multiverse / alt history / other) | **Dual reality.** Two readings of one line = two branches, both true. |
| It is **leaked government tech** | No support, no explanations, odd app behavior, and a franchise-level meta-arc available but never required. |
| The app is **not contained in the app** | **Alt-channels.** SMS, calls, and off-app contact are the leak spreading, not a gimmick. |

**This is the important part:** every mentalism technique in `mentalism-and-storytelling.md` now
has in-fiction cover. Before, a hot read was a trick that died if the seam showed. Now the seam
*is the product* — the player is meant to wonder whether the app is real. Uncertainty was always
what we sold (waiver clause 7); the premise makes it the platform's stated purpose.

## Determinism is canon (the equivoque upgrade)

Under a block universe the future has already happened. So an author may, sparingly and late,
let a protagonist brush against it:

    "it already happened. i'm just telling you in an order you can stand."

Do not over-spend this. One brush per story, at most, and never as an explanation — the moment
the fiction *explains* itself, the dread converts to trivia.

## Story taxonomy — every module declares its flavor

- **Multiverse** — a branch of our world. Divergence is recent and personal.
- **Alternate history** — a branch that split long ago. Divergence is civilizational.
- **Something other** — not a branch of anything recognizable. Reserve for the worst ones.

The flavor sets what the player's disbelief has to do: a multiverse story is "this could be
me," an alt-history is "this could have been us," an other is "this should not be reachable."

## Protagonist awareness — DEFAULT: they do not know

**Default (recommended, and what shipped modules already do):** the protagonist does NOT know
they are texting a stranger from another branch. They believe you are *their* person — the
friend who should be awake right now. The player receives messages meant for their counterpart.
That is dual reality for free, it is spookier, and **Kokugikan already reads exactly this way,
so the retrofit cost is zero.**

Alternative (per-module, deliberate): the protagonist knows about QMM because it leaked on their
side too. Reserve for stories *about* the app. Reversible; it is a content choice, not a format
one.

## The ACME wrapper

ACME Co. is the tonal joke that makes the horror land: a cheerful corporate voice wrapped around
a cursed artifact. Anvils and rocket skates in the brand's DNA; a leaked reality-bridging
messenger in the product. Keep app chrome relentlessly upbeat — the dissonance does the work.

**Caveat, once, then never again:** "Acme" as a company name is generic and was used by real
businesses for a century — using it for a fictional corporation is low risk and common. What is
NOT free: Warner Bros.' *Merrie Melodies* branding, their character IP, and any logo styled to
look like theirs. Our ACME gets its own look and never references the cartoons in-product. If
this ever goes commercial at scale, it is a five-minute lawyer question, not a design question.

## The waiver becomes the EULA

`waiver-draft-v1.md` is now **ACME's End User License Agreement** — the thing that was always
there, that you clicked through, that nobody reads. This is a straight upgrade to the strongest
convincer in the deck: a participation agreement asks you to consent to a story; **an EULA for a
leaked government instrument tells you what the instrument does.** Its clauses re-read perfectly
under the frame — unexpected channels (clause 3), knowledge you don't remember providing
(clause 5), arranged-vs-coincidence (clause 7). Same text, colder source.

> **✅ REWRITE DONE — backend/channels chat, 2026-07-22.** It's in `waiver-draft-v1.md` (filename
> kept so every pointer still resolves). All ten clauses survive; letterhead and party are ACME's;
> clause 10 still flagged. **One deliberate departure from "same text, new letterhead":** Section II
> (THE WORD) and a new Operator Disclosure are written *out of character* on purpose — a fully
> diegetic consent surface makes `ethics-and-safety.md`'s concern #2 (the untrusted exit) strictly
> worse, since STOP would then live inside the voice the player is being taught to doubt. Breaking
> character exactly once is what makes the safeword legible as real. Consequence for the frame:
> **ACME never admits QMM is fiction** — that acknowledgment moved out of clause 2 into the plain
> voice. Rationale in that doc's design notes.

## Naming — the acronym survives, so the code doesn't move

"Quantum **Media Messenger**" preserves **QMM**: repo names, ports, module ids, env vars, the
`qmm-*` containers, and every API path stay exactly as they are. **Zero rename cost in code.**
Only human-visible strings change, and they are few:

- `README.md` title (this lane)
- module `title` fields — "Quantum Murder Mysteries — Kokugikan" → Kokugikan keeps its own title;
  the product name should not be in a module title at all
- `server/engine.mjs` prompt strings name the product to the fill model (backend lane — and note
  the engine-parity golden fixtures pin those exact strings, so it is a deliberate re-baseline,
  not a drive-by edit)
- channel app strings, install/EULA flow (channel lanes)

## What changes where

- **This lane (studio/authoring):** `authoring-skill.md` leads with the frame; module titles drop
  the product name; scaffold and overview eventually carry the story flavor.
- **Backend:** engine prompt strings + parity fixture re-baseline; possibly a manifest
  `connection: {flavor, …}` field if we want the platform to know a story's flavor.
- **Channels (web/android):** the app chrome — install, EULA, connection handshake, silence and
  drift messaging. This is where most of the branding actually lives, and none of it is mine.
- **Docs:** waiver → EULA rewrite; `mentalism-and-storytelling.md` gains the diegetic-cover note.

## Open decisions (Martin's, not mine)

1. **Does the connection handshake belong to the app or the module?** Recommendation: the app —
   one consistent ritual, so authors never re-write it and every story feels like the same
   instrument.
2. **Does the government meta-arc ever surface in a story,** or stay wallpaper? Recommendation:
   wallpaper for now; a franchise arc is a promise that has to be paid off.
3. **Does the flavor become a manifest field** (validator-visible) or stay an authoring
   convention? Recommendation: convention first, field only if the platform needs to branch on it.
