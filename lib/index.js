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
  function normalizeConfig(input) {
    if (!input || typeof input !== 'object') throw new Error('invalid server config');
    const nm = typeof input.name === 'string' ? input.name.trim() : '';
    if (!NAME_RE.test(nm)) throw new Error('server name must match [A-Za-z0-9_-]{1,32}');
    const transport = input.transport === 'stdio' ? 'stdio' : 'http';
    if (transport === 'http') {
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      if (!url) throw new Error('url is required for http transport');
      return {
        name: nm, transport, command: '', args: [], env: {}, cwd: '', url,
        headers: stringMap(input.headers),
        toolCallTimeoutMs: Number.isFinite(Number(input.toolCallTimeoutMs)) && Number(input.toolCallTimeoutMs) > 0 ? Math.round(Number(input.toolCallTimeoutMs)) : 60000,
      };
    }
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command) throw new Error('command is required for stdio transport');
    return {
      name: nm, transport, command,
      args: Array.isArray(input.args) ? input.args.filter((a) => typeof a === 'string') : [],
      env: stringMap(input.env),
      cwd: typeof input.cwd === 'string' ? input.cwd : '',
      url: '', headers: {},
      toolCallTimeoutMs: Number.isFinite(Number(input.toolCallTimeoutMs)) && Number(input.toolCallTimeoutMs) > 0 ? Math.round(Number(input.toolCallTimeoutMs)) : 60000,
    };
  }
  function makeEntry(cfg) {
    return { config: cfg, state: 'disconnected', error: null, handle: undefined, transport: undefined, tools: [], disposers: [] };
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
      state: entry.state,
      error: entry.error,
      tools: entry.tools.map((t) => t.name),
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
    const tools = await listTools(entry.transport);
    entry.tools = tools;
    registerTools(entry);
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
  function registerTools(entry) {
    unregisterTools(entry);
    const disposers = [];
    for (const t of entry.tools) {
      try {
        const tool = buildMcpTool(entry, t);
        disposers.push(ctx.tools.register(tool));
      } catch (e) {
        console.error('[mcp-manager] failed to register mcp__' + entry.config.name + '__' + t.name + ':', (e && e.message) || e);
      }
    }
    entry.disposers = disposers;
  }
  function unregisterTools(entry) {
    for (const d of entry.disposers) { try { d(); } catch (e) {} }
    entry.disposers = [];
  }

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
  async function runOp(op, payload) {
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
          tools: entry.tools.map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || {} })),
        };
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
    description: 'Manage MCP (Model Context Protocol) servers for this agent: add/update/remove server configs (stdio or streamable-HTTP transport), connect/disconnect, list discovered tools, and call a server tool directly. Connected servers expose their tools to the model as mcp__<server>__<tool>.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'status', 'add', 'update', 'remove', 'connect', 'disconnect', 'tools', 'call'],
          description: 'Operation. list/status: all servers with state; add: name + (stdio: command, args, env, cwd) or (http: url, headers); update: same fields, pass originalName to rename; remove: delete config; connect/disconnect: live connection; tools: discovered tools of a server; call: invoke one tool with arguments.',
        },
        name: { type: 'string', description: 'Server name ([A-Za-z0-9_-], max 32); required for every action except list/status. On update, carries the NEW name when renaming.' },
        originalName: { type: 'string', description: 'update only: the server\'s previous name when renaming (name carries the new name).' },
        transport: { type: 'string', enum: ['stdio', 'http'], description: 'Transport: stdio (spawn a child process) or http (streamable HTTP endpoint). Default http.' },
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
    async execute(args) {
      if (!args || typeof args.action !== 'string') throw new Error('mcp_manager requires an action');
      return runOp(args.action, args);
    },
  };
  ctx.effect(() => ctx.tools.register(managerTool), 'mcp-manager: manager tool');

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
