# RustDesk Control Plane - OAuth 2.0 / OIDC (Authelia) 接入指南

本指南详细说明如何在 RustDesk Control Plane（控制面管理后台）中启用 OAuth 2.0 / OpenID Connect (OIDC) 单点登录，并以开源身份认证网关 **Authelia** 作为标准接入示例。

---

## 1. 架构与安全特性

- **协议标准**：采用 **Authorization Code Flow（授权码模式）+ PKCE (RFC 7636, S256)**，杜绝授权码拦截注入攻击。
- **状态防伪**：授权请求中生成高熵随机 `state`，并经由 HMAC-SHA256 签名存入受保护的 HttpOnly、`SameSite=Lax` 临时 Cookie（`rd_oauth_state`），跨站跳转回调时进行 `crypto.timingSafeEqual` 恒定时间防篡改校验。
- **自动建档（JIT Provisioning）**：初次通过 Authelia 登录的用户可自动在后台 `managed_users` 表建档并赋予角色（默认 `role_admin`，可配置）。
- **零外部依赖**：基于 Node.js 22 内置 `node:crypto` 与原生 `fetch` 实现，轻量、无第三方供应链安全风险。
- **多模并存**：本地超级管理员账号密码登录（scrypt）、可信反向代理身份透传（`ADMIN_PROXY_AUTH_TRUST`）与 OAuth 单点登录入口无缝共存。

---

## 2. 控制面环境变量配置

在控制面运行环境（如 `.env` 或 Docker 环境变量）中进行配置：

| 环境变量 | 必填 | 默认值 | 说明 |
| :--- | :---: | :---: | :--- |
| `OAUTH_ENABLED` | 是 | `N` | 设为 `Y` 或 `true` 启用 OAuth 2.0 登录入口 |
| `OAUTH_PROVIDER_NAME` | 否 | `Authelia` | 前端登录按钮展示的提供商名称，例如 `Authelia` 或 `企业统一认证` |
| `OAUTH_ISSUER` | 推荐 | - | OIDC 提供商基础 URL（如 `https://auth.example.com`），自动拉取 `/.well-known/openid-configuration` |
| `OAUTH_DISCOVERY_URL` | 否 | - | 自定义服务发现 URL（若 issuer 未挂载在标准根路径） |
| `OAUTH_AUTH_URL` | 否 | - | 手动指定授权端点（设置时跳过网络发现） |
| `OAUTH_TOKEN_URL` | 否 | - | 手动指定 Token 交换端点（设置时跳过网络发现） |
| `OAUTH_USERINFO_URL` | 否 | - | 手动指定 UserInfo 端点（若支持从 id_token 解析可留空） |
| `OAUTH_CLIENT_ID` | 是 | - | 在 Authelia 注册的客户端 ID（例如 `rustdesk-control-plane`） |
| `OAUTH_CLIENT_SECRET` | 是 | - | 在 Authelia 注册的客户端明文密钥（对应 Authelia 端配置的 hash） |
| `OAUTH_REDIRECT_URI` | 否 | 自动推导 | 控制面回调地址，格式为 `https://<control-plane-domain>/api/auth/oauth/callback` |
| `OAUTH_SCOPES` | 否 | `openid profile email` | 授权范围列表（以空格隔开） |
| `OAUTH_AUTO_CREATE_USER` | 否 | `Y` | 初次登录且本地无对应账号时，是否自动建档（`Y`/`N`） |
| `OAUTH_DEFAULT_ROLE_ID` | 否 | `role_admin` | 自动建档时赋予的初始角色 ID（如 `role_admin`） |

---

## 3. Authelia 端配置示例

在 Authelia 的 `configuration.yml` 中的 `identity_providers.oidc` 节点下增加 RustDesk 客户端：

```yaml
identity_providers:
  oidc:
    ## 生产环境必须配置用于签署 JWT/id_token 的 HMAC 密钥或 RSA 私钥
    hmac_secret: 'a_very_secure_secret_for_authelia_oidc_hmac_at_least_64_bytes'
    issuer_private_key: |
      -----BEGIN RSA PRIVATE KEY-----
      ... 你的私钥 ...
      -----END RSA PRIVATE KEY-----

    clients:
      - client_id: 'rustdesk-control-plane'
        client_name: 'RustDesk Control Plane'
        ## client_secret 推荐在 Authelia 中使用 pbkdf2 或 argon2 哈希
        ## 生成命令：authelia crypto hash generate pbkdf2 --password 'YourSecretHere123'
        client_secret: '$pbkdf2-sha512$100000$...'
        public: false
        authorization_policy: 'one_factor' # 或 'two_factor' 启用强制 2FA
        redirect_uris:
          - 'https://control.example.com/api/auth/oauth/callback'
          - 'http://127.0.0.1:3000/api/auth/oauth/callback' # 本地测试用
        scopes:
          - 'openid'
          - 'profile'
          - 'email'
        response_types:
          - 'code'
        grant_types:
          - 'authorization_code'
        response_modes:
          - 'form_post'
          - 'query'
        userinfo_signed_response_alg: 'none'
        token_endpoint_auth_method: 'client_secret_basic' # 控制面同时兼容 basic 与 post
```

---

## 4. Docker Compose 联合运行配置范例

以下为使用 Docker Compose 同时部署 **PostgreSQL + Authelia + RustDesk Control Plane + 反向代理** 的最小拓扑示例：

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: rustdesk_control
      POSTGRES_USER: rustdesk
      POSTGRES_PASSWORD: postgres_secure_password
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - internal_net

  authelia:
    image: authelia/authelia:latest
    restart: unless-stopped
    volumes:
      - ./authelia/config:/config
    environment:
      TZ: Asia/Shanghai
    networks:
      - internal_net
      - public_net

  rustdesk-control-plane:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: postgres://rustdesk:postgres_secure_password@postgres:5432/rustdesk_control
      ADMIN_PASSWORD: super_admin_breakglass_password # 本地应急管理员密码
      ADMIN_COOKIE_SECURE: "Y"
      ADMIN_TRUST_PROXY: "Y"

      # OAuth 2.0 / Authelia 联动配置
      OAUTH_ENABLED: "Y"
      OAUTH_PROVIDER_NAME: "Authelia"
      OAUTH_ISSUER: "https://auth.example.com"
      OAUTH_CLIENT_ID: "rustdesk-control-plane"
      OAUTH_CLIENT_SECRET: "YourSecretHere123"
      OAUTH_REDIRECT_URI: "https://control.example.com/api/auth/oauth/callback"
      OAUTH_AUTO_CREATE_USER: "Y"
      OAUTH_DEFAULT_ROLE_ID: "role_admin"
    depends_on:
      - postgres
      - authelia
    networks:
      - internal_net
      - public_net

networks:
  internal_net:
    internal: true
  public_net:

volumes:
  postgres_data:
```

---

## 5. 常见故障排查 SOP

### 1. 提示 `invalid_state`
- **原因**：
  1. 用户在授权页面停留超过 10 分钟，临时 state Cookie（TTL 10m）已过期；
  2. 浏览器未携带 `rd_oauth_state` Cookie。常见于未使用 HTTPS 导致浏览器拦截 Cookie，或回调重定向涉及跨协议（如 HTTP 回调至 HTTPS）。
- **解决办法**：
  - 生产环境确保控制面配置了 `ADMIN_COOKIE_SECURE=Y` 并全站启用 HTTPS；
  - 刷新页面重新点击“通过 Authelia 登录”。

### 2. 提示 `user_not_found`
- **原因**：设置了 `OAUTH_AUTO_CREATE_USER=N`，且当前 Authelia 返回的用户名在控制面 `managed_users` 表中不存在。
- **解决办法**：
  - 由系统管理员登录控制后台，在“组织与策略”中手动登记该用户名；
  - 或将环境变量设置为 `OAUTH_AUTO_CREATE_USER=Y` 允许初次登录自动建档。

### 3. 提示 `user_disabled`
- **原因**：该用户在控制面已被设为禁用状态（`disabled=true`）。
- **解决办法**：
  - 管理员进入控制台在“用户管理”中解除该账号的停用状态。

### 4. 无法获取有效用户名 (preferred_username 为空)
- **原因**：Authelia 后端用户源（如 LDAP / File）未提供 `username` 或 `preferred_username` 声明。
- **解决办法**：
  - 控制面会自动回退尝试使用 `email`、`sub` 或 `name` 作为本地唯一标识；若仍为空，请检查 Authelia 中 `profile` 和 `email` scope 的字段映射。

