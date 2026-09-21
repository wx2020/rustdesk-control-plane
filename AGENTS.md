# rustdesk（RustDesk Control Plane）项目记忆

## 项目定位

保留 RustDesk 官方通信层（hbbs/hbbr），在上层增加独立管理后台（控制面）。工作区 `/home/openchamber/workspaces/rustdesk`，非 git 仓库（根目录未 init）。

- 客户端不修改；通信数据不经过管理后台；直连会话不经过 hbbr。
- 管理数据使用独立 PostgreSQL（`DATABASE_URL`），不依赖 hbbs 的 SQLite。
- 架构边界（已文档化，勿对外承诺）：客户端协议无稳定源端 RustDesk ID → 不能做源设备→目标设备 ACL；直连会话无法由后台断开/精确观测。

## 当前结构（2026-09-21 更新）

- `vendor/rustdesk-server`：官方 1.1.17 快照（a7736be）+ **本仓库策略补丁**（已突破"vendor 不改"旧约定，决策记录：静态代码接入，待 Rust 环境编译验证）
  - `src/policy.rs`：策略客户端、800ms 超时、缓存 `CONTROL_PLANE_CACHE_TTL`（默认5s）、熔断 `CONTROL_PLANE_CIRCUIT_OPEN_FOR`（默认15s）、事件重试3次（内存态，无持久化队列）
  - `src/rendezvous_server.rs`：RegisterPeer/RegisterPk/Punch Hole/Request Relay 接入策略
  - `src/relay_server.rs`：Relay 建立前策略 + `disconnect <sessionKey>` console 命令 + 生命周期事件
- `vendor/rustdesk-server-demo`、`vendor/rustdesk`：未改动的官方快照
- `admin/`：Node.js ≥20 控制面（唯一运行时依赖 `pg`）
  - `server.js`：HTTP API、子进程管理、策略判定、保留清理、Token 轮换
  - `store.js`：MemoryStore（测试）/PostgresStore，自动执行 `admin/migrations/`（001-008）
  - `auth.js`：scrypt 本地登录、HttpOnly SameSite Cookie、CSRF、RBAC、持久化会话（admin_sessions 表）、可信代理身份映射
  - `observability.js`：Prometheus 指标、固定窗口限流、日志脱敏、X-Forwarded-For
  - `migrations/`：8 个版本化 SQL；`schema_migrations` 记录已应用版本
  - `backup.sh` / `restore.sh`：`npm run backup` / `npm run restore`（restore 需 `RESTORE_CONFIRM=Y`）
  - `postgres.test.js`：需 `TEST_DATABASE_URL`，否则跳过
  - `public/`：中文单页控制台（原生 HTML/CSS/JS，无框架），2026-09-21 已产品化改版：首屏三轨状态（控制面/通信面/审批队列）、状态色体系、响应式布局、去重后的单文件 styles.css
- `patches/`：`patches/rustdesk-server/0001-control-plane-policy.patch` 标准 Patch 资产
- `scripts/`：`scripts/sync-server.js` 跨平台上游同步与补丁管理工具（`npm run sync:server:check` / `sync:server:apply` / `sync:server:export`）
- `.github/workflows/upstream-sync.yml`：上游定时版本探测与补丁门禁自动化工作流
- `vendor/rustdesk-server/.upstream-rev`：上游基准仓库、Commit、Tag 与 Patch 映射清单
- `docs/`：`IMPLEMENTATION-TODO.md`（单一 P0→P1→P2 优先级 + 四级状态定义）、`OPERATIONS-RUNBOOK.md`（含第9节上游同步 SOP）、`SE-ARCHITECTURE.md`

## 核心机制

- 设备状态：`pending/approved/rejected/disabled`；未知设备默认 `UNKNOWN_DEVICE_POLICY=pending`
- 策略版本 `device-owner-department-v1`：目标设备 approved 且未禁用、负责人未禁用、部门未禁用 → allow；规则（设备/组/标签匹配，allow/deny/force_relay，priority 升序）在此之后
- 策略 API：`/api/policy/check`、`/api/policy/events`，Bearer Token = `CONTROL_PLANE_TOKEN` + 轮换期 `CONTROL_PLANE_TOKEN_NEXT`（timingSafeEqual）
- 事件：`eventId` 幂等（communication_events）；`relay_start/relay_end` 按 `sessionKey` 投影 sessions
- 保留清理：审计365天/事件90天/已结束会话180天（环境变量可调），定时+手动 `POST /api/admin/retention/run`
- 审计导出：`GET /api/admin/audit/export`（CSV）
- Metrics：`/metrics`，可用 `METRICS_TOKEN` Bearer 或管理员会话

## 验证状态（2026-09-21）

- `npm test`：**14 通过 / 4 跳过**（4 项 PostgreSQL 集成测试：migration 幂等、20 并发设备唯一约束、20 并发事件幂等+会话投影、JSONB——需 TEST_DATABASE_URL）
- 语法检查全部通过（node --check、bash -n）；restore 脚本无凭据时正确拒绝执行
- 预览实例验证过：`ADMIN_PORT=3001 ADMIN_PASSWORD=... ADMIN_ALLOW_MEMORY_STORE=Y npm start`，静态资源 200
- **未验证（环境阻塞，本容器无 cargo/rustc/docker/psql）**：Rust 编译、hbbs/hbbr 启动、官方客户端互操作、真实 PostgreSQL 执行、fail-open/closed 故障注入

## 关键环境变量（完整表见 README.md）

生产必填：`DATABASE_URL`、`ADMIN_PASSWORD`；非 loopback 需 `ADMIN_COOKIE_SECURE=Y`
安全联动：`ADMIN_PROXY_AUTH_TRUST=Y` 必须同时 `ADMIN_TRUST_PROXY=Y`（auth.js 与 server.js 双重校验）

## 当前待办（详见 docs/IMPLEMENTATION-TODO.md）

- P0：PostgreSQL 16 实测（`docker compose -f docker-compose.test.yml up -d && npm run test:postgres`）、备份恢复演练、Rust 构建与三种模式验证、官方客户端端到端、生产安全审查
- P1：列表分页下推 PostgreSQL、事件持久化队列/死信、结构化日志与告警、管理台组织 CRUD/批量审批/规则一键回滚
- P2：源端 ACL / 直连可观测性 / 直连断开——协议验证后的决策项，不作为交付承诺

## 行为约定

- vendor/ 内官方代码保持快照可对比；**唯一例外**是 rustdesk-server 的策略补丁（已发生，上游同步时需重放审查，见 Runbook 第9节）
- 定制代码一律放 `admin/`；后台定位"进程级运维控制 + 官方 console 透传 + 策略判定"，不重写通信逻辑
- 文档状态口径：`[x]` 仅代表 Node 本地验证，不代表 PostgreSQL/Rust/生产可用；`[V]`（目标验证）才是发布阻塞项的完成状态
