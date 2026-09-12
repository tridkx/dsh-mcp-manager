// End-to-end check of the mcp-manager host plugin against a REAL MCP server
// (a cached blender-mcp executable): injection modes, the mcp_tools gateway,
// notes injection, content-block projection and the health probe.
//
//   node test/e2e.mjs <path-to-blender-mcp.exe>
//
// The health probe is exercised in both directions: a deliberately dead bridge
// port must report `degraded`, and (only when something actually listens on
// 9877) the live bridge must report `healthy`.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { makeCtx, makeSpawn, tmpHome } from './harness.mjs';

const EXE = process.argv[2];
if (!EXE) { console.error('usage: node test/e2e.mjs <blender-mcp.exe>'); process.exit(2); }

const DEAD_PORT = 9999;   // nothing listens here -> backend unreachable
const LIVE_PORT = 9877;   // the real Blender MCP bridge, when Blender is open

const portListening = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
  s.setTimeout(1500, () => { s.destroy(); resolve(false); });
});

const NOTES = '本机 Blender 说明：先 netstat 查 9877；报 Could not connect 只代表 Blender 没启动。';
const baseServer = (port) => ({
  name: 'blender', transport: 'stdio', command: EXE, args: [],
  env: { BLENDER_HOST: '127.0.0.1', BLENDER_PORT: String(port) },
  cwd: '', url: '', headers: {}, toolCallTimeoutMs: 20000,
  mode: 'lazy', notes: NOTES, healthTool: 'get_addon_status', healthArguments: { user_prompt: 'e2e health probe' },
  // blender-mcp reports backend failures as isError:false, so the payload must be judged
  healthExpect: 'protocol_version',
});

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
    await new Promise((r) => setTimeout(r, 250));
  }
};

async function boot(home, servers) {
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, '.dsh-mcp-servers.json'), JSON.stringify(servers, null, 2), 'utf8');
  const ctx = makeCtx({ dshHome: home, spawn: makeSpawn() });
  await (await import('../lib/index.js')).apply(ctx);
  return ctx;
}
const api = (ctx) => ctx.registered.get('mcp_manager');
const gw = (ctx) => ctx.registered.get('mcp_tools');
const status = async (ctx) => (await api(ctx).execute({ action: 'status' })).servers[0];
const directNames = (ctx) => [...ctx.registered.keys()].filter((n) => n.startsWith('mcp__blender__'));

// ── part A: dead bridge port -> the health probe must expose the lie ─────────
console.log('\n=== A. 后端不可达（桥接端口写死 ' + DEAD_PORT + '）===');
const homeA = tmpHome('dead');
const ctxA = await boot(homeA, [baseServer(DEAD_PORT)]);

ok(!!gw(ctxA), 'mcp_tools 网关已注册');
ok(!!api(ctxA), 'mcp_manager 已注册');
ok(directNames(ctxA).length === 0, 'lazy 模式：无 mcp__blender__* 直连工具', directNames(ctxA));

const stA = await waitFor(async () => {
  const s = await status(ctxA);
  return s.health && (s.health.status === 'degraded' || s.health.status === 'healthy') ? s : null;
}, 90000, 'connect + health probe');
ok(stA.state === 'connected', 'MCP 握手成功 → state=connected（GUI 误报的来源）', stA.state);
ok(stA.health.status === 'degraded', '★ 修复点：探针判定后端不可用 → degraded', stA.health);
ok(typeof stA.health.error === 'string' && stA.health.error.length > 0, 'degraded 附带具体原因', stA.health && stA.health.error);

const catA = await gw(ctxA).execute({ action: 'list' });
ok(catA.text.includes('健康探针失败'), '★ 目录如实显示后端不可用', catA.text.slice(0, 160));
ok(!catA.text.includes(NOTES), '目录不含 notes（只在 describe 时注入）');
ok(catA.text.includes('未载入'), '目录标注载入状态');

const descA = await gw(ctxA).execute({ action: 'describe', tool: 'execute_blender_code' });
ok(descA.text.includes('"code"'), 'describe 返回参数 schema');
ok(descA.text.includes(NOTES), '★ describe 按需注入 notes');
const catA2 = await gw(ctxA).execute({ action: 'list' });
ok(catA2.text.includes('已载入'), 'describe 后目录标记已载入');

let badArg = null;
try { await gw(ctxA).execute({ action: 'describe', tool: 'nope_not_real' }); } catch (e) { badArg = e; }
ok(badArg && /no connected server offers/.test(badArg.message), '未知工具给出清晰错误', badArg && badArg.message);

// The bridge reports backend failure as a SUCCESSFUL tool result
// (isError:false, error text in the payload), so the gateway must pass that
// text through verbatim rather than throwing or pretending it worked.
const deadCall = await gw(ctxA).execute({ action: 'call', tool: 'get_scene_info', arguments: { user_prompt: 'e2e: read scene' } });
ok(typeof deadCall.text === 'string' && /Could not connect to Blender|Error/.test(deadCall.text),
  '★ 后端不可达时错误原文如实透传（不伪装成正常数据）', deadCall.text.slice(0, 160));
ok(deadCall.isError === false, '如实反映服务端的 isError=false（网关不臆造错误标志）', deadCall.isError);

const loadedA = await gw(ctxA).execute({ action: 'load', server: 'blender' });
ok(loadedA.mode === 'eager', 'load 切到 eager');
ok(directNames(ctxA).length === stA.tools.length, 'load 后全部工具直连注册', directNames(ctxA).length + '/' + stA.tools.length);
const persistedA = JSON.parse(await fsp.readFile(path.join(homeA, '.dsh-mcp-servers.json'), 'utf8'));
ok(persistedA[0].mode === 'eager' && persistedA[0].notes === NOTES, 'mode/notes 已落盘');

console.log('\n=== B. off 模式 ===');
const homeB = tmpHome('off');
const ctxB = await boot(homeB, [Object.assign(baseServer(DEAD_PORT), { mode: 'off' })]);
await new Promise((r) => setTimeout(r, 1500));
ok(directNames(ctxB).length === 0, 'off 模式零直连工具', directNames(ctxB));
ok(ctxB.registered.has('mcp_tools'), '网关仍注册（服务器管理不依赖它）');

// ── part C: live bridge -> healthy, and the image path that used to be text ──
const live = await portListening(LIVE_PORT);
console.log('\n=== C. 后端可达性：' + (live ? '检测到 ' + LIVE_PORT + ' 有服务，跑 healthy + 截图路径' : LIVE_PORT + ' 无服务，跳过（打开 Blender 可覆盖此段）') + ' ===');
if (live) {
  const homeC = tmpHome('live');
  const ctxC = await boot(homeC, [baseServer(LIVE_PORT)]);
  const stC = await waitFor(async () => {
    const s = await status(ctxC);
    return s.health && (s.health.status === 'degraded' || s.health.status === 'healthy') ? s : null;
  }, 90000, 'connect + health probe (live)');
  ok(stC.health.status === 'healthy', '★ 后端正常时探针通过 → healthy（无误报）', stC.health);

  const scene = await gw(ctxC).execute({ action: 'call', tool: 'get_scene_info', arguments: { user_prompt: 'e2e: read the current scene' } });
  ok(scene.text && scene.text.length > 2 && !/Error executing/.test(scene.text), '真实工具调用返回结果', scene.text.slice(0, 200));
  ok(scene.blocks.every((b) => b.type === 'text' || b.type === 'image'), 'blocks 只含 text/image', scene.blocks.map((b) => b.type));

  const shot = await gw(ctxC).execute({ action: 'call', tool: 'get_viewport_screenshot', arguments: { max_size: 400, user_prompt: 'e2e: screenshot the viewport' } });
  const imgs = shot.blocks.filter((b) => b.type === 'image');
  // The human-readable receipt is `shot.text` (the same string the UI/model
  // sees); it is not a separate text BLOCK when the result is image-only.
  const txt = shot.text || '';
  // No attachment store is mounted on this ctx, so the only SAFE outcome is a
  // text diagnostic: the request assembler reads `block.attachment.bytes`
  // unconditionally, so a hand-made image block would fail the whole request.
  ok(imgs.length === 0, '★ 无 attachments 服务时不产出 image 块（否则装配器抛错，整请求失败）', imgs.map((b) => Object.keys(b)));
  ok(/\[image unavailable: image\/png; .+\]/.test(txt), '★ 图片降级为明确诊断文本（不静默丢失）', txt.slice(0, 220));
}

// ── part D: with an attachment store + vision route, images become real blocks ─
if (live) {
  console.log('\n=== D. 挂载 attachments + llm 后，截图应成为真实 ImageBlock ===');
  const homeD = tmpHome('attach');
  await fsp.mkdir(homeD, { recursive: true });
  await fsp.writeFile(path.join(homeD, '.dsh-mcp-servers.json'), JSON.stringify([baseServer(LIVE_PORT)], null, 2), 'utf8');
  const ctxD = makeCtx({ dshHome: homeD, spawn: makeSpawn(), attachments: true });
  await (await import('../lib/index.js')).apply(ctxD);
  await waitFor(async () => (await status(ctxD)).state === 'connected', 60000, 'connect (D)');
  const execD = { agent: { options: { provider: 'opencode-go', model: 'deepseek-flash' }, session: { requestHeader: () => ({ config: { provider: 'opencode-go', model: 'deepseek-flash' } }) } } };
  const shotD = await gw(ctxD).execute({ action: 'call', tool: 'get_viewport_screenshot', arguments: { max_size: 300, user_prompt: 'e2e: screenshot for admission' } }, execD);
  const imgsD = shotD.blocks.filter((b) => b.type === 'image');
  ok(imgsD.length === 1, '★ 截图投影为 1 个真实 image 块', shotD.blocks.map((b) => b.type));
  const ref = imgsD[0] && imgsD[0].attachment;
  ok(ref && typeof ref.attachmentId === 'string' && typeof ref.bytes === 'number' && ref.bytes > 1000,
    '★ image 块带 attachment 引用（装配器所需形状）', ref);
  ok(!imgsD[0].source, '不再使用非法的 source 形状', imgsD[0] && Object.keys(imgsD[0]));
  ok(ctxD.savedImages.length === 1, '图片确实经 attachments.saveImages 落库', ctxD.savedImages.length);
  ok(/\[图片: image\/png\]/.test(shotD.text), '文本回执保留图片位置说明', shotD.text);

  // a text-only route must degrade instead of shipping an unusable image
  const ctxE = makeCtx({ dshHome: homeD, spawn: makeSpawn(), attachments: true, modalities: ['text'] });
  await (await import('../lib/index.js')).apply(ctxE);
  await waitFor(async () => (await status(ctxE)).state === 'connected', 60000, 'connect (E)');
  const execE = { agent: { options: { provider: 'p', model: 'text-only' }, session: { requestHeader: () => ({ config: { provider: 'p', model: 'text-only' } }) } } };
  const shotE = await gw(ctxE).execute({ action: 'call', tool: 'get_viewport_screenshot', arguments: { max_size: 300, user_prompt: 'e2e: text-only route' } }, execE);
  ok(shotE.blocks.every((b) => b.type !== 'image'), '纯文本模型下不产出 image 块', shotE.blocks.map((b) => b.type));
  ok(/does not declare image input/.test(shotE.text), '并说明原因', shotE.text.slice(0, 200));
}

console.log('\n' + (fail === 0 ? '★ 全部通过' : '✗ ' + fail + ' 项失败') + '：' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
