# QMM — Quantum Murder Mysteries demo

A murder mystery told entirely as a text-message conversation. You text Yuki; a local
LLM (`gemma4:e4b` in ollama) classifies each of your texts into one of 8 intents, picks
the matching authored response template for the current story beat, and writes Yuki's
reply in-voice. Seven beats, 48 templates, 8 unique endings.

The design is authored as a set of markdown templates; the runtime story pack is pre-built
and committed at `server/story-pack.json`, so this repo runs as-is.

## Requirements

- [Node.js](https://nodejs.org) 18+ (zero npm dependencies)
- [ollama](https://ollama.com) running, with the model pulled: `ollama pull gemma4:e4b`

## Run it

```bash
node server/server.mjs      # serves http://127.0.0.1:8791
```

On Windows you can use the detached helper instead:

```powershell
powershell -ExecutionPolicy Bypass -File start-qmm.ps1        # start
powershell -ExecutionPolicy Bypass -File start-qmm.ps1 -Stop  # stop
```

Then open http://127.0.0.1:8791. Config via env: `PORT` (default 8791), `OLLAMA`
(default `http://127.0.0.1:11434`), `MODEL` (default `gemma4:e4b`).

## How a turn works

Story beats are drawn out: between advances Yuki is **just a chatbot** with the beat's
context shoved in her head. Advancing the story is effectively a tool call the model
chooses.

1. `POST /api/turn` with `{state, user_message, reply_latency_s, transcript_tail}`
   (client holds all state; the server is stateless).
2. ollama call 1 — the **router** ("advance_story tool"): decides `chat` vs `advance` and
   measures intent in one schema-locked call (temp 0). Pacing inputs: chat exchanges spent
   on this beat and the player's reply latency. Server overlay: after 4 chat exchanges the
   next message force-advances (the `R0X_OTHER` templates are built for exactly that).
3. ollama call 2 —
   - **chat**: Yuki replies with ONE short message (two only to complete a thought,
     temp 0.9). Prompt carries the beat's situation, its do-not-reveal rules, and the
     beat's 8 templates as EXAMPLES she must not deliver early.
   - **advance**: the `R0<beat>_<INTENT>` template is populated into 3–8 bubbles
     (temp 0.85) and state updates apply mechanically; beat 6 adds the `ending` object.
4. `POST /api/nudge` — the client's silence timer (25–45 s of player quiet) asks for one
   double-text (nervous follow-up / sensory detail / "you there?"). No state change.

Thinking is ON and `num_predict` is a generous 16384 runaway guard (num_ctx 32768) —
**gemma4:e4b is a thinking model: a small num_predict gets consumed by the think phase and
the reply comes back EMPTY (`done_reason: length`). Never lowball it.** Warm timings on
the 5090: chat ~4–6 s, advance ~5–8 s, typing indicator covers both.

## Files

- `tools/build-pack.mjs` — parses the design markdown → `server/story-pack.json`.
  **Re-run after the design templates change**, then restart the server.
- `tools/play.mjs` — scripted playthrough smoke test (`node tools/play.mjs` or
  `node tools/play.mjs "msg1|msg2|..."`). Flags misclassifications, `{{`-leaks, fallbacks.
- `server/server.mjs` — zero-dependency Node server (static + API). Env: `PORT`, `OLLAMA`, `MODEL`.
- `public/` — the phone UI. Add `?debug=1` (or menu → debug) for template/intent chips.

## The waiver

First visit is gated by the participation agreement (`design/waiver-draft-v1.md`, baked
into `index.html`): type initials, stamp each clause, sign, "sign anyway". Logged
server-side (`waiver_signed`). THE WORD: a bare "stop" message (any casing/punctuation,
alone) is string-matched **server-side before the model sees it** → `{mode:"stopped"}`,
terminal screen, session + signature wiped, `stop_word` logged. Re-entry = re-signing,
and every restart ("start a new story" / "play again") also wipes the signature — each
new story begins at the waiver.

## Frontend niceties

Battery drains and signal bars degrade as Yuki goes deeper underground; the contact
status line tracks her `scene_anchor`; typing-indicator pacing covers LLM latency;
localStorage persistence; per-beat snapshots power "redo my last text" and the
ending-card "redo final choice".
