// Measures the per-request tool payload in lazy vs eager mode against a real
// server, so the token claim in the README is a measurement, not a guess.
//   node test/measure.mjs <blender-mcp.exe>
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { makeCtx, makeSpawn, tmpHome } from './harness.mjs';

const EXE = process.argv[2];
const cfg = (mode) => ({
  name: 'blender', transport: 'stdio', command: EXE, args: [],
  env: { BLENDER_HOST: '127.0.0.1', BLENDER_PORT: '9877' },
  cwd: '', url: '', headers: {}, toolCallTimeoutMs: 20000,
  mode, notes: '', healthTool: '', healthExpect: '',
});

const payloadBytes = (ctx) => {
  let total = 0;
  const parts = [];
  for (const [name, def] of ctx.registered) {
    const s = JSON.stringify({ name: def.name, description: def.description, parameters: def.parameters });
    total += s.length;
    parts.push([name, s.length]);
  }
  return { total, parts };
};

async function boot(mode) {
  const home = tmpHome('measure-' + mode);
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, '.dsh-mcp-servers.json'), JSON.stringify([cfg(mode)], null, 2));
  const ctx = makeCtx({ dshHome: home, spawn: makeSpawn() });
  await (await import('../lib/index.js')).apply(ctx);
  await new Promise((r) => setTimeout(r, 5000));
  return ctx;
}

const lazy = await boot('lazy');
const eager = await boot('eager');
const l = payloadBytes(lazy);
const e = payloadBytes(eager);
const gateway = l.parts.find(([n]) => n === 'mcp_tools');
const manager = l.parts.find(([n]) => n === 'mcp_manager');
const mcpTools = e.parts.filter(([n]) => n.startsWith('mcp__blender__'));

console.log('\n每个请求会带上（字符数，UTF-16 长度）:');
console.log('  lazy  模式: mcp_tools = ' + (gateway ? gateway[1] : 0) + ', mcp_manager = ' + (manager ? manager[1] : 0) + '  → 合计 ' + l.total);
console.log('  eager 模式: ' + mcpTools.length + ' 个直连工具 = ' + mcpTools.reduce((a, [, n]) => a + n, 0) + ', mcp_manager = ' + (manager ? manager[1] : 0) + '  → 合计 ' + e.total);
console.log('\n  差额: ' + (e.total - l.total) + ' 字符  ≈ ' + Math.round((e.total - l.total) / 3.5) + '–' + Math.round((e.total - l.total) / 2.5) + ' tokens（按 2.5–3.5 字符/token 估）');
console.log('  describe 一个工具时一次性注入的量:');
const gw = lazy.registered.get('mcp_tools');
const d = await gw.execute({ action: 'describe', tool: 'execute_blender_code' });
console.log('    execute_blender_code schema + 说明 = ' + (d.text || '').length + ' 字符');
process.exit(0);
