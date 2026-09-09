const root = document.getElementById('ctc-direction');
const main = document.getElementById('main');
const notice = document.getElementById('notice');
const connection = document.getElementById('connection');
const modal = document.getElementById('modal');
const modalContent = document.getElementById('modal-content');
const state = { projects: [], project: null, task: null, subtask: null, draft: null, route: [], tab: 'overview', generation: 0, reading: false, pending: false, online: false, turns: [], hasMore: false, after: 0, attachments: new Map(), imageCache: new Map(), scope: null, review: null, modalAction: null, drafts: new Map(), requestIds: new Map() };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = value => typeof value === 'number' ? value.toLocaleString('zh-CN') : '未知';
const timestamp = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未开始';
const label = value => ({ IN_PROGRESS: '进行中', DONE: '工程已完成', TODO: '待开始', QA_DEBUG: '检查与修复', DROPPED: '已取消', ARCHIVED: '已归档', NOT_STARTED: '未实施', IMPLEMENTED: '已实施', HARDENED: '已加固', ACCEPTED: '已验收', CLOSED: '已收尾 · 产品未验收', READY: '可以开始规划', RUNNING: '执行中', APPROVED: '已批准', PAUSED: '已暂停', HUMAN_REQUIRED: '需要处理', AWAITING_ACCEPTANCE: '等待产品验收', AWAITING_REVIEW: '计划审核中', AWAITING_REVISION: '修改计划中', EXECUTE: '实施', HARDEN: '加固', FRESH_QA: '独立 QA', REPAIR: '修复', FOCUSED_RE_QA: '复验', VERIFY: '验证', COMPLETE: '完成', PLANNING: '规划', REVIEW: '审核', MATERIALIZE: '未实施', DISPATCH: '准备执行', LOW: '轻量', STANDARD: '标准', HIGH_RISK_FOUNDATION: '深入', FAILED: '失败', SUCCEEDED: '成功', INTERRUPTED: '已中断' }[value] ?? value ?? '尚无记录');
const errors = { SESSION_AUTH_FAILED: '本机会话已过期。请重新使用 Console 启动器打开界面。', OPERATION_CONFLICT: '任务状态已改变，或当前步骤尚未停止。请刷新后根据最新记录继续。', INVALID_REQUEST: '填写内容不符合要求，请检查必填项和长度。', SUBTASK_NOT_FOUND: '这条记录不存在，或所属项目已经改变。', PRODUCT_DIRECTION_REQUIRED: '先确认目标、范围和成功标准，再开始规划。', REQUEST_TOO_LARGE: '这次提交内容过长，请缩短文字后提交。', RESPONSE_TOO_LARGE: '这部分记录过大，暂时无法显示；其他记录和执行状态仍保留。', LOCAL_OPERATION_FAILED: '本机操作未完成。执行记录保留，请查看当前状态；不会自动重复提交。', CONCURRENCY_LIMIT: '本机服务正在处理其他工作，请稍后刷新。', DAEMON_SHUTTING_DOWN: '本机服务正在停止，已保存的任务不会丢失。' };
const reasons = { USER_PAUSED: '你暂停了任务', DAEMON_STOPPING: '本机服务正在停止', CHECKPOINT_RECOVERED: '已恢复保存的进度，可以继续', INTERRUPTED: '上次运行中断，需要核对保存的结果', TIME_LIMIT_REACHED: '已到约定截止时间', TOKEN_LIMIT_REACHED: '已到约定用量上限', ROLE_LIMIT_REACHED: '已到约定执行次数', USAGE_UNKNOWN: '有一轮最终用量未返回，需要处理', GOVERNED_BLOCKED: '当前任务有尚未解决的依赖或检查问题', LOCAL_OPERATION_FAILED: '本机执行步骤失败', PRODUCT_QUESTION: '规划需要你补充产品决定', REVIEW_ESCALATED: '审核发现需要你决定的问题', PLAN_REVIEW_EXHAUSTED: '计划修改已用完约定次数', PROVIDER_FAILED: '模型没有成功完成本轮', INVALID_OUTPUT: '模型没有返回完整可用的结果', BUDGET_BLOCKED: '规划已到约定用量', CONTEXT_CHANGED: '规划期间目标或仓库发生变化', CONTEXT_LIMIT: '当前输入过长' };
const pill = (text, tone = '') => `<span class="ctc-pill ${tone}">${escape(text)}</span>`;
const button = (text, action, primary = false, extra = '') => `<button type="button" class="ctc-button${primary ? ' ctc-primary' : ''}" data-action="${action}" ${extra}>${text}</button>`;
const link = (text, path, className = 'ctc-button') => `<a class="${className}" href="#/${path}">${escape(text)}</a>`;
const heading = (title, description, actions = '') => `<div class="ctc-heading"><div><h1>${escape(title)}</h1><p>${escape(description)}</p></div><div class="ctc-actions">${actions}</div></div>`;
const fact = (title, body) => `<div class="ctc-fact"><span class="ctc-label">${escape(title)}</span><span>${escape(body)}</span></div>`;
const facts = pairs => `<div class="ctc-facts">${pairs.map(pair => fact(...pair)).join('')}</div>`;
const empty = (title, body, actions = '') => `<section class="ctc-surface ctc-empty"><h2>${escape(title)}</h2><p>${escape(body)}</p><div class="ctc-actions">${actions}</div></section>`;
const field = (name, title, value = '', options = {}) => `<label class="ctc-field">${escape(title)}${options.multiline ? `<textarea name="${name}" ${options.required === false ? '' : 'required'} maxlength="${options.max ?? 8000}" rows="${options.rows ?? 3}">${escape(value)}</textarea>` : `<input name="${name}" value="${escape(value)}" type="${options.type ?? 'text'}" ${options.required === false ? '' : 'required'} ${options.min !== undefined ? `min="${options.min}"` : ''} ${options.max !== undefined ? `max="${options.max}" maxlength="${options.max}"` : ''}>`}</label>`;
const lines = value => String(value ?? '').split(/\r?\n/u).map(item => item.trim()).filter(Boolean);
const reviewSelect = (name = 'reviewIntensity', selected = 'STANDARD') => `<label class="ctc-field">审核深度<select name="${name}">${[['LIGHT', '实施 + 基本测试'], ['STANDARD', '独立 QA · 第 2 次失败反馈'], ['THOROUGH', '加固 + QA · 第 3 次失败反馈']].map(([value, text]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${text}</option>`).join('')}</select></label>`;
const requestId = key => { if (!state.requestIds.has(key)) state.requestIds.set(key, crypto.randomUUID()); return state.requestIds.get(key); };
const scopeKey = scope => scope ? `${scope.kind}:${scope.id}` : '';
function notify(message, error = false) { notice.textContent = message; notice.classList.toggle('ctc-error', error); }
async function transport(path, body) {
  const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), path === "/ui/folder" ? 125_000 : 30_000);
  try {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-ctc-request': '1' }, body: JSON.stringify(body), signal: controller.signal });
    const value = await response.json();
    if (!response.ok) { const code = value?.error?.code; const error = new Error(errors[code] ?? '本机请求未完成。请刷新查看已保存的状态。'); error.code = code; throw error; }
    state.online = true; connection.textContent = `本机已连接 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    return value;
  } catch (error) {
    if (error.code) throw error;
    state.online = false; connection.textContent = '连接中断 · 保留最后已知状态';
    throw new Error('等待结束或连接中断，不代表后台任务失败。请刷新确认状态；本次请求不会自动重新提交。');
  } finally { clearTimeout(deadline); }
}
const api = async (action, input = {}) => { const generation = state.generation; const result = await transport(action.startsWith('asset-') ? '/ui/attachment' : action === 'folder-choose' ? '/ui/folder' : '/ui/api', { action, input }); if (generation !== state.generation) { const error = new Error('页面已切换'); error.code = 'STALE_VIEW'; throw error; } return result; };
const routeTo = path => { location.hash = `/${path}`; };
function treeMemory() { try { return JSON.parse(localStorage.getItem('ctc-tree') ?? '{}'); } catch { return {}; } }
function nav() {
  const memory = treeMemory();
  const [type, id] = state.route;
  const pathChanged = state.route.length > 0 && (state.treeRoute ?? localStorage.getItem('ctc-tree-route')) !== `${type}:${id}`;
  if (state.route.length) { state.treeRoute = `${type}:${id}`; localStorage.setItem('ctc-tree-route', state.treeRoute); }
  const isOpen = (node, closed, selected) => {
    const previous = memory[node];
    if (!previous || previous.closed !== closed) memory[node] = { open: !closed, closed };
    if (pathChanged && selected) memory[node].open = true;
    return memory[node].open;
  };
  const row = (node, title, route, open, expandable, tag) => `<div class="ctc-tree-row">${expandable ? `<button class="ctc-tree-toggle" data-tree="${escape(node)}" aria-label="${open ? '折叠' : '展开'} ${escape(title)}" aria-expanded="${open}">${open ? '⌄' : '›'}</button>` : '<span class="ctc-tree-dot">·</span>'}${link(title, route, 'ctc-nav')}<span class="ctc-tree-tag">${tag}</span></div>`;
  const projectTree = project => {
    const tasks = project.tasks ?? [];
    const belongs = type === 'project' && id === project.id || tasks.some(task => task.id === id || task.subtasks.some(sub => sub.id === id)) || project.drafts?.some(draft => draft.id === id);
    const opened = isOpen(`p:${project.id}`, project.settings?.projectClosed ?? false, belongs);
    const renderTask = task => {
      const active = id === task.id || task.subtasks.some(sub => sub.id === id);
      const expanded = isOpen(`t:${task.id}`, task.status === 'DONE' || task.closed, active);
      const name = task.presentation?.title ?? task.title;
      const children = task.subtasks.map((sub, index) => row(`s:${sub.id}`, `${index + 1}. ${sub.title}`, `subtask/${encodeURIComponent(sub.id)}`, false, false, sub.lifecycle === 'ENDED' ? '结束' : sub.lifecycle === 'PAUSED' ? '暂停' : sub.status === 'DONE' ? '✓' : sub.stage ? '●' : '计划中')).join('');
      return row(`t:${task.id}`, name, `task/${encodeURIComponent(task.id)}`, expanded, Boolean(children), task.lifecycle === 'ENDED' ? '结束' : task.lifecycle === 'PAUSED' ? '暂停' : task.status === 'DONE' ? '✓' : task.taskKind === 'SMALL_TASK' ? '小任务' : '任务') + (expanded && children ? `<div class="ctc-tree-children">${children}</div>` : '');
    };
    const current = tasks.filter(task => !task.presentation?.historyOf);
    const history = tasks.filter(task => task.presentation?.historyOf);
    const historyOpen = isOpen(`h:${project.id}`, true, history.some(task => task.id === id));
    return `<section class="ctc-tree-project">${row(`p:${project.id}`, project.name, `project/${encodeURIComponent(project.id)}`, opened, true, project.settings?.projectClosed ? '结束' : '项目')}${opened ? `<div class="ctc-tree-children">${current.map(renderTask).join('')}${(project.drafts ?? []).filter(draft => !draft.confirmedBigTaskId).map(draft => { const open = isOpen(`d:${draft.id}`, false, id === draft.id); return row(`d:${draft.id}`, draft.title, `draft/${encodeURIComponent(draft.id)}`, open, Boolean(draft.children?.length), '准备中') + (open && draft.children?.length ? `<div class="ctc-tree-children">${draft.children.map(child => row(`d:${child.id}`, child.title, `draft/${encodeURIComponent(child.id)}`, false, false, '小任务')).join('')}</div>` : ''); }).join('')}${project.directoryTruncated ? link('更多任务 →', `project/${encodeURIComponent(project.id)}`, 'ctc-nav') : ''}${history.length ? row(`h:${project.id}`, `早期尝试 · ${history.length}`, `project/${encodeURIComponent(project.id)}/history`, historyOpen, true, '') + (historyOpen ? `<div class="ctc-tree-children">${history.map(renderTask).join('')}</div>` : '') : ''}</div>` : ''}</section>`;
  };
  const active = state.projects.filter(project => !project.settings?.projectClosed);
  const finished = state.projects.filter(project => project.settings?.projectClosed);
  document.getElementById('project-nav').innerHTML = `<div class="ctc-navlabel">项目与任务</div>${active.map(projectTree).join('')}${finished.length ? '<div class="ctc-navlabel ctc-spaced">已结束的项目</div>' + finished.map(projectTree).join('') : ''}${link('＋ 添加项目', 'new-project', 'ctc-nav')}`;
  localStorage.setItem('ctc-tree', JSON.stringify(memory));
  root.querySelectorAll('.ctc-nav').forEach(item => { const selected = item.hash === location.hash || item.hash === `#/${type}/${encodeURIComponent(id ?? '')}`; if (selected) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
}
function lifecycleHtml(settings, execution = null) {
  if (!settings) return '';
  const lifecycle = settings.lifecycle ?? (settings.projectClosed || ['CLOSED','ACCEPTED'].includes(execution?.phase) ? 'ENDED' : 'ACTIVE');
  return `<div class="ctc-controlbar"><span>${pill(lifecycle === 'ENDED' ? '已结束' : lifecycle === 'PAUSED' ? '已暂停' : execution?.phase === 'RUNNING' ? '正在执行' : '已打开', lifecycle === 'ACTIVE' ? 'ctc-good' : '')}${execution?.activeRoleCount && lifecycle !== 'ACTIVE' ? ' 当前步骤完成后暂停，不再启动下一步…' : ''}</span><div class="ctc-actions">${lifecycle === 'ACTIVE' ? button('暂停', 'scope-pause') + button('结束…', 'scope-end') : button(lifecycle === 'ENDED' ? '重新打开' : '继续', 'scope-resume', true, execution?.activeRoleCount ? 'disabled' : '')}</div></div>`;
}
function preferencesFields(value = {}) {
  return `<div class="ctc-formgrid"><label class="ctc-field">计划检查<select name="planReview"><option value="SELF" ${value.planReview !== 'INDEPENDENT' ? 'selected' : ''}>规划者自检</option><option value="INDEPENDENT" ${value.planReview === 'INDEPENDENT' ? 'selected' : ''}>增加独立计划审核</option></select></label><label class="ctc-field">用量控制<select name="budgetMode"><option value="MEASURE" ${value.budgetMode !== 'HARD' ? 'selected' : ''}>只统计和提醒</option><option value="HARD" ${value.budgetMode === 'HARD' ? 'selected' : ''}>达到预算后暂停</option></select></label>${field('durationMinutes', '运行时长（分钟）', value.durationMinutes ?? 180, { type: 'number', min: 1, max: 1440 })}${field('executionTokenLimit', '执行用量参考／预算', value.executionTokenLimit ?? 2000000, { type: 'number', min: 1000, max: 100000000 })}${field('planningTokenLimit', '规划用量参考／预算', value.planningTokenLimit ?? 120000, { type: 'number', min: 1000, max: 10000000 })}</div>`;
}
function preferencesValue(data) { return { planReview: data.planReview || 'SELF', budgetMode: data.budgetMode || 'MEASURE', durationMinutes: Number(data.durationMinutes || 180), executionTokenLimit: Number(data.executionTokenLimit || 2000000), planningTokenLimit: Number(data.planningTokenLimit || 120000) }; }
function scopeSettingsHtml(settings, frozen = false) {
  if (!settings) return '';
  const scope = settings.scope;
  return `<form data-form="scope-settings" class="ctc-policy" data-scope="${escape(scope.kind)}" data-id="${escape(scope.id)}" data-revision="${settings.revision}"><div><strong>${frozen ? '后续规划的检查深度' : '检查深度'}</strong><p class="ctc-small">${settings.reviewLevel ? '当前范围单独设置' : `继承${settings.inheritedFrom?.kind === 'BIG_TASK' ? '大任务' : settings.inheritedFrom?.kind === 'PROJECT' ? '项目' : '默认'}：${levelName(settings.effectiveReviewLevel)}`}${frozen ? ' · 本次已审计划保留原约定' : ''}</p></div><select name="reviewLevel" aria-label="检查深度"><option value="" ${settings.reviewLevel === null ? 'selected' : ''}>使用上级设置</option>${['LIGHT','STANDARD','THOROUGH'].map(level => `<option value="${level}" ${settings.reviewLevel === level ? 'selected' : ''}>${levelName(level)}</option>`).join('')}</select><button type="submit" class="ctc-button">保存</button><details class="ctc-scope-preferences"><summary>计划检查与用量偏好（下次计划生效）</summary>${preferencesFields(settings.effectivePreferences)}</details></form>`;
}
function levelName(level) { return { LIGHT: '实施与基本测试', STANDARD: '独立 QA · 第 2 次失败反馈', THOROUGH: '加固与 QA · 第 3 次失败反馈' }[level] ?? level; }
function historyHtml(tasks) { return tasks.length ? `<section class="ctc-surface"><h2>早期尝试与保留记录</h2><p class="ctc-label">按原推进顺序保留。失败记录仍可查看，不代表当前成果的状态。</p><div class="ctc-stack ctc-spaced">${taskCards(tasks)}</div></section>` : empty('没有归入历史的尝试', '任务会按推进顺序显示。'); }
function taskRows(tasks) {
  return tasks.map((task, index) => `<section class="ctc-surface ctc-spaced"><div class="ctc-subtitle"><div><span class="ctc-label">${task.taskKind === 'SMALL_TASK' ? '直接小任务' : '大任务'} ${index + 1} · ${escape(projectName(task.projectId))}</span><h2>${link(task.presentation?.title ?? task.title, `task/${encodeURIComponent(task.id)}`, 'ctc-titlelink')}</h2></div>${pill(task.lifecycle === 'ENDED' ? '已结束' : task.lifecycle === 'PAUSED' ? '已暂停' : label(task.status), task.status === 'DONE' ? 'ctc-good' : '')}</div><p class="ctc-label">${escape(task.goal)}</p>${task.subtasks?.length ? orderedSubtasks(task.subtasks) : `<p class="ctc-small ctc-spaced">${escape(task.planning?.stopReason ? reasons[task.planning.stopReason] : '方向与计划待准备')}</p>`}</section>`).join('');
}
function orderedSubtasks(tasks) { return `<div class="ctc-ordered">${tasks.map((task, index) => `<a class="ctc-ordered-row" href="#/${`subtask/${encodeURIComponent(task.id)}`}"><span class="ctc-stepnum">${task.status === 'DONE' ? '✓' : index + 1}</span><div><strong>${escape(task.title)}</strong><p class="ctc-small">${escape(task.stage ? label(task.stage) : label(task.status))} · ${task.stage === 'FRESH_QA' || task.stage === 'FOCUSED_RE_QA' ? '独立审核代理' : task.stage === 'HARDEN' ? '加固代理' : task.status === 'DONE' ? '工程记录已保存' : '执行代理'}</p></div>${pill(label(task.maturity))}</a>`).join('')}</div>`; }
function progressGraph(tasks) {
  if (!tasks.length) return empty('先交一项任务', '确认方向后，这里显示实际的依赖关系与当前阶段。');
  return `<section class="ctc-surface"><h2>项目推进图</h2><p class="ctc-label">从左向右推进，连线表示先后依赖；同列节点可以并行安排。当前执行器一次推进一项，准备好不等于正在运行。</p><div class="ctc-flow-legend">${pill('○ 等待')}${pill('● 当前阶段', 'ctc-wait')}${pill('✓ 工程完成', 'ctc-good')}<span class="ctc-small">产品决定：你 · 规划／实施／审核：对应代理</span></div></section>` + tasks.map(task => {
    const nodes = task.subtasks ?? []; const edges = task.dependencies ?? [];
    if (!nodes.length) return `<section class="ctc-surface ctc-spaced"><h3>${link(task.presentation?.title ?? task.title, `task/${encodeURIComponent(task.id)}`, 'ctc-titlelink')}</h3><p>${escape(task.planning?.stopReason ? reasons[task.planning.stopReason] : '等待方向确认与具体计划')} · 当前负责：${task.planning?.phase === 'RUNNING' ? '规划 / 审核代理' : '你'}</p></section>`;
    const levels = new Map(nodes.map(node => [node.id, 0]));
    for (let pass = 0; pass < nodes.length; pass++) { let changed = false; for (const edge of edges.filter(edge => edge.dependencyType === 'BLOCKING')) { if (!levels.has(edge.upstreamSubtaskId) || !levels.has(edge.downstreamSubtaskId)) continue; const next = Math.min(nodes.length - 1, levels.get(edge.upstreamSubtaskId) + 1); if (next > levels.get(edge.downstreamSubtaskId)) { levels.set(edge.downstreamSubtaskId, next); changed = true; } } if (!changed) break; }
    const counts = new Map(); const positions = new Map(nodes.map(node => { const col = levels.get(node.id); const row = counts.get(col) ?? 0; counts.set(col, row + 1); return [node.id, { x: col * 280 + 12, y: row * 196 + 12 }]; }));
    const width = (Math.max(...levels.values()) + 1) * 280; const height = Math.max(...counts.values()) * 196;
    const paths = edges.map(edge => { const a = positions.get(edge.upstreamSubtaskId), b = positions.get(edge.downstreamSubtaskId); if (!a || !b) return ''; return `<path d="M${a.x + 236} ${a.y + 77} C${a.x + 260} ${a.y + 77},${b.x - 24} ${b.y + 77},${b.x} ${b.y + 77}" class="${edge.dependencyType === 'INFORMATIONAL' ? 'ctc-edge-info' : ''}" marker-end="url(#arrow-${escape(task.id)})"/>`; }).join('');
    return `<section class="ctc-surface ctc-spaced"><div class="ctc-subtitle"><h2>${link(task.presentation?.title ?? task.title, `task/${encodeURIComponent(task.id)}`, 'ctc-titlelink')}</h2>${pill(`${nodes.filter(node => node.status === 'DONE').length} / ${nodes.length} 已完成`)}</div><div class="ctc-graph-scroll" tabindex="0" aria-label="${escape(task.title)} 依赖图"><div class="ctc-graph" data-width="${width}" data-height="${height}"><svg viewBox="0 0 ${width} ${height}" aria-hidden="true"><defs><marker id="arrow-${escape(task.id)}" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6"/></marker></defs>${paths}</svg>${nodes.map((node, index) => { const position = positions.get(node.id); const dependencies = edges.filter(edge => edge.downstreamSubtaskId === node.id && edge.dependencyType === 'BLOCKING'); const waiting = dependencies.filter(edge => nodes.find(other => other.id === edge.upstreamSubtaskId)?.status !== 'DONE'); const ready = node.status === 'TODO' && waiting.length === 0; return `<a class="ctc-graph-node ${node.status === 'DONE' ? 'ctc-node-done' : node.stage && node.status !== 'TODO' ? 'ctc-node-active' : ''}" data-x="${position.x}" data-y="${position.y}" href="#/${`subtask/${encodeURIComponent(node.id)}`}"><span class="ctc-small">小任务 ${index + 1} · ${escape(label(node.stage ?? node.status))}</span><strong>${escape(node.title)}</strong><span class="ctc-small">${node.status === 'DONE' ? '✓ 工程完成' : waiting.length ? `等待 ${waiting.length} 个前置任务` : ready ? '依赖已就绪 · 等待执行名额' : `当前负责：${['FRESH_QA','FOCUSED_RE_QA'].includes(node.stage) ? '独立审核代理' : node.stage === 'HARDEN' ? '加固代理' : '执行代理'}`}</span><span class="ctc-small">${dependencies.length ? `依赖：${dependencies.map(edge => nodes.findIndex(other => other.id === edge.upstreamSubtaskId) + 1).join('、')}` : '没有前置依赖'}${(counts.get(levels.get(node.id)) ?? 0) > 1 ? ' · 同列可并行' : ''}</span></a>`; }).join('')}</div></div></section>`;
  }).join('');
}
function mountGraphLayout() {
  for (const graph of main.querySelectorAll('.ctc-graph')) { graph.style.width = `${Number(graph.dataset.width)}px`; graph.style.height = `${Number(graph.dataset.height)}px`; }
  for (const node of main.querySelectorAll('.ctc-graph-node')) { node.style.left = `${Number(node.dataset.x)}px`; node.style.top = `${Number(node.dataset.y)}px`; }
}
function projectName(id) { return state.projects.find(project => project.id === id)?.name ?? '项目'; }
function taskCards(tasks) {
  return tasks.map(task => `<a class="ctc-taskcard" href="#/task/${encodeURIComponent(task.id)}"><strong>${escape(task.presentation?.title ?? task.title)}</strong><span class="ctc-label">${escape(task.goal)}</span><span>${pill(label(task.status))}</span></a>`).join('');
}
function draftCards(drafts) {
  return drafts.filter(draft => !draft.confirmedBigTaskId && !draft.parentDraftId).map(draft => `<a class="ctc-taskcard" href="#/draft/${encodeURIComponent(draft.id)}"><strong>${escape(draft.title)}</strong><span class="ctc-label">${escape(draft.goal)}</span><span>${pill(draft.kind === 'SMALL_TASK' ? '小任务 · 方向待确认' : '大任务 · 方向待确认', 'ctc-wait')}</span></a>`).join('');
}
async function loadWorkspace() { state.projects = (await api('workspace')).projects; nav(); }
async function home(kind) {
  const records = await Promise.all(state.projects.map(project => api('project', { projectId: project.id })));
  if (kind === 'home') return heading('你的工程工作台', '对齐方向，安排任务，交付成果。', link('＋ 新任务', 'new-task', 'ctc-button ctc-primary')) + (records.length ? `<div class="ctc-project-grid">${records.map(record => `<section class="ctc-surface"><div class="ctc-subtitle"><h2>${escape(record.project.name)}</h2>${link('打开 →', `project/${encodeURIComponent(record.project.id)}`, 'ctc-link')}</div>${facts([['待讨论', `${record.drafts.filter(draft => !draft.confirmedBigTaskId).length} 项`], ['进行中', `${record.bigTasks.filter(task => task.status === 'IN_PROGRESS' && task.lifecycle !== 'ENDED' && !task.presentation?.historyOf).length} 项任务`]])}<div class="ctc-actions ctc-spaced">${link('项目讨论', `project/${encodeURIComponent(record.project.id)}/discussion`)}${link('交新任务', `new-task/${encodeURIComponent(record.project.id)}`)}</div></section>`).join('')}</div>` : empty('从一个项目开始', '选择你的本地 Git 仓库，然后在项目里讨论或交任务。', link('添加项目', 'new-project', 'ctc-button ctc-primary')));
  const drafts = records.filter(record => !record.settings?.projectClosed).flatMap(record => record.drafts).filter(draft => !draft.confirmedBigTaskId && draft.settings?.lifecycle !== 'ENDED');
  const tasks = records.flatMap(record => record.bigTasks).filter(task => !task.presentation?.historyOf);
  const details = await Promise.all(tasks.map(task => api('task', { bigTaskId: task.id })));
  if (kind === 'results') {
    const finished = details.filter(detail => ['AWAITING_ACCEPTANCE', 'ACCEPTED', 'CLOSED'].includes(detail.execution?.phase));
    return heading('成果记录', '工程检查与产品验收分别保留。') + (finished.length ? `<div class="ctc-project-grid">${finished.map(detail => `<a class="ctc-taskcard" href="#/task/${encodeURIComponent(detail.task.id)}/results"><strong>${escape(detail.task.title)}</strong><span>${pill(label(detail.execution.phase), detail.execution.phase === 'ACCEPTED' ? 'ctc-good' : 'ctc-wait')}</span><span class="ctc-label">${escape(projectName(detail.task.projectId))}</span></a>`).join('')}</div>` : empty('还没有交付的成果', '执行完成后，成果和验收入口会出现在这里。'));
  }
  const decisions = details.filter(detail => detail.settings?.lifecycle !== 'ENDED' && !records.find(record => record.project.id === detail.task.projectId)?.settings?.projectClosed && (['HUMAN_REQUIRED', 'AWAITING_ACCEPTANCE'].includes(detail.execution?.phase) || (!detail.execution && ['APPROVED', 'HUMAN_REQUIRED'].includes(detail.planning?.phase))));
  return heading('需要你决定', '产品方向、实施计划和真正超出约定的事项。') + (drafts.length || decisions.length ? `<div class="ctc-project-grid">${draftCards(drafts)}${decisions.map(detail => `<a class="ctc-taskcard" href="#/task/${encodeURIComponent(detail.task.id)}/${detail.execution?.phase === 'AWAITING_ACCEPTANCE' ? 'results' : 'plan'}"><strong>${escape(detail.task.title)}</strong><span>${pill(detail.execution ? label(detail.execution.phase) : detail.planning.phase === 'APPROVED' ? '计划待批准' : '产品问题待回答', 'ctc-wait')}</span></a>`).join('')}</div>` : empty('当前没有待处理的决定', '已批准范围内的工作会按任务约定推进。'));
}
async function projectPage(id, tab) {
  const record = await api('project', { projectId: id }); state.project = record; const directory = state.projects.find(project => project.id === id); if (directory) { directory.tasks = record.bigTasks; directory.drafts = record.drafts; } state.scope = { kind: 'PROJECT', id };
  const head = `<div class="ctc-crumb">${pill('项目')} / ${escape(record.project.name)}</div>` + heading(record.project.name, '项目目标、任务推进和已确认的决定，都在同一个工作区。', link('＋ 新任务', `new-task/${encodeURIComponent(id)}`, 'ctc-button ctc-primary')) + lifecycleHtml(record.settings);
  state.scopeSettings = record.settings;
  const tabs = tabsHtml('project', id, tab, [['overview', '项目总览'], ['progress', '推进图'], ['discussion', '项目讨论'], ['context', '项目上下文'], ['history', '历史尝试']]);
  if (tab === 'discussion') return head + tabs + await discussionHtml();
  if (tab === 'context') return head + tabs + await contextHtml();
  if (tab === 'history') return head + tabs + historyHtml(record.bigTasks.filter(task => task.presentation?.historyOf));
  const tasks = record.bigTasks.filter(task => !task.presentation?.historyOf);
  if (tab === 'progress') return head + tabs + progressGraph(tasks);
  return head + tabs + scopeSettingsHtml(record.settings) + `<div class="ctc-summary"><span class="ctc-label">${escape(record.project.repository.kind === 'PATH' ? record.project.repository.path : record.project.repository.reference)}</span></div><div id="task-grid">${draftCards(record.drafts)}${taskRows(tasks)}</div>` + (!record.drafts.length && !tasks.length ? empty('还没有任务', '在项目讨论里直接说出目标，Console 可以创建任务草稿并建议拆分。', link('开始讨论', `project/${encodeURIComponent(id)}/discussion`, 'ctc-button ctc-primary')) : '');
}
function tabsHtml(type, id, tab, entries) {
  return `<nav class="ctc-tabs" aria-label="当前工作内容">${entries.map(([value, title]) => `<a class="ctc-tab" aria-current="${value === tab ? 'page' : 'false'}" href="#/${type}/${encodeURIComponent(id)}/${value}">${title}</a>`).join('')}</nav>`;
}
function briefForm(brief, draft) {
  const saved = state.drafts.get(`brief:${draft.id}`) ?? {};
  return `<section class="ctc-surface ctc-reading"><form data-form="direction"><h2>准备执行计划</h2><p class="ctc-small ctc-spaced">确认这里准确表达了你的要求。Console 会先调查项目、安排小任务；实施前再把完整计划交给你确认。</p>${field('title', '任务名称', saved.title ?? brief.title, { max: 200 })}${field('goal', '希望得到什么', saved.goal ?? brief.goal, { multiline: true, max: 1000 })}<details><summary>范围与完成标准</summary>${field('scopeIn', '这次包含（每行一项）', saved.scopeIn ?? brief.scopeIn?.join('\n'), { multiline: true })}${field('successCriteria', '怎样算做好', saved.successCriteria ?? brief.successCriteria?.join('\n'), { multiline: true })}${field('scopeOut', '留到以后', saved.scopeOut ?? brief.scopeOut?.join('\n'), { multiline: true, required: false })}</details>${reviewSelect('reviewIntensity', saved.reviewIntensity ?? state.scopeSettings?.effectiveReviewLevel ?? 'STANDARD')}<details><summary>计划检查、时长与用量偏好</summary>${preferencesFields({ ...state.scopeSettings?.effectivePreferences, ...saved })}</details><button class="ctc-button ctc-primary" type="submit">整理执行计划</button></form></section>`;
}
async function draftPage(id) {
  const draft = await api('draft', { draftId: id }); state.draft = draft; state.scope = { kind: 'DRAFT', id };
  state.scopeSettings = draft.settings;
  const head = `<div class="ctc-crumb">${draft.parentDraftId ? link('所属大任务', `draft/${encodeURIComponent(draft.parentDraftId)}`, 'ctc-link') + ' / ' : ''}${escape(projectName(draft.projectId))} / ${draft.kind === 'SMALL_TASK' ? '小任务' : '大任务'} / 方向讨论</div>` + heading(draft.title, draft.goal) + lifecycleHtml(draft.settings);
  if (draft.confirmedBigTaskId) return head + empty('方向已确认', '讨论原文继续保留；到任务页查看计划和后续执行。', link('打开任务', `task/${encodeURIComponent(draft.confirmedBigTaskId)}`, 'ctc-button ctc-primary')) + await discussionHtml();
  const discussion = await discussionHtml();
  if (draft.parentDraftId) return head + `<section class="ctc-surface ctc-spaced"><p>这项小任务正在准备中。可以补充要求和截图，随所属大任务一起安排实施。</p>${link('查看所属大任务', `draft/${encodeURIComponent(draft.parentDraftId)}`)}</section>` + discussion;
  const origin = state.origin ? `<div class="ctc-note">${link('查看任务来源讨论 →', `${{ PROJECT: 'project', BIG_TASK: 'task', SUBTASK: 'subtask', DRAFT: 'draft' }[state.origin.scope.kind]}/${encodeURIComponent(state.origin.scope.id)}${state.origin.scope.kind === 'DRAFT' ? '' : '/discussion'}`, 'ctc-link')}<span>原指令：${escape(state.origin.message)}</span></div>` : '';
  const proposal = state.latestProposal ?? draft.suggestedBrief;
  const suggested = draft.suggestedSubtasks?.length ? `<section class="ctc-surface ctc-spaced"><h3>建议拆分</h3><p class="ctc-small">每项都可以单独打开，提前讨论和补充材料。</p>${draft.suggestedSubtasks.map((task, index) => `<article class="ctc-contextitem"><strong>${draft.children?.[index] ? link(`${index + 1}. ${task.title}`, `draft/${encodeURIComponent(draft.children[index].id)}`, 'ctc-titlelink') : escape(task.title)}</strong><p>${escape(task.goal)}</p></article>`).join('')}</section>` : '';
  return head + origin + `<div class="ctc-note"><span>目标已整理。需要调整可以继续聊，准备好后生成执行计划。</span>${button('准备计划 ↓', 'scroll-direction')}</div>` + discussion + suggested + `<div class="ctc-sectiontitle" id="direction"><h2>产品方向</h2><span class="ctc-label">可直接修改后确认</span></div>` + briefForm(proposal ?? { title: draft.title, goal: draft.goal, scopeIn: [], scopeOut: [], successCriteria: [] }, draft);
}
async function discussionHtml() {
  const scope = state.scope;
  const result = await api('discussion', { scope }); state.turns = result.turns; state.latestProposal = result.latestProposal; state.after = result.previousAfter; state.hasMore = result.hasPrevious;
  const context = await api('context', { scope }); state.scopeSettings = context.settings; state.origin = context.origin;
  const related = (context.relatedScopes ?? []).filter(item => scopeKey(item) !== scopeKey(scope));
  return `<section class="ctc-surface ctc-chat"><div class="ctc-subtitle"><div><h2>${{ PROJECT: '项目聊天', BIG_TASK: '大任务聊天', SUBTASK: '小任务聊天', DRAFT: '任务准备' }[scope.kind]}</h2><p class="ctc-small">可讨论、创建任务、调整检查深度，或询问当前进度。</p></div>${button('上下文与偏好', 'chat-context')}</div><details id="chat-context"><summary>当前上下文与检查安排</summary><p>当前目标、计划和停止原因可供聊天读取；需要时会只读调查项目代码。历史对话自动整理，原文继续保留。</p>${scopeSettingsHtml(context.settings, false)}${related.map(item => link('查看来源讨论', `${item.kind === 'DRAFT' ? 'draft' : item.kind === 'SUBTASK' ? 'subtask' : item.kind === 'PROJECT' ? 'project' : 'task'}/${encodeURIComponent(item.id)}${item.kind === 'DRAFT' ? '' : '/discussion'}`)).join('')}${(context.notes ?? []).map(note => `<p class="ctc-spaced">${escape(note.title)}：${escape(note.body)}</p>`).join('')}${button('补充上下文', 'context-dialog')}</details><div id="messages">${messagesHtml(state.turns)}</div><div id="older-messages">${result.hasPrevious ? button('加载更早的对话', 'more-messages') : ''}</div><form class="ctc-composer" data-form="discussion"><textarea name="message" aria-label="讨论内容" maxlength="32000" placeholder="告诉我你想做什么，或直接粘贴截图…">${escape(state.drafts.get(scopeKey(scope)) ?? '')}</textarea><div id="attachment-tray">${attachmentTray()}</div><div class="ctc-composerfoot"><label class="ctc-button ctc-attach">＋ 图片<input type="file" accept="image/png,image/jpeg,image/webp" multiple data-images hidden></label><span class="ctc-label">支持粘贴、拖入截图</span><button class="ctc-button ctc-primary" type="submit" ${state.turns.some(turn => turn.status === 'RUNNING') ? 'disabled' : ''}>发送</button></div></form></section>`;
}
function attachmentTray() { return (state.attachments.get(scopeKey(state.scope)) ?? []).map(asset => `<span class="ctc-attachment"><img src="${escape(asset.dataUrl)}" alt="${escape(asset.name)}"><button type="button" data-remove-image="${asset.id}" aria-label="移除 ${escape(asset.name)}">×</button></span>`).join(''); }
async function mountSavedImages() {
  const scope = state.scope, generation = state.generation;
  for (const element of main.querySelectorAll('[data-saved-image]')) {
    const id = element.dataset.savedImage;
    try {
      if (!state.imageCache.has(id)) { const image = await api('asset-get', { scope, id }); state.imageCache.set(id, image.dataUrl); }
      if (generation !== state.generation) return;
      element.src = state.imageCache.get(id);
    } catch { element.alt = '截图暂时无法载入，点击重试'; }
  }
}
function discussionFailure(code) {
  const cause = {
    MODEL_CONNECTION_FAILED: '这次没有连通模型服务，或连接中途断开。',
    MODEL_REQUEST_REJECTED: '模型服务拒绝了本轮请求，需要检查模型或请求配置。',
    MODEL_ACCOUNT_LIMIT: '模型服务提示使用额度或请求频率受限。',
    MODEL_CONTEXT_TOO_LARGE: '模型服务提示本轮上下文过长，需要整理后继续。',
    CHATGPT_AUTH_REQUIRED: '本机的 ChatGPT 登录需要恢复。',
    APP_SERVER_START_FAILED: '本机模型运行程序未能启动，请检查运行程序和连接设置。',
    APP_SERVER_TIMEOUT: '等待模型服务超过了本轮时限。',
  }[code] ?? '本轮没有得到可用回复，未取得具体失败原因。';
  return cause + ' 原消息已保存，可以继续讨论；不会自动重复调用。';
}
function messagesHtml(turns) {
  if (!turns.length) return `<div class="ctc-empty"><h3>从这里开始讨论</h3><p>告诉 Console 想要什么结果。任务相关的决定会先整理给你确认。</p></div>`;
  return turns.map(turn => `<article class="ctc-message ctc-human"><div class="ctc-messagehead"><span class="ctc-avatar">H</span><strong>你</strong><span class="ctc-label">${escape(timestamp(turn.createdAt))}</span></div><p>${escape(turn.message)}</p>${(turn.attachments ?? []).map(asset => `<button class="ctc-image-link" type="button" data-view-image="${escape(asset.id)}"><img data-saved-image="${escape(asset.id)}" alt="${escape(asset.name)}" ${state.imageCache.has(asset.id) ? `src="${escape(state.imageCache.get(asset.id))}"` : ''}><span>${escape(asset.name)} · 查看大图</span></button>`).join('')}</article><article class="ctc-message"><div class="ctc-messagehead"><span class="ctc-avatar">C</span><strong>Console</strong>${pill(label(turn.status), turn.status === 'RUNNING' ? 'ctc-wait' : '')}</div><p>${escape(turn.answer?.reply ?? (turn.status === 'RUNNING' ? '正在思考。你可以切换页面，回复会保存在这里。' : discussionFailure(turn.failureCode)))}</p>${(turn.effects ?? []).map(effect => `<div class="ctc-effect">${effect.kind === 'TASK_CREATED' ? link(effect.description + ' →', `draft/${encodeURIComponent(effect.targetId)}`, 'ctc-link') : effect.kind === 'PLAN_REVIEW_CHANGED' ? link(effect.description + ' →', `task/${encodeURIComponent(effect.targetId)}/plan`, 'ctc-link') : escape(effect.description)}</div>`).join('')}${turn.answer?.proposal ? '<p class="ctc-small">已整理产品方向建议，可在方向表单中查看和修改。</p>' : ''}<details class="ctc-message-details"><summary>运行记录</summary><p class="ctc-small">${turn.status === 'RUNNING' ? '用量统计中' : `本轮用量：${num(turn.usage?.totalTokens)} tokens`}</p></details></article>`).join('');
}
async function contextHtml() {
  const context = await api('context', { scope: state.scope });
  const intent = context.intent.task ?? context.intent.draft ?? context.intent;
  const brief = context.intent.draft?.confirmation?.brief ?? context.intent.draft?.suggestedBrief ?? intent;
  const scopeName = { PROJECT: '项目', BIG_TASK: '大任务', SUBTASK: '小任务', DRAFT: '方向草稿' }[state.scope.kind];
  return `<section class="ctc-surface ctc-reading"><div class="ctc-subtitle"><h2>${scopeName}上下文</h2>${button('保存已确认结论', 'context-dialog', true)}</div>${facts([['目标', brief.goal ?? intent.name ?? '尚未单独记录'], ...(context.intent.parentGoal ? [['来自大任务的目标', context.intent.parentGoal]] : []), ['本次范围', (brief.scopeIn ?? []).join('；') || '见项目约定'], ['成功标准', (brief.acceptanceCriteria ?? brief.successCriteria ?? []).join('；') || '方向讨论中确认'], ['留到后续', (brief.scopeOut ?? []).join('；') || '未单独记录']])}<p class="ctc-small ctc-spaced">来源：保存的任务资料${context.confirmedDirection ? '与已确认方向' : ''}。旧 Codex 聊天未自动导入；这里不会补造对话记录。</p></section>${context.inherited?.length ? `<section class="ctc-surface ctc-spaced"><h3>继承的背景</h3>${context.inherited.map(item => `<p class="ctc-spaced">${escape(item.scope.scopeType === 'PROJECT' ? '项目' : '大任务')} · ${escape(item.title)}</p>`).join('')}</section>` : ''}<section class="ctc-surface ctc-spaced"><h2>已保存的决定与材料</h2>${(context.notes ?? []).map(note => `<article class="ctc-contextitem"><h3>${escape(note.title)}</h3><p>${escape(note.body)}</p></article>`).join('')}${context.items.length ? context.items.map(item => `<article class="ctc-contextitem"><h3>${escape(item.title)}</h3><p>${escape(item.body)}</p><span>${item.subtaskId ? '小任务' : item.bigTaskId ? '大任务' : '项目'} · ${item.authority === 'HUMAN' ? '你确认的决定' : '参考材料'} · 来源：${escape(item.provenance.sourceReference)}</span></article>`).join('') : '<p class="ctc-label ctc-spaced">尚未另外保存决定。上面的目标与范围仍然有效。</p>'}${Array.isArray(context.productDecisions) ? context.productDecisions.map(item => `<article class="ctc-contextitem"><p>${escape(typeof item === 'string' ? item : item.decision ?? item.answer ?? item.summary ?? '')}</p><span>来源：原始规划的产品决定</span></article>`).join('') : ''}</section>`;
}
async function taskPage(id, tab) {
  const record = await api('task', { bigTaskId: id }); state.task = record; state.scope = { kind: 'BIG_TASK', id };
  const execution = record.execution; state.scopeSettings = record.settings;
  const head = `<div class="ctc-crumb">${link(projectName(record.task.projectId), `project/${encodeURIComponent(record.task.projectId)}`, 'ctc-link')} / ${record.sourceDraft?.kind === 'SMALL_TASK' ? '小任务' : '大任务'}</div>` + heading(record.presentation?.title ?? record.task.title, record.task.goal, `${link('后续改进', `new-task/${encodeURIComponent(record.task.projectId)}/${encodeURIComponent(id)}`)}${execution && record.canResume ? button(execution.phase === 'APPROVED' ? '开始执行' : '继续执行', 'start', true) : ''}`) + lifecycleHtml(record.settings, execution) + tabsHtml('task', id, tab, [['overview', '概览'], ['discussion', '讨论'], ['plan', '计划'], ['tasks', '小任务'], ['results', '成果'], ['context', '上下文']]);
  if (tab === 'discussion') return head + (record.sourceDraft ? `<div class="ctc-note">${link('查看开工前的方向讨论', `draft/${encodeURIComponent(record.sourceDraft.id)}`, 'ctc-link')}</div>` : '') + await discussionHtml();
  if (tab === 'context') return head + await contextHtml();
  if (tab === 'plan') return head + planHtml(record);
  if (tab === 'tasks') return head + progressGraph(record.navigation ? [record.navigation] : []) + subtasksHtml(record);
  if (tab === 'results') return head + await resultHtml(record);
  const phase = execution?.phase ?? record.planning?.phase;
  const historyNotice = record.presentation?.historyOf ? `<div class="ctc-note">这是早期尝试。${link('查看当前任务与成果 →', `task/${encodeURIComponent(record.presentation.historyOf)}/results`, 'ctc-link')}</div>` : '';
  return head + historyNotice + `<div class="ctc-summary">${pill(label(phase ?? record.task.status), ['HUMAN_REQUIRED', 'PAUSED', 'AWAITING_ACCEPTANCE'].includes(phase) ? 'ctc-wait' : 'ctc-good')}<span class="ctc-label">${escape((record.canResume && execution?.stopReason === 'TIME_LIMIT_REACHED' ? '续跑时间已更新，可以继续执行' : reasons[execution?.stopReason ?? record.planning?.stopReason]) ?? (record.planningActive ? '正在规划或审核' : '当前状态来自已保存记录'))}</span></div>${blockersHtml(record)}<div class="ctc-two"><section class="ctc-surface"><h2>这次的目标与范围</h2><div class="ctc-spaced">${facts([['希望得到', record.task.goal], ['这次包含', record.task.scopeIn.join('；')], ['成功标准', record.task.acceptanceCriteria.join('；')], ['留到后续', record.task.scopeOut.join('；') || '未单独列出']])}</div></section><aside class="ctc-surface"><h3>下一步</h3><div class="ctc-spaced">${!execution ? (record.planning?.phase === 'APPROVED' ? `<p>具体计划已准备好，等待你确认并开工。</p>${link('查看计划', `task/${encodeURIComponent(id)}/plan`, 'ctc-button ctc-primary')}` : record.planning?.phase === 'READY' && !record.planningActive ? button('调查并准备计划', 'plan-start', true) : '<p>规划状态和需要回答的问题，会在这里更新。</p>') : `<p>${escape(execution.phase === 'AWAITING_ACCEPTANCE' ? '工程流程已完成，请查看成果并亲自测试。' : execution.phase === 'ACCEPTED' ? '产品已验收，可开始下一项工作。' : execution.phase === 'CLOSED' ? '本次流程已收尾。未验收的方向和跳过的检查保留记录。' : '按批准的计划推进；需要处理的问题会明确列出。')}</p>${link('查看成果与记录', `task/${encodeURIComponent(id)}/results`)}`}</div></aside></div>${execution ? usageHtml(execution) : ''}<div class="ctc-sectiontitle"><h2>任务安排</h2>${link('完整看板 →', `task/${encodeURIComponent(id)}/tasks`, 'ctc-link')}</div>${subtasksHtml(record)}`;
}
function blockersHtml(record) {
  const planning = record.planning, execution = record.execution;
  const reason = execution?.stopReason ?? planning?.stopReason;
  if (!reason && !planning?.questions?.length) return '';
  const engineering = !execution && (['ENGINEERING_PREPARATION', 'CONTEXT_CHANGED', 'CONTEXT_LIMIT', 'INVALID_OUTPUT'].includes(reason) || (planning?.questions ?? []).some(question => /禁止使用工具|只读核对|协调者|用量费用估算/.test(question)));
  const title = engineering ? '计划准备遇到问题' : reason === 'USER_PAUSED' ? '任务已暂停' : execution ? '执行需要处理' : '准备下一步';
  const explanation = engineering ? '需要继续核对代码、现有成果或工具能力。实施尚未开始；这些调查由 Console 处理，你可以让它重新准备计划。' : reasons[reason] ?? '查看当前记录后继续。';
  return `<section class="ctc-surface ctc-spaced ctc-blocker"><h2>${title}</h2><p class="ctc-spaced">${escape(explanation)}</p>${!engineering ? (planning?.questions ?? []).map(question => `<p class="ctc-spaced">${escape(question)}</p>`).join('') : ''}<div class="ctc-actions ctc-spaced">${!execution && planning?.phase === 'HUMAN_REQUIRED' ? button('重新调查并准备计划', 'plan-retry', true) : ''}${link('在聊天里讨论', `task/${encodeURIComponent(record.task.id)}/discussion`)}${execution && record.canRenewWindow ? button('调整续跑时间', 'renew-dialog') : ''}${execution && ['PAUSED','HUMAN_REQUIRED'].includes(execution.phase) && (execution.lastRoleFailure || execution.lastControlFailure) ? button('处理执行中断', execution.stopReason === 'USAGE_UNKNOWN' ? 'qa-recovery-review' : 'recovery-review') : ''}</div><details class="ctc-spaced"><summary>查看工程记录</summary><p>${escape((planning?.questions ?? []).join('\n'))}</p>${execution?.lastRoleFailure ? `<p>${escape(execution.lastRoleFailure.phase)} · ${escape(execution.lastRoleFailure.failureCode)}</p>` : ''}${execution?.lastControlFailure ? `<p>${escape(execution.lastControlFailure.phase)} · ${escape(execution.lastControlFailure.failureCode)}</p>` : ''}</details></section>`;
}
function usageHtml(execution) {
  const activity = execution.activeRole;
  return `<section class="ctc-surface ctc-spaced"><div class="ctc-subtitle"><h2>当前活动与用量</h2>${pill(execution.activeRoleCount ? '仍在执行' : '无活动步骤')}</div><div class="ctc-grid2">${facts([['正在做什么', activity ? `${label(activity.role)} · ${activity.progress?.phase ?? '运行中'}` : '当前没有运行中的模型步骤'], ['已确认用量', `${num(execution.knownTokens)} tokens${execution.unknownCompletedUsage ? '，另有未知用量' : ''}`]])}${facts([['执行次数', `${num(execution.roleCalls)} / ${num(execution.limits.roleCallLimit)}`], ['本次截止时间', timestamp(execution.expiresAt)]])}</div><details><summary>详细用量与预算记录</summary><pre class="ctc-evidence">${escape(JSON.stringify({ limits: execution.limits, usageBreakdown: execution.usageBreakdown, usageComplete: execution.usageComplete, activeRole: activity, windowRenewal: execution.windowRenewal }, null, 2))}</pre></details></section>`;
}
function planHtml(record) {
  const candidate = record.plan?.reviewState?.candidate;
  if (!candidate) return blockersHtml(record) + empty(record.planningActive || record.planning?.phase === 'RUNNING' ? '正在生成或审核计划' : '计划尚未生成', 'Console 会先调查项目并整理计划；你确认计划后才开始实施。', record.planning?.phase === 'READY' && !record.planningActive ? button('调查并准备计划', 'plan-start', true) : '');
  return blockersHtml(record) + `<section class="ctc-surface"><div class="ctc-subtitle"><h2>具体实施计划</h2>${pill(`第 ${candidate.revision} 版 · ${record.planReviewMode === 'SELF' ? '规划者自检' : '独立计划审核'} · ${label(record.planning?.phase)}`)}</div><form data-form="plan-review">${record.contracts.map((contract, index) => `<article class="ctc-contextitem"><h3>${index + 1}. ${link(contract.title, `subtask/${encodeURIComponent(contract.subtaskId)}`, 'ctc-titlelink')}</h3><p>${escape(contract.goal)}</p><details class="ctc-spaced"><summary>完成标准</summary><p>${escape(contract.acceptanceCriteria.join('；'))}</p></details><span>检查深度：${escape(label(candidate.subtasks.find(task => task.id === contract.subtaskId)?.profile))}</span>${!record.execution && record.planning?.phase !== 'RUNNING' && !record.presentation?.historyOf ? `<label class="ctc-field ctc-spaced">检查深度<select name="${escape(contract.subtaskId)}">${[['LIGHT','LOW'],['STANDARD','STANDARD'],['THOROUGH','HIGH_RISK_FOUNDATION']].map(([level, profile]) => `<option value="${level}" ${candidate.subtasks.find(task => task.id === contract.subtaskId)?.profile === profile ? 'selected' : ''}>${levelName(level)}</option>`).join('')}</select></label>` : `<span>本次已固定：${escape(label(candidate.subtasks.find(task => task.id === contract.subtaskId)?.profile))}</span>`}</article>`).join('')}${!record.execution && record.planning?.phase !== 'RUNNING' && !record.presentation?.historyOf ? '<button class="ctc-button" type="submit">保存检查安排</button><p class="ctc-small ctc-spaced">保留原记录，按任务偏好检查调整后的计划。</p>' : ''}</form><details><summary>任务依赖、范围与完整计划</summary><pre class="ctc-evidence">${escape(JSON.stringify({ dependencies: candidate.dependencies, contracts: record.contracts }, null, 2))}</pre></details>${!record.execution && record.planning?.phase === 'APPROVED' ? `<div class="ctc-actions ctc-spaced">${button('确认计划并开工', 'execution-review', true)}${link('先讨论调整', `task/${encodeURIComponent(record.task.id)}/discussion`)}</div>` : ''}</section>`;
}
function subtasksHtml(record) {
  const tasks = record.navigation?.subtasks ?? record.subtasks;
  if (!tasks.length) return empty('小任务待安排', '具体计划审核后，这里按任务推进顺序显示每一项。');
  return `<section class="ctc-surface">${orderedSubtasks(tasks)}</section>`;
}
async function subtaskPage(id, tab) {
  const record = await api('subtask', { subtaskId: id }); state.subtask = record; state.scope = { kind: 'SUBTASK', id }; state.scopeSettings = record.settings;
  const head = `<div class="ctc-crumb">${link(projectName(record.parent?.projectId), `project/${encodeURIComponent(record.parent?.projectId ?? '')}`, 'ctc-link')} / ${link(record.parent?.title ?? '大任务', `task/${encodeURIComponent(record.task.bigTaskId)}`, 'ctc-link')} / 小任务</div>` + heading(record.task.title, record.task.goal) + lifecycleHtml(record.settings) + tabsHtml('subtask', id, tab, [['overview', '任务概览'], ['discussion', '聊天'], ['context', '上下文'], ['history', '执行记录']]);
  if (tab === 'discussion') return head + await discussionHtml();
  if (tab === 'context') return head + await contextHtml();
  if (tab === 'history') return head + `<section class="ctc-surface"><h2>执行记录</h2>${record.inspection?.durableExecution.recentChatThreads.flatMap(thread => thread.runs.map(run => `<article class="ctc-contextitem"><strong>${escape(label(run.status))}</strong><span>${escape(timestamp(run.updatedAt))} · ${escape(run.providerModelId ?? '模型信息未返回')}</span></article>`)).join('') || '<p class="ctc-spaced">还没有开始实施，聊天与准备材料已经可以使用。</p>'}</section>`;
  const planned = record.materialized === false;
  return head + `<section class="ctc-surface ctc-nextstep"><div>${pill(planned ? '计划中 · 尚未开工' : label(record.workflow?.currentStage ?? record.task.status))}<h2>${planned ? '先把这项任务说明白' : '当前工作'}</h2><p>${planned ? '你可以现在讨论细节、附截图或补充上下文。大任务计划确认后，这些材料会继续保留。' : record.inspection?.dependencyReadiness.ready ? '前置条件已满足，按大任务安排推进。' : '正在等待前置任务完成。'}</p></div>${link('进入小任务聊天', `subtask/${encodeURIComponent(id)}/discussion`, 'ctc-button ctc-primary')}</section><section class="ctc-surface ctc-spaced">${facts([['要做什么', record.task.goal], ['怎样算完成', record.task.acceptanceCriteria.join('；')], ['属于哪个大任务', record.parent?.title]])}</section>${record.canAmendPlan ? `<form data-form="candidate-review" class="ctc-surface ctc-spaced"><h3>这项任务怎么检查</h3>${reviewSelect('reviewLevel', {LOW:'LIGHT',STANDARD:'STANDARD',HIGH_RISK_FOUNDATION:'THOROUGH'}[record.plannedProfile])}<button class="ctc-button" type="submit">保存到当前计划</button><p class="ctc-small">开工前可调整，原聊天和计划记录会保留。</p></form>` : scopeSettingsHtml(record.settings, !planned)}${planned ? link('查看整体计划', `task/${encodeURIComponent(record.task.bigTaskId)}/plan`) : ''}`;
}
async function resultHtml(record) {
  const execution = record.execution;
  if (!execution?.resultRefCreated) return empty('尚未产生可交付的结果', '执行后的成果、改动和检查结论会保留在这里。');
  const delivery = await api('delivery', { bigTaskId: record.task.id });
  const preview = delivery.kind === 'WEB' ? await api('preview-status', { bigTaskId: record.task.id }) : { phase: 'NONE' }; state.preview = preview;
  const previewUrl = preview.phase === 'READY' && /^http:\/\/localhost:[0-9]{1,5}$/.test(preview.url ?? '') ? preview.url : null;
  const canAccept = execution.phase === 'AWAITING_ACCEPTANCE';
  return `<section class="ctc-surface"><div class="ctc-subtitle"><h2>当前交付</h2>${pill(label(execution.phase), execution.phase === 'ACCEPTED' ? 'ctc-good' : 'ctc-wait')}</div><p class="ctc-delivery-summary">${escape(record.task.goal)}</p><p class="ctc-spaced">已整合 ${execution.integratedSubtaskIds.length} 项小任务。${delivery.kind === 'WEB' ? '这是可运行的网页成果。' : '查看交付说明和文件改动，了解使用方式。'}</p>${execution.closeout ? `<details class="ctc-spaced"><summary>已收尾 · 产品未验收，查看保留的问题</summary><p>${escape(execution.closeout.reason)}</p></details>` : ''}<div class="ctc-actions ctc-spaced">${delivery.kind === 'WEB' ? previewUrl ? `<a class="ctc-button ctc-primary" href="${escape(previewUrl)}" target="_blank" rel="noopener noreferrer">打开应用</a>${button('停止预览', 'preview-stop')}` : button(preview.phase === 'STARTING' ? '预览启动中…' : '运行并打开应用', 'preview-start', true, preview.phase === 'STARTING' ? 'disabled' : '') : ''}${button('查看文件改动', 'show-diff')}${canAccept ? button('我已测试，确认产品验收', 'accept-dialog') : ''}${link('反馈与后续改进', `new-task/${encodeURIComponent(record.task.projectId)}/${encodeURIComponent(record.task.id)}`)}${canAccept ? button('保留问题并收尾', 'close-dialog') : ''}</div>${preview.phase === 'FAILED' ? `<p class="ctc-label">${preview.failureCode === 'PREVIEW_UNSUPPORTED' ? '这个成果没有可自动启动的网页入口。当前支持根目录 index.html 或 server/index.mjs；仍可查看成果分支和文件改动。' : '预览启动失败。成果与执行记录仍保留，可查看改动后重试。'}</p>` : ''}${delivery.guide ? `<details class="ctc-spaced"><summary>交付与使用说明</summary><pre class="ctc-guide">${escape(delivery.guide)}</pre></details>` : ''}<details class="ctc-spaced"><summary>版本与文件清单</summary>${facts([['成果版本', delivery.headSha], ['结果分支', delivery.resultRef]])}<pre class="ctc-evidence">${escape(delivery.stat || '没有文件改动')}</pre></details><details id="diff-details"><summary>展开文件改动${delivery.truncated ? '（内容较长，当前显示部分）' : ''}</summary><pre class="ctc-evidence">${escape(delivery.diffUnavailable ? '完整文件改动暂时无法载入（例如改动超过显示容量）。成果版本和其他操作仍可使用；可通过结果分支查看完整改动。' : delivery.diff)}</pre></details></section><div class="ctc-sectiontitle"><h2>工程检查</h2></div>${subtasksHtml(record)}${usageHtml(execution)}`;
}
function newProject() {
  return heading('添加项目', '选择电脑上的项目文件夹，Console 会自动识别名称和版本信息。') + `<section class="ctc-surface ctc-reading"><div class="ctc-folder-drop"><span class="ctc-folder-icon">▱</span><h2>项目在哪里？</h2><p>选择已有项目文件夹，无需查找 Git 路径。</p>${button('选择文件夹', 'choose-folder', true)}<p class="ctc-small">Mac 和 Windows 使用各自的系统选择窗口。</p></div><p id="folder-status" role="status"></p><form data-form="project">${field('name', '项目名称', '', { max: 200 })}<details id="project-details"><summary>项目位置与高级设置</summary>${field('repositoryPath', '项目文件夹路径', '')}${button('识别这个路径', 'inspect-folder')}${field('slug', '项目简称（自动生成，可修改）', '')}${field('defaultBranch', '工作分支', 'main')}</details><button class="ctc-button ctc-primary" type="submit">添加项目</button></form></section>`;
}

async function newTask(projectId, relatedBigTaskId) { const related = relatedBigTaskId ? await api('task', { bigTaskId: relatedBigTaskId }) : null; return heading('先说你想做成什么', '你可以交一个大任务，也可以直接交一个明确的小任务。') + (state.projects.length ? `<form data-form="new-task" class="ctc-surface ctc-reading"><div class="ctc-grid2"><label class="ctc-field">所属项目<select name="projectId">${state.projects.map(project => `<option value="${escape(project.id)}" ${project.id === projectId ? 'selected' : ''}>${escape(project.name)}</option>`).join('')}</select></label><label class="ctc-field">任务大小<select name="kind"><option value="BIG_TASK">大任务 · 需要讨论和拆分</option><option value="SMALL_TASK">小任务 · 一项明确改动</option></select></label></div>${related ? `<div class="ctc-note">关联任务：${escape(related.task.title)}。原目标和已确认结论会带入下一步方向讨论。</div>` : ''}${field('title', '任务名称', related ? `后续：${related.task.title}`.slice(0, 200) : '', { max: 200 })}${field('goal', '希望得到什么结果', related?.task.goal ?? '', { multiline: true, max: 1000 })}${relatedBigTaskId ? `<input type="hidden" name="relatedBigTaskId" value="${escape(relatedBigTaskId)}"><p class="ctc-label">这是关联原任务的后续工作，不会改写原来的执行计划。</p>` : ''}<div class="ctc-actions ctc-spaced"><button class="ctc-button ctc-primary" type="submit">创建并讨论方向</button><span class="ctc-label">不会直接开始改代码。</span></div></form>` : empty('先添加一个项目', '任务需要属于一个明确的本地仓库。', link('添加项目', 'new-project', 'ctc-button ctc-primary'))); }
function settings() { return heading('任务偏好', '按任务难度选择检查深度；每项任务开工前都能调整。') + `<form data-form="settings" class="ctc-surface ctc-reading"><p class="ctc-small">检查深度在项目总览设置默认值，也可在具体任务中单独调整。</p><label class="ctc-field">外观<select name="theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><p class="ctc-label">范围内的工具和工程检查自动进行。产品方向、计划和超出约定的事项交给你决定。已批准任务保留其原有约定。</p><div class="ctc-actions ctc-spaced"><button class="ctc-button ctc-primary" type="submit">保存偏好</button></div></form>`; }
async function renderRoute() {
  const generation = ++state.generation;
  if (modal.open) modal.close(); state.modalContext = null;
  state.reading = true;
  state.route = location.hash.replace(/^#\//, '').split('/').map(part => { try { return decodeURIComponent(part); } catch { return ''; } });
  const [type = 'home', id, tab = 'overview'] = state.route; state.tab = tab; state.scope = null; state.scopeSettings = null; state.project = null; state.task = null; state.subtask = null; state.draft = null; state.turns = []; state.preview = null;
  nav(); main.setAttribute('aria-busy', 'true');
  try {
    let html;
    if (['home', 'decisions', 'results', ''].includes(type)) html = await home(type || 'home');
    else if (type === 'project') html = await projectPage(id, tab);
    else if (type === 'draft') html = await draftPage(id);
    else if (type === 'task') html = await taskPage(id, tab);
    else if (type === 'subtask') html = await subtaskPage(id, tab);
    else if (type === 'new-project') html = newProject();
    else if (type === 'new-task') html = await newTask(id, tab === 'overview' ? undefined : tab);
    else if (type === 'settings') html = settings();
    else html = empty('页面不存在', '返回工作台继续。', link('工作台', 'home'));
    if (generation !== state.generation) return;
    main.innerHTML = html; mountGraphLayout(); nav(); void mountSavedImages();
    if (type === 'settings') main.querySelector('[name=theme]').value = localStorage.getItem('ctc-theme') ?? 'system';
  } catch (error) {
    if (generation !== state.generation) return;
    notify(error.message, true);
    main.innerHTML = empty('暂时无法载入这部分内容', error.message, button('重新读取状态', 'refresh', true));
  } finally { if (generation === state.generation) { state.reading = false; main.removeAttribute('aria-busy'); } }
}
function openModal(title, body, action, confirm = '确认') {
  state.modalAction = action;
  state.modalContext = { generation: state.generation, scope: state.scope ? structuredClone(state.scope) : null, task: state.task, review: state.review, settings: state.scopeSettings };
  modalContent.innerHTML = `<h2 id="modal-title">${escape(title)}</h2>${body}<div class="ctc-actions"><button type="button" data-modal="cancel">返回</button><button type="button" class="ctc-primary" data-modal="confirm">${escape(confirm)}</button></div>`;
  modal.showModal();
}
async function act(action) {
  if (action === 'chat-context') { const panel = document.getElementById('chat-context'); panel.open = !panel.open; return; }
  if (action === 'choose-folder' || action === 'inspect-folder') {
    const result = await api(action === 'choose-folder' ? 'folder-choose' : 'folder-inspect', action === 'choose-folder' ? {} : { path: main.querySelector('[name="repositoryPath"]').value });
    if (result.cancelled) return;
    document.getElementById('folder-status').textContent = result.ready ? '已识别项目，可以直接添加。' : result.message;
    for (const key of ['name', 'slug', 'repositoryPath', 'defaultBranch']) if (result[key]) main.querySelector(`[name="${key}"]`).value = result[key];
    if (!result.ready) document.getElementById('project-details').open = true;
    return;
  }
  if (action === 'plan-retry') { const result = await api('planning-retry', { bigTaskId: state.task.task.id, requestId: requestId('prepare-again') }); state.requestIds.delete('prepare-again'); await loadWorkspace(); routeTo(`task/${encodeURIComponent(result.bigTaskId)}/plan`); return; }
  if (action.startsWith('scope-')) {
    const settings = state.scopeSettings;
    if (action === 'scope-end') { openModal('结束这项工作', '<p>保留聊天、成果与检查记录。结束不会把未通过的检查标为通过。</p><label class="ctc-field">结束方式<select name="endOutcome"><option value="STOPPED">不再继续</option><option value="COMPLETED">标记工作已完成</option></select></label>', 'scope-end', '结束并保留记录'); return; }
    await api('lifecycle-change', { requestId: requestId(action), scope: settings.scope, expectedRevision: settings.revision, lifecycle: action === 'scope-pause' ? 'PAUSED' : 'ACTIVE' }); state.requestIds.delete(action); await loadWorkspace(); await renderRoute(); return;
  }
  if (action === 'refresh') { await loadWorkspace(); await renderRoute(); return; }
  if (action === 'scroll-direction') { document.getElementById('direction')?.scrollIntoView({ behavior: 'smooth' }); return; }
  if (action === 'more-messages') {
    const result = await api('discussion', { scope: state.scope, after: state.after }); state.turns = [...new Map([...result.turns, ...state.turns].map(turn => [turn.sequence, turn])).values()].sort((a, b) => a.sequence - b.sequence); state.after = result.previousAfter; state.hasMore = result.hasPrevious;
    document.getElementById('messages').innerHTML = messagesHtml(state.turns); void mountSavedImages(); document.getElementById('older-messages').innerHTML = result.hasPrevious ? button('加载更早的对话', 'more-messages') : ''; return;
  }
  if (action === 'context-dialog') { openModal('保存已确认的结论', `<p>只在当前范围内生效。涉及正在执行的任务时，结论不会改写已经批准的计划。</p>${field('title', '结论标题', '', { max: 200 })}${field('body', '确认的内容', '', { multiline: true, max: 4000 })}`, 'context-confirm', '保存结论'); return; }
  if (action === 'project-status') { const settings = state.project.settings; await api('settings-change', { requestId: requestId('project-status'), scope: settings.scope, expectedRevision: settings.revision, projectClosed: !settings.projectClosed }); state.requestIds.delete('project-status'); await loadWorkspace(); await renderRoute(); return; }
  const record = state.task; const id = record?.task.id;
  if (action === 'plan-start') { await api('planning-start', { bigTaskId: id }); notify('规划已提交。你可以离开页面，结果会保留。'); await renderRoute(); }
  if (action === 'pause') { await api('execution-pause', { bigTaskId: id }); notify('已请求暂停；请看当前步骤是否已经安全停止。'); await renderRoute(); }
  if (action === 'start') { await api('execution-start', { bigTaskId: id }); notify('已从保存的进度开始推进。'); await renderRoute(); }
  if (action === 'execution-review') {
    state.review = await api('execution-review', { bigTaskId: id });
    const prefs = state.review.consoleWorkflow;
    openModal('确认计划并开始实施', `<p>按刚才查看的计划实施，完成约定的检查与修复；最终产品验收仍由你决定。</p><details><summary>时长和用量安排</summary>${prefs ? `<label class="ctc-field">用量控制<select name="budgetMode"><option value="MEASURE" ${prefs.budgetMode === 'MEASURE' ? 'selected' : ''}>只统计和提醒</option><option value="HARD" ${prefs.budgetMode === 'HARD' ? 'selected' : ''}>达到预算后暂停</option></select></label>` : ''}${field('minutes', '本次运行窗口（分钟）', prefs?.durationMinutes ?? 180, { type: 'number', min: 1, max: prefs ? 1440 : 180 })}${field('tokens', state.review.consoleWorkflow ? '用量参考／预算' : '本次 token 上限', prefs?.executionTokenLimit ?? 2000000, { type: 'number', min: 1, max: prefs ? 100000000 : 2880000 })}${prefs ? '<input type="hidden" name="calls" value="10000">' : field('calls', '最多模型步骤', 96, { type: 'number', min: 1, max: 192 })}</details>${state.review.consoleReviewPolicy ? '<input type="hidden" name="repairs" value="2"><p>按各小任务选择执行：独立 QA 第 2 次失败停止；加固与 QA 第 3 次失败停止。</p>' : '<label class="ctc-field">QA 未通过后的修复轮数<select name="repairs"><option value="1">最多一轮</option><option value="2" selected>最多两轮</option></select></label>'}${state.review.executionIssues?.length ? `<p>当前计划仍有执行问题，请先处理：${escape(JSON.stringify(state.review.executionIssues))}</p>` : ''}`, 'execution-approve', '批准并开始');
  }
  if (action === 'recovery-review') { state.review = await api('execution-recovery-review', { bigTaskId: id }); openModal('恢复已知失败的步骤', `<p>保留成果与失败记录，使用 Sol 的深入推理恢复这一步。</p><p>本次恢复将小任务 token 上限改为提醒${state.review.request.totalBudgetMode === 'WARNING_ONLY' ? '，总任务 token 上限也改为提醒' : ''}；时间窗口与修复轮数继续生效。当前已知用量 ${num(state.review.knownTokens)} token。</p>`, 'execution-recover', '恢复并继续'); }
  if (action === 'qa-recovery-review') { state.review = await api('execution-qa-recovery-review', { bigTaskId: id }); openModal('处理审核用量未知', `<p>已有一轮最终用量没有返回，历史记录保留为未知。仅对这一次失败审核继续复验：已知用量上限 200 万 token，新增最多三小时。未知用量不会被写成零。</p><p>当前已知用量：${num(state.review.request.acknowledgedKnownTokens)} token。</p>`, 'execution-recover-qa', '确认本次例外并继续'); }
  if (action === 'renew-dialog') openModal('调整续跑窗口', `<p>从实际继续时按已批准的续跑规则计时；历史用量和修复次数保留。</p>${field('minutes', '新的窗口（分钟）', '180', { type: 'number', min: 1, max: 180 })}`, 'execution-renew-window', '确认新窗口');
  if (action === 'accept-dialog') openModal('确认产品验收', '<p>确认你已经亲自测试当前成果，且结果符合目标。此操作记录产品验收，不会自动部署或合并其他仓库。</p>', 'execution-accept', '确认验收');
  if (action === 'close-dialog') openModal('保留问题并收尾', `<p>结束本次流程，保留工程成果和未解决问题；产品不会标为验收通过。</p>${field('reason', '收尾原因与保留的问题', '', { multiline: true, max: 2000 })}`, 'execution-close', '记录并收尾');
  if (action === 'preview-start' || action === 'preview-stop') { await api(action, { bigTaskId: id }); notify(action === 'preview-start' ? '正在独立的成果目录启动网页预览。' : '预览已停止。'); await renderRoute(); }
  if (action === 'show-diff') { const details = document.getElementById('diff-details'); details.open = true; details.scrollIntoView({ block: 'start' }); }
}
async function submit(form) {
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form)); const type = form.dataset.form;
  if (type === 'candidate-review') {
    const record = state.subtask;
    const result = await api('plan-review-change', { requestId: requestId('candidate-review'), bigTaskId: record.task.bigTaskId, expectedBinding: record.planningBinding, changes: [{ subtaskId: record.task.id, reviewLevel: data.reviewLevel }] });
    state.requestIds.delete('candidate-review'); await loadWorkspace();
    routeTo(result.subtaskIds?.[record.task.id] ? `subtask/${encodeURIComponent(result.subtaskIds[record.task.id])}` : `task/${encodeURIComponent(result.bigTaskId)}/plan`); return;
  }
  if (type === 'plan-review') { const result = await api('plan-review-change', { requestId: requestId('plan-review'), bigTaskId: state.task.task.id, expectedBinding: state.task.planningBinding, changes: Object.entries(data).map(([subtaskId, reviewLevel]) => ({ subtaskId, reviewLevel })) }); state.requestIds.delete('plan-review'); await loadWorkspace(); routeTo(`task/${encodeURIComponent(result.bigTaskId)}/plan`); return; }
  if (type === 'scope-settings') { const key = `settings:${form.dataset.id}`; await api('settings-change', { requestId: requestId(key), scope: { kind: form.dataset.scope, id: form.dataset.id }, expectedRevision: Number(form.dataset.revision), reviewLevel: data.reviewLevel || null, preferences: preferencesValue(data) }); state.requestIds.delete(key); notify('检查深度已保存。'); await loadWorkspace(); await renderRoute(); return; }
  if (type === 'settings') { localStorage.setItem('ctc-theme', data.theme); document.documentElement.style.colorScheme = data.theme === 'system' ? 'light dark' : data.theme; notify('偏好已保存，现有任务的约定保持不变。'); return; }
  if (type === 'project') { const project = await api('project-create', { ...data, requestId: requestId('project') }); state.requestIds.delete('project'); await loadWorkspace(); routeTo(`project/${encodeURIComponent(project.id)}`); }
  if (type === 'new-task') { const draft = await api('draft-create', { ...data, requestId: requestId('new-task') }); state.requestIds.delete('new-task'); routeTo(`draft/${encodeURIComponent(draft.id)}`); }
  if (type === 'discussion') {
    const scope = state.scope; const key = scopeKey(scope);
    const assets = state.attachments.get(key) ?? []; if (!data.message.trim() && !assets.length) return;
    await api('discuss', { requestId: requestId(key), scope, message: data.message.trim() || '请查看附图。', attachments: assets.map(({ dataUrl, ...asset }) => { void dataUrl; return asset; }) }); state.attachments.delete(key); state.requestIds.delete(key); state.drafts.delete(key); notify('消息已保存，回复会显示在当前讨论中。'); await renderRoute();
  }
  if (type === 'direction') {
    const result = await api('direction-confirm', { draftId: state.draft.id, revision: state.draft.revision,
      brief: { title: data.title, goal: data.goal, scopeIn: lines(data.scopeIn), scopeOut: lines(data.scopeOut), successCriteria: lines(data.successCriteria) },
      reviewIntensity: data.reviewIntensity, planningTokenLimit: Number(data.planningTokenLimit), workflow: preferencesValue(data) });
    notify('产品方向已保存，接下来生成并审核具体计划。');
    await api('planning-start', { bigTaskId: result.confirmedBigTaskId });
    routeTo(`task/${encodeURIComponent(result.confirmedBigTaskId)}/plan`);
  }
}
async function confirmModal() {
  const captured = state.modalContext;
  if (!modal.open || !captured || captured.generation !== state.generation) { modal.close(); const error = new Error('页面已切换，请根据当前任务重新确认。'); error.code = 'STALE_VIEW'; throw error; }
  const action = state.modalAction; const value = name => modalContent.querySelector(`[name="${name}"]`)?.value;
  for (const control of modalContent.querySelectorAll('input,textarea,select')) if (!control.reportValidity()) return;
  const record = captured.task; const review = captured.review; const scope = captured.scope; const id = record?.task.id;
  if (action === 'scope-end') { const settings = captured.settings; await api('lifecycle-change', { requestId: requestId('end-scope'), scope: settings.scope, expectedRevision: settings.revision, lifecycle: 'ENDED', endOutcome: value('endOutcome') }); state.requestIds.delete('end-scope'); await loadWorkspace(); }
  if (action === 'context-confirm') { const key = `context:${scopeKey(scope)}`; await api(action, { requestId: requestId(key), scope, title: value('title'), body: value('body') }); state.requestIds.delete(key); }
  if (action === 'execution-approve') { await api(action, { bigTaskId: id, planDigest: review.planDigest, repositoryHeadSha: review.repositoryHeadSha,
    limits: { durationMilliseconds: Number(value('minutes')) * 60_000, totalTokenLimit: Number(value('tokens')), roleCallLimit: Number(value('calls')), repairCycleLimit: Number(value('repairs')), ...(review.consoleWorkflow ? { budgetMode: value('budgetMode') || review.consoleWorkflow.budgetMode } : {}) } }); await api('execution-start', { bigTaskId: id }); }
  if (action === 'execution-recover') { await api(action, review.request); await api('execution-start', { bigTaskId: id }); }
  if (action === 'execution-recover-qa') { await api(action, review.request); await api('execution-start', { bigTaskId: id }); }
  if (action === 'execution-renew-window') await api(action, { bigTaskId: id, planDigest: record.execution.planDigest, previousExpiresAt: record.execution.expiresAt, durationMilliseconds: Number(value('minutes')) * 60_000 });
  if (action === 'execution-accept') await api(action, { bigTaskId: id, headSha: record.execution.resultHeadSha });
  if (action === 'execution-close') await api(action, { bigTaskId: id, headSha: record.execution.resultHeadSha, reason: value('reason') });
  modal.close(); notify('操作已保存。'); await renderRoute();
}
async function guarded(operation) {
  if (state.pending) return; state.pending = true;
  const buttons = [...document.querySelectorAll('button:not([data-modal="cancel"])')].filter(button => !button.disabled); buttons.forEach(button => { button.disabled = true; });
  try { await operation(); } catch (error) { if (error.code !== 'STALE_VIEW') notify(error.message, true); } finally { state.pending = false; buttons.forEach(button => { if (button.isConnected) button.disabled = false; }); }
}
async function addImages(files) {
  const scope = structuredClone(state.scope), key = scopeKey(scope);
  const saved = state.attachments.get(key) ?? [];
  for (const file of files) {
    if (saved.length >= 6) throw new Error('一次最多添加六张图片。');
    if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
    if (file.size > 4 * 1024 * 1024) throw new Error('这张图片超过 4 MB，请缩小后再添加。');
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
    const asset = await api('asset-save', { scope, name: file.name || '截图.png', dataUrl });
    if (!saved.some(item => item.id === asset.id)) saved.push({ ...asset, dataUrl });
    state.attachments.set(key, saved);
  }
  if (scopeKey(state.scope) === key) document.getElementById('attachment-tray').innerHTML = attachmentTray();
}
root.addEventListener('submit', event => { event.preventDefault(); void guarded(() => submit(event.target)); });
root.addEventListener('click', event => { const remove = event.target.closest('[data-remove-image]'); if (remove) { const key = scopeKey(state.scope); state.attachments.set(key, (state.attachments.get(key) ?? []).filter(asset => asset.id !== remove.dataset.removeImage)); document.getElementById('attachment-tray').innerHTML = attachmentTray(); return; } const image = event.target.closest('[data-view-image]'); if (image) { void guarded(async () => { const asset = await api('asset-get', { scope: state.scope, id: image.dataset.viewImage }); openModal(asset.name, `<img class="ctc-full-image" src="${escape(asset.dataUrl)}" alt="${escape(asset.name)}">`, 'image-close', '关闭'); }); return; } const tree = event.target.closest('[data-tree]'); if (tree) { const memory = treeMemory(); const previous = memory[tree.dataset.tree]; if (previous) { previous.open = !previous.open; localStorage.setItem('ctc-tree', JSON.stringify(memory)); nav(); } return; } if (state.pending && event.target.closest('a')) { event.preventDefault(); return; } const target = event.target.closest('[data-action]'); if (target) void guarded(() => act(target.dataset.action)); });
root.addEventListener('change', event => { if (event.target.matches('[data-images]')) void guarded(() => addImages([...event.target.files])); });
root.addEventListener('paste', event => { const files = [...(event.clipboardData?.files ?? [])]; if (files.length && event.target.closest('.ctc-composer')) { event.preventDefault(); void guarded(() => addImages(files)); } });
root.addEventListener('dragover', event => { if (event.target.closest('.ctc-composer')) event.preventDefault(); });
root.addEventListener('drop', event => { if (event.target.closest('.ctc-composer')) { event.preventDefault(); void guarded(() => addImages([...event.dataTransfer.files])); } });
root.addEventListener('input', event => {
  if (event.target.matches('[data-search]')) { const query = event.target.value.toLocaleLowerCase(); main.querySelectorAll('#task-grid .ctc-taskcard').forEach(card => { card.hidden = !card.textContent.toLocaleLowerCase().includes(query); }); }
  if (event.target.name === 'message' && state.scope) state.drafts.set(scopeKey(state.scope), event.target.value);
  const form = event.target.closest('[data-form="direction"]'); if (form && state.draft) state.drafts.set(`brief:${state.draft.id}`, Object.fromEntries(new FormData(form)));
});
modal.addEventListener('click', event => { const action = event.target.closest('[data-modal]')?.dataset.modal; if (action === 'cancel') modal.close(); if (action === 'confirm') void guarded(confirmModal); });
document.getElementById('refresh').addEventListener('click', () => { void guarded(() => act('refresh')); });
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#launch=')) { window.scrollTo(0, 0); void renderRoute(); } });
const theme = localStorage.getItem('ctc-theme'); if (theme && theme !== 'system') document.documentElement.style.colorScheme = theme;
async function boot() {
  try {
    const fragment = location.hash;
    if (fragment.startsWith('#launch=')) { history.replaceState(null, '', '/#/home'); await transport('/ui/session', { code: fragment.slice(8) }); }
    if (!location.hash) history.replaceState(null, '', '/#/home');
    await loadWorkspace(); await renderRoute();
  } catch (error) { notify(error.message, true); main.innerHTML = empty('打开你的本机 Console', '请使用项目中的 Console 启动器打开。它会连接本机服务，不需要复制登录凭据。', button('重新连接', 'refresh', true)); }
}
void boot();
setInterval(() => {
  if (document.hidden || state.reading || state.pending || modal.open || main.contains(document.activeElement) && document.activeElement.matches('input,textarea,select')) return;
  const busy = state.turns.some(turn => turn.status === 'RUNNING') || state.task?.planningActive || state.task?.planning?.phase === 'RUNNING' || state.task?.execution?.phase === 'RUNNING' || state.preview?.phase === 'STARTING';
  if (busy) void renderRoute();
}, 4000);
