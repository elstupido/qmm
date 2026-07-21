#!/usr/bin/env node
// Protocol-level spec for the authoring MCP server: boots a scratch studio, spawns studio/mcp.mjs
// over pipes, and drives a real JSON-RPC conversation — handshake, tools/list (module_id
// injection), tools/call through to TOOL_IMPL, prompts, and ledger source-tagging.
// Run: node tools/mcp-test.mjs

import { spawn } from 'node:child_process';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const PORT = 8794;
const TOKEN = 'mcp-suite-token';
const MODULE = 'mcp-suite-test';

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

// ---- boot a scratch studio ---------------------------------------------------
const studioProc = spawn(process.execPath, [join(ROOT, 'studio', 'studio.mjs')], {
  env: { ...process.env, PORT: String(PORT), STUDIO_TOKEN: TOKEN, PLAYER_URL: 'http://127.0.0.1:1' },
  stdio: 'ignore',
});
const B = `http://127.0.0.1:${PORT}`;
const api = async (method, path, body) => {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', 'x-studio-token': TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json();
};
for (let i = 0; i < 40; i++) {
  try { await fetch(B + '/api/health', { headers: { 'x-studio-token': TOKEN } }); break; }
  catch { await new Promise(r => setTimeout(r, 250)); }
}
await api('POST', '/api/studio/modules', { id: MODULE, scaffold: 'dark-demo', title: 'MCP Suite' });

// ---- spawn the MCP server over pipes ----------------------------------------
const mcp = spawn(process.execPath, [join(ROOT, 'studio', 'mcp.mjs')], {
  env: { ...process.env, STUDIO_URL: B, STUDIO_TOKEN: TOKEN },
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buffer = '';
const pending = new Map();
mcp.stdout.on('data', (d) => {
  buffer += d.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
let seq = 0;
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, resolve);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 15000);
});
const notify = (method) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');

try {
  // ---- handshake -------------------------------------------------------------
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-test' } });
  ok('initialize: serverInfo + capabilities', init.result.serverInfo.name === 'qmm-author-studio' && !!init.result.capabilities.tools);
  notify('notifications/initialized');
  const ping = await rpc('ping', {});
  ok('ping answers', !!ping.result);

  // ---- tools/list ------------------------------------------------------------
  const list = await rpc('tools/list', {});
  const tools = list.result.tools;
  const names = tools.map(t => t.name);
  ok(`tools/list: ${names.length} tools incl. core set`, ['list_modules', 'read_doc', 'get_module_overview', 'upsert_template', 'validate', 'test_fill', 'get_authoring_guide'].every(n => names.includes(n)));
  ok('tools/list: NO publish tool (human-only law)', !names.some(n => /publish|rollback/.test(n)));
  const overviewDef = tools.find(t => t.name === 'get_module_overview');
  ok('module_id injected as required param', overviewDef.inputSchema.required.includes('module_id') && !!overviewDef.inputSchema.properties.module_id);
  const lm = tools.find(t => t.name === 'list_modules');
  ok('list_modules stays module-free', !(lm.inputSchema.required || []).includes('module_id'));

  // ---- tools/call ------------------------------------------------------------
  const guide = await rpc('tools/call', { name: 'get_authoring_guide', arguments: {} });
  ok('authoring guide served', guide.result.content[0].text.includes('FORMAT LAW') && guide.result.isError === false);

  const mods = await rpc('tools/call', { name: 'list_modules', arguments: {} });
  ok('list_modules via MCP', JSON.parse(mods.result.content[0].text).modules.some(m => m.id === MODULE));

  const ov = await rpc('tools/call', { name: 'get_module_overview', arguments: { module_id: MODULE } });
  const ovr = JSON.parse(ov.result.content[0].text);
  ok('overview via MCP (scaffold shape)', ovr.beats.length === 1 && ovr.breaches.has_todo_scaffolding === true);

  const setc = await rpc('tools/call', { name: 'set_character', arguments: { module_id: MODULE, name: 'McpTester' } });
  ok('write tool via MCP lands', JSON.parse(setc.result.content[0].text).character.name === 'McpTester');

  const rd = await rpc('tools/call', { name: 'read_doc', arguments: { module_id: MODULE, doc: 'manifest' } });
  ok('read_doc round-trips the write', JSON.parse(rd.result.content[0].text).content.character.name === 'McpTester');

  const noMod = await rpc('tools/call', { name: 'get_module_overview', arguments: {} });
  ok('missing module_id -> isError guidance', noMod.result.isError === true && noMod.result.content[0].text.includes('list_modules'));

  const badTool = await rpc('tools/call', { name: 'validate', arguments: { module_id: 'no-such-module-xyz' } });
  ok('tool failure -> isError, not crash', badTool.result.isError === true);

  // ---- prompts ---------------------------------------------------------------
  const pl = await rpc('prompts/list', {});
  ok('prompts/list has authoring-briefing', pl.result.prompts.some(p => p.name === 'authoring-briefing'));
  const pg = await rpc('prompts/get', { name: 'authoring-briefing' });
  ok('prompts/get serves the briefing', pg.result.messages[0].content.text.includes('PACING LAW'));

  const unknown = await rpc('no/such/method', {});
  ok('unknown method -> -32601', unknown.error?.code === -32601);

  // ---- ledger tagging --------------------------------------------------------
  const ledger = readFileSync(join(ROOT, 'logs', 'studio.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const mcpCalls = ledger.filter(e => e.kind === 'author_tool' && e.source === 'mcp' && e.id === MODULE);
  ok(`ledger: MCP calls tagged source:"mcp" (${mcpCalls.length})`, mcpCalls.length >= 3);
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  failures++;
} finally {
  await api('DELETE', `/api/studio/draft/${MODULE}`).catch(() => {});
  mcp.kill();
  studioProc.kill();
  // trash-dirs from this suite
  const draftDir = join(ROOT, 'modules-draft');
  if (existsSync(draftDir)) {
    for (const d of (await import('node:fs')).readdirSync(draftDir)) {
      if (d.startsWith(MODULE)) rmSync(join(draftDir, d), { recursive: true, force: true });
    }
  }
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
