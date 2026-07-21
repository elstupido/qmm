#!/usr/bin/env node
// QMM Authoring MCP server — a thin stdio <-> studio-HTTP proxy, so ANY MCP-capable chat client
// (Claude Code, Claude Desktop, the phone app via a bridge) authors stories with the exact same
// tools the built-in author chat uses. Zero dependencies: newline-delimited JSON-RPC 2.0 on stdio.
//
//   env: STUDIO_URL   (default http://127.0.0.1:8792 — point at prod for the real drafts)
//        STUDIO_TOKEN (required — the studio's write token)
//
// Register (Claude Code):
//   claude mcp add qmm-author -e STUDIO_URL=http://<studio> -e STUDIO_TOKEN=<token> -- node studio/mcp.mjs
//
// Design (design/authoring-mcp-plan.md): proxy over the studio, never a second brain — one tool
// truth (TOOL_IMPL), and every call lands in the studio's ledger tagged source:"mcp".
// Publishing is deliberately NOT exposed: human-only, via the studio's Publish panel.

import { createInterface } from 'node:readline';

const STUDIO_URL = (process.env.STUDIO_URL || 'http://127.0.0.1:8792').replace(/\/$/, '');
const STUDIO_TOKEN = process.env.STUDIO_TOKEN || '';
const PROTOCOL = '2025-06-18';

let toolCache = null; // { tools: [mcp defs], briefing }

async function studio(method, path, body) {
  const res = await fetch(STUDIO_URL + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-studio-token': STUDIO_TOKEN, 'x-qmm-source': 'mcp' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.detail || `studio HTTP ${res.status}`);
  return data;
}

async function loadTools() {
  if (toolCache) return toolCache;
  const { tools, briefing } = await studio('GET', '/api/studio/tooldefs');
  const mcpTools = tools.map(t => {
    const params = JSON.parse(JSON.stringify(t.parameters || { type: 'object', properties: {} }));
    if (t.name !== 'list_modules') {
      params.properties = { module_id: { type: 'string', description: 'the module to work on (see list_modules)' }, ...params.properties };
      params.required = ['module_id', ...(params.required || [])];
    }
    return { name: t.name, description: t.description, inputSchema: params };
  });
  mcpTools.push({
    name: 'get_authoring_guide',
    description: 'Returns the QMM authoring briefing: the format law, pacing law, and workflow. CALL THIS ONCE BEFORE ANY AUTHORING WORK if you have not already read it.',
    inputSchema: { type: 'object', properties: {} },
  });
  toolCache = { tools: mcpTools, briefing };
  return toolCache;
}

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'qmm-author-studio', version: '1.0.0' },
      });
    }
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return; // no response
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') {
      const { tools } = await loadTools();
      return reply(id, { tools });
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = { ...(params?.arguments || {}) };
      const { briefing } = await loadTools();
      if (name === 'get_authoring_guide') {
        return reply(id, { content: [{ type: 'text', text: briefing }], isError: false });
      }
      const moduleId = String(args.module_id || '');
      delete args.module_id;
      if (name !== 'list_modules' && !moduleId) {
        return reply(id, { content: [{ type: 'text', text: 'module_id is required — call list_modules first' }], isError: true });
      }
      try {
        const r = await studio('POST', `/api/studio/tool/${encodeURIComponent(moduleId || '-')}/${name}`, { args });
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(r.result, null, 2) }], isError: false });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: `tool failed: ${String(e.message || e)}` }], isError: true });
      }
    }
    if (method === 'prompts/list') {
      return reply(id, { prompts: [{ name: 'authoring-briefing', description: 'The QMM story-authoring briefing: format law, pacing law, workflow.' }] });
    }
    if (method === 'prompts/get') {
      if (params?.name !== 'authoring-briefing') return fail(id, -32602, 'unknown prompt');
      const { briefing } = await loadTools();
      return reply(id, { messages: [{ role: 'user', content: { type: 'text', text: briefing } }] });
    }
    if (!isNotification) fail(id, -32601, `method not found: ${method}`);
  } catch (e) {
    if (!isNotification) fail(id, -32603, String(e.message || e));
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  handle(msg);
});
rl.on('close', () => process.exit(0));
