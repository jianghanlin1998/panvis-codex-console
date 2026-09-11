# Step 9 工作中问题清单

Hanlin 要求：工作中遇到的问题必须记录，后续修复并验证。临时绕过不等于解决；缺少根因、回归证据或真实验收时不能关单。此清单与 CURRENT_STATE.md 一起维护，新的故障先保留准确现场，再修复。

2026-09-08 最新批准：取消剩余浏览器复验，直接收尾 Step 9；随后根治 Console 遗留问题，并将“先确认产品方向，范围内自动执行”固化。Board 内容改版明确延期，收尾不代表产品验收。下表区分代码修复、用户豁免与外部边界；历史未知数据不能编造补齐。

| 编号 | 问题与影响 | 修复／下一步 | 状态与证据 |
| --- | --- | --- | --- |
| S9-01 | 本地模型调用的 TLS 连接失败，真实 Planner 无法完成 | 使用经授权的本地代理，保留运行时的明确代理配置；不绕过 TLS | 后续 Planner、Reviewer、Sol 实施和加固已成功；运行证据见 CURRENT_STATE.md。固定运行环境已验证，其他主机需各自验证 |
| S9-02 | 规划回复受 16 KiB 和流式通知限制，完整方案反复中止 | 已批准的回复上限提高到 100 KiB，输入和下游读取容量同步调整；通知按真实消息处理 | 代码回归和真实规划通过；当前四项计划来自真实 Planner 和 Reviewer |
| S9-03 | 规划命令等待五分钟后退出，但后台规划还在运行，容易被误认为失败 | 规划等待结束后只读查询一次保存状态，明确 WAIT_ENDED；状态不可得时显示 STATUS_UNAVAILABLE，不重发规划 | 已修复；模拟时间验证后台仍运行、已完成和状态不可得三种情况，均只有一次规划请求。原 331.175 秒事件保留为历史证据 |
| S9-04 | Git 过滤器、fsmonitor、清理和嵌套操作的期限覆盖不一致，可能错误推进或超时 | 所有候选检查、整合和工作区释放使用同一执行边界；到期保留可恢复证据 | 已修复；额外独立 re-QA 12 个探针通过，实施提交 4699af7，详见 CURRENT_STATE.md |
| S9-05 | 第二轮修复遗漏前面未解决的问题 | 每轮携带累计阻塞问题，只有通过复审才关闭；两轮失败后停止 | 已修复并通过回归／独立 re-QA；保留两轮限制 |
| S9-06 | 120K 小任务硬上限中断首次实施，单次恢复和历史用量的展示容易混淆 | 最新批准将小任务与总任务 token 都改为统计预警；历史失败和缓存输入照实计入，模型固定 Sol/xhigh | 旧 2M 硬上限已由明确恢复记录改为预警，真实执行超过该值并完成第二项整合；一条旧未知仍保留，新未知仍停止。见 S9-17 |
| S9-07 | 工程 QA 禁止全部命令事件，无法读取代码和执行只读检查 | 允许工作区内的只读命令生命周期；继续禁止文件修改和联网，保留完整性检查 | 代码及全量回归通过；9 月 8 日第一项真实 Sol QA 通过（84,175 tokens）并整合。不能认定这是历史 QA 失败的唯一原因 |
| S9-08 | 自动执行器丢弃模型返回的标准错误码；本地交接错误也只有笼统失败 | 持久保存允许列出的错误码、失败阶段、计数及清理结果；不保存原始错误或敏感数据 | 代码及全量回归通过；历史 QA 的精确原因及消耗仍无法恢复，不能补写为零或已知原因 |
| S9-09 | 本次提高总预算后，下一个小任务仍按旧预算校验；总量和小任务预警口径混用 | 新预算必须绑定用户批准的恢复记录；历史校验保留旧上限，展示分别标明总量和小任务量 | 离线恢复 QA、两任务整合及全量回归通过；真实第一项整合后，第二项已自动开始 |
| S9-10 | 未知用量导致停止；简单重试可能丢失成本或重复调用 | 只允许此次用户明确批准的一条未知 QA 例外；旧记录永久保留未知，后续新未知仍停止，调用和修复次数不重置 | 已真实激活，原 QA 未重放，替代 QA 成功，未知记录仍保留；后续新未知再次停止及重启行为有确定性回归覆盖 |
| S9-11 | 审批重复且自动审批曾拒绝两次，用户难以判断已授权范围 | 产品目标、成功示例、范围和实质变化由 Hanlin 确认；范围内工具、模型、工程审核与约定修复沿用已有授权。审核深度按新任务难度选择 | Console 工作规则和 Planner/Reviewer 输入已固化；并非关闭托管审批。外层曾分别因未识别模型调用授权、怀疑批量修改历史测试而拒绝；已有授权与精确证据应随动作提供。不能伪称能从 Console 取消外部规则 |
| S9-12 | Console 修复进度被误当成 Board 交付进度，用户长时间看不到成果 | 工程完成、产品验收和用户明确要求的收尾分别记录；新增 exact-SHA CLOSE 事件，关闭后禁止自动重开或升级为已验收 | 收尾机制已修复，独立 QA 与两轮修复后的真实 CLI/HTTP 关单、重开数据库、重复请求和错误 SHA 均有回归。Board 四项已整合，48 个离线测试通过；内容方向未验收、浏览器豁免、原文挑战仍如实保留 |
| S9-13 | 长时间实施只显示 RUNNING，缺少可供用户判断进展的中间信号；运行中未结算用量也容易与失败后的未知用量混淆 | 持久保存经过筛选的最近活动时间、当前角色/步骤、工具计数和部分用量；明确 IN_PROGRESS，部分用量不重复计入最终统计 | 已实现并验证活动节流、重开、计数倒退及敏感字段拒绝；显示数据缺失或损坏不打断正式任务和权威用量。最终未知仍独立保留，不改写成零 |
| S9-14 | 第二项结果接收失败，代码不能推进到加固；消息接收器把过程说明和最终结果拼接成一段 JSON | 按协议选择明确的最终回复；没有 phase 的旧消息使用最后一条 completed 内容。沿用已有恢复入口继续保留代码，不新增特例审批接口 | 接收修复与保留代码续跑的确定性验证通过（169 文件／4,732 测试）；真实续跑于 15:49 成功，自动进入加固；实际错误为 STRUCTURED_RESULT_INVALID / RESULT，用量已完整记录，保留代码的 25 个离线测试通过。拼接缺陷已可重现，但该次完整最终回复未留存，不能证明它是此次失败的唯一原因 |
| S9-15 | 采集器首次实施消耗 682,865 tokens，保留代码续跑另用 527,107；重读与续跑成本过高，原始总 token 数也不等于实际费用 | 分列输入、缓存输入、输出、reasoning 与缺失记录；确认 Console 初始输入没有重复注入，并通过 S9-16/19 减少无必要角色和被强制打断后的续跑 | 评估完成并补统计：18 次执行已知输入 7,044,601（含缓存 6,047,360），输出 208,550（含 reasoning 117,836），已知合计 7,253,151，另有一条未知。18 份编译输入共 182,947 字节、每份 8,899–12,338 字节，只各注入一次；字节不是 tokens。无实际账单，不能计算费用或宣称已证实真实节省；新的普通两任务流程确定性验证为四角色，原最高强度需六角色 |
| S9-16 | 风险档位、可达到的完成状态和修复能力绑定过紧，普通任务也容易套用最重流程 | 新确认产品意图的 STANDARD 任务采用实施→独立 QA，失败后支持批准的修复/re-QA；高强度任务另加加固，审核偏好由 Hanlin 按任务选择 | 已修复；两任务 ACCEPTED 依赖、两轮修复、关闭与持久重放通过。STANDARD 可凭独立 QA 从 IMPLEMENTED 到 ACCEPTED，不伪造 HARDENED。旧 STANDARD 的 VERIFY 路径和现有 Board 图保持原合同 |
| S9-17 | 达到总预算后 HARDEN 被标记失败，现有恢复只覆盖初次 EXECUTE 和一条 QA 例外，普通暂停又需要新特例才能继续 | 改为可解释、可保留成果的统一暂停／恢复；用户修改原明确预算后，从原阶段继续，历史用量与审核要求保留。不要再加仅针对本次角色的新接口 | Hanlin 已批准 token 改为统计预警，统一保留阶段续跑的修复及全量回归已通过（170 文件／4,736 测试），已于 16:45 激活；HARDEN 和独立 QA 通过，17:00 前自动整合并启动下一任务。15:58 因 TOKEN_LIMIT_REACHED 停止；已知 2,019,339，加固用量 281,789，零活动调用。该次停止时保留代码 26 个离线测试通过；随后已按新批准模式完成加固和独立 QA，采集器已整合，历史失败与用量继续保留 |
| S9-18 | 当前迁移数量、表清单和升级矩阵分散手填，新增迁移时容易漏改 | 当前迁移数集中为 27，当前 50 表清单也集中为一份独立明确列表；升级矩阵自动覆盖每个迁移并核对明确总数与历史前缀，旧版本重建从钉住的快照识别新增空表 | 此前计数修复通过 4,736 测试；本轮新增进度表再次暴露手工表清单/矩阵遗漏，已扩展根治并通过 257 项邻接回归。历史版本、不可变数据、触发器、外键及回滚断言保持；旧格式重建只移除经验证为空的后续新增表。最初外层审批曾因担心削弱历史测试拒绝批量命令，此次修改有明确上下文和完整断言 |
| S9-19 | 第三项实施仍在产出文件，却被固定 20 分钟单次工作期限中断，新增一次昂贵续跑 | 受大任务授权的单次模型工作使用剩余总窗口；有效活动刷新无活动计时，不能延长用户总期限；保留独立任务无父授权时的旧上限 | 已修复；注入时间的回归覆盖持续活动越过旧单次上限、无活动停止、总期限到期仍停止，均只调用一次。旧 1,199,837-token 中断及其续跑历史不删除 |
| S9-20 | 详情打开期间列表轮询重建，关闭后键盘焦点回到 BODY；冷却期点击刷新也缺少明确反馈 | 按稳定文章身份恢复焦点，文章移除时有后备焦点；显示刷新冷却。按用户最新决定取消浏览器复验 | 代码修复及独立 QA 已完成；最终候选离线 48 测试通过。2026-09-08 Hanlin 明确豁免剩余浏览器复验，因此按修复完成＋复验豁免收尾，不声称新版浏览器检查 PASS |
| S9-21 | 延期入口仅支持第一次、尚未调用模型的恢复，用户已批准第二次延期仍无法登记；旧 QA 延期还会覆盖后来的窗口计算 | 同一个延期入口保存连续授权记录，精确绑定上一截止时间；从原阶段恢复，历史用量／未知例外／调用数不重置 | 已修复并验证：3f5b1de，完整回归 171 文件／4,741 测试；真实第二次延期后，原 HARDEN 续跑成功、独立 QA 通过、第三项整合并自动进入第四项。截止保持 19:40:48，历史 13 次调用和 4,718,539 已知用量未重置 |
| S9-22 | 任务历史增长后，详细状态接口把正常结果误报为 LOCAL_OPERATION_FAILED，容易误以为任务失败 | 状态使用摘要，历史按稳定序号分页；完整旧接口仍保留，容量不足明确报 RESPONSE_TOO_LARGE | 已修复；大于 64 KiB 的完整历史通过摘要/分页 CLI 与 HTTP 读取，遍历不遗漏，未知任务拒绝且零模型调用。完整旧接口的容量错误不会再冒充任务失败 |
| S9-23 | 最终真实验收的原文自动访问失败；采集成功不能替代原文可访问性验证 | 保留采集成功与原文自动访问失败的不同证据；按用户最新指示豁免浏览器复验，不绕过来源网站挑战 | 按用户豁免收尾，外部网站限制仍存在：OpenAI 样本 403/challenge，其他两源 200，原 smoke 仍为 FAIL。不能把本次豁免写成技术根治或产品验收；内容方案已整体延期到下一产品方向讨论 |
| S9-24 | 把有用的 AI 科技进展消息默认为几个大厂 feed 聚合，产品方向没有充分对齐 | 新项目或方向变化前，先用人话确认目标、成功示例、内容选择标准、范围与关键假设；将确认的方向和审核偏好绑定实施批准 | 未来流程已固化在 AGENTS.md、规划入口及 Planner/Reviewer 输入中；缺少产品确认不能创建新任务或调用模型。现有 Board 内容不改、不补写为已确认，按 Hanlin 决定留到后续 |
| S10-01 | 桌面后台没有继承此前可用的代理，页面可打开但模型连接失败 | Console 专用私有连接设置随每个模型子进程读取；显式环境变量优先，不改系统代理、不绕过 TLS | 已修复；受控直接连接超时、既有本机代理完成 HTTPS；桌面重启后真实项目讨论成功。其他主机仍需自己的连接设置 |
| S10-02 | 项目聊天的 Zod 回复 schema 含模型接口不支持的 oneOf；模拟模型未覆盖供应方 schema 子集 | 只转换生成的判别联合为 anyOf，保留必填唯一 kind 和本地严格验证；增加嵌套 action/scope 合约回归 | 已修复；网络修复后一次约三秒的失败仍保留，格式修复后的真实请求成功、保存回复及六项建议子任务的方向草稿。模拟成功不能代替真实接口兼容验证 |
| S10-03 | 聊天只显示通用失败；添加分类时曾意外改变旧角色失败记录的严格结构 | 仅在聊天返回边界附加固定分类；规划和 governed 继续使用原字段，并验证失败落盘/重开和原七字段合约 | 独立 QA 发现的中间版本回归已修复并只读复验通过。原两次失败不能补写为已知用量或精确供应方错误；无结构化错误时仍如实显示未知原因 |
| S10-04 | 用户认为审核和用量门槛过厚，已清楚的方向仍需重复经过草稿/方向/计划确认 | 下一轮提出精简方案：上下文持续维护；用量默认记录；确认清楚方向后集中确认可执行计划；质量检查保留按任务难度选择 | 待方案确认与实施。本次连接修复没有移除已有预算、时间或执行批准约定；普通聊天有效回复可带未知用量正常保存 |

验证过程中发现的构建／测试问题也必须留痕：当前迁移已更新但一次邻接测试误用了旧 dist，触发 schema 指纹不符；重新构建后的编译产物测试通过。第一轮全量回归另发现四个文件的十个迁移计数断言仍期待 24，实际是 25；补齐准确数量后，29 个迁移测试和最终 169 文件／4,726 测试全部通过。历史数据、外键、回滚和防篡改断言均保留。后续新增迁移要先构建并完整核对最终迁移数量断言，避免重犯。完整测试历史和最终结果记录在 CURRENT_STATE.md。

本轮验证过程也保留：HTTP 测试最初因沙箱禁止 localhost 监听失败，按既有授权重跑通过；容量边界断言明确更新为新错误码，未放宽字节上限。新模拟模型漏填协议字段、错误使用 QA 的 PASS 作为 EXECUTE 结果及固定时间导致先后关系不成立，均修正测试生产器后通过。旧版本兼容用历史形状插入测试库，未关闭不可变记录保护。首次全量为 175 文件／4,755 测试，34 失败、1 个未捕获的旧路由断言：涉及新增表的清单/矩阵、旧路由/错误码预期，以及全量运行期间新增测试读到已缓存旧实现；分别修复并先验证 257 项邻接回归。摘要路由另补中文编号真实 HTTP 解码测试。最终全量结果与真实关单状态见 CURRENT_STATE.md。


2026-09-11 recovery follow-up:

| ID | Root problem | Durable correction | Evidence / remaining limit |
| --- | --- | --- | --- |
| S10-05 | Chat acknowledged explicit confirmation but could only describe another UI entry | Bound draft confirmation, plan approval/start and technical recovery actions; show authoritative effects | Deterministic action/scope/idempotence tests; real revision planned and started. Missing product decisions still require alignment |
| S10-06 | Unknown completed usage kept recovery blocked after changing the budget | Explicit acknowledgment of exact unknown completed runs in measurement mode | Unknown remains unknown; old QA outcomes and history preserved; invalid/cross-run acknowledgment rejected |
| S10-07 | Read-only planning rejected the retained Git worktree; chat lacked original QA evidence | Allow canonical registered same-repo checkouts; scoped paginated original QA reports | Actual Astra/high plan succeeded after a confirmed COMMAND_WORKING_DIRECTORY failure; outside paths still rejected |
| S10-08 | Paused idle work consumed execution capacity, while service dropped the blocker | Explicit PAUSED dispatch state, retained checkout, writer-locked resume and safe reason propagation | Original active-write uniqueness retained; live calls prevent slot release; migration preserves old rows |
| S10-09 | Revision links returned to failed earlier plans; stopped subtask lacked a recovery route | Link latest revision and expose parent recovery/revision controls beside task status | Actual-data private-copy browser check; no promise that external provider failures can be eliminated |

Verification issues retained: after the final schema addition, the first full run passed 4,942/4,946 checks. Three assertions still expected WORKTREE_BLOCKED where capacity now correctly reports CONCURRENCY_BLOCKED; the predecessor-upgrade fixture also retained a current Console-dependent trigger after deleting Console tables. Exact category assertions and the pinned predecessor trigger were corrected; no history/provenance/foreign-key assertion was removed.

Final recheck: 204 files / 4,946 tests PASS, including all four corrected checks; no failures, skips or weakened assertions. Schema 34 activated with all 55 existing table record sets unchanged, and B revision entered a real EXECUTE role.
