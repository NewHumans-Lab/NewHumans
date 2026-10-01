# ADR NH-002 — Knowledge Ball 权威边界

Status: **Accepted**  
Date: 2026-10-01  
Scope: NewHumans ↔ Knowledge Ball domain authority and integration boundary  
Task: NH-002

## Context

Knowledge Ball 已经是独立产品，并且必须继续能够独立运行，也能够作为 NewHumans 的认知与经济权威被集成。NewHumans 不得为了集成方便重新实现一套可写的 Knowledge Ball、长期记忆系统或 Energy 账本。

V3 与当前仓库仍保留较早的模块边界：M03 负责 Knowledge/Memory，M05 负责 Economy；M02 文档还将长期记忆和 Personal Overlay 描述为 NewHumans 持有；当前开发顺序文件仍把最终 Knowledge Ball 采用路径标成未决定。Owner 的最新决定覆盖这些旧权威口径：

- **Knowledge Ball 是 Economy + Memory + Knowledge 的唯一可写权威。**
- **NewHumans 是 Identity + Lifecycle + Goals + Relationships 的唯一业务权威。**
- NewHumans 可以引用、展示、缓存或建立只读投影，但不能产生第二个独立可写事实源。
- Knowledge Ball 内部实现不属于 NH-002 修改范围。
- 本 ADR 只确定权威边界，不宣称当前 NewHumans M05 等旧可执行路径已经完成迁移。

## Decision

### 1. Authoritative ownership

| Domain | Authoritative owner | NewHumans may | NewHumans must not |
| --- | --- | --- | --- |
| Identity | **NewHumans / M01** | 创建并维护 Entity、认证绑定、HPA 绑定、delegation、授权根和 identity status | 允许 Knowledge Ball 生成、合并、拆分或替换 NewHumans Entity 身份 |
| Lifecycle | **NewHumans / M02** | 维护 REGISTERED/ACTIVE/DORMANT/TERMINATED、runtime eligibility、lease、wake/dormancy 和恢复状态 | 让 Knowledge Ball 的记忆、知识或经济状态直接成为 lifecycle 写权威 |
| Goals | **NewHumans / M02** | 维护 goal、dependency、version 和当前 goal status | 让 Knowledge Ball 的记忆、知识节点或个人判断直接改写目标权威状态 |
| Relationships | **NewHumans / M04，及当前规则指定的 M01/M02 关系生成流程** | 维护社会、组织、合同、出生/治理产生的关系及其确认、撤销和状态 | 让 Knowledge Ball 中的陈述、记忆或知识判断直接成为关系写入事实 |
| Economy | **Knowledge Ball** | 通过稳定契约读取/展示余额和经济状态，提交幂等经济命令，保存非权威引用与执行证据 | 建立或继续扩张第二套可写 wallet、balance、ledger、reservation、escrow、settlement、mint/burn 或 fee 权威 |
| Memory | **Knowledge Ball** | 检索长期记忆、提交授权记忆事件、保存 memory/version/provenance 引用；M02 可保留短期 runtime/checkpoint 状态 | 建立本地长期记忆库、Personal Overlay 权威、可独立回写的记忆镜像或 model-specific memory silo |
| Knowledge | **Knowledge Ball** | 查询、引用、提交并展示公共知识/个人知识对象 | 建立第二套可写知识节点、claim、evidence、challenge、review 或 personal knowledge state 权威 |

该边界是**语义所有权**，不是部署拓扑。Knowledge Ball 可以是独立服务、SDK/embedded provider、同库不同 schema 或未来其他部署形态；物理同库不等于 NewHumans 获得第二写权威。

### 2. Identity unification without authority mixing

Knowledge Ball 独立运行时可以拥有自己的登录、账户或内部 subject 标识；这些标识只属于 Knowledge Ball 产品域，不是第二个 NewHumans Entity 身份。

当 Knowledge Ball 集成到 NewHumans：

1. 世界身份由 M01 提供稳定 `entity_id` / approved subject reference。
2. Knowledge Ball 将 Economy、Memory、Knowledge 的主体状态绑定到该外部身份引用。
3. Knowledge Ball 不独立决定两个 NewHumans Entity 是否为同一主体，也不拆分、重分配 Entity ID。
4. 多聊天窗口、设备、worker、模型替换、路由替换或重连不得为同一 Entity 创建多个并行权威钱包/记忆主体。
5. standalone KB account 与 NewHumans Entity 的关联必须有显式、可审计、版本化的 binding；名称、邮箱、模型行为或文本相似度都不能作为隐式身份合并依据。

因此：**身份唯一性由 NewHumans 保证，Economy/Memory/Knowledge 唯一性由 Knowledge Ball 保证。**

### 3. Referenced / projected data allowed in NewHumans

NewHumans 可以保存 Knowledge Ball 数据的非权威引用或派生读模型，例如：

- Economy：`kb_wallet_ref`、显示余额快照、available balance snapshot、quote/reservation/settlement result ref、authority version/cursor；
- Memory：`kb_memory_ref`、snapshot/version、retrieval/context reference、provenance；
- Knowledge：node/evidence/source/challenge/personal-state ID、version、query result、provenance；
- 跨域工作流所需的 request ID、idempotency key、operation state 和可验证 KB result receipt。

所有此类本地记录必须同时满足：

1. 明确标记 Knowledge Ball authority ID/version/cursor；
2. 可从 Knowledge Ball 权威状态重建；
3. 不接受能改变 Economy/Memory/Knowledge 业务事实的独立写入；
4. stale 状态可检测，关键动作在执行前重新向 Knowledge Ball 核对；
5. 删除或重建投影不会改变 Knowledge Ball 权威状态；
6. retry/replay 不能产生第二份 journal、memory history 或 knowledge decision。

NewHumans UI 显示的余额必须是 Knowledge Ball 余额的展示，不是另一个本地余额。

### 4. Forbidden second-authority patterns

自本 ADR 起，以下模式被禁止作为当前或未来目标架构：

- NewHumans 本地可写 Energy wallet/balance 与 Knowledge Ball 并列；
- 本地 authoritative journal/posting/reservation/escrow/settlement 与 KB Economy 并列；
- 本地长期 memory、Personal Overlay、belief/memory state、recall authority 与 KB Memory 并列；
- 第二套可写 public knowledge graph、canonical claim store、evidence verdict、challenge/review state；
- 双向同步后两边都可接受权威写入；
- last-write-wins、timestamp priority 或人工择一来调和两个可写事实源；
- KB 不可用时先写 NewHumans 本地 authority，之后“再同步”；
- adapter/cache 的本地 mutation 可以绕过 KB write contract 后再上传成为权威；
- 将 M01 event log、M02 checkpoint、M04 message/relationship、M06 usage receipt、M07 UI state 升级为 Economy/Memory/Knowledge authority；
- 因旧 M05/M03 可执行路径仍存在，就继续把它们当作未来第二权威。

兼容层只允许**一个 authoritative write destination：Knowledge Ball**。临时 read bridge 必须有明确移除条件，且不得接受独立权威写入。

### 5. NewHumans-owned domains remain authoritative

本 ADR 不把以下状态迁入 Knowledge Ball：

- M01 Entity identity、authentication、HPA binding、delegation、authorization roots、world rules 和 action authority；
- M02 lifecycle、runtime lease/checkpoint、当前 goals/dependencies、model route/runtime state 和 scheduling；
- M04 社会、组织、合同及其他按当前规则归 NewHumans 的 relationship state；
- M06 provider/model/tool execution authority 与 usage measurement；
- M07 presentation state。

Knowledge Ball 可以保存这些事实的引用、证据、解释和历史，但不能因某条 knowledge statement 被接受或争议就直接修改底层 NewHumans state。

例如：“A 当前 ACTIVE”“A 有目标 G”“A 是组织 O 成员”在 Knowledge Ball 中只能是对 NewHumans 权威事实的引用/认知对象；它们的知识审核结果不能直接改写 lifecycle、goal 或 relationship。

### 6. Cross-domain operation rule

任何跨 NewHumans / Knowledge Ball 的工作流都必须维持“一项事实一个权威”。

- **Activation:** M02 拥有 lifecycle transition；Knowledge Ball Economy 拥有 fee/balance operation。M02 只消费权威经济结果，不再写第二份本地 fee journal。
- **Model execution:** M06 拥有 provider/tool usage measurement；Knowledge Ball Economy 拥有由该 usage 引出的 Energy charge。usage receipt 是证据，不是钱包。
- **Contract settlement:** M04 拥有 contract/relationship state；Knowledge Ball Economy 拥有 escrow 与 settlement money state；双方仅保存对方稳定引用用于协调。
- **Autonomous turn:** M02 拥有 turn/lifecycle/goal state；KB Memory/Knowledge 提供 context 并接收授权提交；checkpoint 只引用 KB 长期对象，不复制成第二长期记忆权威。
- **Identity-linked memory:** M01 拥有 subject identity；Knowledge Ball 拥有该 subject 的 memory；memory 写入不能重写身份 binding。

在真正的跨系统事务/idempotency 协议完成前，相关代码必须 fail closed，而不是通过本地第二权威“模拟成功”。

## Conflict audit

以下旧表述仅在列明范围内被本 ADR supersede；无关不变量继续有效。

| Existing source | Existing meaning | NH-002 resolution |
| --- | --- | --- |
| `docs/NewHumans_System_Spec_V3.md` §2 | M03 owns Knowledge/Memory；M05 owns Economy | **Superseded ownership split.** KB owns Economy + Memory + Knowledge；NH keeps Identity + Goals + Lifecycle + Relationships. |
| `docs/modules/03_Knowledge_Ball.md` §1.2 | “真实余额”不归 Knowledge Ball | **Superseded.** Energy/Economy 权威现归 Knowledge Ball；Identity/Permissions/Contracts/Lifecycle/Goals/Relationships 仍是 NewHumans 事实。 |
| `docs/modules/03_Knowledge_Ball.md` §2 | world mode budget 由 M05 提供 | **Superseded.** 集成模式预算权威改为 KB Economy provider。 |
| `docs/modules/05_Energy_and_Resources.md` | M05 权威维护 wallet/journal/reservation/escrow/fee/issuance/settlement | **Superseded as target ownership.** 会计安全语义可迁移保留，但 writable authority 必须由 Knowledge Ball 提供。当前本地 M05 是 replacement/migration debt。 |
| `docs/modules/02_Agent_Life_Runtime.md` §1/§2.1 | NewHumans/M02 持有 goals、长期 memory、Personal Overlay 等 | **Partially superseded.** Goals/Lifecycle 留在 NewHumans；长期 Memory/Personal Overlay 改归 KB。 |
| `docs/modules/02_Agent_Life_Runtime.md` §6 | M02 分别依赖 M05 budget、M03 memory/knowledge | **Conceptual dependency update.** 两类依赖都指向权威 Knowledge Ball provider，但 M02 自身 ownership 不变。 |
| `docs/modules/04_Social_Collaboration.md` | M04 owns relationships；M05 owns money | **Partially retained.** Relationships 仍归 NewHumans/M04；money dependency 改到 KB Economy。 |
| `docs/modules/01_World_Core.md` | M01 owns identity；M05 owns balance | **Partially retained.** Identity 仍归 M01；集成后 balance/economic checks 必须来自 KB Economy。 |
| `docs/CURRENT_DEVELOPMENT_SEQUENCE.md` | Knowledge Ball 最终采用路径未定；V3 ownership unchanged | **Partially superseded.** “provider 未决定”已解决；禁止 fake/temporary M03、memoryless cognition 与 fail-closed 原则继续有效。 |
| `DECISIONS.md` ADR-003/004/009 | microE、balanced journal、append-only economic evidence | **Retained as safety semantics**，除非后续 ADR 明确改变；它们不再证明 NewHumans owns the ledger。 |
| `DECISIONS.md` ADR-006 | local `economy.activity_subjects` 与 M02 分离 | **Implementation-specific economy path becomes migration debt.** M02 separation 保留。 |
| `DECISIONS.md` ADR-013 | “M05 remains the only authority” for money | **Superseded.** Knowledge Ball Economy 是唯一 money authority；M06 不拥有 money 的约束仍有效。 |
| `DECISIONS.md` ADR-015/016/018/021 | eligibility/settlement/quote/billing evidence 依赖 M05 | **Economic safety semantics retained, authority endpoint changes.** 后续实现从 KB Economy 获取权威结果。 |
| `DECISIONS.md` ADR-001 | 核心语义变化需要版本化，不能静默重解释已持久化历史 | **Preserved.** NH-002 不把已有 `nh.v3.0` 历史记录伪装成已经迁移到 KB；真正 cutover 需后续版本化接口与迁移任务。 |

### Conflict-audit result

- Identity：保留 M01 权威，无新增冲突。
- Goals/Lifecycle：保留 M02 权威，无新增冲突。
- Relationships：保留 NewHumans 关系权威，无新增冲突。
- Memory/Personal Overlay：旧 NewHumans/M02 ownership wording 被覆盖。
- Knowledge：现有 KB ownership 被保留并强化为唯一可写权威。
- Economy/Energy：旧 M05 ownership 被覆盖；现有 executable M05 明确是待替换实现，不是第二目标权威。
- Development sequencing：fake/substitute KB 禁令继续有效；只覆盖“最终 provider 未决定”这一点。

目标架构因此对每个受影响领域只有一个语义 owner。**当前仓库尚未被宣称已经完成 Economy executable replacement。**

## Migration constraints for later tasks

后续实现必须：

1. 使用版本化 KB Economy/Memory/Knowledge contract；
2. 不为了兼容旧 NewHumans M05/M03 布局而修改 Knowledge Ball 内核权威模型；
3. 在启用 KB write path 前盘点所有 NewHumans writable M05 / long-term-memory paths；
4. 明确 cutover、source of truth 和数据迁移；正常运行期间同一 world/subject 不允许两边同时 writable；
5. 迁移引用、idempotency 与历史证据时不得重复扣款、重复结算、重复 memory/knowledge submission；
6. 增加测试证明 NewHumans 无法本地写 authoritative Economy/Memory/Knowledge；
7. KB integration 不可用时继续 fail closed，不得补 temporary authority；
8. retirement/permanent disable 完成后才可声明 executable replacement complete。

## Consequences

- Knowledge Ball 可继续 standalone，也可作为 NewHumans 的统一 Economy/Memory/Knowledge provider；不需要 fork 核心事实模型。
- NewHumans 后续只做 adapter/boundary/reference，不重建 KB 核心。
- 模型、worker、窗口与设备变化不会分裂 wallet 或长期 memory identity。
- NewHumans 显示的余额可直接代表 KB 权威余额，而不是双向同步副本。
- 现有本地 Economy implementation 需要单独的版本化收口任务；NH-002 不提前触碰该代码。
- 跨系统动作必须补齐 idempotency、version、failure、reconciliation 和 cutover 设计。

## Acceptance invariants

NH-002 完成时必须同时成立：

- [x] **Owned:** KB = Economy + Memory + Knowledge；NewHumans = Identity + Lifecycle + Goals + Relationships。
- [x] **Referenced:** 允许稳定跨域引用和 non-authoritative read projection。
- [x] **Forbidden:** NewHumans 不得建立第二套 independently writable Economy/Memory/Knowledge authority。
- [x] standalone KB identity 与 embedded NewHumans Entity identity 分离，并通过可审计 binding 统一主体引用。
- [x] V3、M01/M02/M03/M04/M05、CURRENT_DEVELOPMENT_SEQUENCE 与现有 Economy ADR 的冲突已逐项标明。
- [x] fail-closed / no fake-memory / no temporary second cognition path 继续保留。
- [x] 现有 executable M05 的 migration debt 被承认，NH-002 不虚称 runtime migration 已完成。
- [x] 本任务不修改 Knowledge Ball 内部、runtime、server、scheduler、policy/control、migration、schema 或 tests。

## Out of scope

NH-002 不执行：

- Knowledge Ball 内部代码/schema 修改；
- NewHumans runtime / server / scheduler / policy / control 修改；
- 当前 M05 表、service、migration 的删除或迁移；
- KB SDK/API 具体字段或部署拓扑设计；
- Energy 数值规则、日费规则、知识审核规则或记忆内容规则修改；
- autonomous cognition 的启用。

这些属于后续、独立、版本化的实现任务。