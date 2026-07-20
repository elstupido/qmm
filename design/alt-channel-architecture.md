# QMM — Alt-Channel Design (native app)

Target: the future native QMM app. The web demo (this repo) is the storytelling
proof. This doc covers how the real product reaches a player outside the app.

Sibling: `waiver-draft-v1.md`. Status: design only. Nothing here is built.

---

## 1. What the channels are

The channels are not a delivery system. They are the trick.

The effect: the player cannot find the edge of the fiction. A game that reaches you through
one channel is a game you can name and block. A thing that reaches you through your texts,
then a different app, then a voice, then goes quiet, is not something you can draw a box
around. That inability to locate the boundary is the illusion of reality, and it is the
product.

Multiple channels are not redundancy. Each is a crack in a different wall. If Yuki only
ever texted, the player would build a model — "the game texts me" — and that model has an
edge. Reaching them through a channel they did not expect denies them the model. The
variety is the point.

---

## 2. Choosing a channel

One rule: the channel is chosen by the fiction being told and the expected emotional
impact. Nothing else. Not reliability, not convenience, not what is easiest to deliver.

The system is a palette, not a router. It makes every channel available for the author to
pick by hand. No logic selects the channel. The beat names its own medium.

Each channel carries a different emotional weight:

- **Text** — arrives silent, read alone, easy to dismiss as a wrong number. Use it for the
  low-intensity, deniable beat: the one you want the player to be able to doubt.
- **A message on a second app (Telegram)** — the player never put Yuki there. Use it for
  the beat where the fiction proves bigger than they thought it was.
- **Voice call** — loud, demands an answer, cannot be ignored or explained away. Use it for
  the undeniable beat.
- **A live channel going silent** — use it for abandonment.

---

## 3. What not to build

These are reliability reflexes. Each one breaks the trick.

- **No "most reliable channel."** Reliability is not the goal. The channel is a creative
  choice; a router that picks the safe one is choosing the wrong scene.
- **No fallback.** A fallback is a visible seam — the audience watches the method hedge. It
  is also the wrong scene: dropping a voice-call beat to a text is not degraded delivery,
  it is a worse, different moment. If a beat cannot fire in its medium, it does not fire.
- **No delivery guarantee.** A thing that always arrives reads as a system, and a system
  has edges. Real contact is unpredictable. The unpredictability is the realism.

---

## 4. The method (what stays hidden)

The method is boring, which is why it holds. The player gave you everything during
onboarding, and the waiver told them so. They forgot both.

Acquisition, all during normal app onboarding:

- **Phone number, via OTP verify.** iOS cannot read the number programmatically; Android is
  nearly as locked. So it is captured the way every app does it — enter number, tap the
  code. Routine, verified, cross-platform.
- **Identity, via Sign in with Google / Apple** — name, email, account id, locale. Not the
  number.
- **Save-our-contact** — a native app can present the OS add-contact sheet, one tap. Web and
  PWA cannot write a contact or read a number at all. This is native-only.

| Want | iOS | Android |
| --- | --- | --- |
| Read the number silently | No (forbidden) | No (modern) |
| Number via OTP | Yes | Yes |
| Name/email via sign-in | Yes (email may be a relay) | Yes |
| Write a contact | Yes (permission/sheet) | Yes (permission/sheet) |

The misdirection is the waiver. It states the method to their face — we may contact you
through unexpected channels, we may know things about you. Saying it is the cover, because
the player dismisses the scary document as theater. The method sits in plain sight, then
gets buried under the days between onboarding and the first contact.

---

## 5. STOP

STOP ends everything, on every channel. Server-side string match before the model sees it,
wipes state. Built for the web demo; the app must honor it across every channel. SMS "STOP"
is carrier-required, so that channel maps for free.

---

## 6. The "how did it know" touch

One or two touches reference the player's real context so precisely it feels impossible.
Material: what they gave at onboarding (name, locale) plus context anyone could look up —
the weather at their city, the actual time. A line about the rain where they are, sent
while it is raining there, costs one API call and reads as impossible.

Boundary — your call. This draft assumes first-party data plus public lookups only, nothing
read from their device (contacts, messages, location history). Tell me where you want the
line.

---

## 7. Voice

Yuki has one fixed, authored voice, generated on the 5090 TTS / full-duplex stack —
delivered first as a voice note, later as a live call.

Clause 4 is a hard constraint on the voice pipeline: it never imitates a voice the player
knows. No cloning of contacts, uploaded samples, or anyone real.

---

## 8. Each channel's real cost

- **In-app push** — free. Only lands if the app is installed and open enough to see it.
- **SMS** — needs A2P 10DLC registration (weeks of paperwork), ~1¢/segment. Discloses
  cleanly on an app store. Cannot carry voice.
- **Telegram userbot** — free, unlimited, carries voice notes. Needs an aged account,
  violates Telegram ToS, can be banned, and does not fit an app-store privacy label — keep
  it off the store-review surface.
- **Voice call** — full-duplex off the 5090.

---

## 9. Phasing

- **P0 — web demo (done).** Story, waiver, STOP, in-app lapse nudge.
- **P1 — one out-of-band touch:** the lapse nudge, arriving after the tab is closed. The
  cheapest proof the Story reaches past the app.
- **P2 — the app:** OTP number, Google/Apple identity, save-contact, waiver in-app.
- **P3 — SMS:** A2P registration in parallel.
- **P4 — Telegram userbot + voice notes.**
- **P5 — live call.**
