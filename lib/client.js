window.__ModuleLoader__.load({
	id: "@dsh-user/dsh-mcp-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		// ── styles ────────────────────────────────────────────────────────────
		const CSS = `
.mcp-page{display:flex;flex-direction:column;gap:10px;padding:2px 0 12px;min-width:0}
.mcp-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.mcp-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0}
.mcp-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mcp-notice{padding:6px 10px;border-radius:8px;font-size:12px;line-height:18px;border:1px solid;word-break:break-all}
.mcp-notice[data-kind=error]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.mcp-notice[data-kind=info]{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1)}
.mcp-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;min-width:0}
.mcp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mcp-name{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary)}
.mcp-dot{width:8px;height:8px;border-radius:50%;flex:none}
.mcp-dot[data-state=connected]{background:var(--dsw-alias-state-success-primary)}
.mcp-dot[data-state=connecting]{background:var(--dsw-alias-state-warn-primary)}
.mcp-dot[data-state=error]{background:var(--dsw-alias-state-error-primary)}
.mcp-dot[data-state=disconnected]{background:var(--dsw-alias-label-secondary)}
.mcp-badge[data-on=true]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}
.mcp-badge{font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 5px;line-height:16px}
.mcp-meta{font-size:12px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,Consolas,monospace;word-break:break-all;min-width:0}
.mcp-err{font-size:12px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;word-break:break-all}
.mcp-btn{font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;line-height:18px}
.mcp-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary)}
.mcp-btn[data-primary]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.mcp-btn[data-danger]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.mcp-btn:disabled{opacity:.5;cursor:default}
.mcp-form{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-1)}
.mcp-field{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.mcp-input{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-primary);padding:5px 8px;font-size:12px;font-family:inherit;box-sizing:border-box;width:100%}
.mcp-input:focus{outline:1px solid var(--dsw-alias-brand-primary)}
.mcp-textarea{min-height:64px;resize:vertical;font-family:ui-monospace,Consolas,monospace}
.mcp-tools{border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px;display:flex;flex-direction:column;gap:10px}
.mcp-tool{display:flex;flex-direction:column;gap:4px;font-size:12px;min-width:0}
.mcp-tool-name{color:var(--dsw-alias-label-primary);font-family:ui-monospace,Consolas,monospace;word-break:break-all}
.mcp-tool-desc{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.mcp-pre{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-primary);max-height:220px;overflow:auto;font-family:ui-monospace,Consolas,monospace;margin:0}
.mcp-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:8px 0}
.mcp-catalog{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px}
.mcp-cat-search input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 12px;font-size:13px;font-family:inherit;outline:none}
.mcp-cat-search input:focus{border-color:var(--dsw-alias-brand-primary)}
.mcp-cat-group{display:flex;flex-direction:column;gap:8px}
.mcp-cat-head{display:flex;align-items:baseline;gap:8px}
.mcp-cat-head h3{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.mcp-cat-head span{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.mcp-cat-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none}
.mcp-cat-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;min-width:0;cursor:pointer}
.mcp-cat-card:hover{border-color:var(--dsw-alias-label-secondary)}
.mcp-cat-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);word-break:break-all}
.mcp-cat-id{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,Consolas,monospace;word-break:break-all}
.mcp-cat-details{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);border-top:1px dashed var(--dsw-alias-border-l1);padding-top:6px}
.mcp-cat-details div{word-break:break-all}`;

		// ── plugin inventory: official vs custom ───────────────────────────────
		const PHASE_TEXT = { pending: '等待依赖', loading: '加载中', active: '已挂载', failed: '挂载失败', unloading: '卸载中' };
		const phaseText = (p) => (p === null ? '未挂载' : (PHASE_TEXT[p] || p));
		const moduleShortName = (m) => (m.startsWith('@') ? m.slice(m.indexOf('/') + 1) : m).replace(/^cordis:/, '').replace(/^cordis-plugin-/, '').replace(/^dsh-(?:host-|client-)?/, '');

		function CatalogPage({ list }) {
			const [state, setState] = React.useState({ status: 'loading' });
			const [query, setQuery] = React.useState('');
			const [expanded, setExpanded] = React.useState(null);
			const [tick, setTick] = React.useState(0);
			React.useEffect(() => {
				let current = true;
				Promise.resolve().then(() => list()).then((snapshot) => {
					if (current) setState({ status: 'ready', snapshot });
				}, () => {
					if (current) setState({ status: 'error' });
				});
				return () => { current = false; };
			}, [list, tick]);
			const q = query.trim().toLocaleLowerCase();
			const entries = state.status === 'ready'
				? state.snapshot.entries.filter((e) => !q || e.moduleName.toLocaleLowerCase().includes(q) || String(e.entryId).toLocaleLowerCase().includes(q))
				: [];
			return h('div', { className: 'mcp-catalog' },
				state.status === 'loading' ? h('div', { className: 'mcp-empty' }, '正在读取插件…') : null,
				state.status === 'error' ? h('div', { className: 'mcp-notice', 'data-kind': 'error' }, '暂时无法读取插件。',
					h('button', { className: 'mcp-btn', onClick: () => { setState({ status: 'loading' }); setTick((v) => v + 1); } }, '重试')) : null,
				state.status === 'ready' ? h('div', { className: 'mcp-catalog' },
					h('label', { className: 'mcp-cat-search' },
						h('input', { placeholder: '搜索插件', value: query, onChange: (ev) => setQuery(ev.target.value) })),
					h('div', { className: 'mcp-cat-head' },
						h('span', null, '共 ' + String(entries.length) + ' 个'),
					),
					entries.length === 0 ? h('div', { className: 'mcp-empty' }, '无') :
						h('ul', { className: 'mcp-cat-grid' }, entries.map((entry) => h('li', {
							key: entry.entryId,
							className: 'mcp-cat-card',
							onClick: () => setExpanded(expanded === entry.entryId ? null : entry.entryId),
						},
							h('div', { className: 'mcp-cat-title' }, moduleShortName(entry.moduleName)),
							h('div', { className: 'mcp-cat-id' }, entry.entryId),
							h('div', { className: 'mcp-row' },
								h('span', { className: 'mcp-badge', 'data-on': entry.enabled ? 'true' : undefined }, entry.enabled ? '已启用' : '已停用'),
								h('span', { className: 'mcp-badge' }, phaseText(entry.fiberPhase)),
							),
							expanded === entry.entryId ? h('div', { className: 'mcp-cat-details' },
								h('div', null, '模块: ' + entry.moduleName),
								h('div', null, '启用: ' + (entry.enabled ? '是' : '否') + ' · Cordis: ' + phaseText(entry.fiberPhase)),
							) : null,
						))),
				) : null,
			);
		}

		// ── MCP manager settings page ──────────────────────────────────────────
		async function api(op, payload) {
			const res = await fetch('/mcp-manager/api', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(Object.assign({ op }, payload || {})),
			});
			return res.json();
		}

		function McpManagerPage() {
			const [servers, setServers] = React.useState(null);
			const [notice, setNotice] = React.useState(null);
			const [busy, setBusy] = React.useState({});
			const [expanded, setExpanded] = React.useState({});
			const [editing, setEditing] = React.useState(null);
			const [toolsCache, setToolsCache] = React.useState({});
			const [argsText, setArgsText] = React.useState({});
			const [results, setResults] = React.useState({});
			const [confirmRemove, setConfirmRemove] = React.useState(null);

			const refresh = async () => {
				try {
					const res = await api('list');
					if (!res || !res.ok) { setNotice({ kind: 'error', text: (res && res.error) || 'list failed' }); setServers([]); return; }
					setServers(res.servers || []);
					setNotice(null);
				} catch (e) {
					setNotice({ kind: 'error', text: 'RPC failed: ' + String((e && e.message) || e) });
				}
			};
			React.useEffect(() => { refresh(); }, []);

			const act = async (op, payload, key) => {
				setBusy((b) => Object.assign({}, b, { [key]: true }));
				try {
					const res = await api(op, payload);
					if (!res || !res.ok) setNotice({ kind: 'error', text: (res && res.error) || 'operation failed' });
					else setNotice({ kind: 'info', text: op + ' ok' });
					await refresh();
				} catch (e) {
					setNotice({ kind: 'error', text: String((e && e.message) || e) });
				} finally {
					setBusy((b) => { const n = Object.assign({}, b); delete n[key]; return n; });
				}
			};

			const toggleTools = async (server) => {
				const open = !expanded[server.name];
				setExpanded((e) => Object.assign({}, e, { [server.name]: open }));
				if (open && !toolsCache[server.name]) {
					const key = 'tools:' + server.name;
					setBusy((b) => Object.assign({}, b, { [key]: true }));
					try {
						const res = await api('tools', { name: server.name });
						if (res && res.ok) setToolsCache((c) => Object.assign({}, c, { [server.name]: res.tools || [] }));
						else setNotice({ kind: 'error', text: (res && res.error) || 'tools failed' });
					} catch (e) {
						setNotice({ kind: 'error', text: String((e && e.message) || e) });
					} finally {
						setBusy((b) => { const n = Object.assign({}, b); delete n[key]; return n; });
					}
				}
			};

			const runCall = async (serverName, toolName) => {
				const key = serverName + '|' + toolName;
				setBusy((b) => Object.assign({}, b, { [key]: true }));
				try {
					let parsed = {};
					const raw = (argsText[key] || '').trim();
					if (raw) parsed = JSON.parse(raw);
					const res = await api('call', { name: serverName, tool: toolName, arguments: parsed });
					if (!res || !res.ok) setResults((r) => Object.assign({}, r, { [key]: '错误: ' + ((res && res.error) || 'call failed') }));
					else setResults((r) => Object.assign({}, r, { [key]: JSON.stringify({ isError: res.isError, content: res.content, structuredContent: res.structuredContent }, null, 2) }));
				} catch (e) {
					setResults((r) => Object.assign({}, r, { [key]: '错误: ' + String((e && e.message) || e) }));
				} finally {
					setBusy((b) => { const n = Object.assign({}, b); delete n[key]; return n; });
				}
			};

			const openNew = () => setEditing({ originalName: '', name: '', transport: 'http', command: '', argsText: '', envText: '', cwd: '', url: '', headersText: '', toolCallTimeoutMs: '' });
			const openEdit = (server) => {
				const envText = Object.keys(server.env || {}).map((k) => k + '=' + server.env[k]).join('\n');
				const headersText = Object.keys(server.headers || {}).map((k) => k + '=' + server.headers[k]).join('\n');
				setEditing({
					originalName: server.name,
					name: server.name,
					transport: server.transport || 'stdio',
					command: server.command || '',
					argsText: (server.args || []).join('\n'),
					envText,
					cwd: server.cwd || '',
					url: server.url || '',
					headersText,
					toolCallTimeoutMs: String(server.toolCallTimeoutMs || 60000),
				});
			};
			const parseLines = (text) => (text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
			const parseMap = (text) => {
				const out = {};
				for (const line of parseLines(text)) {
					const idx = line.indexOf('=');
					if (idx <= 0) continue;
					const k = line.slice(0, idx).trim();
					if (k) out[k] = line.slice(idx + 1).trim();
				}
				return out;
			};
			const saveForm = async () => {
				if (!editing) return;
				const payload = {
					name: editing.name,
					transport: editing.transport,
					command: editing.command,
					args: parseLines(editing.argsText),
					env: parseMap(editing.envText),
					cwd: editing.cwd,
					url: editing.url,
					headers: parseMap(editing.headersText),
					toolCallTimeoutMs: Number(editing.toolCallTimeoutMs) || 60000,
				};
				const isNew = !editing.originalName;
				if (!isNew && editing.name !== editing.originalName) payload.originalName = editing.originalName;
				await act(isNew ? 'add' : 'update', payload, 'save');
				setEditing(null);
			};
			const setForm = (patch) => setEditing((e) => (e ? Object.assign({}, e, patch) : e));

			const stateLabel = { connected: '已连接', connecting: '连接中', disconnected: '未连接', error: '错误' };
			const isHttp = editing && editing.transport === 'http';

			return h('div', { className: 'mcp-page' },
				h('div', { className: 'mcp-toolbar' },
					h('p', { className: 'mcp-title' }, 'MCP 服务器'),
					h('span', { className: 'mcp-sub' }, '（stdio / HTTP · 连接后工具自动注册为 mcp__服务器__工具）'),
					h('button', { className: 'mcp-btn', 'data-primary': true, disabled: !!busy.save, onClick: openNew }, '+ 新增服务器'),
				),
				notice ? h('div', { className: 'mcp-notice', 'data-kind': notice.kind }, notice.text) : null,
				servers === null ? h('div', { className: 'mcp-empty' }, '加载中…') :
					servers.length === 0 ? h('div', { className: 'mcp-empty' }, '还没有 MCP 服务器。点击“+ 新增服务器”添加，例如 Godot AI 的 http://127.0.0.1:8000/mcp。') :
						servers.map((server) => h(ServerCard, {
							key: server.name,
							server,
							busy: busy[server.name],
							expanded: !!expanded[server.name],
							tools: toolsCache[server.name],
							argsText,
							results,
							confirmRemove: confirmRemove === server.name,
							onConnect: () => act('connect', { name: server.name }, server.name),
							onDisconnect: () => act('disconnect', { name: server.name }, server.name),
							onRemove: () => setConfirmRemove(server.name),
							onConfirmRemove: () => { act('remove', { name: server.name }, server.name); setConfirmRemove(null); },
							onCancelRemove: () => setConfirmRemove(null),
							onEdit: () => openEdit(server),
							onToggleTools: () => toggleTools(server),
							onArgs: (tool, value) => setArgsText((m) => Object.assign({}, m, { [server.name + '|' + tool]: value })),
							onCall: (tool) => runCall(server.name, tool),
							stateLabel,
						})),
				editing ? h('form', { className: 'mcp-form', onSubmit: (ev) => { ev.preventDefault(); saveForm(); } },
					h('p', { className: 'mcp-title' }, editing.originalName ? '编辑服务器 ' + editing.originalName : '新增服务器'),
					h('label', { className: 'mcp-field' }, '名称（[A-Za-z0-9_-]，最长 32）',
						h('input', { className: 'mcp-input', value: editing.name, onChange: (ev) => setForm({ name: ev.target.value }) })),
					h('label', { className: 'mcp-field' }, '传输方式',
						h('select', { className: 'mcp-input', value: editing.transport, onChange: (ev) => setForm({ transport: ev.target.value }) },
							h('option', { value: 'http' }, 'HTTP (streamable)'),
							h('option', { value: 'stdio' }, 'stdio（子进程）'),
						)),
					isHttp ? [
						h('label', { className: 'mcp-field', key: 'url' }, 'MCP 端点 URL',
							h('input', { className: 'mcp-input', placeholder: 'http://127.0.0.1:8000/mcp', value: editing.url, onChange: (ev) => setForm({ url: ev.target.value }) })),
						h('label', { className: 'mcp-field', key: 'headers' }, '请求头（每行 KEY=VALUE）',
							h('textarea', { className: 'mcp-input mcp-textarea', value: editing.headersText, onChange: (ev) => setForm({ headersText: ev.target.value }) })),
					] : [
						h('label', { className: 'mcp-field', key: 'command' }, '命令（可执行文件路径或 PATH 中的命令，如 node）',
							h('input', { className: 'mcp-input', value: editing.command, onChange: (ev) => setForm({ command: ev.target.value }) })),
						h('label', { className: 'mcp-field', key: 'args' }, '参数（每行一个）',
							h('textarea', { className: 'mcp-input mcp-textarea', value: editing.argsText, onChange: (ev) => setForm({ argsText: ev.target.value }) })),
						h('label', { className: 'mcp-field', key: 'env' }, '环境变量（每行 KEY=VALUE）',
							h('textarea', { className: 'mcp-input mcp-textarea', value: editing.envText, onChange: (ev) => setForm({ envText: ev.target.value }) })),
						h('label', { className: 'mcp-field', key: 'cwd' }, '工作目录（留空 = 工作区）',
							h('input', { className: 'mcp-input', value: editing.cwd, onChange: (ev) => setForm({ cwd: ev.target.value }) })),
					],
					h('label', { className: 'mcp-field' }, '工具调用超时（毫秒）',
						h('input', { className: 'mcp-input', value: editing.toolCallTimeoutMs, onChange: (ev) => setForm({ toolCallTimeoutMs: ev.target.value }) })),
					h('div', { className: 'mcp-toolbar' },
						h('button', { className: 'mcp-btn', 'data-primary': true, type: 'submit', disabled: !!busy.save }, '保存'),
						h('button', { className: 'mcp-btn', type: 'button', onClick: () => setEditing(null) }, '取消'),
					),
				) : null,
			);
		}

		function ServerCard(props) {
			const { server, busy, expanded, tools, argsText, results, stateLabel, confirmRemove } = props;
			const toolBusyKey = (tool) => server.name + '|' + tool;
			const meta = server.transport === 'http'
				? server.url
				: server.command + (server.args && server.args.length ? ' ' + server.args.map((a) => (a.indexOf(' ') >= 0 ? '"' + a + '"' : a)).join(' ') : '');
			return h('div', { className: 'mcp-card' },
				h('div', { className: 'mcp-row' },
					h('span', { className: 'mcp-dot', 'data-state': server.state }),
					h('span', { className: 'mcp-name' }, server.name),
					h('span', { className: 'mcp-badge' }, server.transport),
					h('span', { className: 'mcp-badge' }, stateLabel[server.state] || server.state),
					server.state === 'connected'
						? h('button', { className: 'mcp-btn', disabled: !!busy, onClick: props.onDisconnect }, '断开')
						: h('button', { className: 'mcp-btn', 'data-primary': true, disabled: !!busy, onClick: props.onConnect }, '连接'),
					h('button', { className: 'mcp-btn', onClick: props.onToggleTools }, expanded ? '收起工具' : '工具 (' + server.tools.length + ')'),
					h('button', { className: 'mcp-btn', onClick: props.onEdit }, '编辑'),
					confirmRemove
						? h('span', { className: 'mcp-row' },
							h('button', { className: 'mcp-btn', 'data-danger': true, disabled: !!busy, onClick: props.onConfirmRemove }, '确认删除'),
							h('button', { className: 'mcp-btn', onClick: props.onCancelRemove }, '取消'))
						: h('button', { className: 'mcp-btn', 'data-danger': true, onClick: props.onRemove }, '删除'),
				),
				h('div', { className: 'mcp-meta' }, meta),
				server.error ? h('div', { className: 'mcp-err' }, server.error) : null,
				expanded ? h('div', { className: 'mcp-tools' },
					tools === undefined ? h('div', { className: 'mcp-empty' }, '加载工具中…') :
						tools.length === 0 ? h('div', { className: 'mcp-empty' }, '未发现工具') :
							tools.map((tool) => h('div', { className: 'mcp-tool', key: tool.name },
								h('div', { className: 'mcp-row' },
									h('span', { className: 'mcp-tool-name' }, tool.name),
									h('button', { className: 'mcp-btn', 'data-primary': true, disabled: !!busy[toolBusyKey(tool)], onClick: () => props.onCall(tool.name) }, '调用测试'),
								),
								tool.description ? h('div', { className: 'mcp-tool-desc' }, tool.description) : null,
								h('textarea', { className: 'mcp-input mcp-textarea', placeholder: '参数 JSON，如 {}', value: argsText[toolBusyKey(tool)] || '', onChange: (ev) => props.onArgs(tool.name, ev.target.value) }),
								results[toolBusyKey(tool)] ? h('pre', { className: 'mcp-pre' }, results[toolBusyKey(tool)]) : null,
							)),
				) : null,
			);
		}

		// ── apply ──────────────────────────────────────────────────────────────
		function apply(ctx) {
			if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="@dsh-user/dsh-mcp-manager"]') === null) {
				const tag = document.createElement('style');
				tag.dataset.plugin = '@dsh-user/dsh-mcp-manager';
				tag.dataset.pluginCss = '@dsh-user/dsh-mcp-manager';
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
			const slots = ctx.get('slots');
			if (slots === undefined) return;

			// official vs custom plugin inventory tabs
			const remotePI = ctx.get('remote.pluginInventory');
			if (remotePI !== undefined) {
				const isOfficial = (e) => e.moduleName.startsWith('@deepseek-ai/') || e.moduleName.startsWith('cordis:');
				const makeList = (predicate) => async () => {
					const r = await remotePI.list();
					if (!r.ok) throw new Error('pluginInventory.list failed: ' + r.error.code + ': ' + r.error.message);
					return { entries: r.value.entries.filter(predicate) };
				};
				slots.inject('settings.plugins.tab', () => slots.register(
					{ name: 'settings.plugins.tab', id: 'official', order: 10, label: () => '官方插件', inject: () => ({ list: makeList(isOfficial) }) },
					(props) => h(CatalogPage, props),
				));
				slots.inject('settings.plugins.tab', () => slots.register(
					{ name: 'settings.plugins.tab', id: 'custom', order: 11, label: () => '自定义插件', inject: () => ({ list: makeList((e) => !isOfficial(e)) }) },
					(props) => h(CatalogPage, props),
				));
			}

			// MCP manager settings section
			slots.inject('settings.section', () => slots.register(
				{ name: 'settings.section', id: 'mcp-manager', order: 25, label: () => 'MCP 管理' },
				(props) => h(McpManagerPage, props),
			));
		}

		exports.apply = apply;
		exports.inject = ['slots', 'locale', 'remote.pluginInventory'];
		return module.exports;
	}
});
