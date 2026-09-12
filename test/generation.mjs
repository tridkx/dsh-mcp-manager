// Generation-swap tests: a replacement tool list must be validated as a whole
// and swapped atomically, and every rejection must leave the previous
// generation registered and callable.
//
//   node test/generation.mjs
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCtx, makeSpawn, tmpHome } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(here, 'mock-mcp.mjs');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : '')); }
};
const waitFor = async (fn, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label);
    await new Promise((r) => setTimeout(r, 120));
  }
};

const mockCfg = (scenario, home, name = 'mock', extra = {}) => Object.assign({
  name, transport: 'stdio', command: process.execPath, args: [MOCK, scenario, path.join(home, 'tools.json'), path.join(home, 'notice.txt')],
  env: {}, cwd: here, url: '', headers: {}, toolCallTimeoutMs: 10000,
  mode: 'eager', notes: '', healthTool: '', healthExpect: '',
}, extra);

async function boot(home, servers) {
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, '.dsh-mcp-servers.json'), JSON.stringify(servers, null, 2), 'utf8');
  const ctx = makeCtx({ dshHome: home, spawn: makeSpawn() });
  await (await import('../lib/index.js')).apply(ctx);
  return ctx;
}
const namesOf = (ctx, prefix) => [...ctx.registered.keys()].filter((n) => n.startsWith(prefix)).sort();
const api = (ctx) => ctx.registered.get('mcp_manager');
const statusOf = async (ctx, name) => (await api(ctx).execute({ action: 'status' })).servers.find((s) => s.name === name);

// ── A. duplicate raw name: reject the whole list, register nothing ──────────
console.log('\n=== A. 服务器把同一工具列两次 → 整批拒绝 ===');
const homeA = tmpHome('gen-dup');
const ctxA = await boot(homeA, [mockCfg('duplicate-name', homeA)]);
await waitFor(async () => (await statusOf(ctxA, 'mock')) !== undefined, 5000, 'entry (A)');
const stA = await waitFor(async () => {
  const s = await statusOf(ctxA, 'mock');
  return s && s.generation && s.generation.status !== 'empty' ? s : null;
}, 15000, 'generation decision (A)');
ok(stA.generation.status === 'rejected', '代际被拒绝', stA.generation);
ok(/重复/.test(stA.generation.problems.join(' ')), '拒绝原因指出重复', stA.generation.problems);
ok(namesOf(ctxA, 'mcp__mock__').length === 0, '★ 一个工具都没注册（不存在"半个服务器"）', namesOf(ctxA, 'mcp__mock__'));

// ── B. the server-name namespace keeps two servers from colliding ───────────
console.log('\n=== B. 两台服务器声明同名工具 → 命名空间隔离，各注册各的 ===');
const homeB = tmpHome('gen-collide');
await fsp.mkdir(homeB, { recursive: true });
const tool = (name) => [{ name, description: name, inputSchema: { type: 'object', properties: {} } }];
// Same RAW tool name on both servers. Because the public name is
// `mcp__<serverName>__<rawName>`, the namespace isolates them by construction.
await fsp.writeFile(path.join(homeB, 'blender-tools.json'), JSON.stringify(tool('sneaky')), 'utf8');
// A remote tool name that already embeds a prefix must not escape its own
// namespace either — it still lands under mcp__sneaky__.
await fsp.writeFile(path.join(homeB, 'sneaky-tools.json'), JSON.stringify(tool('mcp__blender__sneaky')), 'utf8');
const ctxB = await boot(homeB, [
  mockCfg('ok', homeB, 'blender', { args: [MOCK, 'ok', path.join(homeB, 'blender-tools.json'), '', 'blender'] }),
  mockCfg('ok', homeB, 'sneaky', { args: [MOCK, 'ok', path.join(homeB, 'sneaky-tools.json'), '', 'sneaky'] }),
]);
await waitFor(async () => {
  const a = await statusOf(ctxB, 'blender');
  const b = await statusOf(ctxB, 'sneaky');
  return a && b && a.generation.status !== 'empty' && b.generation.status !== 'empty';
}, 20000, 'both generations (B)');
const stBlender = await statusOf(ctxB, 'blender');
const stSneaky = await statusOf(ctxB, 'sneaky');
ok(stBlender.generation.status === 'applied' && namesOf(ctxB, 'mcp__blender__').length === 1,
  'blender 注册了自己的 sneaky', { gen: stBlender.generation.status, names: namesOf(ctxB, 'mcp__blender__') });
ok(stSneaky.generation.status === 'applied', 'sneaky 同代照常通过（不是误拒）', stSneaky.generation);
const all = namesOf(ctxB, 'mcp__');
ok(all.length === 2, '两个同名工具各自注册，互不覆盖', all);
ok(all.every((n, i) => all.indexOf(n) === i), '注册表里没有重名条目', all);
ok(namesOf(ctxB, 'mcp__sneaky__').length === 1, '★ 远程工具名里内嵌的前缀没有逃出自己的命名空间', namesOf(ctxB, 'mcp__sneaky__'));

// ── C. resync with a malformed list keeps the live generation ──────────────
console.log('\n=== C. 重同步遇到畸形列表 → 保留上一代且仍可调用 ===');
const homeC = tmpHome('gen-resync');
const toolsFile = path.join(homeC, 'tools.json');
const noticeFile = path.join(homeC, 'notice.txt');
await fsp.mkdir(homeC, { recursive: true });
await fsp.writeFile(toolsFile, JSON.stringify([
  { name: 'alpha', description: 'stable', inputSchema: { type: 'object', properties: {} } },
]), 'utf8');
const ctxC = await boot(homeC, [mockCfg('ok', homeC)]);
const stC1 = await waitFor(async () => {
  const s = await statusOf(ctxC, 'mock');
  return s && s.generation.status === 'applied' ? s : null;
}, 15000, 'applied generation (C)');
ok(stC1.generation.toolCount === 1 && namesOf(ctxC, 'mcp__mock__').length === 1, '初始代已注册（1 个工具）', namesOf(ctxC, 'mcp__mock__'));
const before = namesOf(ctxC, 'mcp__mock__');

// now the server goes bad and announces a change
await fsp.writeFile(toolsFile, JSON.stringify([
  { name: 'dup', description: 'a', inputSchema: { type: 'object', properties: {} } },
  { name: 'dup', description: 'b', inputSchema: { type: 'object', properties: {} } },
]), 'utf8');
await fsp.writeFile(noticeFile, String(Date.now()), 'utf8');

const stC2 = await waitFor(async () => {
  const s = await statusOf(ctxC, 'mock');
  return s.generation.status === 'rejected' ? s : null;
}, 15000, 'rejected resync (C)');
ok(stC2.generation.status === 'rejected', '★ 畸形的新列表被拒绝', stC2.generation);
ok(namesOf(ctxC, 'mcp__mock__').join(',') === before.join(','), '★ 上一代工具仍在注册表里（未被清空）', namesOf(ctxC, 'mcp__mock__'));
ok(stC2.generation.toolCount === 1, '代际记录仍报告在用的是那 1 个工具', stC2.generation);
const callC = await api(ctxC).execute({ action: 'call', name: 'mock', tool: 'alpha', arguments: {} });
ok(/called alpha/.test(JSON.stringify(callC)), '★ 保留下来的工具真的还能调用', callC.content);

// ── D. a good resync still swaps (no over-rejection, no name shadowing) ────
// This is the regression case for a real bug: registering the incoming
// generation BEFORE disposing the outgoing one made same-named tools shadow
// each other, because the tool registry is keyed by public name. Regenerating
// [alpha] into [alpha, beta] then left only `beta` registered while the entry
// still claimed two tools.
console.log('\n=== D. 正常的重同步照常换代，且保留同名工具 ===');
await fsp.writeFile(toolsFile, JSON.stringify([
  { name: 'alpha', description: 'stable', inputSchema: { type: 'object', properties: {} } },
  { name: 'beta', description: 'new one', inputSchema: { type: 'object', properties: {} } },
]), 'utf8');
await fsp.writeFile(noticeFile, String(Date.now() + 1), 'utf8');
const stD = await waitFor(async () => {
  const s = await statusOf(ctxC, 'mock');
  return s.generation.status === 'applied' && s.generation.toolCount === 2 ? s : null;
}, 15000, 'swapped generation (D)');
ok(namesOf(ctxC, 'mcp__mock__').length === 2, '★ 新代已原子替换（2 个工具）', namesOf(ctxC, 'mcp__mock__'));
ok(namesOf(ctxC, 'mcp__mock__').includes('mcp__mock__alpha'),
  '★ 跨代同名工具没有被旧代 disposer 删掉（回归：曾经只剩 beta）', namesOf(ctxC, 'mcp__mock__'));
ok(stD.generation.status === 'applied', '记录为 applied', stD.generation);

console.log('\n' + (fail === 0 ? '★ 全部通过' : '✗ ' + fail + ' 项失败') + '：' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
