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

const NOTES = '回归测试用 notes：只应在 describe 时出现。';
const server = () => ({
  name: 'blender', transport: 'stdio', command: NODE, args: [MOCK, 'ok'],
  env: {}, cwd: '', url: '', headers: {}, toolCallTimeoutMs: 20000,
  mode: 'lazy', notes: NOTES,
});

async function boot(home, servers, spawn) {
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, '.dsh-mcp-servers.json'), JSON.stringify(servers, null, 2), 'utf8');
  const ctx = makeCtx({ dshHome: home, spawn });
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

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
