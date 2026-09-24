# 用户账号与个人资料

网站和 App 都只提供 Apple 和 Google 登录（2026-09-23 起）。邮件验证码接口保留给已安装的旧版 App 和测试构建，界面上不再显示。提供方验证过的邮箱直接登录已拥有该邮箱的账号。App 端流程见 [mobile.md](mobile.md#sign-in-providers)。登录后创建稳定的账号 ID，私有节目、上传记录、收听进度与语音用量按这个 ID 归属；仍可免登录试听公开示例。首次登录会把当前已签名匿名访客名下的私人数据转到账号。profile 可编辑头像、昵称和介绍。头像放在私有 R2，仅登录本人能读取。

本地 Fastify 开发模式仍是单用户模式；账号功能运行在 Cloudflare Worker/D1/R2。生产站点已部署邮件账号、profile 和个人 Space，私人上传已开放。已登录账号在进入收听、提问和上传时免 Turnstile；服务端仍执行每日额度、IP 与全站上限及请求速率限制。

## 配置

生产 D1 已应用 `cloudflare/migrations/0004_accounts.sql`，然后部署了 Worker。迁移新增 `users`、登录方式、持久会话、邮件挑战与 OAuth state；未修改现有匿名节目数据。以下命令保留用于新环境：

```bash
npm run db:cloudflare:local
npm run db:cloudflare:production
```

邮件使用 Cloudflare Email Sending（目前为 Beta，要求 Workers Paid）。2026-09-12 已在当前 Cloudflare 账号中接入 `auth.asidefm.com`；[控制台状态](https://dash.cloudflare.com/221784d24eb2a95d148bc96b6f06d6be/email-service/sending/9a44c3619112d2148087c71b446ac4fd/40f0b96670034aab9f0ef775a45f09ab/overview)显示 Sending **Enabled**、DNS records **Configured**。Cloudflare 已为该子域名添加 MX、SPF、DKIM 和 DMARC 记录。生产 Worker 版本 `c36b8c0c-47be-415c-a11a-40025b19387f` 已包含 `EMAIL` 发信 binding，限定发件地址为 `login@auth.asidefm.com`；无需邮件 API key。参见 [Email Sending 配置](https://developers.cloudflare.com/email-service/get-started/send-emails/) 与 [子域名发信](https://developers.cloudflare.com/email-service/configuration/subdomains/)。

在 Google Cloud 创建 OAuth 2.0 **Web application** client，将 `https://asidefm.com/api/auth/google/callback` 加入 Authorized redirect URIs，并按 Google 要求配置 consent screen。生产 Worker 设置以下 Secrets，值只通过 Wrangler 的私密交互输入提供：

```bash
npx wrangler secret put GOOGLE_CLIENT_ID --config wrangler.production.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.production.jsonc
```

本地 Cloudflare 调试时，`wrangler dev` 默认模拟邮件发送：验证码会显示在控制台并保存在本地文件，不会投递到真实邮箱。`.dev.vars` 只需保存 Google Web OAuth client 等私密变量；本地 Google redirect URI 为 `http://localhost:8787/api/auth/google/callback`。`SESSION_SECRET` 仍需保持稳定，且至少 32 字符。缺少 Google 配置时，界面隐藏 Google 登录；无需改变试用验证配置。

邮件验证码 8 位、10 分钟有效、最多尝试 5 次，发送间隔至少 60 秒；每 IP 每小时最多 20 次发信尝试，全站每天最多 100 次，为同账号其他发信域名预留额度。会话为 HttpOnly、SameSite=Strict cookie，有效期 30 天；服务端只存随机 token 的 SHA-256 摘要，退出登录会撤销该会话。Google 使用一次性 state 与 SameSite=Lax 回调 cookie，并用授权码换取 UserInfo `sub`；账号关联以 `sub` 为准。非 Gmail、非 Google Workspace 的 Google 地址先用邮件验证码验证，再从 profile 关联 Google。Google 对这类外部邮箱的旧 `email_verified` 状态不足以证明现在仍持有邮箱。[Google 账号验证指南](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)、[OAuth Web Server 流程](https://developers.google.com/identity/protocols/oauth2/web-server)、[Cloudflare Workers 发信 API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)。

## 当前边界

账号与 profile 已在本地 Worker/D1 测试并部署到生产。线上 `/api/auth/session` 返回 `emailEnabled: true`、`googleEnabled: true`。2026-09-13 在 PAX Chrome profile 中完成一次真实 Google 登录：Google 授权返回 Aside 后打开 Profile；同一浏览器的 `/api/auth/session` 返回已登录用户、Google 头像、昵称和空介绍，确认回调与会话生效。头像上传和 profile 保存尚未做线上操作验证。向当前 Cloudflare 账号邮箱发起的一次验证码请求返回成功，D1 留有一条挑战记录，[Cloudflare 发信日志](https://dash.cloudflare.com/221784d24eb2a95d148bc96b6f06d6be/email-service/sending/9a44c3619112d2148087c71b446ac4fd/40f0b96670034aab9f0ef775a45f09ab/activity-log)显示 **Delivered**；尚未检查收件箱或用验证码完成线上邮件登录。线上未登录访问 `/api/profile` 返回 401。控制台当前显示账号级每日发信额度 200 封，且由该账号下的发信域名共享；应用全站每天限制 100 次发信尝试。个人 Space 的列表、上传进度、自动分析、账号隔离与删除已实现并发布；设计与验证见[个人 Space](personal-space.md)。当前生产配置为 `ALLOW_UPLOADS=true`，但尚未用真实账号完成一次生产上传和分析。
