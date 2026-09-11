/** Registered Console integration and policy, not a claim of successful live tool use. */
export function describeConsoleCapabilities(executionNetwork: boolean | null) {
  return [
    { id: 'context', title: '项目与任务上下文', state: 'CONNECTED', detail: '读取当前范围的目标、代码、计划、失败记录和历史讨论；可以附截图。' },
    { id: 'search', title: '搜索与网页阅读', state: 'CONNECTED', detail: '聊天与执行已接入 Codex 的公开搜索、打开网页和查找内容；某次访问是否成功以运行记录为准。' },
    { id: 'terminal', title: '终端与文件', state: 'WORKFLOW', detail: '聊天可只读调查；代码修改、命令测试和 Git 操作由已批准任务的执行角色完成。独立 QA 保持只读。' },
    { id: 'network', title: '执行命令联网', state: executionNetwork === null ? 'SELECT_TASK' : executionNetwork ? 'ENABLED' : 'RESTRICTED', detail: executionNetwork === null ? '选择已开工的任务查看它的联网设置。' : executionNetwork ? '当前任务允许联网，包括只读 QA 的联网验证。' : '当前任务的命令联网关闭。可在任务聊天或中断处理处要求开启；搜索工具和命令联网是不同入口。' },
    { id: 'control', title: '聊天推进任务', state: 'WORKFLOW', detail: '项目/大任务聊天能准备计划、按确认开工、暂停和恢复。小任务聊天能推进或暂停自身；父任务中断的调整目前作用于整个大任务，界面会明确标出范围。' },
    { id: 'agents', title: '执行与独立 QA', state: 'WORKFLOW', detail: '执行、可选加固和独立 QA 按任务安排分别运行。并行 agent 调度尚未接入。' },
    { id: 'browser', title: '专用浏览器操作工具', state: 'NOT_CONFIGURED', detail: '尚未接入 Console 的浏览器控制工具；已有网页预览不等于能点击、截图并验证页面。不能据此宣称可视化 QA 已通过。' },
    { id: 'integrations', title: 'Skills 与外部连接器', state: 'NOT_CONFIGURED', detail: '不会自动继承 Codex 桌面中的插件和账户。需逐项接入并验证，不能借用其他项目的凭据。' },
  ] as const;
}
