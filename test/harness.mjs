// Minimal DSH host seam for exercising the plugin outside a live runtime.
// Implements only what lib/index.js touches: effect, timeout, get, fs,
// settings, subprocess, tools, webServer.
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';

export function makeCtx(opts = {}) {
  const registered = new Map(); // name -> definition
  const registrations = [];     // history
  const disposers = [];
  const timers = [];

  const savedImages = [];
  const ctx = {
    registered,
    registrations,
    disposers,
    savedImages,
    get(name) {
      if (name === 'sandboxPolicy') return { workspaceRoot: opts.workspaceRoot || process.cwd() };
      if (name === 'attachments' && opts.attachments) {
        return {
          // Mirrors the real contract: authoritative validation, durable refs,
          // `bytes` taken from the stored bytes.
          async saveImages(inputs) {
            return inputs.map((input) => {
              if (!input.data || !input.data.length) throw new Error('empty image bytes');
              if (!String(input.mediaType || '').startsWith('image/')) throw new Error('unsupported media type: ' + input.mediaType);
              savedImages.push(input);
              return {
                attachmentId: 'att_' + savedImages.length,
                mediaType: input.mediaType,
                bytes: input.data.length,
                width: 640,
                height: 480,
                name: input.name,
              };
            });
          },
        };
      }
      if (name === 'llm' && opts.attachments) {
        return { async resolveModelInfo() { return { inputModalities: opts.modalities || ['text', 'image'] }; } };
      }
      return undefined;
    },
    effect(fn, label) {
      const d = fn();
      disposers.push({ label, d });
      return () => {};
    },
    timeout(fn, ms) {
      const t = setTimeout(fn, ms);
      timers.push(t);
      return () => clearTimeout(t);
    },
    fs: {
      async resolve(p) { return path.resolve(p); },
      async stat(p) {
        try { const s = await fsp.stat(p); return { size: s.size, mtimeMs: s.mtimeMs }; } catch (e) { return null; }
      },
      async readText(p) { return fsp.readFile(p, 'utf8'); },
      async writeText(p, text) { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, text, 'utf8'); },
    },
    settings: {
      async prepareDocument() { return path.join(opts.dshHome, 'settings.yaml'); },
    },
    subprocess: {
      async resolveExecutable(cmd) { return cmd; },
      spawn(spec) {
        return opts.spawn(spec);
      },
    },
    tools: {
      register(def) {
        registered.set(def.name, def);
        registrations.push(def.name);
        return () => { registered.delete(def.name); };
      },
    },
    webServer: {
      register(route) { return () => {}; },
    },
  };
  return ctx;
}

// Spawn seam shaped like the DSH subprocess handle the plugin consumes:
// stdin.write, stdout.on('data'|'end'|'error'), handle.collected.<stream>.readFrom(0).text,
// handle.done -> { exitCode, signal }, handle.terminate().
export function makeSpawn() {
  return function spawn(spec) {
    const { spawn: nodeSpawn } = childProcess;
    const argv = spec.argv || [];
    const stdio = spec.stdio || {};
    const child = nodeSpawn(argv[0], argv.slice(1), {
      cwd: spec.cwd,
      // The plugin hands over the FULL child environment in spec.env; merging
      // process.env here would silently override the very variables under test.
      env: spec.env && Object.keys(spec.env).length ? spec.env : process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks = [];
    let stderrText = '';
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { stderrText += c.toString('utf8'); });

    if (stdio.stdin && typeof stdio.stdin === 'object' && typeof stdio.stdin.data === 'string') {
      child.stdin.end(stdio.stdin.data);
    }

    const done = new Promise((resolve) => {
      child.on('error', (err) => resolve({ exitCode: null, signal: null, error: err }));
      child.on('close', (code, signal) => resolve({ exitCode: code, signal: signal || null }));
    });

    return {
      stdin: { write: (b) => child.stdin.write(b) },
      stdout: child.stdout,
      stderr: child.stderr,
      done,
      collected: {
        stdout: { readFrom: () => ({ text: Buffer.concat(chunks).toString('utf8') }) },
        stderr: { readFrom: () => ({ text: stderrText }) },
      },
      terminate: () => { try { child.kill(); } catch (e) {} },
    };
  };
}

export function tmpHome(tag) {
  return path.join(os.tmpdir(), 'mcp-manager-test-' + tag + '-' + Date.now());
}
