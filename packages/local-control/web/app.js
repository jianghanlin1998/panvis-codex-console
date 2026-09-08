const root = document.getElementById('ctc-direction');
const main = document.getElementById('main');
const notice = document.getElementById('notice');
const connection = document.getElementById('connection');
const modal = document.getElementById('modal');
const modalContent = document.getElementById('modal-content');
const state = { projects: [], project: null, task: null, subtask: null, draft: null, route: [], tab: 'overview', generation: 0, reading: false, pending: false, online: false, turns: [], hasMore: false, after: 0, scope: null, review: null, modalAction: null, drafts: new Map(), requestIds: new Map() };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = value => typeof value === 'number' ? value.toLocaleString('zh-CN') : '未知';
const timestamp = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未开始';
const label = value => ({ IN_PROGRESS: '进行中', DONE: '工程已完成', TODO: '待开始', QA_DEBUG: '检查与修复', DROPPED: '已取消', ARCHIVED: '已归档', NOT_STARTED: '未实施', IMPLEMENTED: '已实施', HARDENED: '已加固', ACCEPTED: '已验收', CLOSED: '已收尾 · 产品未验收', READY: '可以开始规划', RUNNING: '执行中', APPROVED: '已批准', PAUSED: '已暂停', HUMAN_REQUIRED: '需要处理', AWAITING_ACCEPTANCE: '等待产品验收', AWAITING_REVIEW: '计划审核中', AWAITING_REVISION: '修改计划中', EXECUTE: '实施', HARDEN: '加固', FRESH_QA: '独立 QA', REPAIR: '修复', FOCUSED_RE_QA: '复验', VERIFY: '验证', COMPLETE: '完成', PLANNING: '规划', REVIEW: '审核', LOW: '轻量', STANDARD: '标准', HIGH_RISK_FOUNDATION: '深入', FAILED: '失败', SUCCEEDED: '成功', INTERRUPTED: '已中断' }[value] ?? value ?? '尚无记录');
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
const reviewSelect = (name = 'reviewIntensity', selected = 'STANDARD') => `<label class="ctc-field">审核深度<select name="${name}">${[['LIGHT', '轻量'], ['STANDARD', '标准 · 独立 QA'], ['THOROUGH', '深入 · 加固与独立 QA']].map(([value, text]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${text}</option>`).join('')}</select></label>`;
const requestId = key => { if (!state.requestIds.has(key)) state.requestIds.set(key, crypto.randomUUID()); return state.requestIds.get(key); };
const scopeKey = scope => scope ? `${scope.kind}:${scope.id}` : '';
function notify(message, error = false) { notice.textContent = message; notice.classList.toggle('ctc-error', error); }
async function transport(path, body) {
  const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), 20_000);
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
const api = async (action, input = {}) => { const generation = state.generation; const result = await transport('/ui/api', { action, input }); if (generation !== state.generation) { const error = new Error('页面已切换'); error.code = 'STALE_VIEW'; throw error; } return result; };
const routeTo = path => { location.hash = `/${path}`; };
function nav() {
  document.getElementById('project-nav').innerHTML = `<div class="ctc-navlabel">项目</div>${state.projects.map(project => link(project.name, `project/${encodeURIComponent(project.id)}`, 'ctc-nav')).join('')}${link('＋ 添加项目', 'new-project', 'ctc-nav')}`;
  root.querySelectorAll('.ctc-nav').forEach(item => { if (item.hash === location.hash) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
}
function projectName(id) { return state.projects.find(project => project.id === id)?.name ?? '项目'; }
function taskCards(tasks) {
  return tasks.map(task => `<a class="ctc-taskcard" href="#/task/${encodeURIComponent(task.id)}"><strong>${escape(task.title)}</strong><span class="ctc-label">${escape(task.goal)}</span><span>${pill(label(task.status))}</span></a>`).join('');
}
function draftCards(drafts) {
  return drafts.filter(draft => !draft.confirmedBigTaskId).map(draft => `<a class="ctc-taskcard" href="#/draft/${encodeURIComponent(draft.id)}"><strong>${escape(draft.title)}</strong><span class="ctc-label">${escape(draft.goal)}</span><span>${pill(draft.kind === 'SMALL_TASK' ? '小任务 · 方向待确认' : '大任务 · 方向待确认', 'ctc-wait')}</span></a>`).join('');
}
async function loadWorkspace() { state.projects = (await api('workspace')).projects; nav(); }
async function home(kind) {
  const records = await Promise.all(state.projects.map(project => api('project', { projectId: project.id })));
  if (kind === 'home') return heading('你的工程工作台', '对齐方向，安排任务，交付成果。', link('＋ 新任务', 'new-task', 'ctc-button ctc-primary')) + (records.length ? `<div class="ctc-project-grid">${records.map(record => `<section class="ctc-surface"><div class="ctc-subtitle"><h2>${escape(record.project.name)}</h2>${link('打开 →', `project/${encodeURIComponent(record.project.id)}`, 'ctc-link')}</div>${facts([['待讨论', `${record.drafts.filter(draft => !draft.confirmedBigTaskId).length} 项`], ['进行中', `${record.bigTasks.filter(task => task.status === 'IN_PROGRESS').length} 项任务`]])}<div class="ctc-actions ctc-spaced">${link('项目讨论', `project/${encodeURIComponent(record.project.id)}/discussion`)}${link('交新任务', `new-task/${encodeURIComponent(record.project.id)}`)}</div></section>`).join('')}</div>` : empty('从一个项目开始', '选择你的本地 Git 仓库，然后在项目里讨论或交任务。', link('添加项目', 'new-project', 'ctc-button ctc-primary')));
  const drafts = records.flatMap(record => record.drafts).filter(draft => !draft.confirmedBigTaskId);
  const tasks = records.flatMap(record => record.bigTasks);
  const details = await Promise.all(tasks.map(task => api('task', { bigTaskId: task.id })));
  if (kind === 'results') {
    const finished = details.filter(detail => ['AWAITING_ACCEPTANCE', 'ACCEPTED', 'CLOSED'].includes(detail.execution?.phase));
    return heading('成果记录', '工程检查与产品验收分别保留。') + (finished.length ? `<div class="ctc-project-grid">${finished.map(detail => `<a class="ctc-taskcard" href="#/task/${encodeURIComponent(detail.task.id)}/results"><strong>${escape(detail.task.title)}</strong><span>${pill(label(detail.execution.phase), detail.execution.phase === 'ACCEPTED' ? 'ctc-good' : 'ctc-wait')}</span><span class="ctc-label">${escape(projectName(detail.task.projectId))}</span></a>`).join('')}</div>` : empty('还没有交付的成果', '执行完成后，成果和验收入口会出现在这里。'));
  }
  const decisions = details.filter(detail => ['HUMAN_REQUIRED', 'AWAITING_ACCEPTANCE'].includes(detail.execution?.phase) || (!detail.execution && ['APPROVED', 'HUMAN_REQUIRED'].includes(detail.planning?.phase)));
  return heading('需要你决定', '产品方向、实施计划和真正超出约定的事项。') + (drafts.length || decisions.length ? `<div class="ctc-project-grid">${draftCards(drafts)}${decisions.map(detail => `<a class="ctc-taskcard" href="#/task/${encodeURIComponent(detail.task.id)}/${detail.execution?.phase === 'AWAITING_ACCEPTANCE' ? 'results' : 'plan'}"><strong>${escape(detail.task.title)}</strong><span>${pill(detail.execution ? label(detail.execution.phase) : detail.planning.phase === 'APPROVED' ? '计划待批准' : '产品问题待回答', 'ctc-wait')}</span></a>`).join('')}</div>` : empty('当前没有待处理的决定', '已批准范围内的工作会按任务约定推进。'));
}
async function projectPage(id, tab) {
  const record = await api('project', { projectId: id }); state.project = record; state.scope = { kind: 'PROJECT', id };
  const head = `<div class="ctc-crumb">项目 / ${escape(record.project.name)}</div>` + heading(record.project.name, '长期目标与项目约定保留在这里。', link('＋ 新任务', `new-task/${encodeURIComponent(id)}`, 'ctc-button ctc-primary'));
  const tabs = tabsHtml('project', id, tab, [['overview', '任务'], ['discussion', '项目讨论'], ['context', '项目约定']]);
  if (tab === 'discussion') return head + tabs + await discussionHtml();
  if (tab === 'context') return head + tabs + await contextHtml();
  return head + tabs + `<div class="ctc-summary"><span class="ctc-label">${escape(record.project.repository.kind === 'PATH' ? record.project.repository.path : record.project.repository.reference)}</span><input class="ctc-search" aria-label="搜索当前项目任务" placeholder="搜索任务…" data-search></div><div class="ctc-project-grid" id="task-grid">${draftCards(record.drafts)}${taskCards(record.bigTasks)}</div>` + (!record.drafts.length && !record.bigTasks.length ? empty('还没有任务', '可以先在项目层讨论，也可以直接交一个大任务或小任务。', link('开始讨论', `project/${encodeURIComponent(id)}/discussion`)) : '');
}
function tabsHtml(type, id, tab, entries) {
  return `<nav class="ctc-tabs" aria-label="当前工作内容">${entries.map(([value, title]) => `<a class="ctc-tab" aria-current="${value === tab ? 'page' : 'false'}" href="#/${type}/${encodeURIComponent(id)}/${value}">${title}</a>`).join('')}</nav>`;
}
function briefForm(brief, draft) {
  const saved = state.drafts.get(`brief:${draft.id}`); if (saved) brief = saved;
  return `<section class="ctc-surface ctc-reading"><div class="ctc-subtitle"><h2>确认这次要做成什么</h2>${pill('开工前', 'ctc-wait')}</div><form data-form="direction" class="ctc-brief">${field('title', '任务名称', brief.title, { max: 200 })}${field('goal', '希望得到的结果', brief.goal, { multiline: true, max: 1000 })}${field('scopeIn', '这次要做什么 · 每行一项', Array.isArray(brief.scopeIn) ? brief.scopeIn.join('\n') : brief.scopeIn ?? '', { multiline: true })}${field('successCriteria', '怎样判断做好了 · 每行一项', Array.isArray(brief.successCriteria) ? brief.successCriteria.join('\n') : brief.successCriteria ?? '', { multiline: true })}${field('scopeOut', '留到后续的内容 · 每行一项', Array.isArray(brief.scopeOut) ? brief.scopeOut.join('\n') : brief.scopeOut ?? '', { multiline: true, required: false })}${reviewSelect('reviewIntensity', brief.reviewIntensity ?? localStorage.getItem('ctc-review') ?? 'STANDARD')}<details><summary>规划的时间与用量约定</summary>${field('planningTokenLimit', '规划 token 上限', brief.planningTokenLimit ?? '120000', { type: 'number', min: 1000, max: 120000 })}<label class="ctc-choice"><input type="checkbox" name="measureOnly" ${brief.measureOnly ? 'checked' : ''}><span>本次规划只计量用量，以时间窗口约束<small>这是当前任务的明确例外；不会变成所有任务的默认设置。</small></span></label>${field('planningMinutes', '本次规划窗口（分钟）', brief.planningMinutes ?? '60', { type: 'number', min: 1, max: 180 })}</details><div class="ctc-actions"><button class="ctc-button ctc-primary" type="submit">确认方向并生成计划</button><span class="ctc-label">先生成并审核计划，不开始改代码。</span></div></form></section>`;
}
async function draftPage(id) {
  const draft = await api('draft', { draftId: id }); state.draft = draft; state.scope = { kind: 'DRAFT', id };
  const head = `<div class="ctc-crumb">${escape(projectName(draft.projectId))} / ${draft.kind === 'SMALL_TASK' ? '小任务' : '大任务'} / 方向讨论</div>` + heading(draft.title, draft.goal);
  if (draft.confirmedBigTaskId) return head + empty('方向已确认', '讨论原文继续保留；到任务页查看计划和后续执行。', link('打开任务', `task/${encodeURIComponent(draft.confirmedBigTaskId)}`, 'ctc-button ctc-primary')) + await discussionHtml();
  const discussion = await discussionHtml();
  const proposal = state.latestProposal;
  return head + `<div class="ctc-note"><span>先把方向聊清楚，再确认下面的产品方案。</span>${button('查看方向表单 ↓', 'scroll-direction')}</div>` + discussion + `<div class="ctc-sectiontitle" id="direction"><h2>产品方向</h2><span class="ctc-label">可直接修改后确认</span></div>` + briefForm(proposal ?? { title: draft.title, goal: draft.goal, scopeIn: [], scopeOut: [], successCriteria: [] }, draft);
}
async function discussionHtml() {
  const scope = state.scope;
  const result = await api('discussion', { scope }); state.turns = result.turns; state.latestProposal = result.latestProposal; state.after = result.previousAfter; state.hasMore = result.hasPrevious;
  const context = await api('context', { scope });
  return `<div class="ctc-two"><section class="ctc-surface"><div class="ctc-subtitle"><h2>${{ PROJECT: '项目讨论', BIG_TASK: '任务讨论', SUBTASK: '小任务讨论', DRAFT: '方向讨论' }[scope.kind]}</h2>${pill('讨论不直接执行')}</div><div id="messages">${messagesHtml(state.turns)}</div><div id="older-messages">${result.hasPrevious ? button('加载更早的对话', 'more-messages') : ''}</div><form class="ctc-composer" data-form="discussion"><textarea name="message" aria-label="讨论内容" maxlength="8000" required placeholder="描述你的想法，或指出想调整的地方…">${escape(state.drafts.get(scopeKey(scope)) ?? '')}</textarea><div class="ctc-composerfoot"><span class="ctc-label">使用当前范围的上下文</span><button class="ctc-button ctc-primary" type="submit" ${state.turns.some(turn => turn.status === 'RUNNING') ? 'disabled' : ''}>发送</button></div></form></section><aside class="ctc-surface"><h3>这次讨论参考什么</h3><div class="ctc-contextitem">当前${scope.kind === 'PROJECT' ? '项目' : '任务'}的目标<span>原始讨论留在各自范围</span></div>${context.items.slice(0, 8).map(item => `<div class="ctc-contextitem">${escape(item.title)}<span>${escape(item.authority === 'HUMAN' ? '你确认的结论' : '已接受的项目记录')}</span></div>`).join('')}<hr class="ctc-rule"><p class="ctc-label">其他任务的原始聊天不会自动带入。影响产品方向的建议，需要你另行确认。</p>${scope.kind !== 'DRAFT' ? `<div class="ctc-spaced">${button('保存一条已确认结论', 'context-dialog')}</div>` : ''}</aside></div>`;
}
function messagesHtml(turns) {
  if (!turns.length) return `<div class="ctc-empty"><h3>从这里开始讨论</h3><p>告诉 Console 想要什么结果。任务相关的决定会先整理给你确认。</p></div>`;
  return turns.map(turn => `<article class="ctc-message ctc-human"><div class="ctc-messagehead"><span class="ctc-avatar">H</span><strong>你</strong><span class="ctc-label">${escape(timestamp(turn.createdAt))}</span></div><p>${escape(turn.message)}</p></article><article class="ctc-message"><div class="ctc-messagehead"><span class="ctc-avatar">C</span><strong>Console</strong>${pill(label(turn.status), turn.status === 'RUNNING' ? 'ctc-wait' : '')}</div><p>${escape(turn.answer?.reply ?? (turn.status === 'RUNNING' ? '正在思考。你可以切换页面，回复会保存在这里。' : '本轮没有得到可用回复。原消息已保存，可以继续讨论；不会自动重复调用。'))}</p>${turn.answer?.proposal ? '<p class="ctc-small">已整理产品方向建议，可在方向表单中查看和修改。</p>' : ''}<p class="ctc-small">${turn.status === 'RUNNING' ? '用量统计中' : `本轮用量：${num(turn.usage?.totalTokens)} tokens`}${turn.failureCode ? ` · ${escape(reasons[turn.failureCode] ?? '本轮中断')}` : ''}</p></article>`).join('');
}
async function contextHtml() {
  const context = await api('context', { scope: state.scope });
  return `<section class="ctc-surface"><div class="ctc-subtitle"><h2>当前采用的结论</h2>${button('保存已确认结论', 'context-dialog', true)}</div>${context.items.length ? context.items.map(item => `<article class="ctc-contextitem"><h3>${escape(item.title)}</h3><p>${escape(item.body)}</p><span>${escape(item.authority)} · ${escape(timestamp(item.provenance.effectiveAt))}</span></article>`).join('') : '<p class="ctc-label">还没有单独记录的长期结论。任务目标与批准的计划仍然有效。</p>'}<details><summary>当前任务目标</summary><pre class="ctc-evidence">${escape(JSON.stringify(context.intent, null, 2))}</pre></details></section>`;
}
async function taskPage(id, tab) {
  const record = await api('task', { bigTaskId: id }); state.task = record; state.scope = { kind: 'BIG_TASK', id };
  const execution = record.execution;
  const head = `<div class="ctc-crumb">${link(projectName(record.task.projectId), `project/${encodeURIComponent(record.task.projectId)}`, 'ctc-link')} / ${record.sourceDraft?.kind === 'SMALL_TASK' ? '小任务' : '大任务'}</div>` + heading(record.task.title, record.task.goal, `${link('后续改进', `new-task/${encodeURIComponent(record.task.projectId)}/${encodeURIComponent(id)}`)}${execution && ['RUNNING'].includes(execution.phase) ? button('暂停推进', 'pause') : execution && record.canResume ? button(execution.phase === 'APPROVED' ? '开始执行' : '继续执行', 'start', true) : ''}`) + tabsHtml('task', id, tab, [['overview', '概览'], ['discussion', '讨论'], ['plan', '计划'], ['tasks', '小任务'], ['results', '成果'], ['context', '上下文']]);
  if (tab === 'discussion') return head + (record.sourceDraft ? `<div class="ctc-note">${link('查看开工前的方向讨论', `draft/${encodeURIComponent(record.sourceDraft.id)}`, 'ctc-link')}</div>` : '') + await discussionHtml();
  if (tab === 'context') return head + await contextHtml();
  if (tab === 'plan') return head + planHtml(record);
  if (tab === 'tasks') return head + subtasksHtml(record);
  if (tab === 'results') return head + await resultHtml(record);
  const phase = execution?.phase ?? record.planning?.phase;
  return head + `<div class="ctc-summary">${pill(label(phase ?? record.task.status), ['HUMAN_REQUIRED', 'PAUSED', 'AWAITING_ACCEPTANCE'].includes(phase) ? 'ctc-wait' : 'ctc-good')}<span class="ctc-label">${escape((record.canResume && execution?.stopReason === 'TIME_LIMIT_REACHED' ? '续跑时间已更新，可以继续执行' : reasons[execution?.stopReason ?? record.planning?.stopReason]) ?? (record.planningActive ? '正在规划或审核' : '当前状态来自已保存记录'))}</span></div>${blockersHtml(record)}<div class="ctc-two"><section class="ctc-surface"><h2>这次的目标与范围</h2><div class="ctc-spaced">${facts([['希望得到', record.task.goal], ['这次包含', record.task.scopeIn.join('；')], ['成功标准', record.task.acceptanceCriteria.join('；')], ['留到后续', record.task.scopeOut.join('；') || '未单独列出']])}</div></section><aside class="ctc-surface"><h3>下一步</h3><div class="ctc-spaced">${!execution ? (record.planning?.phase === 'APPROVED' ? `<p>具体计划已完成审核，等待你批准实施。</p>${link('查看计划', `task/${encodeURIComponent(id)}/plan`, 'ctc-button ctc-primary')}` : record.planning?.phase === 'READY' && !record.planningActive ? button('生成并审核计划', 'plan-start', true) : '<p>规划状态和需要回答的问题，会在这里更新。</p>') : `<p>${escape(execution.phase === 'AWAITING_ACCEPTANCE' ? '工程流程已完成，请查看成果并亲自测试。' : execution.phase === 'ACCEPTED' ? '产品已验收，可开始下一项工作。' : execution.phase === 'CLOSED' ? '本次流程已收尾。未验收的方向和跳过的检查保留记录。' : '按批准的计划推进；需要处理的问题会明确列出。')}</p>${link('查看成果与记录', `task/${encodeURIComponent(id)}/results`)}`}</div></aside></div>${execution ? usageHtml(execution) : ''}<div class="ctc-sectiontitle"><h2>任务安排</h2>${link('完整看板 →', `task/${encodeURIComponent(id)}/tasks`, 'ctc-link')}</div>${subtasksHtml(record)}`;
}
function blockersHtml(record) {
  const questions = record.planning?.questions ?? [];
  const execution = record.execution;
  const control = execution?.lastControlFailure;
  const role = execution?.lastRoleFailure;
  if (!questions.length && !execution?.stopReason && !record.planning?.stopReason) return '';
  return `<section class="ctc-surface ctc-spaced"><div class="ctc-subtitle"><h2>当前需要处理</h2>${pill('记录已保留', 'ctc-wait')}</div>${questions.map(question => `<p>${escape(question)}</p>`).join('')}<p>${escape(reasons[execution?.stopReason ?? record.planning?.stopReason] ?? '查看下面的记录后决定下一步。')}</p>${control ? `<p class="ctc-small">失败阶段：${escape(control.phase)} · 原因：${escape(control.failureCode)}</p>` : ''}${role ? `<p class="ctc-small">模型阶段：${escape(role.phase)} · 原因：${escape(role.failureCode)}</p>` : ''}<div class="ctc-actions ctc-spaced">${!execution && record.planning?.phase === 'HUMAN_REQUIRED' ? link('回答问题并准备新计划', `new-task/${encodeURIComponent(record.task.projectId)}/${encodeURIComponent(record.task.id)}`) : ''}${execution && ['PAUSED', 'HUMAN_REQUIRED'].includes(execution.phase) && (role || control) ? button('查看可恢复的步骤', execution.stopReason === 'USAGE_UNKNOWN' ? 'qa-recovery-review' : 'recovery-review') : ''}${execution && record.canRenewWindow ? button('调整续跑时间', 'renew-dialog') : ''}${link('回到讨论', `task/${encodeURIComponent(record.task.id)}/discussion`)}</div></section>`;
}
function usageHtml(execution) {
  const activity = execution.activeRole;
  return `<section class="ctc-surface ctc-spaced"><div class="ctc-subtitle"><h2>当前活动与用量</h2>${pill(execution.activeRoleCount ? '仍在执行' : '无活动步骤')}</div><div class="ctc-grid2">${facts([['正在做什么', activity ? `${label(activity.role)} · ${activity.progress?.phase ?? '运行中'}` : '当前没有运行中的模型步骤'], ['已确认用量', `${num(execution.knownTokens)} tokens${execution.unknownCompletedUsage ? '，另有未知用量' : ''}`]])}${facts([['执行次数', `${num(execution.roleCalls)} / ${num(execution.limits.roleCallLimit)}`], ['本次截止时间', timestamp(execution.expiresAt)]])}</div><details><summary>详细用量与预算记录</summary><pre class="ctc-evidence">${escape(JSON.stringify({ limits: execution.limits, usageBreakdown: execution.usageBreakdown, usageComplete: execution.usageComplete, activeRole: activity, windowRenewal: execution.windowRenewal }, null, 2))}</pre></details></section>`;
}
function planHtml(record) {
  const candidate = record.plan?.reviewState?.candidate;
  if (!candidate) return blockersHtml(record) + empty(record.planningActive || record.planning?.phase === 'RUNNING' ? '正在生成或审核计划' : '计划尚未生成', '方向确认后，Console 提出具体任务并完成工程审核；你批准计划后才开始改代码。', record.planning?.phase === 'READY' && !record.planningActive ? button('生成并审核计划', 'plan-start', true) : '');
  return blockersHtml(record) + `<section class="ctc-surface"><div class="ctc-subtitle"><h2>具体实施计划</h2>${pill(`第 ${candidate.revision} 版 · ${label(record.planning?.phase)}`)}</div>${record.contracts.map((contract, index) => `<article class="ctc-contextitem"><h3>${index + 1}. ${escape(contract.title)}</h3><p>${escape(contract.goal)}</p><span>完成标准：${escape(contract.acceptanceCriteria.join('；'))}</span><span>检查深度：${escape(label(candidate.subtasks.find(task => task.id === contract.subtaskId)?.profile))}</span></article>`).join('')}<details><summary>任务依赖、范围与完整计划</summary><pre class="ctc-evidence">${escape(JSON.stringify({ dependencies: candidate.dependencies, contracts: record.contracts }, null, 2))}</pre></details>${!record.execution && record.planning?.phase === 'APPROVED' ? `<div class="ctc-actions ctc-spaced">${button('核对计划并批准实施', 'execution-review', true)}${link('先讨论调整', `task/${encodeURIComponent(record.task.id)}/discussion`)}</div>` : ''}</section>`;
}
function subtasksHtml(record) {
  if (!record.subtasks.length) return empty('小任务尚未开始', '批准具体计划后，这里会显示实际的小任务与依赖状态。');
  const groups = [['待开始', ['TODO']], ['进行中', ['IN_PROGRESS', 'QA_DEBUG']], ['已完成或收尾', ['DONE', 'DROPPED', 'ARCHIVED']]];
  return `<div class="ctc-board">${groups.map(([name, statuses]) => `<section class="ctc-lane"><div class="ctc-lanehead"><strong>${name}</strong><span class="ctc-label">${record.subtasks.filter(task => statuses.includes(task.status)).length}</span></div>${record.subtasks.filter(task => statuses.includes(task.status)).map(task => `<a class="ctc-taskcard" href="#/subtask/${encodeURIComponent(task.id)}"><strong>${escape(task.title)}</strong><span class="ctc-label">${escape(task.goal)}</span><span>${pill(label(task.maturity), task.maturity === 'ACCEPTED' ? 'ctc-good' : '')}</span></a>`).join('')}</section>`).join('')}</div>`;
}
async function subtaskPage(id, tab) {
  const record = await api('subtask', { subtaskId: id }); state.subtask = record; state.scope = { kind: 'SUBTASK', id };
  const head = `<div class="ctc-crumb">${link('父任务', `task/${encodeURIComponent(record.task.bigTaskId)}`, 'ctc-link')} / 小任务</div>` + heading(record.task.title, record.task.goal) + tabsHtml('subtask', id, tab, [['overview', '执行与证据'], ['discussion', '小任务讨论'], ['context', '上下文']]);
  if (tab === 'discussion') return head + (record.sourceDraft ? `<div class="ctc-note">${link('查看开工前的方向讨论', `draft/${encodeURIComponent(record.sourceDraft.id)}`, 'ctc-link')}</div>` : '') + await discussionHtml();
  if (tab === 'context') return head + await contextHtml();
  return head + `<div class="ctc-summary">${pill(label(record.task.status))}${pill(label(record.task.maturity), record.task.maturity === 'ACCEPTED' ? 'ctc-good' : '')}${pill(record.inspection.dependencyReadiness.ready ? '依赖已就绪' : '等待依赖', record.inspection.dependencyReadiness.ready ? '' : 'ctc-wait')}</div><section class="ctc-surface">${facts([['目标', record.task.goal], ['完成标准', record.task.acceptanceCriteria.join('；')], ['当前工作区', record.inspection.worktree ? label(record.inspection.worktree.status) : '尚未创建']])}</section><div class="ctc-sectiontitle"><h2>执行历史</h2></div><section class="ctc-surface">${record.inspection.durableExecution.recentChatThreads.flatMap(thread => thread.runs.map(run => `<article class="ctc-contextitem"><strong>${escape(label(run.status))}</strong><span>${escape(timestamp(run.updatedAt))} · ${escape(run.providerModelId ?? '模型信息未返回')} · ${num(run.normalizedUsage?.totalTokens)} tokens</span></article>`)).join('') || '<p class="ctc-label">还没有执行记录。</p>'}<details><summary>任务阶段、检查与完成证据</summary><pre class="ctc-evidence">${escape(JSON.stringify({ workflow: record.workflow, checkpoints: record.checkpoints }, null, 2))}</pre></details></section>`;
}
async function resultHtml(record) {
  const execution = record.execution;
  if (!execution?.resultRefCreated) return empty('尚未产生可交付的结果', '执行后的成果、改动和检查结论会保留在这里。');
  const delivery = await api('delivery', { bigTaskId: record.task.id });
  const preview = await api('preview-status', { bigTaskId: record.task.id }); state.preview = preview;
  const previewUrl = preview.phase === 'READY' && /^http:\/\/localhost:[0-9]{1,5}$/.test(preview.url ?? '') ? preview.url : null;
  const canAccept = execution.phase === 'AWAITING_ACCEPTANCE';
  return `<section class="ctc-surface"><div class="ctc-subtitle"><h2>当前交付</h2>${pill(label(execution.phase), execution.phase === 'ACCEPTED' ? 'ctc-good' : 'ctc-wait')}</div>${facts([['成果版本', delivery.headSha], ['结果分支', delivery.resultRef], ['已整合的小任务', `${execution.integratedSubtaskIds.length} 项`]])}${execution.closeout ? `<div class="ctc-note ctc-spaced">${escape(execution.closeout.reason)} · 产品验收未通过或未执行。</div>` : ''}<div class="ctc-actions ctc-spaced">${previewUrl ? `<a class="ctc-button ctc-primary" href="${escape(previewUrl)}" target="_blank" rel="noopener noreferrer">打开本机成果</a>${button('停止预览', 'preview-stop')}` : button(preview.phase === 'STARTING' ? '预览启动中…' : '启动本机网页预览', 'preview-start', true, preview.phase === 'STARTING' ? 'disabled' : '')}${button('查看文件改动', 'show-diff')}${canAccept ? button('我已测试，确认产品验收', 'accept-dialog') : ''}${link('反馈与后续改进', `new-task/${encodeURIComponent(record.task.projectId)}/${encodeURIComponent(record.task.id)}`)}${canAccept ? button('保留问题并收尾', 'close-dialog') : ''}</div>${preview.phase === 'FAILED' ? `<p class="ctc-label">${preview.failureCode === 'PREVIEW_UNSUPPORTED' ? '这个成果没有可自动启动的网页入口。当前支持根目录 index.html 或 server/index.mjs；仍可查看成果分支和文件改动。' : '预览启动失败。成果与执行记录仍保留，可查看改动后重试。'}</p>` : ''}<pre class="ctc-evidence">${escape(delivery.stat || '没有文件改动')}</pre><details id="diff-details"><summary>展开文件改动${delivery.truncated ? '（内容较长，当前显示部分）' : ''}</summary><pre class="ctc-evidence">${escape(delivery.diffUnavailable ? '完整文件改动暂时无法载入（例如改动超过显示容量）。成果版本和其他操作仍可使用；可通过结果分支查看完整改动。' : delivery.diff)}</pre></details></section><div class="ctc-sectiontitle"><h2>工程检查</h2></div>${subtasksHtml(record)}${usageHtml(execution)}`;
}
function newProject() { return heading('添加本地项目', '选择现有 Git 仓库。记录保存在本机；讨论和执行使用已登录的 Codex 模型。') + `<form data-form="project" class="ctc-surface ctc-reading">${field('name', '项目名称', '', { max: 200 })}${field('slug', '项目简称 · 小写英文与连字符', '', { max: 100 })}${field('repositoryPath', '本地 Git 仓库的完整路径', '', { max: 2000 })}${field('defaultBranch', '默认分支', 'main', { max: 100 })}<button class="ctc-button ctc-primary" type="submit">添加项目</button></form>`; }
async function newTask(projectId, relatedBigTaskId) { const related = relatedBigTaskId ? await api('task', { bigTaskId: relatedBigTaskId }) : null; return heading('先说你想做成什么', '你可以交一个大任务，也可以直接交一个明确的小任务。') + (state.projects.length ? `<form data-form="new-task" class="ctc-surface ctc-reading"><div class="ctc-grid2"><label class="ctc-field">所属项目<select name="projectId">${state.projects.map(project => `<option value="${escape(project.id)}" ${project.id === projectId ? 'selected' : ''}>${escape(project.name)}</option>`).join('')}</select></label><label class="ctc-field">任务大小<select name="kind"><option value="BIG_TASK">大任务 · 需要讨论和拆分</option><option value="SMALL_TASK">小任务 · 一项明确改动</option></select></label></div>${related ? `<div class="ctc-note">关联任务：${escape(related.task.title)}。原目标和已确认结论会带入下一步方向讨论。</div>` : ''}${field('title', '任务名称', related ? `后续：${related.task.title}`.slice(0, 200) : '', { max: 200 })}${field('goal', '希望得到什么结果', related?.task.goal ?? '', { multiline: true, max: 1000 })}${relatedBigTaskId ? `<input type="hidden" name="relatedBigTaskId" value="${escape(relatedBigTaskId)}"><p class="ctc-label">这是关联原任务的后续工作，不会改写原来的执行计划。</p>` : ''}<div class="ctc-actions ctc-spaced"><button class="ctc-button ctc-primary" type="submit">创建并讨论方向</button><span class="ctc-label">不会直接开始改代码。</span></div></form>` : empty('先添加一个项目', '任务需要属于一个明确的本地仓库。', link('添加项目', 'new-project', 'ctc-button ctc-primary'))); }
function settings() { return heading('任务偏好', '按任务难度选择检查深度；每项任务开工前都能调整。') + `<form data-form="settings" class="ctc-surface ctc-reading">${reviewSelect('reviewIntensity', localStorage.getItem('ctc-review') ?? 'STANDARD')}<label class="ctc-field">外观<select name="theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><p class="ctc-label">范围内的工具和工程检查自动进行。产品方向、计划和超出约定的事项交给你决定。已批准任务保留其原有约定。</p><div class="ctc-actions ctc-spaced"><button class="ctc-button ctc-primary" type="submit">保存偏好</button></div></form>`; }
async function renderRoute() {
  const generation = ++state.generation;
  if (modal.open) modal.close(); state.modalContext = null;
  state.reading = true;
  state.route = location.hash.replace(/^#\//, '').split('/').map(part => { try { return decodeURIComponent(part); } catch { return ''; } });
  const [type = 'home', id, tab = 'overview'] = state.route; state.tab = tab; state.scope = null; state.task = null; state.subtask = null; state.draft = null; state.turns = []; state.preview = null;
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
    main.innerHTML = html;
    if (type === 'settings') main.querySelector('[name=theme]').value = localStorage.getItem('ctc-theme') ?? 'system';
  } catch (error) {
    if (generation !== state.generation) return;
    notify(error.message, true);
    main.innerHTML = empty('暂时无法载入这部分内容', error.message, button('重新读取状态', 'refresh', true));
  } finally { if (generation === state.generation) { state.reading = false; main.removeAttribute('aria-busy'); } }
}
function openModal(title, body, action, confirm = '确认') {
  state.modalAction = action;
  state.modalContext = { generation: state.generation, scope: state.scope ? structuredClone(state.scope) : null, task: state.task, review: state.review };
  modalContent.innerHTML = `<h2 id="modal-title">${escape(title)}</h2>${body}<div class="ctc-actions"><button type="button" data-modal="cancel">返回</button><button type="button" class="ctc-primary" data-modal="confirm">${escape(confirm)}</button></div>`;
  modal.showModal();
}
async function act(action) {
  if (action === 'refresh') { await loadWorkspace(); await renderRoute(); return; }
  if (action === 'scroll-direction') { document.getElementById('direction')?.scrollIntoView({ behavior: 'smooth' }); return; }
  if (action === 'more-messages') {
    const result = await api('discussion', { scope: state.scope, after: state.after }); state.turns = [...new Map([...result.turns, ...state.turns].map(turn => [turn.sequence, turn])).values()].sort((a, b) => a.sequence - b.sequence); state.after = result.previousAfter; state.hasMore = result.hasPrevious;
    document.getElementById('messages').innerHTML = messagesHtml(state.turns); document.getElementById('older-messages').innerHTML = result.hasPrevious ? button('加载更早的对话', 'more-messages') : ''; return;
  }
  if (action === 'context-dialog') { openModal('保存已确认的结论', `<p>只在当前范围内生效。涉及正在执行的任务时，结论不会改写已经批准的计划。</p>${field('title', '结论标题', '', { max: 200 })}${field('body', '确认的内容', '', { multiline: true, max: 4000 })}`, 'context-confirm', '保存结论'); return; }
  const record = state.task; const id = record?.task.id;
  if (action === 'plan-start') { await api('planning-start', { bigTaskId: id }); notify('规划已提交。你可以离开页面，结果会保留。'); await renderRoute(); }
  if (action === 'pause') { await api('execution-pause', { bigTaskId: id }); notify('已请求暂停；请看当前步骤是否已经安全停止。'); await renderRoute(); }
  if (action === 'start') { await api('execution-start', { bigTaskId: id }); notify('已从保存的进度开始推进。'); await renderRoute(); }
  if (action === 'execution-review') {
    state.review = await api('execution-review', { bigTaskId: id });
    openModal('确认计划并开始实施', `<p>按刚才查看的计划实施，完成约定的检查与修复；最终产品验收仍由你决定。</p>${field('minutes', '本次运行窗口（分钟）', '180', { type: 'number', min: 1, max: 180 })}${field('tokens', '本次 token 上限', '2000000', { type: 'number', min: 1, max: 2880000 })}${field('calls', '最多模型步骤', '96', { type: 'number', min: 1, max: 192 })}<label class="ctc-field">QA 未通过后的修复轮数<select name="repairs"><option value="1">最多一轮</option><option value="2" selected>最多两轮</option></select></label>${state.review.executionIssues?.length ? `<p>当前计划仍有执行问题，请先处理：${escape(JSON.stringify(state.review.executionIssues))}</p>` : ''}`, 'execution-approve', '批准并开始');
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
  if (type === 'settings') { localStorage.setItem('ctc-review', data.reviewIntensity); localStorage.setItem('ctc-theme', data.theme); document.documentElement.style.colorScheme = data.theme === 'system' ? 'light dark' : data.theme; notify('偏好已保存，现有任务的约定保持不变。'); return; }
  if (type === 'project') { const project = await api('project-create', { ...data, requestId: requestId('project') }); state.requestIds.delete('project'); await loadWorkspace(); routeTo(`project/${encodeURIComponent(project.id)}`); }
  if (type === 'new-task') { const draft = await api('draft-create', { ...data, requestId: requestId('new-task') }); state.requestIds.delete('new-task'); routeTo(`draft/${encodeURIComponent(draft.id)}`); }
  if (type === 'discussion') {
    const scope = state.scope; const key = scopeKey(scope);
    await api('discuss', { requestId: requestId(key), scope, message: data.message }); state.requestIds.delete(key); state.drafts.delete(key); notify('消息已保存，回复会显示在当前讨论中。'); await renderRoute();
  }
  if (type === 'direction') {
    const result = await api('direction-confirm', { draftId: state.draft.id, revision: state.draft.revision,
      brief: { title: data.title, goal: data.goal, scopeIn: lines(data.scopeIn), scopeOut: lines(data.scopeOut), successCriteria: lines(data.successCriteria) },
      reviewIntensity: data.reviewIntensity, planningTokenLimit: Number(data.planningTokenLimit),
      ...(data.measureOnly ? { planningMeasureOnlyMinutes: Number(data.planningMinutes) } : {}) });
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
  if (action === 'context-confirm') { const key = `context:${scopeKey(scope)}`; await api(action, { requestId: requestId(key), scope, title: value('title'), body: value('body') }); state.requestIds.delete(key); }
  if (action === 'execution-approve') { await api(action, { bigTaskId: id, planDigest: review.planDigest, repositoryHeadSha: review.repositoryHeadSha,
    limits: { durationMilliseconds: Number(value('minutes')) * 60_000, totalTokenLimit: Number(value('tokens')), roleCallLimit: Number(value('calls')), repairCycleLimit: Number(value('repairs')) } }); await api('execution-start', { bigTaskId: id }); }
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
root.addEventListener('submit', event => { event.preventDefault(); void guarded(() => submit(event.target)); });
root.addEventListener('click', event => { if (state.pending && event.target.closest('a')) { event.preventDefault(); return; } const target = event.target.closest('[data-action]'); if (target) void guarded(() => act(target.dataset.action)); });
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
