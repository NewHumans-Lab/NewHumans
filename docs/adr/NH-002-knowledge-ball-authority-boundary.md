# ADR NH-002 — Knowledge Ball 权威边界

Status: **Accepted**  
Date: 2026-10-01  
Scope: NewHumans ↔ Knowledge Ball domain authority and integration boundary  
Task: NH-002

## Context

Knowledge Ball 已经是独立产品，并且必须继续能够独立运行，也能够作为 NewHumans 的认知与经济权威被集成。NewHumans 不得为了集成方便重新实现一套可写的 Knowledge Ball、长期记忆系统或 Energy 账本。

V3 现有设计存在需要由本 ADR 覆盖的旧边界：

- V3 §2 将 `M05 Economy` 定义为 NewHumans 内部的 Energy、预留、托管、结算与财政权威；
- V3 §4.1 写明 NewHumans 保存 Entity、长期记忆、Personal Overlay、目标、关系、权限和资产；
- `docs/CURRENT_DEVELOPMENT_SEQUENCE.md` 仍把 Knowledge Ball 最终采用路径留作后续决定，但同时已经要求不得建立临时 M03、假记忆服务或第二条认知路径；
- `DECISIONS.md` 中既有 Economy ADR 是当前 `nh.v3.0` 实现的历史合同，其中部分文字把 M05 作为经济权威。

Owner 的新决定是：**Knowledge Ball 是 Economy + Memory + Knowledge 的唯一可写权威；NewHumans 继续拥有 Identity + Lifecycle + Goals + Relationships 的权威。** 本 ADR 固化该边界。

## Decision

### 1. 单一权威原则

每个领域只能有一个可提交业务事实的权威写入方。集成、缓存、索引、镜像、事件副本和 UI 展示都不得形成第二个可写事实源。

对于本 ADR 涉及的七个领域，权威边界如下：

| Domain | Authoritative owner | NewHumans may | NewHumans must not |
| --- | --- | --- | --- |
| Identity | **NewHumans** | 创建并维护世界内 `Entity`、认证、代理绑定、授权与稳定主体 ID | 允许 Knowledge Ball 生成或替换 NewHumans Entity 身份 |
| Lifecycle | **NewHumans** | 维护 Agent lifecycle、runtime state、lease、wake/dormancy 与恢复编排 | 把 Knowledge Ball 的记忆/知识状态当作 lifecycle 写权威 |
| Goals | **NewHumans** | 维护目标、目标状态、依赖与版本历史 | 让 Knowledge Ball 的记忆或个人知识状态直接改写目标权威状态 |
| Relationships | **NewHumans** | 维护主体关系、关系确认/撤销和关系状态 | 让 Knowledge Ball 中的陈述或记忆直接成为关系写入事实 |
| Economy | **Knowledge Ball** | 通过 Knowledge Ball 权威接口读取/展示余额及经济状态，提交带幂等性的经济命令，保存非权威引用与执行证据 | 建立或继续扩张第二套可写 wallet、balance、ledger、reservation、escrow、settlement 或财政权威 |
| Memory | **Knowledge Ball** | 检索长期记忆，保存对 KB 记忆对象/版本的引用；M02 可保留恢复执行所需的短期工作状态与 checkpoint 元数据 | 建立本地长期记忆库、Personal Overlay 权威、可回写记忆镜像，或在 KB 不可用时先写本地再同步 |
| Knowledge | **Knowledge Ball** | 查询、引用和展示公共知识、证据、个人知识状态、掌握度/挑战结果 | 建立第二套可写知识节点、证据图、个人知识状态或挑战裁决权威 |

本 ADR 没有重新分配未列出的既有领域。权限、合同、消息、模型/工具网关等仍按其现有 ADR/V3 归属，除非后续 ADR 明确修改。

### 2. NewHumans owned

NewHumans 对以下事实保持权威：

- 世界内唯一且持久的 Entity 身份，以及认证、代理绑定和代表关系；
- Agent 生命周期与 runtime 控制状态；
- 目标、目标依赖和目标状态历史；
- 主体之间的关系及其确认、撤销和状态；
- M02 为恢复正在执行的工作所需的短期 runtime/checkpoint 状态，但 checkpoint 只能引用 Knowledge Ball 的长期记忆版本，不得复制成另一套长期记忆权威。

Knowledge Ball 在集成模式中可以引用这些 NewHumans 事实，但不能成为它们的第二写入方。

### 3. NewHumans referenced

NewHumans 可以持有以下 Knowledge Ball 数据的**非权威引用或派生读模型**：

- Economy：账户引用、余额/可用额快照、报价/预留/结算结果引用、权威版本或游标；
- Memory：memory ID、snapshot/version、检索结果、上下文引用和 provenance；
- Knowledge：node/evidence/challenge/personal-state ID、版本、查询结果和 provenance。

任何缓存或派生读模型都必须满足：

1. 明确标记来源是 Knowledge Ball；
2. 可从 Knowledge Ball 权威状态重建；
3. 不能接受业务写入，也不能在冲突时覆盖 Knowledge Ball；
4. 对需要当前状态的关键决策必须读取足够新的 Knowledge Ball 权威结果，否则 fail closed；
5. UI 展示的 NewHumans 余额是 Knowledge Ball 余额的展示，不是 NewHumans 自有余额。

### 4. NewHumans forbidden

以下实现自本 ADR 起被禁止：

- 新建或扩张 NewHumans 内部 Economy、Memory、Knowledge 的第二套可写权威；
- 在 Knowledge Ball 不可用时把 Economy/Memory/Knowledge 写入本地，然后以“稍后同步”作为生产 fallback；
- 使用双向同步、last-write-wins、时间戳优先或人工挑选来解决两个可写事实源之间的冲突；
- 通过复制 Knowledge Ball 表结构到 NewHumans 来获得本地写能力；
- 让 NewHumans 直接依赖 Knowledge Ball 私有数据库表并绕过其稳定集成契约；
- 由 NewHumans 本地事件重放出一个可独立结算的 Energy 余额并把它当成权威；
- 将 runtime checkpoint、prompt context、摘要或搜索索引升级为长期记忆/知识权威；
- 让 Knowledge Ball 的 standalone account、用户名或内部 subject ID 冒充 NewHumans Entity ID。

### 5. 身份统一但权威不混合

Knowledge Ball 独立运行时可以拥有自身的登录、账户或内部 subject 标识；这些标识只代表 Knowledge Ball 产品域身份。

当 Knowledge Ball 与 NewHumans 集成时：

- NewHumans `Entity` 仍是世界身份权威；
- 集成层必须建立稳定、可审计的 subject binding，把 NewHumans Entity 映射到 Knowledge Ball 中承载 Economy/Memory/Knowledge 的主体；
- 一个有效 NewHumans Entity 不得因为多个聊天、模型、设备或重连而产生多个可同时代表其本人的 KB 权威主体；
- 绑定变更必须显式、版本化、可审计，不能靠名称、邮箱、模型 ID 或页面会话隐式匹配；
- Knowledge Ball 的 standalone 身份体系不得反向修改 NewHumans Entity 身份事实。

该设计实现“同一主体跨产品引用”，而不是“两个系统都拥有同一个领域的写权威”。

### 6. 写路径与故障行为

Economy、Memory、Knowledge 的生产写入必须经 Knowledge Ball 的稳定契约完成；契约可以最终表现为 API、SDK/embedded adapter 或事件命令，但必须保持 Knowledge Ball 是唯一提交方。

NewHumans 可以保存命令 ID、idempotency key、KB object/version reference、outcome/provenance 和自身业务动作证据；这些记录用于审计和恢复，不构成对应领域的第二份业务状态。

当 Knowledge Ball 不可用时：

- 需要 Economy 当前状态或写入的动作 fail closed；
- 需要长期 Memory/Knowledge 的自主认知路径 fail closed；
- 可以继续执行与 Knowledge Ball 无关、且仅写 NewHumans-owned 领域的操作；
- 不得通过临时本地权威绕过依赖门槛。

### 7. 对现有仓库实现的处理

本 ADR 是**权威边界决定**，不是本任务中的迁移或删码任务。

当前仓库已经存在 `src/services/economy.js`、Economy migrations/tests，以及 `nh.v3.0` 下把 M05 当作本地经济权威的实现。NH-002 不修改这些文件，也不修改 PR #17 正在处理的 runtime 热点。它们在完成版本化切换前仍是当前实现的历史行为，不因此获得未来架构上的第二权威资格。

从本 ADR 接受后：

- 不得把现有本地 M05 继续扩张为与 Knowledge Ball 并列的长期权威；
- 后续集成任务必须选择迁移、适配、冻结或退役旧本地 Economy 写路径，使生产最终只剩 Knowledge Ball 一个经济写权威；
- Memory/Knowledge 不得因为集成尚未完成而补建临时本地替代；
- Knowledge Ball 内部实现不属于 NewHumans 仓库本任务修改范围。

### 8. 与 V3、开发顺序和既有 ADR 的冲突审计

#### V3 §2 — M05 Economy ownership

**Superseded in authority ownership.** V3 把 M05 定义为 NewHumans 内部 Economy 权威；本 ADR 改为 Knowledge Ball 是 Economy 唯一权威。Energy 的具体业务规则没有被本 ADR 自动修改，只改变其最终权威归属和写入边界。

#### V3 §4.1 — NewHumans 保存长期记忆 / Personal Overlay

**Superseded for Memory and Knowledge.** 长期记忆、Personal Overlay、个人知识状态及公共知识的权威改归 Knowledge Ball。该段中的 Goals、Relationships 和 Identity 连续性不被取消，仍由 NewHumans 负责。

#### `CURRENT_DEVELOPMENT_SEQUENCE.md`

**Partially superseded.** “Knowledge Ball 最终采用路径以后再决定”这一点已被新决定取代：采用现有独立 Knowledge Ball 作为最终权威边界已经确定。该文件的“禁止临时 M03 / 假记忆服务 / 第二认知路径”和 fail-closed 原则继续有效，并与本 ADR 一致。

#### `DECISIONS.md` ADR-003 / ADR-004 / ADR-009 / ADR-013 / ADR-018 / ADR-021

这些 ADR 描述当前 `nh.v3.0` Economy 实现与不可变计费证据，其中 ADR-013/ADR-018 明确把 M05 放在经济写路径中。

**本 ADR supersedes 其中关于“NewHumans/M05 是最终 Economy authority/location”的部分，但不静默废除其金额精度、平衡账本、不可变证据、幂等和结算安全约束。** 后续 Knowledge Ball Economy 接入必须明确决定哪些经济不变量原样迁移、哪些由新的版本化合同替代。

#### `DECISIONS.md` ADR-001 — protocol versioning

**Preserved.** ADR-001 要求核心语义变更使用新的协议版本。本 ADR 不把现有 `nh.v3.0` 已持久化数据静默解释成 Knowledge Ball 权威，也不在 NH-002 中修改运行时协议。真正切换生产写权威时必须通过后续任务完成明确的版本化接口、数据迁移/冻结策略和回滚边界。

### 9. Acceptance invariants

后续实现必须能够同时证明：

1. Economy 只有 Knowledge Ball 一个生产写权威；
2. Memory 只有 Knowledge Ball 一个长期写权威；
3. Knowledge 只有 Knowledge Ball 一个知识状态写权威；
4. Identity、Lifecycle、Goals、Relationships 的最终业务写权威仍在 NewHumans；
5. NewHumans 展示的 Energy 余额可追溯到 Knowledge Ball 权威版本；
6. Knowledge Ball 故障不会触发 NewHumans 本地第二权威 fallback；
7. Agent 更换模型、窗口、设备或 runtime 不会创建第二身份或第二份权威记忆；
8. Knowledge Ball 仍可作为独立产品运行，NewHumans 集成不要求把其内部实现复制进本仓库；
9. 协议切换不会静默重解释既有 `nh.v3.0` 历史记录。

## Consequences

- NewHumans 以后围绕 Knowledge Ball 建 adapter/boundary，而不是重建 Economy/Memory/Knowledge 核心。
- M02 的自主运行必须把 KB 作为外部权威依赖；可恢复 runtime state 与长期记忆保持分层。
- 现有本地 Economy 实现需要单独的版本化收口任务；NH-002 不提前触碰该代码。
- 任何后续任务若需要在 NewHumans 新增 Economy/Memory/Knowledge 可写表或可写服务，默认与本 ADR 冲突，必须先有明确 superseding ADR。

## Out of scope

- 修改 Knowledge Ball 内部代码或 schema；
- 修改 NewHumans runtime、server、scheduler、policy/control 热点；
- 在 NH-002 中迁移或删除现有 Economy 实现；
- 设计 Knowledge Ball API 的具体字段、网络协议或部署拓扑；
- 修改 Energy 数值规则、日费规则、知识审核规则或记忆内容规则。
