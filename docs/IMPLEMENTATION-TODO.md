# RustDesk Control Plane 实施 ToDoList

本文档是唯一的后续执行顺序。后续工作必须按 P0、P1、P2 推进；同一优先级内的项目可并行，但不得将未完成的 P0 能力作为生产承诺。

## 状态定义

- `[ ]` 已规划：没有可合并的实现或验证证据。
- `[~]` 已实现待验证：存在代码或脚本，但尚未在该项要求的目标环境完成验收。
- `[x]` 本地验证：已通过 Node 自动测试或静态检查；不能据此声明 PostgreSQL、Rust 服务端或生产环境可用。
- `[V]` 目标验证：已按项目验收标准在 PostgreSQL、通信面或生产预演环境完成，并在变更记录中保留命令、版本、时间、操作者和结果。

`[V]` 是发布阻塞项的唯一完成状态。环境证据应存放在发布记录或受控运维系统，不记录密码、Token、私钥或完整数据库连接串。

## 当前基线

- 控制面：Node.js 20+，独立 PostgreSQL 数据库，版本化 migration；支持本地管理员认证、OAuth 2.0 / OIDC (Authelia) 单点登录与反向代理身份透传。
- 通信面：官方 RustDesk `hbbs/hbbr` 加入本仓库策略、事件和 Relay 断开静态代码。
- 客户端：不修改 RustDesk 客户端。
- 当前验证：`npm test` 通过 19 项 Node 控制面测试（含 OAuth PKCE、发现与回调认证套件）；没有 `TEST_DATABASE_URL` 时，PostgreSQL 集成测试套件跳过。
- 当前环境阻塞：没有 `cargo`、`rustc` 或 Docker，未执行 PostgreSQL、Rust 构建、服务启动及官方客户端互操作验证。
- 架构边界：在不修改客户端的前提下，不能可靠提供源设备到目标设备 ACL、直连会话完整生命周期/流量统计，或断开已建立的直连会话。

已实现但尚未完成目标验证的能力统一标记为 `[~]`：PostgreSQL migration 与 CRUD、`hbbs/hbbr` 策略接入、策略缓存/熔断/重试、Relay 生命周期和 `disconnect <sessionKey>`、Authelia 生产端到端 SSO。

## P0：发布阻塞验证与安全部署

所有 P0 项必须达到 `[V]` 才能将策略强制执行或改造版通信面用于生产。

### P0.1 PostgreSQL 数据正确性与恢复

- `[~]` 在 PostgreSQL 16 上执行 `docker compose -f docker-compose.test.yml up -d` 与 `npm run test:postgres`。
- `[~]` 已为顺序 migration、并发设备唯一约束、并发事件幂等和 Relay 会话投影建立 PostgreSQL 集成测试；仍缺数据库中断与备份恢复自动化。
- `[~]` 已提供 `npm run backup` 与需 `RESTORE_CONFIRM=Y` 的 `npm run restore`；仍需在隔离的 PostgreSQL 16 环境执行备份和恢复演练。

验收标准：

- `npm test` 的 14 项 Node 控制面测试全部通过，`npm run test:postgres` 的 PostgreSQL 测试不得跳过且必须全部通过。
- 空数据库第一次启动和同一数据库连续两次启动均成功；`schema_migrations` 中每个 migration 仅一条记录。
- 20 个并发请求创建同一个 `rustdeskId` 时，恰有 1 个成功，其余返回冲突；20 个并发事件使用同一 `eventId` 时，恰有 1 条 `communication_events` 记录和至多 1 个关联 Relay 会话。
- 在连续写入期间断开 PostgreSQL 30 秒，`/healthz` 在 10 秒内返回 `503`；数据库恢复后 60 秒内恢复 `200`，进程不得退出或静默丢失已确认写入。
- `npm run backup` 生成的 custom-format 备份可恢复到空库；恢复后用户、设备、规则版本、审计、通信事件和会话的行数与备份前一致，并抽样验证至少 10 条 JSONB `metadata`/`tags` 值相等。
- 运维目标：每日成功备份，RPO 不超过 24 小时，单库恢复 RTO 不超过 60 分钟。备份需加密并有恢复演练记录。

### P0.2 Rust 构建与策略执行

- `[~]` 在 `vendor/rustdesk-server` 编译改造版 `hbbs/hbbr`。
- `[~]` 在测试网络验证注册、连接、Relay、策略事件与 Relay 断开。
- `[~]` 验证控制面错误下的 fail-open、fail-closed、缓存和熔断路径。

验收标准：

- `cargo check --manifest-path vendor/rustdesk-server/Cargo.toml` 与 `npm run build:server` 退出码为 0，且记录 Rust 版本、上游提交和构建产物校验值。
- 未设置 `CONTROL_PLANE_URL` 时，至少 10 次注册、连接和 Relay 尝试全部按上游基线完成。
- `CONTROL_PLANE_ENFORCE=Y` 时，pending、rejected、disabled 目标设备各进行 10 次连接/Relay 尝试，全部被拒绝；approved 设备各进行 10 次尝试，全部按规则允许或拒绝。
- `force_relay` 规则在 10 次连接尝试中均使用 Relay；不含该规则的基线测试保留实际传输类型作为证据，不假设必然直连。
- 对策略 API 注入超时、401 和 500：每种故障执行 10 次。fail-open 模式不得因策略 API 故障拒绝请求；fail-closed 模式不得允许请求。策略 HTTP 超时预算为 800 ms，熔断打开时间与 `CONTROL_PLANE_CIRCUIT_OPEN_FOR` 配置相符。
- 相同 `eventId` 重放 10 次后只保留一条通信事件；每个完整 Relay 测试产生一条 `relay_start` 与一条 `relay_end` 投影会话。
- 对一个活跃 Relay 会话执行 `disconnect <sessionKey>`，会话在 30 秒内标记为结束。该项不适用于直连会话，直连会话不得宣称可由后台断开。

### P0.3 官方客户端与部署安全

- `[ ]` 选定至少一个受支持官方客户端版本，在隔离环境做端到端验证。
- `[ ]` 完成 HTTPS、Secret、备份加密、监控、可信代理和 Token 轮换预演。

验收标准：

- 每个受支持客户端版本完成 10 次注册、连接和 Relay；拒绝策略在 10 次尝试中均拒绝，客户端显示可识别的失败结果且不崩溃。
- 外部网络无法直接访问 Node 后台监听端口、PostgreSQL 端口和 `hbbs/hbbr` loopback console；仅 HTTPS 反向代理公开管理页面。
- 非 loopback 部署设置 `ADMIN_COOKIE_SECURE=Y`；所有密钥均经 Secret 注入，仓库、日志、审计 CSV 和备份文件抽查不得包含明文密码、Token 或私钥。
- 启用代理认证时，`ADMIN_TRUST_PROXY=Y` 和 `ADMIN_PROXY_AUTH_TRUST=Y` 同时存在；从代理外部伪造 `X-Forwarded-For` 或代理用户头不得获得管理员身份。
- `/metrics` 仅接受 `METRICS_TOKEN` 或具备 `services.manage` 权限的会话；未认证请求返回 401/403，公网边界不得可达。
- 双 Token 轮换中，新旧 Token 在重叠期均可完成 10 次策略检查；移除旧 Token 后旧 Token 的 10 次请求均返回 401，新 Token 的 10 次请求均成功。

## P1：可靠性、可观测性与治理效率

P1 开始前，P0.1、P0.2 和 P0.3 必须均为 `[V]`。P1 项完成后应达到 `[V]`，并将压测环境、数据规模和结果写入发布记录。

### P1.1 数据访问与审计规模

- `[ ]` 将列表筛选、排序和游标分页下推到 PostgreSQL。
- `[ ]` 为审计导出增加强制时间范围、最大导出量和异步/分段导出策略。
- `[ ]` 补充事件、会话、审计和设备列表的索引使用与边界测试。

验收标准：

- 在 PostgreSQL 16、至少 100,000 条通信事件和 100,000 条审计记录的数据集上，分页查询每页最多 100 条，不允许 Node 先加载全表再 `slice()`。
- 在基准环境连续执行 100 次第一页和 100 次游标后续页查询，HTTP 端到端 p95 小于 500 ms，错误率为 0；基准环境的 CPU、内存、PostgreSQL 版本和数据生成脚本必须记录。
- 审计导出必须要求起止时间；单次最多导出 100,000 行或 30 天数据，以较小者为准。超过限制返回可操作错误或转入受审计的异步任务。
- `EXPLAIN (ANALYZE, BUFFERS)` 证明常用时间范围和游标查询使用适用索引，不得对 100,000 行测试表产生顺序全表扫描。

### P1.2 事件可靠投递与可观测性

- `[ ]` 以持久化队列或可查询死信队列替代仅内存的 Rust 事件重试。
- `[ ]` 增加结构化日志、请求/事件关联 ID、数据库与策略 API 失败指标。
- `[ ]` 配置指标告警、运行手册链接和告警恢复验证。

验收标准：

- 在控制面不可用时发送 100 个不同 `eventId`，通信面重启后每个事件要么成功持久化一次，要么在死信队列中可查询；不得静默丢失，重复投递不得生成重复记录。
- 对每个死信事件提供事件 ID、首次失败时间、最近错误、重试次数和人工重放结果；成功重放后在 60 秒内从死信队列移除或标记完成。
- 所有管理 API 请求和策略事件均写入关联 ID；日志为可解析 JSON，且自动脱敏密码、Token、数据库密码和私钥。
- 指标至少覆盖健康状态、策略检查总数及结果、策略延迟分位数、事件投递/死信、数据库错误、限流和活跃 Relay 会话。
- 在 5 分钟内连续三次健康检查失败、5 分钟策略错误率超过 1%、或死信队列非空超过 15 分钟时触发告警；演练必须在 5 分钟内收到告警并链接到 Runbook。

### P1.3 管理台治理闭环

- `[ ]` 完成部门、用户、角色、设备组和 Relay 的 CRUD 管理台。
- `[ ]` 增加设备批量审批与规则版本一键回滚。
- `[ ]` 为高风险治理操作提供确认、权限边界和审计检索入口。

验收标准：

- 每种组织资源均可在管理台完成创建、读取、更新和禁用/删除（若模型支持），并由相应 RBAC 权限拒绝未授权用户。
- 单次批量审批支持 1 至 100 台设备；部分失败时返回每台结果，成功项仅执行一次并全部产生审计记录。
- 任一规则版本可在管理台一键恢复；恢复后创建新版本，旧版本不被覆盖，模拟结果与恢复后的规则一致。
- 管理台全部写操作要求 CSRF 或可信代理认证，并在审计日志中记录操作者、时间、资源和结果。

## P2：协议确认后的能力决策

这些项目不阻塞 P0/P1，但没有协议与互操作证据前不得写入产品承诺。

- `[ ]` 通过抓包、服务端代码审查和官方客户端测试确认连接路径是否有可信源端身份。
- `[ ]` 若存在可信映射，实现源设备到目标设备 ACL，并补充防伪、缓存和端到端回归；否则将产品边界明确固定为目标设备级控制。
- `[ ]` 仅记录经协议验证的直连生命周期；不得伪造直连结束、流量或断开结果。
- `[ ]` 只有协议层具备相应能力后，评估直连断开、带宽策略和客户端扩展。

## 持续维护
 
- `[~]` 建立 `vendor/rustdesk-server` 上游同步流水线：基于 `.upstream-rev` 与 `patches/rustdesk-server/0001-control-plane-policy.patch`，通过 `scripts/sync-server.js` 实现版本感知、冲突探测（`npm run sync:server:apply -- --dry-run`）和 Patch 导出（`npm run sync:server:export`）。
- `[ ]` 每次同步 `vendor/rustdesk-server`：记录上游提交与补丁，重新执行 P0.2 和受支持客户端版本验证。
- `[ ]` 每季度执行一次 PostgreSQL 恢复演练和 Token 轮换演练，确认 RPO/RTO 与审计证据。
- `[ ]` 每次发布前复核 RustDesk 上游 AGPL-3.0 义务与本项目新增 MIT 代码边界。

