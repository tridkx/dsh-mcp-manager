// Regression tests for the two fixes in v1.2.2:
//
//   A. Teardown must WAIT for the subprocess seam's asynchronous termination
//      promise. The seam's `terminate()` returns its cleanup promise (typed
//      `void`), so a synchronous teardown makes plugin unload — and therefore a
//      dsh restart — finish while the child's process range is still draining,
//      orphaning `cmd.exe` → `uvx` → the MCP server.
//
//   B. `mcp_tools load` must be IN-MEMORY ONLY. Persisting the promotion made
//      it outlive the plugin reload that both the gateway description and the
//      README promise would restore lazy mode.
//
//   node test/lifecycle.mjs
//
// The spawn seam here is a LOCAL one, not harness.mjs's: it must return a
// terminate() that is observably asynchronous, which is the exact property
// under test. The child under it is test/mock-mcp.mjs, which answers the
// handshake immediately, so the connection is deterministic and does not
// depend on Blender running.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { makeCtx, tmpHome } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(HERE, 'mock-mcp.mjs');
const NODE = process.execPath;

const TERMINATE_DELAY_MS = 400; // long enough to observe "still alive" mid-flight

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until the entry reports `connected` (auto-connect runs ~500ms after apply). */
const waitConnected = async (api, label) => {
  const t0 = Date.now();
  for (;;) {
    const s = (await api.execute({ action: 'status' })).servers[0];
    if (s.state === 'connected') return s;
    if (Date.now() - t0 > 15000) throw new Error('timeout waiting for ' + label + ' (state=' + s.state + ', error=' + s.error + ')');
    await sleep(100);
  }
};
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/**
 * Spawn seam whose terminate() returns a real promise: it kills the child only
 * after TERMINATE_DELAY_MS, so an unawaited teardown is detectable as a live
 * child at the moment unload claims to be finished.
 */
function makeAsyncTerminateSpawn(trace) {
  return function spawn(spec) {
    const { spawn: nodeSpawn } = childProcess;
    const argv = spec.argv || [];
    const child = nodeSpawn(argv[0], argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env && Object.keys(spec.env).length ? spec.env : process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    trace.pid = child.pid;
    let stderrText = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (c) => { stderrText += c.toString('utf8'); });

    let termination;
    return {
      stdin: { write: (b) => child.stdin.write(b) },
      stdout: child.stdout,
      stderr: child.stderr,
      done: new Promise((resolve) => {
        child.on('error', (err) => resolve({ exitCode: null, signal: null, error: err }));
        child.on('close', (code, signal) => resolve({ exitCode: code, signal: signal || null }));
      }),
      collected: {
        stdout: { readFrom: () => ({ text: '' }) },
        stderr: { readFrom: () => ({ text: stderrText }) },
      },
      // Mirrors the real seam: the procedure is staged, and the promise
      // resolves only once the range is empty.
      terminate() {
        trace.calls += 1;
        if (termination) return termination;
        termination = (async () => {
          await sleep(TERMINATE_DELAY_MS);
          try { child.kill(); } catch (e) {}
          trace.killedAt = Date.now();
        })();
        return termination;
      },
    };
  };
}

const NOTES = [
  '本机 Blender 环境（回归测试用多行 notes）。',
  '',
  '可执行文件不在 PATH 里：`D:\\Blender Foundation\\Blender 5.2\\blender.exe`',
  '启动命令（路径含空格，必须加引号）：',
  '- Git Bash：`"/d/Blender Foundation/Blender 5.2/blender.exe" &`',
  '- PowerShell：`& "D:\\Blender Foundation\\Blender 5.2\\blender.exe"`',
  '',
  '不要去找 blender.exe、不要怀疑安装路径。',
].join('\n');
const server = () => ({
  name: 'blender', transport: 'stdio', command: NODE, args: [MOCK, 'ok'],
  env: {}, cwd: '', url: '', headers: {}, toolCallTimeoutMs: 20000,
  mode: 'lazy', notes: NOTES,
});

async function boot(home, servers, spawn, opts = {}) {
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, '.dsh-mcp-servers.json'), JSON.stringify(servers, null, 2), 'utf8');
  const ctx = makeCtx(Object.assign({ dshHome: home, spawn }, opts));
  const plugin = await import('../lib/index.js');
  await plugin.apply(ctx);
  return ctx;
}
/** Run every registered effect disposer, as Cordis' `_unload` does. */
const unload = async (ctx) => {
  const pending = [];
  for (const { d } of ctx.disposers) {
    if (typeof d === 'function') pending.push(Promise.resolve(d()));
  }
  await Promise.all(pending);
};

// ── A. unload must wait for the asynchronous termination promise ────────────
console.log('\n=== A. 卸载等待异步 terminate ===');
const traceA = { pid: null, calls: 0, killedAt: 0 };
const homeA = tmpHome('async-term');
const ctxA = await boot(homeA, [server()], makeAsyncTerminateSpawn(traceA));

const apiA = ctxA.registered.get('mcp_manager');
const stA = await waitConnected(apiA, 'connect');
ok(stA.state === 'connected', '前置：stdio 服务器已连接', stA.state);
ok(typeof traceA.pid === 'number' && alive(traceA.pid), '前置：子进程存活', traceA.pid);

const t0 = Date.now();
await unload(ctxA);
const elapsed = Date.now() - t0;

ok(traceA.calls >= 1, '★ 卸载确实调用了 terminate()', traceA.calls);
ok(elapsed >= TERMINATE_DELAY_MS - 50,
  '★ 卸载耗时覆盖了 terminate 的异步窗口（未被同步跳过）',
  { elapsed, terminateDelay: TERMINATE_DELAY_MS });
ok(traceA.killedAt > 0 && traceA.killedAt - t0 >= TERMINATE_DELAY_MS - 50,
  '★ terminate 的 promise 跑完了完整延迟才杀进程', { killedAt: traceA.killedAt, t0 });
await sleep(150);
ok(traceA.pid !== null && !alive(traceA.pid),
  '★ 卸载返回时子进程已确实退出（无孤儿）', traceA.pid);

// ── B. `load` must not be written to disk ──────────────────────────────────
console.log('\n=== B. load 只改内存、不写盘 ===');
const homeB = tmpHome('load-memory');
const ctxB = await boot(homeB, [server()], makeAsyncTerminateSpawn({ pid: null, calls: 0, killedAt: 0 }));
const apiB = ctxB.registered.get('mcp_manager');
const gwB = ctxB.registered.get('mcp_tools');
await waitConnected(apiB, 'connect (B)');

const loaded = await gwB.execute({ action: 'load', server: 'blender' });
ok(loaded.mode === 'eager', 'load 在内存里切到 eager', loaded.mode);
ok(loaded.persisted === false, '★ 返回值声明未落盘', loaded.persisted);

const onDisk = JSON.parse(await fsp.readFile(path.join(homeB, '.dsh-mcp-servers.json'), 'utf8'))[0];
ok(onDisk.mode === 'lazy',
  '★ 磁盘上的 mode 仍是 lazy（重载插件/重启 dsh 会恢复按需）', onDisk.mode);
ok(onDisk.notes === NOTES, 'notes 未被 load 波及', onDisk.notes);

// A later unrelated save must not smuggle the promotion to disk either.
await apiB.execute({ action: 'health', name: 'blender' }).catch(() => {});
const afterSave = JSON.parse(await fsp.readFile(path.join(homeB, '.dsh-mcp-servers.json'), 'utf8'))[0];
ok(afterSave.mode === 'lazy',
  '★ 后续任何 saveServers() 也不会把临时 eager 写上盘', afterSave.mode);

// An EXPLICIT mode change is still persisted (that is the permanent path).
const explicitServer = server();
await apiB.execute({
  action: 'update', name: 'blender', transport: 'stdio',
  command: explicitServer.command, args: explicitServer.args,
  mode: 'eager', notes: NOTES,
});
const explicit = JSON.parse(await fsp.readFile(path.join(homeB, '.dsh-mcp-servers.json'), 'utf8'))[0];
ok(explicit.mode === 'eager', '★ 显式配置的 eager 仍然正常落盘（永久路径未被破坏）', explicit.mode);

await unload(ctxB);

// ── C. notes must survive describe with their structure intact ──────────────
// `brief()` collapses every whitespace run, which is right for a one-line tool
// description and destructive for multi-line environment notes: a 51-line
// primer used to arrive as a single unreadable line.
console.log('\n=== C. describe 保留 notes 的多行结构 ===');
const homeC = tmpHome('notes-shape');
const ctxC = await boot(homeC, [server()], makeAsyncTerminateSpawn({ pid: null, calls: 0, killedAt: 0 }));
const apiC = ctxC.registered.get('mcp_manager');
const gwC = ctxC.registered.get('mcp_tools');
await waitConnected(apiC, 'connect (C)');

const catC = await gwC.execute({ action: 'list' });
ok(catC.text.includes('✎有环境说明'),
  '★ 目录标明该服务器有 notes（否则模型无从知道值得 describe）', catC.text.slice(0, 160));

const descC = await gwC.execute({ action: 'describe', tool: 'alpha' });
const body = descC.text.slice(descC.text.indexOf('本机 Blender 环境'));
ok(body.includes('blender.exe'),
  'notes 里的关键环境事实确实进入了 describe 输出');
ok(body.includes('\n'),
  '★ notes 保留了换行（未被压成单行）', { newlines: (body.match(/\n/g) || []).length });
ok(body.includes('\n\n'),
  '★ notes 保留了空行/段落结构');
ok(descC.text.includes('✎有环境说明') === false ||
   descC.text.indexOf('✎有环境说明') < descC.text.indexOf('本机 Blender 环境'),
  '目录标记没有混进 describe 正文');

await unload(ctxC);

// ── D. first-screen prompt section (discoverability) ───────────────────────
// Tools alone are not discoverability: without a prompt section the model never
// learns the servers exist, never calls describe, and so never sees `notes` —
// which is what made MCP look unconfigured in real sessions.
console.log('\n=== D. 首屏提示词注入 ===');
const homeD = tmpHome('prompt-section');
const ctxD = await boot(homeD, [server()], makeAsyncTerminateSpawn({ pid: null, calls: 0, killedAt: 0 }));
ok(ctxD.systemPrompt.sections.length === 1,
  '★ 插件注册了 system prompt section', ctxD.systemPrompt.sections.map((s) => s.name));
const rendered = ctxD.systemPrompt.render();
ok(rendered.includes('blender'),
  '★ 首屏就点名了 MCP 服务器（模型无需先试探）', rendered.slice(0, 200));
ok(rendered.includes('Blender Foundation') || rendered.includes('blender.exe') || rendered.includes('本机 Blender'),
  '★ 首屏带上了 notes 摘要行（关键环境事实的第一手线索）', rendered.slice(0, 240));
ok(rendered.includes('mcp_tools'),
  '★ 首屏告知用 mcp_tools 取工具与完整说明');
ok(!rendered.includes('不要去找 blender.exe、不要怀疑安装路径'),
  '★ 完整 notes 仍留在 describe（首屏只给摘要，未破坏两级注入）');
ok(rendered.includes('不在') && rendered.includes('工具列表'),
  '★ 首屏明确说明这些工具不在工具列表里（模型最容易搞错的一点）');
ok(rendered.includes('action:"list"') || rendered.includes('list'),
  '★ 首屏给出取用路径');
ok(rendered.length <= 700, '首屏注入有总量上限（不违反 lazy 成本原则）', rendered.length);

// Multi-server budget: one verbose summary must not truncate another server
// out of the section entirely.
const homeD2 = tmpHome('prompt-multi');
const verbose = Object.assign(server(), { name: 'alpha', notes: 'A'.repeat(400) + '\n第二行不该出现' });
const second = Object.assign(server(), { name: 'beta', notes: 'BETA 服务器：关键事实在第一行。' });
const ctxD2 = await boot(homeD2, [verbose, second], makeAsyncTerminateSpawn({ pid: null, calls: 0, killedAt: 0 }));
const multi = ctxD2.systemPrompt.render();
ok(multi.includes('alpha') && multi.includes('beta'),
  '★ 多服务器时每台都被列出（严苛的首行不会挤掉别人）', multi.slice(0, 220));
ok(!multi.includes('第二行不该出现'), '首行摘要不会把 notes 整段拖进首屏');
await unload(ctxD2);
console.log('  ── 实际注入文本 ──');
console.log(rendered.split('\n').map((l) => '  │ ' + l).join('\n'));
await unload(ctxD);

// ── E. absent systemPrompt must degrade, not break ─────────────────────────
console.log('\n=== E. 无 systemPrompt 服务时降级 ===');
const homeE = tmpHome('no-prompt');
const ctxE = await boot(homeE, [server()], makeAsyncTerminateSpawn({ pid: null, calls: 0, killedAt: 0 }), { systemPrompt: false });
ok(ctxE.registered.has('mcp_tools') && ctxE.registered.has('mcp_manager'),
  '★ 缺 systemPrompt 时工具桥接仍正常（提示词是增强，不是硬依赖）');
await waitConnected(ctxE.registered.get('mcp_manager'), 'connect (E)');
await unload(ctxE);

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
