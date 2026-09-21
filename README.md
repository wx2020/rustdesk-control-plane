# RustDesk Control Plane

本项目保留 RustDesk 官方通信层，在其上增加一个独立的管理后台。

## 代码来源

官方代码以浅克隆快照放在 `vendor/`：

- `vendor/rustdesk-server`：正式版 `hbbs`、`hbbr`、`rustdesk-utils`
- `vendor/rustdesk-server-demo`：极简服务端示例，供学习和二次开发参考
- `vendor/rustdesk`：客户端、通信协议和网络连接实现

管理后台位于 `admin/`。基础运维能力保留官方通信协议；当前仓库同时在 `vendor/rustdesk-server` 增加了可选的策略回调，用于不修改客户端时的设备级注册和连接控制。管理后台通过官方服务提供的 loopback runtime console，以及受限的子进程生命周期管理实现运维操作。

## 启动

需要 Node.js 20 或更高版本。首次使用先安装 Rust 工具链，然后构建官方服务端：

```bash
npm run build:server
npm start
```

打开 `http://127.0.0.1:3000`。后台默认只监听本机，不应直接暴露到公网。

## 配置

可通过环境变量调整：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_HOST` | `127.0.0.1` | 管理后台监听地址 |
| `ADMIN_PORT` | `3000` | 管理后台端口 |
| `HBBS_PORT` | `21116` | hbbs 主端口 |
| `HBBR_PORT` | `21117` | hbbr 中继端口 |
| `RELAY_ADDRESS` | `127.0.0.1:21117` | hbbs 广播给客户端的中继地址 |
| `RUSTDESK_RUNTIME_DIR` | `data/` | 运行时数据库、密钥和日志目录 |
| `HBBS_BIN` / `HBBR_BIN` | 自动探测 | 指定已构建的官方二进制 |
| `DATABASE_URL` | 未设置 | PostgreSQL 连接串；未设置时使用仅用于开发的内存存储 |
| `ID_SERVER_ADDRESS` | `127.0.0.1:21116` | 下发给客户端的 ID Server 地址 |
| `RUSTDESK_PUBLIC_KEY` | 从 `data/id_ed25519.pub` 读取 | 下发给客户端的公钥，不读取私钥 |
| `CONTROL_PLANE_URL` | 未设置 | 改造版 `hbbs/hbbr` 调用的策略 API 地址 |
| `CONTROL_PLANE_TOKEN` | 未设置 | 策略 API Bearer token；应与管理后台使用同一值 |
| `CONTROL_PLANE_TOKEN_NEXT` | 未设置 | Token 轮换期间临时接受的下一把策略 API Token |
| `CONTROL_PLANE_ENFORCE` | `N` | `Y` 时策略 API 超时或错误将拒绝连接；未设置地址时不生效 |
| `ADMIN_USERNAME` | `admin` | 本地管理员用户名 |
| `ADMIN_PASSWORD` | 必填 | 首次启动时创建本地管理员的密码 |
| `ADMIN_COOKIE_SECURE` | 自动 | 设置为 `Y` 时只在 HTTPS 请求发送登录 Cookie |
| `ADMIN_ALLOW_MEMORY_STORE` | 未设置 | 仅测试用途；生产环境显式设为 `Y` 才允许内存存储 |
| `UNKNOWN_DEVICE_POLICY` | `pending` | 未登记设备的注册策略：`pending`、`deny` 或仅联调用的 `allow` |
| `ADMIN_LOGIN_RATE_LIMIT` | `10` | 每个来源每分钟允许的登录尝试次数 |
| `CONTROL_PLANE_RATE_LIMIT` | `600` | 每个来源每分钟允许的策略 API 请求次数 |
| `ADMIN_TRUST_PROXY` | `N` | `Y` 时将可信代理的 `X-Forwarded-For` 作为限流来源 |
| `ADMIN_PROXY_AUTH_TRUST` | `N` | `Y` 时信任反向代理用户名头；同时必须设置 `ADMIN_TRUST_PROXY=Y` |
| `ADMIN_PROXY_USER_HEADER` | `x-forwarded-user` | 可信代理传递用户名的请求头 |
| `METRICS_TOKEN` | 未设置 | 可选 Prometheus Bearer Token，不依赖浏览器会话 |
| `AUDIT_RETENTION_DAYS` | `365` | 审计日志保留天数 |
| `EVENT_RETENTION_DAYS` | `90` | 通信事件保留天数 |
| `SESSION_RETENTION_DAYS` | `180` | 已结束 Relay 会话保留天数 |
| `RETENTION_CLEANUP_INTERVAL_HOURS` | `24` | 自动保留清理间隔小时数 |
| `CONTROL_PLANE_CACHE_TTL` | `5` | 改造版服务端策略决策缓存秒数 |
| `CONTROL_PLANE_CIRCUIT_OPEN_FOR` | `15` | 连续策略失败后熔断打开秒数 |

管理后台不会执行任意 shell 命令。控制台输入会被限制为单条命令，并通过 `127.0.0.1` 连接官方服务的控制端口。

管理 API 使用本地管理员登录、HttpOnly SameSite 会话 Cookie 和 CSRF Token 保护。生产环境必须设置 `DATABASE_URL` 与 `ADMIN_PASSWORD`；使用反向代理时应终结 HTTPS 并设置 `ADMIN_COOKIE_SECURE=Y`。PostgreSQL 结构通过 `admin/migrations/` 的版本化迁移管理，已应用版本保存在 `schema_migrations` 表；`admin/schema.sql` 只保留为早期结构参考。

控制面提供 `GET /healthz` 健康检查，以及受管理员会话保护的 `GET /metrics` Prometheus 文本指标；配置 `METRICS_TOKEN` 后可使用 Bearer Token 抓取。管理员会话保存于 PostgreSQL，可在多个控制面实例间共享。完整的部署、备份恢复、密钥与 Token 轮换流程见 `docs/OPERATIONS-RUNBOOK.md`。

PostgreSQL 集成测试使用 `docker-compose.test.yml` 提供临时数据库。数据库健康后运行 `npm run test:postgres`；常规 `npm test` 在未设置 `TEST_DATABASE_URL` 时会跳过该集成测试。

## 管理 API

配置 `DATABASE_URL` 后启动后台会自动创建独立的 PostgreSQL 表结构，管理数据不依赖官方服务的 SQLite。主要接口包括：

- `GET/POST /api/admin/departments`：部门
- `GET/POST /api/admin/users`：用户
- `GET/POST /api/admin/groups`：设备分组
- `GET/POST /api/admin/relays`：中继登记
- `GET/POST /api/admin/devices`：设备登记
- `PATCH /api/admin/devices/:id`：设备负责人、分组、禁用状态等
- `POST /api/devices/:id/heartbeat`：设备最后在线时间
- `GET /api/devices/:id/config`：生成 ID Server、Relay Server、公钥配置
- `GET /api/admin/summary`：管理统计
- `GET /api/admin/sessions`：Relay 会话记录
- `GET /api/admin/events`：通信事件流
- `GET /api/admin/audit/export`：审计 CSV 导出
- `POST /api/admin/retention/run`：手动执行保留清理
- `GET/POST/PATCH /api/admin/rules`：设备、分组和标签目标策略规则
- `POST /api/admin/policy/simulate`：策略模拟
- `POST /api/admin/sessions/:id/terminate`：请求断开活跃 Relay 会话

第一阶段接口是内网管理 API，尚未替代 `hbbs` 的连接授权。客户端配置已知时，设备仍可能绕过页面直接连接；需要强制授权时，应在后续 fork 的 `hbbs` 中增加授权回调。

## 服务端策略增强

`vendor/rustdesk-server` 现在包含可选的策略回调。使用本仓库构建的 `hbbs/hbbr`，并设置：

```bash
CONTROL_PLANE_URL=http://127.0.0.1:3000
CONTROL_PLANE_TOKEN=change-me
CONTROL_PLANE_ENFORCE=Y
```

服务端会在设备注册、连接请求和 Relay 建立前调用管理 API，并上报事件。未启用 `CONTROL_PLANE_URL` 时行为保持官方默认；启用但不强制时 API 暂时不可用会 fail-open；`CONTROL_PLANE_ENFORCE=Y` 才会 fail-closed。

设备状态为 `pending`、`approved`、`rejected` 或 `disabled`。管理员手工登记的设备默认 `approved`；服务端发现未知设备时，默认创建 `pending` 资产，允许完成注册但拒绝新的连接和 Relay，直到管理员调用 `POST /api/admin/devices/:id/approval` 并提交 `{"status":"approved"}`。`UNKNOWN_DEVICE_POLICY=deny` 会立即拒绝未知设备注册，`allow` 只用于过渡联调。

连接和 Relay 的当前策略版本为 `device-owner-department-v1`：目标设备必须为 `approved` 且未禁用；如果设备已绑定负责人，则负责人不能禁用；如果负责人属于部门，则部门不能禁用。未绑定负责人或部门的设备不受该可选关系限制。策略响应包含 `policyVersion` 与 `reason`，常见拒绝原因包括 `device_pending`、`device_disabled`、`owner_disabled`、`department_disabled` 和 `device_unknown`。

策略事件必须携带 `eventId`、`eventType` 和 `targetId`。`eventId` 在 `communication_events` 中幂等；`relay_start` 和 `relay_end` 还应携带稳定的 `sessionKey`，用于投影至 `sessions`。直连协商仅保存连接请求事件，当前不会伪造不可观察的会话结束记录。

策略规则按 `priority` 从小到大匹配目标设备、设备分组或标签。规则动作为 `register`、`connect`、`relay`、`force_relay`，效果为 `allow`、`deny` 或 `force_relay`。设备审批、设备禁用、负责人禁用和部门禁用始终优先于规则。策略模拟可在发布规则前检查结果。Relay 断开请求依赖改造版 `hbbr` 的 `disconnect <sessionKey>` 控制台命令，直连会话仍不能由该命令断开。

由于客户端协议没有稳定携带发起方 RustDesk ID，当前可强制执行的是设备注册审批、目标设备禁用和目标连接控制；不能仅靠服务端可靠实现完整的“发起设备 -> 目标设备”ACL。`hbbr` 可再次校验 Relay 建立请求，但已建立的直连会话不经过 `hbbr`。

## Docker

官方服务端已有 `vendor/rustdesk-server/docker-compose.yml`。当前管理后台设计为宿主机控制已构建的官方二进制；生产部署建议将管理后台放在内网或反向代理认证之后，并将 `data/` 持久化。

## 许可

官方仓库的许可证和版权声明保留在各自 `vendor/` 目录中。新增管理后台代码采用 MIT 许可，见 `LICENSE`。
