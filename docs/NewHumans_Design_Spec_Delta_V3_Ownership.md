# NewHumans V3 Ownership Delta

状态：NH-048 设计增量；仅覆盖与本文件冲突的 V3 所有权描述。  
基线：`docs/NewHumans_System_Spec_V3.md`。  
目的：记录 NewHumans 与独立 Knowledge Ball 的最终职责重分配，不重写 V3 历史正文。

## 1. 覆盖规则与历史可追溯性

1. 本文件只覆盖 V3 及其后续文档中与 **Economy / Memory / Knowledge 写入权威** 冲突的职责归属；未明确覆盖的产品约束、领域规则和安全不变量继续有效。
2. `NewHumans_System_Spec_V3.md` 保持原样，继续作为 2026-09-15 的历史设计基线。不得为了让旧文档“看起来一致”而回写或重写其 M03/M05 原文。
3. 后续开发解释 M03/M05 ownership 时，以本 delta 及 NH-002～NH-012 的已合并边界合同为准；旧事件、旧记录仍按其产生时的 schema/authority 解释，不追溯伪造历史。
4. 同一状态只能有一个 `AUTHORITATIVE_WRITER`。投影、缓存、展示模型、兼容层和测试夹具都不是第二权威。

## 2. 当前唯一写入权威

### 2.1 Knowledge Ball

Knowledge Ball 是以下三类状态的唯一可写权威：

- **Economy**：Energy 余额、活动日计费事实、基于权威经济状态的资格判断、报价、预留、释放、结算、转账、托管、账本和财政状态。
- **Memory**：长期记忆、记忆追加/更新历史、来源与 provenance、游标及可恢复的长期记忆引用。
- **Knowledge**：知识节点/命题、关系、证据、挑战、审核状态、主体知识状态与其规范语义。

NewHumans 可以通过受版本约束的 Port/Adapter 读取或请求这些能力，但不得维护可独立写入并与 Knowledge Ball 竞争的 Economy、Memory 或 Knowledge 真值。

### 2.2 NewHumans

NewHumans 继续拥有以下权威：

- **M01 / Identity**：Entity 身份、认证、代理绑定、授权、动作归属、正式事件与身份/继承资格。
- **M02 / Lifecycle + Goals**：生命周期、模型路由、目标、人格/运行参数、租约、调度、检查点及运行编排。M02 可以组装一次运行所需的瞬时上下文，但不拥有长期 Memory 真值。
- **M04 / Relationships + Collaboration**：关系、消息、目录、作品、项目、合同、组织及协作状态。合同中的资金托管/结算只引用 Knowledge Ball Economy 的权威结果。
- **M06 / Execution**：模型与工具执行、连接器、凭据引用、用量及结果证据；M06 不拥有货币余额或结算真值。
- **M07 / Presentation**：人类界面、世界观察与展示编排；页面状态不构成业务真值。

M03/M05 名称可在 NewHumans 的兼容层、端口或文档引用中继续出现，但不得再被解释为 NewHumans 本地的第二套 Knowledge/Economy 可写权威。

## 3. V3 M03/M05 逐条职责 diff 审计

下表逐条覆盖 V3 第 2 节“模块职责”中 M03 与 M05 的每一个 `负责` 项。每一项只出现一次。

| Audit ID | V3 owner | V3 responsibility | Current authoritative owner | Delta |
| --- | --- | --- | --- | --- |
| V3-M03-01 | M03 Knowledge Ball | 公共知识节点 | Knowledge Ball / Knowledge | 仍属 Knowledge Ball；明确为独立产品中的唯一知识写入权威。 |
| V3-M03-02 | M03 Knowledge Ball | 证据 | Knowledge Ball / Knowledge | 仍属 Knowledge Ball；NewHumans 只引用/投影证据。 |
| V3-M03-03 | M03 Knowledge Ball | 个人状态层 | Knowledge Ball / Memory + Knowledge | 个人长期认知/记忆状态由 KB 写入；NewHumans 不复制可独立修改的个人知识状态。 |
| V3-M03-04 | M03 Knowledge Ball | 记忆引用 | Knowledge Ball / Memory | 从“引用”明确升级为长期 Memory 权威；M02 仅拥有运行时上下文装配。 |
| V3-M03-05 | M03 Knowledge Ball | 挑战 | Knowledge Ball / Knowledge | 挑战及其知识语义仍由 KB 写入。 |
| V3-M03-06 | M03 Knowledge Ball | 展示组件 | Knowledge Ball + NewHumans M07 (presentation composition only) | KB 可提供自身组件/数据；NewHumans M07 负责宿主界面组合，但不因此取得知识写权限。 |
| V3-M05-01 | M05 Economy | 官方货币 Energy | Knowledge Ball / Economy | 写入权威从 NewHumans 本地 M05 移至独立 KB Economy。 |
| V3-M05-02 | M05 Economy | 日活动费 | Knowledge Ball / Economy | 计费规则可由 NewHumans 生命周期触发，但计费事实/账本写入由 KB Economy 决定。 |
| V3-M05-03 | M05 Economy | 报价 | Knowledge Ball / Economy | NewHumans 通过 EconomyPort 请求，不保留并行权威报价账本。 |
| V3-M05-04 | M05 Economy | 资金预留 | Knowledge Ball / Economy | 预留/释放是 KB Economy 原子能力；本地余额投影不可替代。 |
| V3-M05-05 | M05 Economy | 托管 | Knowledge Ball / Economy | M04 合同只保存业务引用；资金托管状态归 KB Economy。 |
| V3-M05-06 | M05 Economy | 结算 | Knowledge Ball / Economy | M06 用量收据是结算输入，不是货币权威；最终结算写入 KB Economy。 |
| V3-M05-07 | M05 Economy | 财政 | Knowledge Ball / Economy | 世界财政的货币状态也受同一单写入权威约束。 |

审计结论：V3 M03 的知识职责继续归 Knowledge Ball，但长期 Memory ownership 被明确收敛到 Knowledge Ball；V3 M05 的全部 7 项 Economy 写入职责从 NewHumans 本地实现迁移到 Knowledge Ball。没有任何一项被复制成双写权威。

## 4. 与 V3 相邻职责的必要澄清

- V3 对 M03 的“不通过认知判断修改余额或取得权限”继续成立：Knowledge 与 Economy 是两个独立 capability；知识投票不能直接写余额，身份/授权仍由 M01 执行。
- V3 对 M04 的“不维护第二套账本”由本 delta 强化：M04 只能保存合同/托管操作引用和业务状态，不可嵌入可独立结算的钱包。
- V3 对 M06 的“不拥有钱”继续成立。ADR-013 中“`M05 remains the only authority`”这一**位置/模块归属**被本 delta 覆盖为 Knowledge Ball Economy；“M06 不拥有 money、BYOK 不重复计费”等安全语义不变。
- V3 M02 的“上下文”解释为运行时上下文构建、选取和检查点协作，不等于长期 Memory 存储权威。
- V3 的 microE 精度、不可并发双花、幂等、追加式证据、未知外部结果需 reconciliation 等安全约束不因权威迁移而放宽。

## 5. 身份绑定边界

NewHumans `entity_id` 与 Knowledge Ball 的 subject identity 是两个独立命名空间。集成必须使用可审计、可版本化、可失效的显式绑定，而不是：

- 共用同一个主键并假定其天然等价；
- 按名称、显示编号或文本标签猜测主体；
- 允许一个当前有效的 NewHumans Entity 同时指向多个当前有效 KB subject。

HPA 代表 Human 调用长期记忆时，目标是该 Human 所绑定的 KB subject；普通 Agent 不得越权写入其他主体 Memory。

## 6. Port、失败与一致性语义

### 6.1 Economy

NewHumans 对 Economy 的生产写操作必须通过 Knowledge Ball EconomyPort。能力至少覆盖 `balance`、`eligibility`、`activity_day`、`quote`、`reserve`、`release`、`settle`、`transfer`、`escrow`、`ledger`。Energy 继续使用精确 microE 整数语义。

Knowledge Ball Economy 不可用时，生产路径必须 fail closed；**must not fall back to the legacy local ledger**。

### 6.2 Memory

长期 Memory 的 recall/append/update/history/cursor/provenance 经 MemoryPort 进入 Knowledge Ball。NewHumans 运行时可以持有短期上下文、响应缓存和非权威投影，但不得形成模型专属或服务专属的第二长期记忆真值。

### 6.3 Knowledge

知识节点、关系、证据、挑战与主体知识状态的规范读写经 KnowledgePort 进入 Knowledge Ball。NewHumans 可以缓存查询结果，但缓存必须能识别版本/滞后且不可反向成为权威写入源。

### 6.4 Retry / unknown outcome

- 写操作携带稳定幂等标识；安全超时只能使用同一幂等标识重试。
- 已发送但结果不确定的写入必须返回/映射为 `OUTCOME_UNKNOWN`，先 reconciliation，禁止盲目重复提交。
- Economy、Memory、Knowledge readiness 分能力且区分 read/write；缺失 capability 不得被“总体健康”掩盖。
- NewHumans 与独立 Knowledge Ball 之间 **do not assume cross-database ACID**。跨产品多步操作使用 Saga / Outbox / reconciliation，保留本地 intent、远端 operation reference、状态转移和可恢复证据。

## 7. Legacy NewHumans Economy

现有 NewHumans 本地 Economy 代码、数据库 schema 与历史回归测试属于迁移债务/Legacy surface，而不是并列权威：

1. 不新增生产业务能力。
2. 可暂时保留用于历史回归、开发或迁移验证。
3. 生产模式不得在 Knowledge Ball Economy 失败时切回本地 ledger。
4. 本地只读 projection 若保留，必须明确标注非权威且可由 KB 重建/刷新。
5. 真正删除 Legacy surface 属于后续迁移任务；NH-048 只记录 design delta，不删除实现。

## 8. 前置决策链

本 delta 的最终解释依赖并继承以下任务的合并结果：

- NH-002：Knowledge Ball authority boundary
- NH-003：跨模块 ownership matrix
- NH-004：NewHumans Entity ↔ Knowledge Ball subject binding
- NH-005：EconomyPort contract
- NH-006：MemoryPort contract
- NH-007：KnowledgePort contract
- NH-008：Knowledge Ball error model
- NH-009：idempotency / retry semantics
- NH-010：readiness / capability contract
- NH-011：cross-product Saga / Outbox / reconciliation
- NH-012：Legacy NewHumans Economy freeze

如果后续任务发现本文件与上述已合并合同存在冲突，必须修改本 delta 或新建明确的后续 delta；不得通过实现细节偷偷恢复旧 M03/M05 ownership。

## 9. 后续开发的强制解释

从 NH-048 合并起：

- “M05 owns Economy”只能解释为历史 V3/Legacy implementation 描述，不再是目标架构的写入权威。
- “M03 stores memory references”不得解释为 NewHumans 另有一套长期 Memory；长期 Memory/Knowledge 的目标权威均为 Knowledge Ball。
- NewHumans 新代码需要 Economy/Memory/Knowledge 时，应依赖已定义的 Knowledge Ball 边界合同，而不是直接扩展 Legacy M05/M03 数据面。
- 历史 V3、ADR 和实现文档继续保留以便追溯；本文件提供最小覆盖层，不大规模重写历史设计。