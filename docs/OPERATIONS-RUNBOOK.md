# RustDesk Control Plane 运维 Runbook

## 1. 生产前配置

控制面必须使用独立 PostgreSQL；不得以 `ADMIN_ALLOW_MEMORY_STORE=Y` 运行生产环境。

```bash
NODE_ENV=production
DATABASE_URL=postgresql://control_plane:<password>@db:5432/rustdesk_control
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<long-random-password>
ADMIN_COOKIE_SECURE=Y
CONTROL_PLANE_URL=https://control-plane.internal
CONTROL_PLANE_TOKEN=<long-random-token>
CONTROL_PLANE_ENFORCE=Y
CONTROL_PLANE_CACHE_TTL=5
CONTROL_PLANE_CIRCUIT_OPEN_FOR=15
UNKNOWN_DEVICE_POLICY=pending
```

安全要求：

- 管理后台应仅监听 loopback 或私网，并由 HTTPS 反向代理对外提供服务。
- 非 loopback 的生产监听地址必须设置 `ADMIN_COOKIE_SECURE=Y`。
- 反向代理仅在可信网络中添加 `X-Forwarded-For`；只有显式设置 `ADMIN_TRUST_PROXY=Y` 时应用才使用该头做限流来源。使用代理身份认证时，还需设置 `ADMIN_PROXY_AUTH_TRUST=Y`，并使代理的用户名头不可由外部请求伪造。
- 所有密码、Token 和数据库 URL 必须通过 Secret 管理系统、systemd `EnvironmentFile` 或容器 Secret 注入。
- 不要将 `.env`、备份、`id_ed25519` 或 `data/` 提交到仓库。

## 2. 健康和指标

```bash
curl -fsS http://127.0.0.1:3000/healthz
```

预期：`{"status":"ok"}`。健康检查会等待数据存储和认证引导完成。

`/metrics` 是受管理员会话保护的 Prometheus 文本端点。生产监控应使用仅具 `services.manage` 权限的专用管理账号，或由受控的本地抓取代理附带会话。也可设置 `METRICS_TOKEN` 并使用 `Authorization: Bearer <token>`；不要将 Metrics 端点公开到公网。

关注指标：

- `rustdesk_control_plane_policy_checks_total`
- `rustdesk_control_plane_policy_check_duration_seconds_*`
- `rustdesk_control_plane_events_total`
- `rustdesk_control_plane_rate_limited_total`
- `rustdesk_control_plane_active_sessions`

告警建议：

- 健康检查连续失败。
- 策略拒绝或策略延迟突然升高。
- `rate_limited_total` 持续增加。
- 活跃 Relay 会话与业务预期明显偏离。

## 3. PostgreSQL 备份与恢复

备份前确认应用仍可服务，且使用正确的生产连接串：

```bash
DATABASE_URL="$DATABASE_URL" BACKUP_DIR=/secure/backups npm run backup
```

恢复到新建的隔离数据库。脚本要求显式确认，以避免误清理生产库：

```bash
DATABASE_URL=postgresql://control_plane:<password>@db:5432/rustdesk_control_restore \
BACKUP_FILE=/secure/backups/rustdesk-control-YYYYMMDDTHHMMSSZ.dump \
RESTORE_CONFIRM=Y \
npm run restore
```

恢复演练：

1. 在隔离环境启动控制面，使用恢复后的 `DATABASE_URL`。
2. 验证管理员可登录、设备、审批状态、审计记录、通信事件和会话均可查询。
3. 不要在生产恢复演练中运行 `--clean` 指向生产数据库。
4. 为备份设置加密、访问控制和保留期限；建议至少每日备份及定期恢复演练。

## 4. 审计导出与保留清理

审计员可从 `GET /api/admin/audit/export` 下载 CSV。自动保留清理按 `RETENTION_CLEANUP_INTERVAL_HOURS` 执行；它删除超过 `AUDIT_RETENTION_DAYS`、`EVENT_RETENTION_DAYS`、`SESSION_RETENTION_DAYS` 的记录以及过期后台会话。清理前若需长期归档，应先执行数据库备份。

管理员也可在已登录会话下调用 `POST /api/admin/retention/run`；该操作会写入审计日志。不要将管理员 Cookie 或 CSRF Token 放入 shell 历史记录；仅在受控自动化中使用 `admin/retention.sh` 的环境变量接口。

## 5. RustDesk 密钥轮换

`id_ed25519` 是服务端私钥；`id_ed25519.pub` 是下发给客户端的公钥。轮换会要求客户端更新公钥配置，应安排维护窗口。

1. 备份现有 `data/id_ed25519` 与 `data/id_ed25519.pub` 到受保护的离线位置。
2. 停止 `hbbs` 和 `hbbr`，确认没有正在维护的重要 Relay 会话。
3. 生成新密钥对，或移除运行目录的旧密钥后由 `hbbs` 生成新对。
4. 更新 `RUSTDESK_PUBLIC_KEY` 或确认新 `id_ed25519.pub` 被控制面读取。
5. 重启 `hbbs`、`hbbr` 和控制面。
6. 在批准设备上更新客户端 ID Server、公钥配置，验证注册、连接和 Relay。
7. 在所有客户端迁移前保留旧密钥的加密备份；完成迁移并验证后按组织密钥保留策略销毁。

不要记录、打印或通过管理 API 下发 `id_ed25519` 私钥。

## 6. 控制面 Token 轮换

`CONTROL_PLANE_TOKEN` 是 `hbbs/hbbr` 调用策略 API 的主 Bearer Token。`CONTROL_PLANE_TOKEN_NEXT` 可在轮换期间作为临时接受的第二把 Token，实现平滑重叠。

1. 创建新的高熵 Token，并先作为控制面的 `CONTROL_PLANE_TOKEN_NEXT` 部署。
2. 先将改造版 `hbbs/hbbr` 更新为新 Token，验证策略事件正常。
3. 将控制面的主 Token 更新为新 Token，旧 Token 临时设置为 `CONTROL_PLANE_TOKEN_NEXT`。
4. 验证新 Token 正常、旧 Token仍可在重叠期工作。
5. 所有通信面实例更新后移除 `CONTROL_PLANE_TOKEN_NEXT`，验证旧 Token 收到 401。
6. 记录轮换时间、操作者和结果，不记录 Token 本身。

后续可增加 key ID、过期时间和独立 Token 轮换审计。

## 7. 事故处理

### 策略 API 不可用

- `CONTROL_PLANE_ENFORCE=Y`：新注册、连接和 Relay 可能被拒绝。
- `CONTROL_PLANE_ENFORCE=N`：服务端按 fail-open 继续，但需要审计风险。
- 先检查 `/healthz`、PostgreSQL 连接、反向代理和 `CONTROL_PLANE_TOKEN` 是否一致。
- 不要为恢复服务而永久关闭认证、审计或安全头。

### 疑似 Token 泄露

1. 立即轮换 `CONTROL_PLANE_TOKEN` 和受影响的管理员密码。
2. 查看审计日志、策略拒绝记录和应用日志。
3. 检查 Secret 注入、反向代理日志、CI 输出和备份访问记录。
4. 对于疑似私钥泄露，执行完整 RustDesk 密钥轮换。

### 登录暴力尝试

- 检查 `rustdesk_control_plane_rate_limited_total{scope="login"}`。
- 通过反向代理、WAF 或防火墙封锁来源；不要仅依赖进程内限流。
- 调低 `ADMIN_LOGIN_RATE_LIMIT` 前先评估合法管理员共享出口 IP 的影响。

## 8. 策略与 Relay 运维

策略规则按优先级升序匹配目标设备、其设备组或标签。设备审批、设备禁用、负责人禁用和部门禁用始终先于规则。发布规则前先使用 `POST /api/admin/policy/simulate` 验证目标设备和动作。

`force_relay` 规则要求使用改造版 `hbbs`，它会把连接协商标记为对称 NAT，从而要求客户端使用 Relay。规则配置完成不代表立即生效：服务端会按 `CONTROL_PLANE_CACHE_TTL` 缓存策略结果；紧急禁用设备时应将该值设为低 TTL，并在具备 Rust 运行验证后确认缓存收敛时间。

管理后台可对活跃 Relay 会话调用：

```text
POST /api/admin/sessions/:id/terminate
```

该操作向 `hbbr` loopback console 发送 `disconnect <sessionKey>`，Relay 循环将在下一个检查周期关闭会话。它不能断开直连会话。只有使用本仓库改造版 `hbbr` 并完成 Rust 互操作验证后，才能作为生产断开流程使用。

## 9. 上游同步

每次同步 `vendor/rustdesk-server` 前：

1. 记录上游标签、提交 ID 和本仓库策略补丁列表。
2. 重点复核 `rendezvous_server.rs` 的注册、Punch Hole、Request Relay 路径，以及 `relay_server.rs` 的配对与控制台路径。
3. 重新应用并审查 `policy.rs`、缓存/熔断、事件重试和 Relay 断开逻辑。
4. 在隔离环境执行 Rust 构建、控制面测试、官方客户端和 fail-open/fail-closed 互操作测试。
5. 评审 AGPL-3.0 上游义务和本仓库 MIT 新增代码边界后再发布。
