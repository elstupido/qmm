# Authoring MCP Server — Plan

Expose the Author Studio's tool layer as an MCP server so ANY MCP-capable chat interface
(Claude Code, Claude Desktop, the Claude phone app, anything else that speaks the protocol)
can drive story authoring. The client's own LLM becomes the authoring agent; the built-in
MiniMax author chat remains as the zero-setup default.

## Why this is cheap and right

Everything hard already exists and is tested:
- `studio/lib/author-chat.mjs` `TOOL_IMPL` — the 11 authoring tools (overview, character, meta,
  intents, beats, templates, lore, rails, validate, test_fill) with guards, rev-safe draft
  writes, and a 46-assertion suite.
- The studio HTTP service with token auth, the tool ledger (`author_tool`), transcripts,
  ACTIVE_TURNS gauge, drafts/publish separation, and the engine-split law (game runs on gemma;
  test_fill always hits the game engine).
MCP adds a protocol skin, not new machinery. One tool truth, many doorways: built-in chat,
HTTP, MCP — all dispatch into the same TOOL_IMPL.

## Architecture decision: proxy over the studio, not a second brain

Two possible shapes:
- **Lib-direct**: an MCP process imports TOOL_IMPL and edits the local tree. Fast, offline —
  but it forks the operational surface (no ledger, no gauge, wrong tree when the real drafts
  live on the prod box).
- **Proxy (CHOSEN)**: the MCP server is a thin stdio↔HTTP translator that calls the studio's
  API (`STUDIO_URL` + `STUDIO_TOKEN` env — point it at prod for the real drafts, or a local
  studio for offline work). Single source of truth, ledger/transcript/gauge coverage for free,
  zero logic duplication, and it inherits every future tool automatically.

## Phase 1 — generic tool endpoint on the studio (~1h)

`POST /api/studio/tool/<module_id>/<tool_name> {args}` → dispatches into TOOL_IMPL.
- Token-gated like every mutation; counts in ACTIVE_TURNS (deploy safety); logs to the
  author_tool ledger with `source: "mcp"` (observability parity with the built-in chat).
- Also `GET /api/studio/tooldefs` → the tool manifest (name/description/JSON-Schema) exported
  from the same `toolDefs()` that feeds MiniMax — schemas stay in lockstep by construction.
- Plus two small tool additions that a general agent needs and the built-in chat didn't:
  `list_modules` (dashboard data) and `read_doc(module_id, doc)` (full manifest/pack/lore
  read-back; overview is summary-only). `create_module` (scaffold) rides the existing endpoint.
- Suite: HTTP-level tests for dispatch, auth, unknown tool, ledger tagging.

## Phase 2 — the MCP server itself, stdio transport (~2–3h)

`studio/mcp.mjs` — hand-rolled JSON-RPC 2.0 over stdio (zero-dep house rule; the stdio MCP
surface is small: `initialize`, `tools/list`, `tools/call`, `prompts/list`, `prompts/get`,
`ping`). Pin to the current widely-supported protocol revision; stdio is the stable transport.
- `tools/list` = fetched from `/api/studio/tooldefs` (cached per session).
- `tools/call` = POST to the tool endpoint; results returned as MCP text content (JSON).
- **The system-prompt problem**: the built-in chat injects the FORMAT LAW + pacing law; MCP
  clients bring their own system prompts. Solve three ways at once:
  1. Tool descriptions stay rich (they already carry the law fragments).
  2. MCP prompt `authoring-briefing` — the full format law + workflow; Claude surfaces
     prompts as slash commands.
  3. `get_authoring_guide` tool for clients without prompt support (agents discover it via
     its description: "call this before authoring").
- **Publish stays human-only.** The publish/rollback/listing endpoints are deliberately NOT
  exposed as MCP tools — same law as the built-in chat. (Env escape hatch considered and
  rejected; the Publish panel is the button.)
- Registration: `claude mcp add qmm-author -- node <repo>/studio/mcp.mjs` with
  `STUDIO_URL`/`STUDIO_TOKEN` env; document local-vs-prod pointing in DEPLOY.md.
- Suite: spawn the server over pipes, do the initialize handshake, list tools, call
  `get_module_overview` against a scratch studio, assert ledger got `source:"mcp"`.

## Phase 3 — remote MCP for claude.ai / the phone (gated on Martin's infra call)

Streamable-HTTP MCP transport served by the studio itself, so claude.ai connectors and the
phone app can attach without a local process. The hard part is not code, it's the edge:
**Cloudflare Access intercepts with a browser login that MCP clients cannot perform.** Options,
pick one when we get here:
  a. **CF Access service token** for the MCP path (client sends CF-Access-Client-Id/Secret
     headers — works where the client supports custom headers).
  b. **Tailnet/LAN-only** remote MCP (desk + phone on the tailnet; no public exposure).
  c. A separate non-CFA path with strong bearer auth only (weakest posture; last resort).
Until decided, Phase 2's stdio server on the 5090 pointed at the prod studio already covers
"author from any chat interface at the desk," and the built-in chat covers the phone.

## What the client's voice gets us for free

The Claude phone app's native voice mode + this MCP = hands-free authoring with a
production-grade voice stack — no custom mic/TTS code in the loop. The studio's own voice
chat remains the CFA-friendly fallback.

## Risks / notes

- Protocol drift: hand-rolled MCP must track the spec's revision; stdio + the five methods
  above are the stable core. Revisit if we want resources/notifications.
- Concurrent authors (MCP agent + built-in chat + manual editors): tool writes are fresh-load
  + rev-checked save per call — last-write-wins per tool, acceptable single-operator; the
  ledger records who did what (`source` tag).
- Result sizes: `read_doc` on a big pack is large; cap or per-family pagination if it bothers
  clients.
- Anti-goal: do NOT expose the MiniMax author chat itself as an MCP tool (nested agents).
  The point is the client's LLM does the authoring with the same hands.

## Definition of done

Phase 1+2: from a fresh Claude Code session on the 5090 — `claude mcp add`, ask Claude to
"add a lore entry to dark-demo and validate," watch it call the tools; the prod studio's
ledger shows the calls tagged `mcp`, the transcript-equivalent (client-side) is the client's
own history, and the draft reflects the edit in the studio UI.
