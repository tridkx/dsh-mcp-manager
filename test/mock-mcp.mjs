// A deliberately minimal MCP server used to inject malformed tool lists that a
// real server would not produce. Speaks newline-delimited JSON-RPC on stdio.
//
//   node test/mock-mcp.mjs <scenario> [stateFile] [noticeFile]
//
// The tool list is re-read from `stateFile` on every tools/list, so a test can
// change the payload at runtime. Touching `noticeFile` emits
// notifications/tools/list_changed, which is how a resync is triggered.
import { readFileSync, existsSync } from 'node:fs';
import readline from 'node:readline';

const scenario = process.argv[2] || 'ok';
const stateFile = process.argv[3] || '';
const noticeFile = process.argv[4] || '';
// The bridge's public name embeds the CONFIGURED server name, so a forged
// prefix must be built from the real one to collide.
const serverName = process.argv[5] || 'mock';

const SCENARIOS = {
  ok: () => [{ name: 'alpha', description: 'first tool', inputSchema: { type: 'object', properties: {} } }],
  // One raw name listed twice: normalizes to the same public name.
  'duplicate-name': () => [
    { name: 'dup', description: 'first', inputSchema: { type: 'object', properties: {} } },
    { name: 'dup', description: 'second', inputSchema: { type: 'object', properties: {} } },
  ],
};

function toolList(serverName) {
  if (stateFile && existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
    } catch (e) { /* fall through to the scenario default */ }
  }
  const make = SCENARIOS[scenario];
  return make ? make(serverName) : SCENARIOS.ok();
}

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }
  if (msg.method === 'initialize') {
    write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: serverName, version: '1.0.0' } } });
    return;
  }
  if (msg.method === 'tools/list') {
    write({ jsonrpc: '2.0', id: msg.id, result: { tools: toolList(serverName) } });
    return;
  }
  if (msg.method === 'tools/call') {
    write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'called ' + msg.params.name }] } });
    return;
  }
  if (typeof msg.id === 'number') write({ jsonrpc: '2.0', id: msg.id, result: {} });
});

if (noticeFile) {
  let last = null;
  setInterval(() => {
    try {
      if (!existsSync(noticeFile)) return;
      const stamp = readFileSync(noticeFile, 'utf8');
      if (stamp !== last) {
        last = stamp;
        write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
      }
    } catch (e) { /* ignore */ }
  }, 150);
}
