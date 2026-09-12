// @dsh-user/dsh-plugins — persistent MCP manager (host half)
// Zero-import plugin: tools are hand-built ToolDefinitions (raw JSON-Schema
// parameters), the GUI API is an HTTP route on the webServer service, and
// every disposer is fiber-owned through ctx.effect.

export const name = 'mcp-manager';
export const inject = ['subprocess', 'timer', 'fs', 'settings', 'tools', 'sandboxPolicy', 'webServer'];

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export async function apply(ctx) {
  const servers = new Map(); // name -> entry
  let configTarget = null;

  // ───────────────────────── helpers ─────────────────────────
  function stringMap(value) {
    const out = {};
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const k of Object.keys(value)) {
        const v = value[k];
        if (typeof v === 'string') out[k] = v;
        else if (v !== undefined && v !== null) out[k] = String(v);
      }
    }
    return out;
  }
  // Injection mode per server:
  //   lazy  (default) — only `mcp_tools` is registered; a server's tool schemas
  //                     and its `notes` enter the request only after the model
  //                     asks for them. Mirrors how skills inject on demand.
  //   eager           — every tool is registered up front, exactly as before.
  //   off             — the server is managed but contributes no model tools.
  const MODES = ['lazy', 'eager', 'off'];
  function normalizeConfig(input) {
    if (!input || typeof input !== 'object') throw new Error('invalid server config');
    const nm = typeof input.name === 'string' ? input.name.trim() : '';
    if (!NAME_RE.test(nm)) throw new Error('server name must match [A-Za-z0-9_-]{1,32}');
    const transport = input.transport === 'stdio' ? 'stdio' : 'http';
    const mode = MODES.includes(input.mode) ? input.mode : 'lazy';
    const notes = typeof input.notes === 'string' ? input.notes : '';
    const healthTool = typeof input.healthTool === 'string' ? input.healthTool.trim() : '';
    const healthArgs = input.healthArguments && typeof input.healthArguments === 'object' && !Array.isArray(input.healthArguments) ? input.healthArguments : {};
    const healthExpect = typeof input.healthExpect === 'string' ? input.healthExpect : '';
    const timeout = Number.isFinite(Number(input.toolCallTimeoutMs)) && Number(input.toolCallTimeoutMs) > 0 ? Math.round(Number(input.toolCallTimeoutMs)) : 60000;
    const shared = { name: nm, transport, mode, notes, healthTool, healthArguments: healthArgs, healthExpect, toolCallTimeoutMs: timeout };
    if (transport === 'http') {
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      if (!url) throw new Error('url is required for http transport');
      return Object.assign(shared, { command: '', args: [], env: {}, cwd: '', url, headers: stringMap(input.headers) });
    }
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command) throw new Error('command is required for stdio transport');
    return Object.assign(shared, {
      command,
      args: Array.isArray(input.args) ? input.args.filter((a) => typeof a === 'string') : [],
      env: stringMap(input.env),
      cwd: typeof input.cwd === 'string' ? input.cwd : '',
      url: '', headers: {},
    });
  }
  function makeEntry(cfg) {
    return { config: cfg, state: 'disconnected', error: null, handle: undefined, transport: undefined, tools: [], disposers: [], loaded: new Set(), health: null, publicNames: [], generation: { status: 'empty', replacedAt: 0, toolCount: 0, problems: [], reason: null }, resyncing: false, resyncQueued: false, generator: null };
  }
  function summaryOf(entry) {
    return {
      name: entry.config.name,
      transport: entry.config.transport,
      command: entry.config.command,
      args: entry.config.args,
      env: entry.config.env,
      cwd: entry.config.cwd,
      url: entry.config.url,
      headers: entry.config.headers,
      toolCallTimeoutMs: entry.config.toolCallTimeoutMs,
      mode: entry.config.mode,
      notes: entry.config.notes,
      healthTool: entry.config.healthTool,
      healthArguments: entry.config.healthArguments,
      healthExpect: entry.config.healthExpect,
      state: entry.state,
      error: entry.error,
      health: entry.health,
      generation: entry.generation,
      tools: entry.tools.map((t) => t.name),
      loaded: Array.from(entry.loaded),
    };
  }
  function defaultCwd() {
    try {
      const sp = ctx.get('sandboxPolicy');
      if (sp && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot) return sp.workspaceRoot;
    } catch (e) {}
    return '.';
  }
  async function dshHome() {
    try {
      const doc = await ctx.settings.prepareDocument();
      if (doc && typeof doc === 'string') {
        const idx = Math.max(doc.lastIndexOf('/'), doc.lastIndexOf('\\'));
        if (idx > 0) return doc.slice(0, idx);
      }
    } catch (e) { console.error('[mcp-manager] dshHome lookup failed:', e && e.message); }
    return null;
  }

  // ───────────────────────── persistence ─────────────────────────
  async function configFile() {
    if (configTarget) return configTarget;
    const home = await dshHome();
    const root = (home || defaultCwd()).replace(/[\\/]+$/, '');
    configTarget = await ctx.fs.resolve(root + '/.dsh-mcp-servers.json');
    return configTarget;
  }
  async function legacyConfigFile() {
    try {
      const root = defaultCwd().replace(/[\\/]+$/, '');
      const home = await dshHome();
      if (home && root === home) return null;
      return await ctx.fs.resolve(root + '/.dsh-mcp-servers.json');
    } catch (e) { return null; }
  }
  async function loadFrom(target, into) {
    const info = await ctx.fs.stat(target);
    if (!info) return;
    const text = await ctx.fs.readText(target);
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      try {
        const cfg = normalizeConfig(item);
        if (!into.has(cfg.name)) into.set(cfg.name, makeEntry(cfg));
      } catch (e) { console.error('[mcp-manager] skipped invalid saved server:', e && e.message); }
    }
  }
  async function loadServers() {
    try {
      await loadFrom(await configFile(), servers);
      const legacy = await legacyConfigFile();
      if (legacy) await loadFrom(legacy, servers);
    } catch (e) {
      console.error('[mcp-manager] load config failed:', e && e.message);
    }
  }
  async function saveServers() {
    try {
      const target = await configFile();
      const arr = [];
      for (const entry of servers.values()) arr.push(entry.config);
      await ctx.fs.writeText(target, JSON.stringify(arr, null, 2));
    } catch (e) {
      console.error('[mcp-manager] save config failed:', e && e.message);
    }
  }

  // ─────────────────────── stdio transport ───────────────────────
  function attachStdio(entry) {
    const handle = entry.handle;
    const decoder = new TextDecoder();
    let buffer = '';
    let nextId = 0;
    const pending = new Map();
    let notifier = null;
    const request = (method, params, timeoutMs) => {
      nextId += 1;
      const reqId = nextId;
      return new Promise((resolve, reject) => {
        const timer = ctx.timeout(() => {
          pending.delete(reqId);
          reject(new Error('MCP request ' + method + ' timed out after ' + timeoutMs + 'ms'));
        }, timeoutMs);
        pending.set(reqId, { resolve, reject, timer });
        const msg = JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params: params || {} }) + '\n';
        handle.stdin.write(new TextEncoder().encode(msg));
      });
    };
    const send = (method, params) => {
      const msg = JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n';
      handle.stdin.write(new TextEncoder().encode(msg));
    };
    const onMessage = (msg) => {
      if (msg && typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        try { p.timer(); } catch (e) {}
        if (msg.error) p.reject(new Error((msg.error.message) || 'MCP error: ' + JSON.stringify(msg.error)));
        else p.resolve(msg.result);
        return;
      }
      if (msg && typeof msg.method === 'string' && notifier) {
        try { notifier(msg); } catch (e) { console.error('[mcp-manager] notifier error:', e && e.message); }
      }
    };
    handle.stdout.on('data', (chunk) => {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg = null;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        try { onMessage(msg); } catch (e) {}
      }
    });
    handle.stdout.on('end', () => { buffer += decoder.decode(); });
    handle.stdout.on('error', () => {});
    entry.transport = { request, send, setNotifier: (fn) => { notifier = fn; } };
    return entry.transport;
  }

  // ─────────────────────── HTTP transport (curl) ───────────────────────
  function makeHttpTransport(entry) {
    let sessionId = null;
    let notifier = null;
    let nextId = 0;
    async function curl(body, timeoutMs) {
      const args = ['-sS', '-i', '-X', 'POST', entry.config.url,
        '-H', 'Content-Type: application/json',
        '-H', 'Accept: application/json, text/event-stream'];
      if (sessionId) args.push('-H', 'Mcp-Session-Id: ' + sessionId);
      const headers = entry.config.headers || {};
      for (const k of Object.keys(headers)) args.push('-H', k + ': ' + headers[k]);
      const secs = Math.max(5, Math.ceil(timeoutMs / 1000) + 2);
      args.push('--max-time', String(secs));
      args.push('--data-binary', '@-');
      const exe = await ctx.subprocess.resolveExecutable('curl');
      const handle = ctx.subprocess.spawn({
        argv: [exe].concat(args),
        cwd: defaultCwd(),
        stdio: { stdin: { data: body }, stdout: { maxBytes: 8388608 }, stderr: { maxBytes: 65536 } },
        graceMs: 3000,
      });
      const outcome = await handle.done;
      const out = handle.collected.stdout.readFrom(0).text;
      const err = handle.collected.stderr.readFrom(0).text;
      if (outcome.exitCode !== 0 && !out) {
        throw new Error('curl failed (exit ' + outcome.exitCode + '): ' + (err || 'no output').slice(-600));
      }
      return { out, err };
    }
    function splitHttp(text) {
      const idx = text.indexOf('\r\n\r\n');
      if (idx < 0) return { headers: '', body: text };
      return { headers: text.slice(0, idx), body: text.slice(idx + 4) };
    }
    function parseSse(text) {
      const events = [];
      let dataLines = [];
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line === '') {
          if (dataLines.length) { events.push(dataLines.join('\n')); dataLines = []; }
          continue;
        }
        if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (dataLines.length) events.push(dataLines.join('\n'));
      return events;
    }
    function readSessionId(headerText) {
      const m = /^mcp-session-id:\s*(\S+)/im.exec(headerText);
      if (m) sessionId = m[1];
    }
    function serverErrorFrom(events) {
      for (const ev of events) {
        try {
          const m = JSON.parse(ev);
          if (m && m.error) return (m.error.message) || JSON.stringify(m.error);
        } catch (e) {}
      }
      return null;
    }
    async function request(method, params, timeoutMs) {
      nextId += 1;
      const reqId = nextId;
      const body = JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params: params || {} });
      let timer = null;
      const timeout = new Promise((resolve, reject) => {
        timer = ctx.timeout(() => reject(new Error('MCP request ' + method + ' timed out after ' + timeoutMs + 'ms')), timeoutMs);
      });
      const work = (async () => {
        const { out, err } = await curl(body, timeoutMs);
        const { headers: headerText, body: respBody } = splitHttp(out);
        readSessionId(headerText);
        const events = parseSse(respBody);
        if (!events.length) {
          const trimmed = respBody.trim();
          if (trimmed) events.push(trimmed);
        }
        if (!events.length) throw new Error('empty MCP response' + (err ? ' — curl stderr: ' + err.slice(-400) : ''));
        for (const ev of events) {
          let msg = null;
          try { msg = JSON.parse(ev); } catch (e) { continue; }
          if (msg && msg.id === reqId) {
            if (msg.error) throw new Error((msg.error.message) || 'MCP error: ' + JSON.stringify(msg.error));
            return msg.result;
          }
          if (msg && typeof msg.method === 'string' && notifier) {
            try { notifier(msg); } catch (e) { console.error('[mcp-manager] notifier error:', e && e.message); }
          }
        }
        const serverErr = serverErrorFrom(events);
        if (serverErr) throw new Error('MCP server error: ' + serverErr);
        throw new Error('no response for request ' + method + ' (got ' + events.length + ' event(s))');
      })();
      try {
        return await Promise.race([work, timeout]);
      } finally {
        try { if (timer) timer(); } catch (e) {}
      }
    }
    async function send(method, params) {
      const body = JSON.stringify({ jsonrpc: '2.0', method, params: params || {} });
      const { out } = await curl(body, 15000);
      const { headers: headerText, body: respBody } = splitHttp(out);
      readSessionId(headerText);
      for (const ev of parseSse(respBody)) {
        let msg = null;
        try { msg = JSON.parse(ev); } catch (e) { continue; }
        if (msg && typeof msg.method === 'string' && notifier) {
          try { notifier(msg); } catch (e) { console.error('[mcp-manager] notifier error:', e && e.message); }
        }
      }
    }
    entry.transport = { request, send, setNotifier: (fn) => { notifier = fn; } };
    return entry.transport;
  }

  // ───────────────────── common protocol helpers ─────────────────────
  async function listTools(transport) {
    const all = [];
    let cursor;
    for (let i = 0; i < 50; i++) {
      const result = await transport.request('tools/list', cursor ? { cursor } : {}, 60000);
      if (Array.isArray(result.tools)) {
        for (const t of result.tools) if (t && typeof t.name === 'string') all.push(t);
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return all;
  }
  function stderrTail(entry) {
    try {
      const reader = entry.handle && entry.handle.collected && entry.handle.collected.stderr;
      if (reader) return reader.readFrom(0).text;
    } catch (e) {}
    return '';
  }

  // ───────────────────── health probe ─────────────────────
  // A successful MCP handshake proves only that the bridge process answered
  // `initialize` — not that the program behind it is usable. A stdio server
  // such as `uvx blender-mcp` finishes the handshake with Blender closed, and
  // worse, it reports backend failures as SUCCESSFUL tool results: calling
  // `get_addon_status` with a dead bridge port returns
  // `isError: false` with the text "Error checking addon status: Could not
  // connect to Blender…". So a probe must judge the payload, not just isError.
  //
  // `healthTool`      — the tool to call
  // `healthArguments` — its arguments
  // `healthExpect`    — literal substring that must appear in the result for
  //                     the backend to count as reachable (e.g. "protocol_version").
  //                     Without it only isError is judged, which is not enough
  //                     for servers that swallow backend errors.
  function healthToolExists(entry) {
    const want = entry.config.healthTool;
    if (!want) return false;
    return entry.tools.some((t) => t && t.name === want);
  }
  async function probeHealth(entry) {
    const want = entry.config.healthTool;
    if (!want) { entry.health = { status: 'unchecked', tool: '', error: null, at: Date.now() }; return entry.health; }
    if (entry.state !== 'connected' || !entry.transport) {
      entry.health = { status: 'unknown', tool: want, error: 'not connected', at: Date.now() };
      return entry.health;
    }
    if (!healthToolExists(entry)) {
      entry.health = { status: 'unknown', tool: want, error: 'health tool "' + want + '" is not in this server\'s tool list', at: Date.now() };
      return entry.health;
    }
    const budget = Math.min(15000, Math.max(3000, Math.round(entry.config.toolCallTimeoutMs / 4)));
    try {
      const result = await entry.transport.request('tools/call', { name: want, arguments: entry.config.healthArguments || {} }, budget);
      const text = mcpTextOf(result) || '';
      if (result && result.isError) throw new Error(text.slice(0, 400) || 'tool reported an error');
      const expect = entry.config.healthExpect;
      if (expect && text.indexOf(expect) < 0) {
        throw new Error('探针返回中未出现期望内容 "' + expect + '"（后端可能不可用）。实际返回：' + text.slice(0, 300));
      }
      entry.health = { status: 'healthy', tool: want, error: null, at: Date.now() };
    } catch (e) {
      entry.health = { status: 'degraded', tool: want, error: ((e && e.message) || String(e)).slice(0, 600), at: Date.now() };
    }
    console.log('[mcp-manager] ' + entry.config.name + ' health: ' + entry.health.status + (entry.health.error ? ' — ' + entry.health.error : ''));
    return entry.health;
  }

  // ───────────────────── connection lifecycle ─────────────────────
  function teardownConnection(entry) {
    unregisterTools(entry);
    if (entry.handle) { try { entry.handle.terminate(); } catch (e) {} }
    entry.handle = undefined;
    entry.transport = undefined;
  }
  function onExit(entryName, outcome) {
    const entry = servers.get(entryName);
    if (!entry || !entry.handle) return;
    const tail = stderrTail(entry);
    teardownConnection(entry);
    entry.state = 'disconnected';
    const code = outcome && outcome.exitCode !== null && outcome.exitCode !== undefined ? 'exit code ' + outcome.exitCode : 'signal ' + (outcome && outcome.signal);
    entry.error = 'process exited (' + code + ')' + (tail ? ' — stderr: ' + tail.slice(-1500) : '');
    console.log('[mcp-manager] ' + entryName + ' disconnected (' + code + ')');
  }
  function onSpawnFail(entryName, err) {
    const entry = servers.get(entryName);
    if (!entry) return;
    teardownConnection(entry);
    entry.state = 'error';
    entry.error = 'spawn failed: ' + ((err && err.message) || err);
  }
  async function connect(entryName) {
    const entry = servers.get(entryName);
    if (!entry) throw new Error('server "' + entryName + '" not found');
    if (entry.state === 'connected' || entry.state === 'connecting') {
      return { state: entry.state, tools: entry.tools.map((t) => t.name) };
    }
    entry.state = 'connecting';
    entry.error = null;
    entry.loaded = new Set();
    entry.health = entry.config.healthTool ? { status: 'probing', tool: entry.config.healthTool, error: null, at: Date.now() } : { status: 'unchecked', tool: '', error: null, at: Date.now() };
    try {
      const cfg = entry.config;
      if (cfg.transport === 'http') {
        const transport = makeHttpTransport(entry);
        entry.transport = transport;
        await transport.request('initialize', {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'dsh-mcp-manager', version: '1.0.0' },
        }, 20000);
        await transport.send('notifications/initialized');
        const tools = await listTools(transport);
        entry.tools = tools;
        transport.setNotifier((msg) => {
          if (msg.method === 'notifications/tools/list_changed') {
            resyncTools(entryName).catch((e) => console.error('[mcp-manager] resync failed:', e && e.message));
          }
        });
        registerTools(entry);
        entry.state = 'connected';
        console.log('[mcp-manager] ' + entryName + ' connected (http): ' + tools.length + ' tools');
        probeHealth(entry).catch((e) => console.error('[mcp-manager] health probe failed:', e && e.message));
        return { state: entry.state, tools: tools.map((t) => t.name) };
      }
      const exe = await ctx.subprocess.resolveExecutable(cfg.command, cfg.env);
      const handle = ctx.subprocess.spawn({
        argv: [exe].concat(cfg.args || []),
        cwd: cfg.cwd || defaultCwd(),
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 } },
        graceMs: 3000,
        env: cfg.env || {},
      });
      entry.handle = handle;
      handle.done.then((outcome) => onExit(entryName, outcome), (err) => onSpawnFail(entryName, err));
      attachStdio(entry);
      await entry.transport.request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'dsh-mcp-manager', version: '1.0.0' },
      }, 15000);
      entry.transport.send('notifications/initialized');
      const tools = await listTools(entry.transport);
      entry.tools = tools;
      entry.transport.setNotifier((msg) => {
        if (msg.method === 'notifications/tools/list_changed') {
          resyncTools(entryName).catch((e) => console.error('[mcp-manager] resync failed:', e && e.message));
        }
      });
      registerTools(entry);
      entry.state = 'connected';
      console.log('[mcp-manager] ' + entryName + ' connected: ' + tools.length + ' tools');
      probeHealth(entry).catch((e) => console.error('[mcp-manager] health probe failed:', e && e.message));
      return { state: entry.state, tools: tools.map((t) => t.name) };
    } catch (e) {
      const tail = stderrTail(entry);
      teardownConnection(entry);
      entry.state = 'error';
      entry.error = ((e && e.message) || String(e)) + (tail ? ' — stderr: ' + tail.slice(-1500) : '');
      throw e;
    }
  }
  async function disconnect(entryName) {
    const entry = servers.get(entryName);
    if (!entry) throw new Error('server "' + entryName + '" not found');
    if (entry.state === 'connected' || entry.state === 'connecting') {
      teardownConnection(entry);
      entry.state = 'disconnected';
      entry.error = null;
    }
    return { ok: true, name: entryName, state: entry.state };
  }
  async function resyncTools(entryName) {
    const entry = servers.get(entryName);
    if (!entry || entry.state !== 'connected' || !entry.transport) return;
    // Serialize generations: if a swap is already in flight, this call only
    // leaves a marker; the running pass re-fetches and re-validates afterwards.
    if (entry.resyncing) { entry.resyncQueued = true; return; }
    entry.resyncing = true;
    try {
      // A queued notification means the list changed again while a swap was
      // running, so the newest snapshot needs its own fetch and validation.
      const passes = entry.resyncQueued ? 2 : 1;
      entry.resyncQueued = false;
      for (let pass = 0; pass < passes; pass++) {
        let tools;
        try {
          tools = await listTools(entry.transport);
        } catch (e) {
          // Fetch stage failed: the previous generation stays registered and
          // callable — this is the "keep the old set" half of the contract.
          noteGenerationFailure(entry, 'fetch', ['重新拉取工具列表失败：' + ((e && e.message) || e)]);
          return;
        }
        entry.tools = tools;
        // The tool list changed: previously described schemas may be gone or
        // reshaped, so the model is asked to describe them again.
        entry.loaded = new Set();
        // This pass owns the generation record: swapToolsGeneration writes the
        // applied/rejected outcome itself, so running it with ownsRecord=true is
        // enough even though `entry.resyncing` is still set.
        swapToolsGeneration(entry, true);
      }
    } finally {
      entry.resyncing = false;
      entry.resyncQueued = false;
    }
    probeHealth(entry).catch((e) => console.error('[mcp-manager] health probe failed:', e && e.message));
  }

  // ───────────────────── tool bridging ─────────────────────
  function publicToolName(serverName, rawName) {
    const base = 'mcp__' + serverName + '__' + rawName;
    const cleaned = base.replace(/[^A-Za-z0-9_-]/g, '_');
    if (cleaned === base && cleaned.length <= 64) return cleaned;
    let h = 0;
    for (let i = 0; i < rawName.length; i++) h = (h * 31 + rawName.charCodeAt(i)) >>> 0;
    return cleaned.slice(0, 51) + '_' + h.toString(16).padStart(12, '0');
  }
  function sanitizeSchema(node) {
    const out = {};
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return out;
    for (const k of ['description', 'title']) if (typeof node[k] === 'string') out[k] = node[k];
    if (node.default !== undefined) out.default = node.default;
    if (node.examples !== undefined) out.examples = node.examples;
    if (Array.isArray(node.oneOf) && node.oneOf.length >= 2) {
      out.oneOf = node.oneOf.map(sanitizeSchema);
      return out;
    }
    const t = node.type;
    if (t === 'object') {
      out.type = 'object';
      if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
        out.properties = {};
        const keys = Object.keys(node.properties);
        for (const k of keys) out.properties[k] = sanitizeSchema(node.properties[k]);
        if (Array.isArray(node.required)) {
          const req = node.required.filter((r) => typeof r === 'string' && Object.prototype.hasOwnProperty.call(out.properties, r));
          if (req.length) out.required = req;
        }
      }
      out.additionalProperties = typeof node.additionalProperties === 'boolean' ? node.additionalProperties : true;
      return out;
    }
    if (t === 'array') {
      out.type = 'array';
      if (node.items) out.items = sanitizeSchema(node.items);
      return out;
    }
    if (t === 'string' || t === 'number' || t === 'integer' || t === 'boolean' || t === 'null') {
      out.type = t;
      if (Array.isArray(node.enum) && node.enum.length > 0) out.enum = node.enum.slice(0, 50);
      if (node.const !== undefined) out.const = node.const;
      return out;
    }
    return out;
  }
  function mcpTextOf(result) {
    const parts = [];
    if (Array.isArray(result && result.content)) {
      for (const block of result.content) {
        if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
        else if (block && typeof block === 'object' && (block.type === 'image' || block.type === 'audio' || block.type === 'resource')) parts.push('[' + block.type + ']');
        else if (block !== null && block !== undefined) parts.push(JSON.stringify(block));
      }
    }
    return parts.length ? parts.join('\n') : JSON.stringify(result);
  }
  function buildMcpTool(entry, t) {
    const serverName = entry.config.name;
    const parameters = sanitizeSchema(t.inputSchema || {});
    if (parameters.type !== 'object') {
      // non-object roots become an open object with an `input` property
      return {
        name: publicToolName(serverName, t.name),
        description: '[MCP ' + serverName + '] ' + (typeof t.description === 'string' && t.description ? t.description : t.name),
        parameters: { type: 'object', properties: parameters.type ? { input: parameters } : {}, additionalProperties: true },
        output: { schema: {}, render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
        async execute(args) {
          if (!entry.transport || entry.state !== 'connected') throw new Error('server "' + serverName + '" is not connected');
          const result = await entry.transport.request('tools/call', { name: t.name, arguments: args || {} }, entry.config.toolCallTimeoutMs || 60000);
          if (result && result.isError) throw new Error(mcpTextOf(result));
          return result || {};
        },
        timeoutMs: entry.config.toolCallTimeoutMs || 60000,
      };
    }
    return {
      name: publicToolName(serverName, t.name),
      description: '[MCP ' + serverName + '] ' + (typeof t.description === 'string' && t.description ? t.description : t.name),
      parameters,
      output: { schema: {}, render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
      async execute(args) {
        if (!entry.transport || entry.state !== 'connected') throw new Error('server "' + serverName + '" is not connected');
        const result = await entry.transport.request('tools/call', { name: t.name, arguments: args || {} }, entry.config.toolCallTimeoutMs || 60000);
        if (result && result.isError) throw new Error(mcpTextOf(result));
        return result || {};
      },
      timeoutMs: entry.config.toolCallTimeoutMs || 60000,
    };
  }
  // ─────────────── tool generation: build, validate, atomic swap ───────────────
  // A "generation" is one complete tool-list snapshot of one server. The swap is
  // all-or-nothing: the previous generation stays live and registered until the
  // replacement has been fully built and validated, so a failure can never leave
  // the model with a partial set (the old unregister-first code did exactly that
  // — it cleared the old tools and then registered one by one, so a mid-way
  // throw left a half-registered server behind).
  function ownerMap() {
    const owners = new Map();
    for (const entry of servers.values()) {
      for (const name of entry.publicNames || []) owners.set(name, entry.config.name);
    }
    return owners;
  }
  function buildGeneration(entry) {
    // Returns { publicName, tool } so problems found here can name the tool.
    return entry.tools.map((t) => ({ publicName: publicToolName(entry.config.name, t.name), tool: t }));
  }
  function trimProblem(problems, max) {
    if (problems.length <= max) return problems;
    return problems.slice(0, max).concat(['…另有 ' + (problems.length - max) + ' 项']);
  }
  function failGeneration(entry, kind, problems, ownsRecord) {
    const previous = entry.generation || { status: 'applied', toolCount: entry.tools.length, replacedAt: 0, problems: [], reason: null };
    const reason = problems.join('; ');
    // status tells the maintenance reader what the model actually sees:
    //   keeping  — an in-flight resync failed; the previously applied set stays live
    //   rejected — a fresh snapshot was refused; the previous set stays live
    //   applied  — this snapshot is live
    const record = {
      status: kind === 'fetch' ? 'keeping' : 'rejected',
      replacedAt: previous.replacedAt,
      toolCount: previous.toolCount,
      problems: trimProblem(problems, 5),
      reason,
    };
    if (ownsRecord) entry.generation = record;
    console.error('[mcp-manager] ' + entry.config.name + ': 工具代际被拒绝（保留上一代）— ' + reason);
    return { applied: false, problems, reason };
  }
  /**
   * Build and validate one generation, then swap it in atomically.
   * All build/validation failures are returned (never thrown); the live
   * generation is untouched unless the replacement is fully registered.
   * @param entry - server entry whose `tools` is the candidate snapshot.
   * @param ownsRecord - when true the function writes `entry.generation`;
   *   an in-flight resync owns that record itself and records the outcome.
   * @returns { applied, swapped, queued, problems, reason }
   */
  function swapToolsGeneration(entry, ownsRecord) {
    const next = { status: 'applied', replacedAt: Date.now(), toolCount: entry.tools.length, problems: [], reason: null };
    const recorded = (result) => { if (ownsRecord) entry.generation = next; return result; };
    if (entry.config.mode !== 'eager') {
      // lazy/off publish no direct tools; drop the previous generation instead
      // of leaking it, but only after the new snapshot is already in hand.
      unregisterTools(entry);
      entry.publicNames = [];
      return recorded({ applied: true, swapped: 0 });
    }
    const generation = buildGeneration(entry);
    // 1. Internal validity: a repeated name inside one list is invalid (the
    //    duplicate would shadow the first entry on every lookup) — reject the
    //    whole list rather than silently keep one of them.
    const seen = new Map();
    const duplicateNames = [];
    for (const item of generation) {
      if (seen.has(item.publicName)) duplicateNames.push(item.publicName + '（列出 ' + (seen.get(item.publicName) + 1) + ' 次）');
      seen.set(item.publicName, (seen.get(item.publicName) || 0) + 1);
    }
    if (duplicateNames.length) return failGeneration(entry, 'duplicates', ['工具名重复：' + duplicateNames.join('、')], ownsRecord);
    // 2. Cross-server validity: the public name carries the server name, so a
    //    collision means another server already owns that exact name (e.g. a
    //    server literally named "blender" plus a tool literally named
    //    "mcp__blender__x"). Registering it would silently overwrite a live
    //    tool, so the whole generation is refused.
    const owners = ownerMap();
    const collisions = [];
    for (const item of generation) {
      const owner = owners.get(item.publicName);
      if (owner !== undefined && owner !== entry.config.name) collisions.push(item.publicName + '（已属服务器 ' + owner + '）');
    }
    if (collisions.length) return failGeneration(entry, 'collisions', ['工具名与其他服务器冲突：' + collisions.join('、')], ownsRecord);
    // 3. Defensive build: everything that can throw here happens before the
    //    live generation is touched. The definitions are also kept as a
    //    GENERATOR so the previous generation can be rebuilt if the swap below
    //    fails part-way.
    let built;
    try {
      built = generation.map((item) => ({ publicName: item.publicName, def: buildMcpTool(entry, item.tool) }));
    } catch (e) {
      return failGeneration(entry, 'build', ['工具定义构建失败：' + ((e && e.message) || e)], ownsRecord);
    }
    // 4. Swap. The outgoing generation MUST be disposed before the incoming one
    //    registers: the tool registry is keyed by public name, so registering a
    //    name that the outgoing generation still occupies makes the two
    //    generations shadow each other, and the old disposer then deletes the
    //    freshly registered entry (verified: regenerating [alpha] into
    //    [alpha, beta] left only beta registered).
    const previous = { disposers: entry.disposers, publicNames: entry.publicNames, generator: entry.generator || null };
    unregisterTools(entry);
    const fresh = [];
    try {
      for (const item of built) fresh.push(ctx.tools.register(item.def));
    } catch (e) {
      // Best effort: put the previous generation back so the model is not left
      // with a partial set.
      for (const d of fresh) { try { d(); } catch (err) {} }
      const restored = [];
      if (previous.generator) {
        try {
          for (const def of previous.generator()) restored.push(ctx.tools.register(def));
        } catch (err) {
          for (const d of restored) { try { d(); } catch (e2) {} }
          restored.length = 0;
        }
      }
      entry.disposers = restored;
      entry.publicNames = restored.length ? previous.publicNames : [];
      return failGeneration(entry, 'register', [
        '注册到工具表失败：' + ((e && e.message) || e),
        restored.length ? '已恢复上一代 ' + restored.length + ' 个工具' : '上一代无法恢复，当前无直连工具',
      ], ownsRecord);
    }
    entry.disposers = fresh;
    entry.publicNames = built.map((item) => item.publicName);
    entry.generator = () => generation.map((item) => buildMcpTool(entry, item.tool));
    return recorded({ applied: true, swapped: built.length });
  }
  /** Publish the current snapshot as a generation, unless a resync owns the swap. */
  function registerTools(entry) {
    if (entry.resyncing) {
      // A resync pass is in flight and will publish the newest snapshot itself;
      // registering now would publish this older one twice.
      entry.generation = { status: 'queued', replacedAt: Date.now(), toolCount: entry.tools.length, problems: [], reason: null };
      return { applied: false, queued: true };
    }
    return swapToolsGeneration(entry, true);
  }
  function unregisterTools(entry) {
    for (const d of entry.disposers) { try { d(); } catch (e) {} }
    entry.disposers = [];
  }
  /** Record a failure without touching the live generation. */
  function noteGenerationFailure(entry, kind, problems) {
    return failGeneration(entry, kind, problems, true);
  }

  // ─────────────── lazy-mode catalog / gateway plumbing ───────────────
  const NOTES_MAX = 8000;
  const DESC_MAX = 140;
  const CATALOG_MAX = 6000;
  function brief(text, max) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function findTool(entry, rawName) {
    return entry.tools.find((t) => t && t.name === rawName) || null;
  }
  function lazyServers() {
    return Array.from(servers.values()).filter((e) => e.config.mode === 'lazy');
  }
  function healthSuffix(entry) {
    if (!entry.health) return '';
    if (entry.health.status === 'degraded') return ' — ⚠ 健康探针失败: ' + brief(entry.health.error, 160);
    if (entry.health.status === 'unknown') return ' — ⚠ 健康状态未知: ' + brief(entry.health.error, 160);
    if (entry.health.status === 'probing') return ' — 健康探针进行中';
    if (entry.health.status === 'unchecked') return ' — 未配置健康探针';
    return '';
  }
  function catalogText() {
    const rows = [];
    for (const entry of lazyServers()) {
      const head = '## ' + entry.config.name + '  [' + entry.state + healthSuffix(entry) + ']';
      if (entry.state !== 'connected') {
        rows.push(head + '\n  （未连接，先 connect ' + entry.config.name + '）');
        continue;
      }
      if (!entry.tools.length) { rows.push(head + '\n  （未发现工具）'); continue; }
      const lines = entry.tools.map((t) => {
        const flag = entry.loaded.has(t.name) ? '已载入' : '未载入';
        return '  - ' + t.name + ' [' + flag + ']: ' + brief(t.description || '(无描述)', DESC_MAX);
      });
      rows.push(head + '\n' + lines.join('\n'));
    }
    let text = rows.join('\n\n') || '（没有处于 lazy 模式的服务器）';
    if (text.length > CATALOG_MAX) text = text.slice(0, CATALOG_MAX) + '\n…（目录已截断，请用 describe 精确查找）';
    return text;
  }
  function describeText(entry, tool) {
    const schema = JSON.stringify(sanitizeSchema(tool.inputSchema || {}), null, 1);
    const parts = [
      '工具: ' + entry.config.name + ' / ' + tool.name,
      '说明: ' + (tool.description || '(无描述)'),
      '',
      '参数 schema:',
      schema,
      '',
      '调用方式: mcp_tools({action:"call", tool:"' + tool.name + '", arguments:{…}})',
    ];
    if (tool.outputSchema) parts.push('', '输出 schema（供参考）:', brief(JSON.stringify(tool.outputSchema), 2000));
    const notes = entry.config.notes;
    if (notes) {
      parts.push('', '── 使用说明（本服务器配置的 notes，每次都随 describe 注入） '.padEnd(8, '─'), brief(notes, NOTES_MAX));
    }
    return parts.join('\n');
  }
  function imageMediaType(raw) {
    const m = String(raw == null ? '' : raw).toLowerCase().trim();
    if (m === 'image/png' || m === 'image/jpeg' || m === 'image/webp' || m === 'image/gif') return m;
    if (m === 'image/jpg' || m === 'image/pjpeg') return 'image/jpeg';
    if (m === 'image/x-png') return 'image/png';
    return null;
  }
  function decodeBase64(strict) {
    if (!strict || strict.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(strict)) throw new Error('not canonical base64');
    const buf = Buffer.from(strict, 'base64');
    if (buf.toString('base64') !== strict) throw new Error('not canonical base64');
    return buf;
  }
  const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
  const imageUnavailable = (mime, why) => ({ type: 'text', text: '[image unavailable: ' + (mime || 'unknown media type') + '; ' + why + ']' });

  // Image results can only enter a request as a DSH ImageBlock, whose payload is
  // an `attachment: ImageAttachmentRef` — the request assembler reads
  // `block.attachment.bytes` unconditionally, so a hand-made image block fails the
  // WHOLE request, not just the picture. Images are therefore decoded here,
  // validated by the attachment store, and projected only when the active model
  // route really declares image input; every refusal degrades to diagnostic text.
  async function saveImageBlocks(blocks, exec) {
    const indexes = [];
    // Staged image blocks carry the private '__mcpImage' marker; a real
    // 'image' block would mean an already-resolved attachment reference.
    for (let i = 0; i < blocks.length; i++) if (blocks[i].type === '__mcpImage') indexes.push(i);
    if (!indexes.length) return blocks;
    const out = blocks.slice();
    const fail = (why) => {
      for (const i of indexes) {
        const b = out[i];
        out[i] = imageUnavailable(b.__mime, why);
      }
      return out;
    };
    const attachments = ctx.get('attachments');
    if (!attachments || typeof attachments.saveImages !== 'function') return fail('no attachment store is mounted');
    let info = null;
    try {
      const llm = ctx.get('llm');
      const routed = exec && exec.agent && exec.agent.session && typeof exec.agent.session.requestHeader === 'function' ? exec.agent.session.requestHeader() : null;
      const cfg = routed && routed.config;
      const provider = (cfg && cfg.provider) || (exec && exec.agent && exec.agent.options && exec.agent.options.provider);
      const model = (cfg && cfg.model) || (exec && exec.agent && exec.agent.options && exec.agent.options.model);
      if (!llm || !provider || !model || typeof llm.resolveModelInfo !== 'function') return fail('the active model route could not be resolved');
      info = await llm.resolveModelInfo(provider, model, exec && exec.signal);
    } catch (e) {
      return fail('the active model route could not be verified (' + (((e && e.message) || e)) + ')');
    }
    if (!info || !Array.isArray(info.inputModalities) || !info.inputModalities.includes('image')) {
      return fail('the active model does not declare image input');
    }
    const inputs = [];
    const decodeErrors = new Map();
    for (const i of indexes) {
      const raw = out[i];
      try {
        const buf = decodeBase64(raw.__data);
        if (buf.length > IMAGE_MAX_BYTES) throw new Error('image is larger than ' + Math.round(IMAGE_MAX_BYTES / 1048576) + ' MiB');
        inputs.push({ data: new Uint8Array(buf), mediaType: raw.__mime, name: raw.__name });
      } catch (e) {
        decodeErrors.set(i, (e && e.message) || String(e));
      }
    }
    if (decodeErrors.size) {
      for (const i of indexes) out[i] = imageUnavailable(out[i].__mime, decodeErrors.get(i) || 'another image in the same result was invalid');
      return out;
    }
    try {
      const refs = await attachments.saveImages(inputs);
      indexes.forEach((blockIndex, k) => { out[blockIndex] = { type: 'image', attachment: refs[k] }; });
      return out;
    } catch (e) {
      return fail('attachment storage refused the image (' + (((e && e.message) || e)) + ')');
    }
  }

  // Reverse projection: MCP content -> harness ContentBlocks. Text passes
  // through; image blocks are carried in a private staging shape and converted
  // to real ImageBlocks by saveImageBlocks() once the model route is verified.
  function contentBlocksOf(result) {
    const blocks = [];
    if (Array.isArray(result && result.content)) {
      for (const block of result.content) {
        if (!block || typeof block !== 'object') { if (block !== null && block !== undefined) blocks.push({ type: 'text', text: String(block) }); continue; }
        if (typeof block.text === 'string') { blocks.push({ type: 'text', text: block.text }); continue; }
        if (block.type === 'image') {
          const mime = imageMediaType(block.mimeType);
          const data = typeof block.data === 'string' ? block.data : '';
          if (mime && data) blocks.push({ type: '__mcpImage', __mime: mime, __data: data, __name: 'mcp-' + mime.replace('image/', '') });
          else blocks.push(imageUnavailable(block.mimeType, mime ? 'the payload is empty' : 'not a supported raster format (PNG/JPEG/WebP/GIF)'));
          continue;
        }
        if (block.type === 'audio' || block.type === 'resource') { blocks.push({ type: 'text', text: '[' + block.type + ']' }); continue; }
        blocks.push({ type: 'text', text: JSON.stringify(block) });
      }
    }
    if (!blocks.length) blocks.push({ type: 'text', text: JSON.stringify(result) });
    return blocks;
  }
  // Public projection: every staging block is resolved or degraded to text, so
  // callers only ever see real ContentBlocks.
  async function projectToolResult(result, exec) {
    const staged = contentBlocksOf(result);
    const resolved = await saveImageBlocks(staged, exec);
    return resolved.length ? resolved : [{ type: 'text', text: JSON.stringify(result) }];
  }
  function renderGatewayResult(value) {
    if (value && Array.isArray(value.blocks) && value.blocks.length) return value.blocks;
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
  }

  // ─────────────── lazy-mode gateway tool ───────────────
  function blocksToText(blocks) {
    return blocks.map((b) => {
      if (b.type === 'text') return b.text;
      const mime = (b.attachment && b.attachment.mediaType) || (b.source && b.source.media_type) || 'image';
      return '[图片: ' + mime + ']';
    }).join('\n');
  }
  async function gatewayCall(entry, rawName, args, exec) {
    const result = await callToolRaw(entry, rawName, args || {});
    const blocks = await projectToolResult(result, exec);
    const text = blocksToText(blocks);
    if (result && result.isError) throw new Error(text || 'tool reported an error');
    return { server: entry.config.name, tool: rawName, isError: false, blocks, text };
  }
  async function runGateway(args, exec) {
    const action = args && typeof args.action === 'string' ? args.action : '';
    const serverName = typeof (args && args.server) === 'string' ? args.server.trim() : '';
    if (action === 'list') {
      const only = serverName ? servers.get(serverName) : null;
      if (serverName && !only) throw new Error('server "' + serverName + '" not found');
      return { mode: 'lazy catalog', text: only ? catalogTextFor(only) : catalogText() };
    }
    if (action === 'describe' || action === 'call') {
      const toolName = typeof (args && args.tool) === 'string' ? args.tool.trim() : '';
      if (!toolName) throw new Error('action "' + action + '" requires a tool name');
      let entry = serverName ? servers.get(serverName) : null;
      if (serverName && !entry) throw new Error('server "' + serverName + '" not found');
      if (!entry) {
        // Resolve an unqualified tool name only when exactly one server offers it.
        const owners = lazyServers().filter((e) => e.state === 'connected' && findTool(e, toolName));
        if (!owners.length) {
          const connected = lazyServers().filter((e) => e.state === 'connected').map((e) => e.config.name);
          throw new Error('no connected server offers "' + toolName + '"' + (connected.length ? ' (connected: ' + connected.join(', ') + ')' : ' (none connected)'));
        }
        if (owners.length > 1) throw new Error('tool "' + toolName + '" exists on multiple servers (' + owners.map((e) => e.config.name).join(', ') + '); pass server explicitly');
        entry = owners[0];
      }
      const tool = findTool(entry, toolName);
      if (!tool) throw new Error('server "' + entry.config.name + '" has no tool "' + toolName + '"');
      if (action === 'describe') {
        entry.loaded.add(toolName);
        return { server: entry.config.name, tool: toolName, text: describeText(entry, tool) };
      }
      if (entry.state !== 'connected') throw new Error('server "' + entry.config.name + '" is not connected');
      entry.loaded.add(toolName);
      return await gatewayCall(entry, toolName, args.arguments || {}, exec);
    }
    if (action === 'load') {
      // Opt-in promotion: register this server's real tools for direct calls.
      // Costs the full schema set per request once loaded, and cannot be undone
      // without a plugin reload.
      if (!serverName) throw new Error('action "load" requires a server name');
      const entry = servers.get(serverName);
      if (!entry) throw new Error('server "' + serverName + '" not found');
      if (entry.config.mode !== 'lazy') throw new Error('server "' + serverName + '" is already in "' + entry.config.mode + '" mode');
      const names = Array.isArray(args.tools) ? args.tools : (typeof args.tool === 'string' ? [args.tool] : null);
      const before = Array.from(entry.loaded);
      entry.config.mode = 'eager';
      registerTools(entry);
      await saveServers();
      const count = names ? names.length : entry.tools.length;
      return {
        server: serverName,
        mode: 'eager',
        registered: entry.tools.map((t) => publicToolName(serverName, t.name)),
        text: '已把 ' + serverName + ' 切到 eager：' + count + ' 个工具现在直接可调用。注意每个请求都会带上它们的 schema，' +
          '直到插件重载才会恢复 lazy。此前 describe 过的工具: ' + (before.length ? before.join(', ') : '（无）'),
      };
    }
    throw new Error('mcp_tools requires action: list | describe | call | load');
  }
  function catalogTextFor(entry) {
    if (entry.config.mode !== 'lazy') return '服务器 ' + entry.config.name + ' 处于 ' + entry.config.mode + ' 模式（非 lazy，工具已直接注册）';
    if (entry.state !== 'connected') return '服务器 ' + entry.config.name + ' 未连接（state: ' + entry.state + '）' + healthSuffix(entry);
    if (!entry.tools.length) return '服务器 ' + entry.config.name + ' 未发现工具';
    return '## ' + entry.config.name + ' [' + entry.state + healthSuffix(entry) + ']\n' + entry.tools.map((t) => {
      return '  - ' + t.name + ' [' + (entry.loaded.has(t.name) ? '已载入' : '未载入') + ']: ' + brief(t.description || '(无描述)', DESC_MAX);
    }).join('\n');
  }
  const gatewayTool = {
    name: 'mcp_tools',
    description:
      'MCP 工具网关（按需注入模式）。MCP 服务器的工具不会直接列出，避免它们的 schema 占用每个请求的 token。\n' +
      '用 action:"list" 查看可用工具目录；用 action:"describe" 载入某个工具的完整参数 schema 和该服务器的使用说明（notes）；' +
      '用 action:"call" 带 arguments 直接调用；用 action:"load" 可把某服务器整体提升为常驻注册。\n' +
      '调用前先 describe 以拿到准确参数名。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'describe', 'call', 'load'], description: 'list: 工具目录；describe: 载入某工具的 schema + 服务器说明；call: 调用工具（arguments 必填）；load: 把服务器整体切到 eager 常驻注册。' },
        server: { type: 'string', description: '服务器名。当工具名在多个服务器上重名时必填；load 时必填。' },
        tool: { type: 'string', description: '工具原始名（describe/call 必填，可用 load.tools 数组代替）。' },
        arguments: { description: 'call 的工具参数对象（JSON）。' },
        tools: { type: 'array', items: { type: 'string' }, description: 'load 时可选的工具名列表（仅用于汇报，load 作用于整个服务器）。' },
      },
      required: ['action'],
    },
    output: {
      schema: {},
      render: (args, value) => renderGatewayResult(value),
    },
    async execute(args, exec) {
      if (!args || typeof args.action !== 'string') throw new Error('mcp_tools requires an action');
      return runGateway(args, exec);
    },
  };

  // ───────────────────── CRUD ─────────────────────
  async function addServer(input) {
    const cfg = normalizeConfig(input);
    if (servers.has(cfg.name)) throw new Error('server "' + cfg.name + '" already exists');
    servers.set(cfg.name, makeEntry(cfg));
    await saveServers();
    return { ok: true, name: cfg.name };
  }
  async function updateServer(input) {
    const cfg = normalizeConfig(input);
    const originalName = typeof input.originalName === 'string' ? input.originalName.trim() : '';
    if (originalName && originalName !== cfg.name) {
      // Rename: the client sends the OLD name in `originalName` and the NEW
      // name in `name`. The old entry is disconnected, moved to the new key
      // with the new config, and persisted — a single atomic rename. (Before
      // v1.1.0 the client tried update(new name) then remove(old name), which
      // errored on the unknown new name and then deleted the old server.)
      const existing = servers.get(originalName);
      if (!existing) throw new Error('server "' + originalName + '" not found');
      if (servers.has(cfg.name)) throw new Error('server "' + cfg.name + '" already exists');
      if (existing.state === 'connected' || existing.state === 'connecting') await disconnect(originalName);
      servers.delete(originalName);
      servers.set(cfg.name, makeEntry(cfg));
      await saveServers();
      return { ok: true, name: cfg.name, renamedFrom: originalName };
    }
    const existing = servers.get(cfg.name);
    if (!existing) throw new Error('server "' + cfg.name + '" not found');
    if (existing.state === 'connected' || existing.state === 'connecting') await disconnect(cfg.name);
    existing.config = cfg;
    existing.state = 'disconnected';
    existing.error = null;
    await saveServers();
    return { ok: true, name: cfg.name };
  }
  async function removeServer(entryName) {
    const entry = servers.get(entryName);
    if (!entry) throw new Error('server "' + entryName + '" not found');
    if (entry.state === 'connected' || entry.state === 'connecting') await disconnect(entryName);
    servers.delete(entryName);
    await saveServers();
    return { ok: true, name: entryName };
  }
  async function callToolRaw(entry, rawName, args) {
    if (!entry.transport || entry.state !== 'connected') throw new Error('server "' + entry.config.name + '" is not connected');
    return entry.transport.request('tools/call', { name: rawName, arguments: args || {} }, entry.config.toolCallTimeoutMs || 60000);
  }

  // ───────────────────── shared op dispatcher ─────────────────────
  async function runOp(op, payload, exec) {
    payload = payload || {};
    switch (op) {
      case 'list':
      case 'status':
        return { servers: Array.from(servers.values()).map(summaryOf) };
      case 'add': return addServer(payload);
      case 'update': return updateServer(payload);
      case 'remove': return removeServer(payload);
      case 'connect': return connect(payload.name);
      case 'disconnect': return disconnect(payload.name);
      case 'tools': {
        const entry = servers.get(payload.name);
        if (!entry) throw new Error('server "' + payload.name + '" not found');
        return {
          name: payload.name,
          state: entry.state,
          mode: entry.config.mode,
          health: entry.health,
          generation: entry.generation,
          loaded: Array.from(entry.loaded),
          tools: entry.tools.map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || {} })),
        };
      }
      case 'health': {
        const entry = servers.get(payload.name);
        if (!entry) throw new Error('server "' + payload.name + '" not found');
        return { name: payload.name, state: entry.state, health: await probeHealth(entry) };
      }
      case 'call': {
        const entry = servers.get(payload.name);
        if (!entry) throw new Error('server "' + payload.name + '" not found');
        const result = await callToolRaw(entry, payload.tool, payload.arguments || {});
        return { name: payload.name, tool: payload.tool, isError: !!result.isError, content: result.content, structuredContent: result.structuredContent };
      }
      default: throw new Error('unknown mcp op: ' + String(op));
    }
  }

  // ───────────────────── GUI API route ─────────────────────
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 262144) { reject(new Error('request too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/mcp-manager/api',
    handler: async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end(JSON.stringify({ ok: false, error: 'POST only' }));
        return;
      }
      try {
        const body = await readBody(req);
        let args = {};
        try { args = JSON.parse(body || '{}'); } catch (e) { args = {}; }
        const result = await runOp(args && args.op, args);
        res.writeHead(200);
        res.end(JSON.stringify(Object.assign({ ok: true }, result)));
      } catch (e) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
      }
    },
  }), 'mcp-manager: api route');

  // ───────────────────── model-facing manager tool ─────────────────────
  const managerTool = {
    name: 'mcp_manager',
    description: 'Manage MCP (Model Context Protocol) servers for this agent: add/update/remove server configs (stdio or streamable-HTTP transport), connect/disconnect, list discovered tools, run a health probe, and call a server tool directly. In the default lazy mode a connected server\'s tools are NOT registered directly — use the separate `mcp_tools` gateway to list, describe and call them; mode "eager" registers every tool as mcp__<server>__<tool>.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'status', 'add', 'update', 'remove', 'connect', 'disconnect', 'tools', 'health', 'call'],
          description: 'Operation. list/status: all servers with state, health and mode; add: name + (stdio: command, args, env, cwd) or (http: url, headers); update: same fields, pass originalName to rename; remove: delete config; connect/disconnect: live connection; tools: discovered tools of a server; health: run the configured health probe now; call: invoke one tool with arguments.',
        },
        name: { type: 'string', description: 'Server name ([A-Za-z0-9_-], max 32); required for every action except list/status. On update, carries the NEW name when renaming.' },
        originalName: { type: 'string', description: 'update only: the server\'s previous name when renaming (name carries the new name).' },
        transport: { type: 'string', enum: ['stdio', 'http'], description: 'Transport: stdio (spawn a child process) or http (streamable HTTP endpoint). Default http.' },
        mode: { type: 'string', enum: ['lazy', 'eager', 'off'], description: 'Tool injection mode. lazy (default): tools are reached through `mcp_tools` on demand, so their schemas cost no per-request tokens. eager: register every tool directly. off: expose no tools.' },
        notes: { type: 'string', description: 'Usage instructions for this server, injected on demand — returned by `mcp_tools` action "describe". Put environment knowledge here instead of in AGENTS.md.' },
        healthTool: { type: 'string', description: 'Tool name called as a health probe after each connect (e.g. get_addon_status). Without it, "connected" only means the MCP handshake succeeded, not that the backend works.' },
        healthArguments: { description: 'Arguments for the health probe as a JSON object.' },
        healthExpect: { type: 'string', description: 'Literal text that MUST appear in the probe result for the backend to count as reachable. Needed for servers that report backend failures as successful results (uvx blender-mcp returns isError:false with "Could not connect to Blender" in the payload); e.g. "protocol_version".' },
        command: { type: 'string', description: 'stdio: executable to spawn (absolute path or PATH name), e.g. node.' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio: command-line arguments for the server process.' },
        env: { description: 'stdio: environment variables as a JSON object of strings.' },
        cwd: { type: 'string', description: 'stdio: working directory for the server process; defaults to the workspace.' },
        url: { type: 'string', description: 'http: MCP endpoint URL, e.g. http://127.0.0.1:8000/mcp.' },
        headers: { description: 'http: extra request headers as a JSON object of strings.' },
        toolCallTimeoutMs: { type: 'integer', description: 'Per tool-call timeout in ms (default 60000).' },
        tool: { type: 'string', description: 'Raw MCP tool name (call action only).' },
        arguments: { description: 'Tool arguments as a JSON object (call action only).' },
      },
      required: ['action'],
    },
    output: {
      schema: {},
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (!args || typeof args.action !== 'string') throw new Error('mcp_manager requires an action');
      return runOp(args.action, args, exec);
    },
  };
  ctx.effect(() => ctx.tools.register(managerTool), 'mcp-manager: manager tool');
  ctx.effect(() => ctx.tools.register(gatewayTool), 'mcp-manager: lazy tool gateway');

  // ───────────────────── lifecycle ─────────────────────
  ctx.effect(() => () => {
    for (const entry of servers.values()) {
      if (entry.handle) { try { entry.handle.terminate(); } catch (e) {} }
    }
  }, 'mcp-manager: child cleanup');

  await loadServers();
  console.log('[mcp-manager] ready with ' + servers.size + ' saved servers');
  // best-effort auto-connect of saved servers shortly after boot
  ctx.timeout(() => {
    for (const entry of servers.values()) {
      if (entry.state !== 'connected' && entry.state !== 'connecting') {
        connect(entry.config.name).catch((e) => console.error('[mcp-manager] auto-connect ' + entry.config.name + ' failed:', (e && e.message) || e));
      }
    }
  }, 500);
}

export default { name, inject, apply };
