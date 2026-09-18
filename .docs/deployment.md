# asidefm.com 生产部署

目标：`https://asidefm.com`。生产配置为 `wrangler.production.jsonc`，本地配置为 `wrangler.jsonc`，避免本地调试覆盖生产域名。

## 资源

- Cloudflare account: `221784d24eb2a95d148bc96b6f06d6be`（个人账号）
- Worker: `asidefm`
- D1: `asidefm` / `5e090133-a259-40a8-a20b-5262a5f7bc48`
- R2: `asidefm-audio`，r2.dev 公开访问关闭；一天后清理未完成 multipart
- Workflow: `asidefm-analysis`
- Durable Objects: `MediaContainer`、`LiveSupervisor`
- Turnstile: `Aside FM trial`，managed 模式，仅 `asidefm.com`

已应用数据库迁移 0001–0005。演示节目 `demo-natural-resume` 已导入元数据和逐字稿，音频 148,288 bytes；这是项目生成的合成演示，不包含私人节目、播放历史和问答记录。

## 发布

```bash
npm run deploy:cloudflare
# 新增数据库迁移时，先执行：
npm run db:cloudflare:production
```

首次部署需要 `SESSION_SECRET`、`OPENAI_API_KEY`、`TURNSTILE_SECRET_KEY` 三个 Worker Secrets；使用 Wrangler secret put/bulk 的私密输入。不要把 secret 值写进仓库。普通再次部署保留现有 Secrets，不重新生成会话密钥。

示例导出：`npm run export:demo`，输出在忽略版本管理的 `.wrangler/release-demo`；脚本仅允许项目自带、已处理的 demo，不导出其他节目或用户历史。

## 当前状态

2026-09-12：D1/R2/Turnstile、演示数据、Worker、Workflow、Container 和自定义域名均已部署。

- Worker version: `638fba73-eac5-4ab8-8b1e-e2870ef5d31e`
- Container app: `a03cceeb-6ffb-4d0f-af94-ce14bd76c7a3`
- Image digest: `sha256:a20de65ab5dcceb4e4a60caa81524447fbb0d95a7868174e000203d58d12cc9e`
- `https://asidefm.com/`：HTTPS HTTP 200。
- `/api/health`：HTTP 200，`liveConfigured=true`，`uploadsEnabled=true`。
- 用户明确授权后，通过 Wrangler 成功写入 `SESSION_SECRET`、`OPENAI_API_KEY`、`TURNSTILE_SECRET_KEY`。

线上验证完成（2026-09-13 04:44 UTC）：

- 公开列表只有项目自带的 `demo-natural-resume`，完整分析含 6 段逐字稿。
- 148,288 bytes 的音频与本地演示 SHA-256 一致，Range 请求返回 206 和正确字节。
- Turnstile 已配置；未验证提问返回 403 / `trial_verification_required`。
- 跨域 checkpoint 写入返回 403。
- 没有调用付费模型；真实语音对话、供应商侧关闭和计费仍需线上实测，不能仅凭 health 推断模型可用。

验证摘要保存在 `.wrangler/production-verification.json`。临时 Secrets JSON 和 Turnstile 创建回包已清理，密钥保存在 Worker Secrets，项目原有 `.env` 不变。

## 界面语言

前端支持中文和英文。首次访问按 `navigator.languages` 的顺序选择支持的语言，均不支持时使用英文；顶部切换器的手动选择保存在 `aside.locale`，优先于浏览器设置。同步更新页面标题和 HTML `lang`，切换不重建播放器、不清空对话。节目名称、逐字稿和问答内容保留原语言。

试用弹窗与 Turnstile 跟随界面语言（[Cloudflare 支持的语言代码](https://developers.cloudflare.com/turnstile/reference/supported-languages/)）。本次发布使用 `wrangler deploy --config wrangler.production.jsonc --containers-rollout=none`，保留现有 Container。

验证：69 项单元测试通过；15 项浏览器用例全部验证通过（新增语言用例修正测试定位和参数传递后单独重跑）。线上语言验证摘要保存于 `.wrangler/i18n-production-verification.json`。

## 产品首页与排版优化

首页改为独立 Hero，包含中英文价值介绍、免登录示例入口、可点选的收听/提问/继续交互示意和示例列表。未开放上传的环境隐藏上传控件，本地允许上传时保留导入入口。字体采用明确的系统字体栈；英文 Hero 使用 Georgia，中文标题使用系统无衬线字体，分别设置行高与字间距。

验证：生产构建通过；15 项既有浏览器回归和 1 项新增首页用例通过。检查了中英文桌面、390px 手机首屏；正式域名试听入口正常进入 6 段示例逐字稿。

## 桌面试听视窗

宽度大于 1000px 时，试听页使用 100dvh 弹性布局；播放器始终紧凑，隐藏大封面和页脚，逐字稿与聊天记录独立滚动，输入框保留可见。手机端保留纵向布局。验证了 1440×900、1280×720、1024×600 页面高度及输入框可见性，7 项相关浏览器用例通过（更新暂停后保持紧凑的预期后复测）。

## 进入试听的麦克风权限

移除插话方式和回答后继续设置栏，使用自动插话与服务端默认续播设置，不再读取旧的模式/等待偏好。首页进入试听的点击立即发起 getUserMedia 权限请求，成功后释放所有 track，播放时再由 ListeningSession 启动监听；拒绝时维持只听模式并提示仍可播放或打字。进入本身不发起 Live/转录/模型请求。

验证：构建、69 项单元测试通过；14 项现行浏览器用例通过（权限时机相关用例更新后复测）。正式 HTML 指向本次构建的 JS，资源返回 200。原生权限弹窗由浏览器处理，自动测试模拟授权和拒绝。

## 英文试用内容

新增 `voa-color-outside-lines`、`voa-pin-your-hopes`、`voa-curiosity-and-prying`，采用 VOA Learning English 原创讲解的约两分钟节选。版权来源、裁剪区间和音频哈希见 [public-samples.md](public-samples.md)。音频已上传 R2，元数据/逐字稿/续播点已导入 D1；公开库共 4 条内容。

4 项相关浏览器测试和生产构建通过。线上逐一验证 ready 状态、署名元数据、逐字稿、音频哈希相同及 Range 206；证据在 `.wrangler/public-samples/production-verification.json`。英文界面试听按钮优先打开英文内容。本次用项目配置的 Whisper 和音频分析模型准备公开样本；未进行线上付费问答。

## 扩充英文试听库

2026-09-12：新增 EFF 两集、NASA 两集、FOSS and Crafts 的 Blender 以及 Hacker Public Radio 的 Large Language Models，共六段 1:56–3:43 的英文节选。公开库现有 10 条（9 英文 + 1 中文演示）。每条的原始区间与授权证据见 [public-samples.md](public-samples.md)。

六条节选的音频已上传 R2，元数据、逐字稿与续播点已导入 D1。英文 Hero CTA 默认选择 Kara Swisher 的 Smashing the Tech Oligarchy。CC 内容显示许可名称，并提供音频节选与带转写 JSON 的下载入口；CC BY-SA 素材及其改编转写继续按同许可发布。

线上只读验证确认六条 ready、逐字稿/续播点数量正确、完整音频 SHA-256 与本地一致、Range 返回 206。证据：`.wrangler/public-samples/expanded-production-verification.json`。前端构建已通过；本地浏览器测试覆盖九条英文音频与授权链接。未执行线上付费 AI 问答。

正式域名浏览器回归也已通过：九条英文内容逐一播放并显示逐字稿，CC 下载链接正确，桌面试听页无需整体滚动。首次运行因测试重复打开同一节目、旧标题提前满足断言导致加载竞态；修正测试后正式域名用例通过（17 秒）。麦克风拒绝由测试模拟，没有采集真实麦克风音频。

## 下架中文演示

按用户要求，生产 D1 中 `demo-natural-resume` 的 `public` 改为 0。公开试听库仅保留 9 条英文节目。前端已有默认节目回退逻辑，中文界面会选择第一条可用英文试听，无需重新发布前端。项目自带演示仍保留用于本地开发。

## 账号与 profile 开发状态

本地已实现邮件验证码、Google OAuth、profile 编辑和私有头像；D1 新增 `0004_accounts.sql`。本地 69 个项目测试和 20 个 Worker/D1/R2 集成测试通过，前端构建及生产 Wrangler dry-run 通过。2026-09-12 已在 Cloudflare Email Sending 接入 `auth.asidefm.com`，控制台显示 Enabled、DNS Configured；生产 D1 已应用 `0004`，Worker 已部署包含限定发件地址 `EMAIL` binding 的版本 `c36b8c0c-47be-415c-a11a-40025b19387f`，其后 Google Secret 配置产生了更新版本。线上 `/api/health` 正常，`/api/auth/session` 返回邮件与 Google 渠道均启用，未登录 profile 返回 401。一次真实发信请求返回成功且 D1 存有挑战，Cloudflare 发信日志显示 Delivered；尚未检查收件箱或用验证码完成线上邮件登录。2026-09-13 已在 PAX Chrome profile 中完成真实 Google 登录和正式域名回调；同一浏览器的 session 返回已登录用户及 Google 头像。部署顺序及精确配置见[用户账号](accounts.md)；这一阶段 `ALLOW_UPLOADS=false` 保持不变。

2026-09-13 已部署登录账号每 UTC 日最多 5 个有效上传（上传中或已完成）的限制；取消未完成上传释放名额，分析重试使用独立额度，全站每日上限仍为 10。生产 Worker 版本 `2462e15a-acf2-4940-86a2-667e9e0e7724` 已接收 100% 流量；部署保留了原有前端资源与 Container。线上 `/api/health` 正常，邮件与 Google 登录渠道正常响应，同源未登录上传请求返回 401。这次配额预发布的绑定显示 `DAILY_UPLOAD_LIMIT=5`，当时 `ALLOW_UPLOADS=false`，因此未做真实上传或生产配额耗尽测试；随后发布的个人 Space 见下节。

## 个人 Space 发布

新版增加 D1 `0005_personal_space.sql` 的删除墓碑列与私人列表索引。发布时先应用迁移，再在 `ALLOW_UPLOADS=false` 下部署 Worker、静态资源与媒体 Container，确认 Container 更新完成，最后将生产配置的 `ALLOW_UPLOADS` 改为 `true` 并只更新 Worker。这个顺序避免新上传落到仍限制 3 小时/500 MiB 的旧 Container。

2026-09-13 实际发布顺序：生产 D1 应用 `0005`；在 `ALLOW_UPLOADS=false` 下部署 Worker、Space 静态资源和媒体镜像；Cloudflare Container 配置随后切换到新 digest，滚动更新结束；将 `ALLOW_UPLOADS=true` 发布为 Worker 版本 `3c90d665-0fc9-474e-83a6-018d229e2d58`。最后修正私人列表加载更多后的自动刷新，发布当前 Worker 版本 `2a05b519-8fc6-481a-abc9-b60fe4dde138`，保留 Container 镜像。

本地验证：69 项项目测试、25 项 Worker/D1/R2/Workflow 集成测试、此前 19 项 Chrome 浏览器回归通过；分页修正后 4 项 Space 浏览器回归和类型/边界检查通过。Linux/amd64 媒体镜像构建成功并在容器内接受 5:00:00 合成 WAV、拒绝 5:00:01。线上验证：`/space` 实际加载新版界面，`/api/health` 返回 `uploadsEnabled=true`，`/api/auth/session` 显示邮件和 Google 登录启用，未登录访问私人列表及上传均返回 401。尚未用真实账号在生产完成一次上传、自动分析，也未对接近五小时的真实压缩节目测量费用/耗时。见[个人 Space](personal-space.md)。

## My Space 双栏播放器

2026-09-13：将私人音频列表移到左侧导航。有可听音频时默认在右侧打开最近一条的暂停播放器、逐字稿和该音频的 checkpoint 对话记录；点击左侧另一条在 `/space` 内切换，不混入公开示例。左侧「上传音频」切到 Profile 和上传视图，空库也直接显示上传视图。手机端列表横向滚动。

本地完整 Chrome 回归 20/20、项目测试 69/69 通过；Space 回归额外检查私人/公开列表隔离、默认选择、跨音频切换逐字稿与对话、返回上传视图和手机宽度。桌面与手机截图人工检查通过。已发布 Worker 版本 `9649da4b-96ab-4a2d-bc90-fafc839320b4`，Cloudflare 部署状态为 100%。首次请求时静态资源短暂返回旧版，随后正式域名 `/space` 返回 `index-e73hOC5u.js` 和 `index-CaqYyiMI.css`，两项资源均以正确 MIME 和内容返回；实际浏览器已加载新版访客页面。未使用用户登录态在生产查看私人节目或播放私人音频。

## 播放器前端模块

2026-09-13：把原来位于 `frontend/src/main.tsx` 的播放器界面、空格键与手动录音释放、聊天滚动和视图切换动效移入 `frontend/src/PlayerView.tsx`。`main.tsx` 只组合账号、公开页与 My Space 路由；`usePlayerController` 和 `ListeningSession` 继续拥有播放及问答运行时。公开试听和私人 Space 仍共享同一套播放器。构建/类型检查、69 项项目测试和 20 项 Chrome 回归通过。生产 Worker 版本 `638fba73-eac5-4ab8-8b1e-e2870ef5d31e` 已接收 100% 流量；正式域名首页及 `/space` 均返回新 JS `index-H8MCYj8f.js`，其 MIME 为 JavaScript，`uploadsEnabled=true`。

## 底部播放器与逐句跳播

2026-09-13：公开试听与 My Space 的播放器改为底部常驻控制栏，保留顶部节目标题、左侧列表、逐字稿和对话区。逐字稿每句左侧在悬停、选中或键盘聚焦时显示播放按钮；点按跳到该句时间戳并立即播放，原有跟随和手动滚动可继续使用。手机端轻点句子后按钮出现。

本地构建、69 项项目测试及 21 项 Chrome 浏览器回归全部通过；新增用例核对逐句时间戳跳转、开始播放和桌面/手机底栏位置。生产 Worker `31bf6064-eab8-4707-99dd-08c796328df8` 已接收 100% 流量，绑定仍包含 `EMAIL`，`ALLOW_UPLOADS=true`。正式域名首页和 `/space` 均返回 `index-BYgAvilu.js`、`index-6mhoYjqW.css`；访客公开示例在生产桌面滚动后悬停按钮可见并能播放，手机触控选句、跳播和底栏贴底亦已验证。未借用私人账号验证生产私人音频。

## My Space 侧栏直传

2026-09-13：取消中间的 Profile/上传大卡片及 `/space?view=upload` 视图。左侧「上传音频」直接打开系统文件选择器，文件通过浏览器大小/时长预检后即按文件名上传，随后自动分析；每日用量、检查/上传进度、取消与错误都留在侧栏。中间有音频时持续显示原播放器、逐字稿和对话，空库只保留简短提示。Profile 仍可从右上角账号控件编辑。

构建、69 项项目测试、21 项 Chrome 浏览器回归通过。Space 回归覆盖空库直传、已有播放器时上传不切换音频、手机布局与分页刷新；桌面空库/播放器及手机截图已人工查看。生产 Worker `35c4da82-93b6-44e2-8b7a-a75b10de0e54` 已接收 100% 流量，`/space` 返回 `index-DJfUAwT5.js` 和 `index-3612Td6H.css`，两项资源 HTTP 200 且 MIME 正确，`/api/health` 显示 `uploadsEnabled=true`。没有对生产账号执行真实上传或付费分析。

## 收听入口的试用验证

2026-09-13：访客进入节目时，浏览器先请求麦克风权限；权限流程结束后显示 Turnstile，取消仍可收听，第一次付费操作会再次要求验证。访客证明绑定匿名身份与 IP，有效期从 30 分钟延长到 6 小时，覆盖最长 5 小时音频。已登录账号在服务端免 Turnstile，仍保留账号、IP、全站每日额度及请求速率限制；上传仍要求登录且每天最多 5 篇。

构建、69 项项目测试、26 项 Worker 集成测试和 23 项 Chrome 回归通过；浏览器回归覆盖权限与验证顺序、登录收听和上传免弹窗。生产 Worker `8c84cdca-7b0a-4fd1-a8a5-bf30470d34e2` 已接收 100% 流量，保留 `EMAIL` binding 和 `ALLOW_UPLOADS=true`。正式域名 `/`、`/space` 均加载新资源 `index-DxsyK5sI.js`；JS/CSS 返回 HTTP 200 且 MIME 正确，`/api/health` 显示 `trial=true`、`uploadsEnabled=true`，未登录 `/api/trial` 返回 `verified=false`。未在生产账号执行付费提问或真实上传。

## 搜索引擎元数据与 llms.txt

2026-09-14：`frontend/index.html` 补齐 description、canonical、robots、Open Graph/Twitter 卡片、Json-LD（`WebSite` + `WebApplication`）与 `noscript` 兜底；`frontend/src/i18n.ts` 按语言同步 title、description 和 OG 标签，`/space` 注入 `noindex, nofollow` 并移除 landing canonical。新增 `robots.txt`、`sitemap.xml`、`llms.txt` 和 1200×630 `og-image.png`（由 `scripts/prepare-og-image.mjs` 生成，重复执行哈希不变）。`llms.txt` 里的时长、大小和每日额度与 `engine/src/core.ts`、`cloudflare/src/uploads.ts` 对齐。

`npm run check`、69 项项目测试和 2 项语言浏览器用例通过，生产构建产物包含四个静态文件。生产 Worker `89f194eb-bed9-46c3-bb39-3bfbe60f8b46` 已接收 100% 流量（`--containers-rollout=none`，保留现有 Container）。正式域名 `/`、`/robots.txt`、`/sitemap.xml`、`/llms.txt`、`/og-image.png` 均 HTTP 200，MIME 依次为 `text/html`、`text/plain`、`application/xml`、`text/plain`、`image/png`；`/api/health` 200 且 `uploadsEnabled=true`。浏览器实测中英文 title/robots/canonical 以及 `/space` 的 noindex 均生效。`/space` 的 noindex 仍由客户端注入，不执行 JS 的爬虫看不到，后续可改由 Worker 返回 `X-Robots-Tag`。

2026-09-15（第二轮，实现与本地验证；2026-09-16 随 `0a32719` 发布）：上一轮的客户端注入对不执行 JS 的爬虫无效，且整站正文、公共音频都只存在于 JS 里，六条样例没有可索引的独立 URL。本轮把 SEO 表层移到 Worker：

- `cloudflare/src/seo.ts` 接管 HTML 路由：`/`（英文）、`/zh`（中文）、`/episodes/<id>`、`/space`、`/sitemap.xml`，`/en` 301 到 `/`。`http://asidefm.com/...` 301 到 https（只对正式域名生效，本地 http 开发不受影响）。
- `cloudflare/src/seo-html.ts` 是纯字符串构建层（head 片段、JSON-LD、sitemap、爬虫可见正文），不含 D1 依赖，便于在根 TypeScript 程序里类型检查。
- `frontend/index.html` 用 `<!--aside:seo:head:start/end-->` 与 `<!--aside:seo:body:start/end-->` 标出按路由替换的区域；Vite 构建保留这两组注释。Worker 用真实公共音频替换正文：首页是 hero 文案加每条录音的 `<a href="/episodes/<id>">`，节目页是标题、作者/出版方/许可/来源、摘要与前 6 段逐字稿。
- 结构化数据：首页 `WebSite` + `WebApplication` + `ItemList`；节目页 `PodcastEpisode`（`AudioObject` 含 `contentUrl` 与 ISO 8601 时长、`author`、`publisher`、`license`、`isBasedOn`）。节目页的语言取自录音本身（`attribution.language` 为 zh 时 `<html lang="zh-CN">`、`og:locale=zh_CN`、逐字稿小标题为「逐字稿」），与其 JSON-LD 的 `inLanguage` 一致。`hreflang` 为 en `/`、zh `/zh`、x-default `/`。未加 `FAQPage`：站上没有真实问答内容，凭空造会违反结构化数据政策。
- `sitemap.xml` 改为 Worker 动态生成（首页、`/zh`、每条公共音频带 `lastmod`），删除静态文件；`robots.txt` 注释改为说明 `/space` 由 `X-Robots-Tag` 保护。
- `wrangler.jsonc` 与 `wrangler.production.jsonc`：`not_found_handling` 从 `single-page-application` 改为 `none`，`run_worker_first` 改为 `true`。前者修掉任意路径返回 200 的软 404，后者保证每条 HTML 路由都经过 Worker——用 glob 数组时实测 `/zh`、`/space`、`/sitemap.xml` 不会进入 Worker，会被静态资源当作 404。
- 前端：`i18n.ts` 从路径前缀取界面语言（`/zh` 优先于浏览器与本地偏好），canonical 按当前路径生成；`/episodes/<id>` 成为真实地址，旧的 `/?episode=<id>` 仍可打开并被改写为新地址；样例卡从 `<button>` 改为 `<a href>`，中键/新标签可打开。

本地验证：`npm run check`、`npm test`（160 项）、`npm run build`、`npm run test:cloudflare`（34 项，含新增 `tests/cloudflare/assets.test.mjs`——它按 `wrangler.jsonc` 的真实 `assets` 配置跑一遍，确认 `/`、`/zh`、`/sitemap.xml`、`/space`、`/episodes/<id>` 都由 Worker 处理，未知路径返回 404，静态资源仍 200）。Chrome 回归：i18n、player-config、landing、library-drawer、player、trial、listening-controls 通过。`public-samples.spec.ts`（期望 6 条样例，本地库有 12 条）与 `vad.spec.ts` 两项在改动前用 `git stash` 对照后同样失败，属本地数据/环境问题，与本轮无关。**尚未部署到生产**，未在生产域名验证。

## 公开音频库换成两段历史录音

2026-09-14：公开音频库原有 9 条英文播客节选（VOA 三条、EFF 两条、NASA 两条、FOSS and Crafts、Hacker Public Radio）全部下架，改为两段美国政府录音：JFK 1962-09-12 莱斯大学登月演说节选 3:48（`jfk-rice-moon`，源 archive.org `jfks19620912`）与里根 1987-06-12 勃兰登堡门演说节选 2:13（`reagan-brandenburg-gate`，源 NARA catalog 7087579，WHCA 带号 PP7163C）。两者都是联邦机构录音，按 17 U.S.C. §105 属公有领域；来源、区间、源与节选 SHA-256 见 [public-samples.md](public-samples.md)。

`content/public-samples.json` 重写为这两条 spec，`scripts/prepare-public-samples.ts` 的 host 白名单精简为 `archive.org` 与 `catalog.archives.gov`。节选窗口先转录定位、再按整句边界选定（JFK 08:14.120–12:02.180，里根 30:24.820–32:38.000）；两条的音频模型复核均为 `musicAudible: false` 且首尾无硬切。里根源长 46:30，单次转录请求会超时，spec 里把转录窗口收窄到 28:20–33:20，使仓库脚本可独立复现。

下架与发布在 `CLOUDFLARE_ACCOUNT_ID=221784d24eb2a95d148bc96b6f06d6be` 下执行（OAuth 登录下有两个账号）：先删除 9 个 R2 对象，再执行 `content/retire-public-samples.sql`（changes 55 / rows_written 54），随后上传两条新节选并导入各自的 seed SQL。9 条旧节目的 seed SQL 与节选 mp3 仍保留在本机 `.wrangler/public-samples/`（该目录被 gitignore），本机可原样回滚；该目录若丢失，仍可从 git 历史里的旧 `content/public-samples.json` 重新准备，代价是重跑一次付费转录。

线上核对：`/api/episodes` 返回 2 条且均 `ready`；两条时长 228060ms / 133180ms 与本地一致；完整下载后的 SHA-256 与本地节选一致（`dafd281c…`、`34b405fc…`）；`Range: bytes=0-1023` 返回 206；9 个旧 id 的 `/api/episodes/<id>/audio` 均返回 404。D1 侧复查这 9 个 id 在 `episodes`、`checkpoints`、`voice_usage`、`uploads` 中均已无残余行，`artifacts` 只剩两条新节目与既有的 `demo-natural-resume` 三条 key。浏览器实测 `/` 只列出这两条，中文「体验示例」打开 `jfk-rice-moon`，署名链接指向 archive.org 条目、转载许可链接指向 `usa.gov/government-works`，文字稿渲染 28 行且包含完整的 "We choose to go to the moon" 段。本地 `npm run check` 与 69 项项目测试通过。

前端已随本次发布部署：`npm run build` 通过后执行 `wrangler deploy --config wrangler.production.jsonc --containers-rollout=none`（保留现有 Container），Worker 版本 `bd8dd6f0-8b74-4c5c-ae50-6824c2a5fc42`，上传 3 个新静态资源（`/index.html`、`/assets/index-qi4jWgdy.js` 及其 sourcemap）。`wrangler.production.jsonc` 补上 `account_id`，避免 OAuth 登录带多个账号时落到错误的账号。线上 `/` 的 HTML 已引用新 bundle，bundle 内的 CTA 逻辑为 `locale==="en"` 时优先 `jfk-rice-moon`；`/api/health`、`/robots.txt`、`/sitemap.xml`、`/llms.txt`、`/og-image.png` 均 200 且 MIME 不变。

未完成或未验证：`tests/browser/public-samples.spec.ts` 已改为覆盖这两条并断言旧内容不再出现，但本地 `.data` 没有公开样本数据，本轮未执行；浏览器实测只到「落地页列出这两条」，切到英文界面复核 CTA 的那次点击触发了自动审批拦截，未完成。两条 1960 年代/1980 年代现场录音的 Whisper 逐字稿有个别错词（里根那条把 "comity" 听成 "comedy"）。

## 公开音频库加入 Longines Chronoscope 访谈

2026-09-14：公开音频库从 2 条增加到 6 条，新增四集 _Longines Chronoscope_（1951–1955 年 CBS 系电视访谈节目）：`chronoscope-kennedy`（众议员约翰·肯尼迪谈 1952 年参议员选战，3:35）、`chronoscope-warren`（加州州长厄尔·沃伦谈党内初选，3:23）、`chronoscope-moses`（罗伯特·摩西谈城市更新，3:06）、`chronoscope-byrd`（理查德·伯德谈极地，2:53）。

授权依据与之前两条不同：Longines-Wittnauer 表厂把赞助并持有的版权**于 1969-12-19 全部转让给美国政府**，母带捐给国家档案馆；NARA 在每个条目的 `useRestriction` 里记着这句话、状态 `Unrestricted`，并由 NARA 自己在 archive.org 的 `usgovfilms` 集合以 CC0 发布（共 231 集）。来源、区间、源与节选 SHA-256 见 [public-samples.md](public-samples.md)。

节选用 `_512kb.mp4` 衍生文件（59–67MB），未用 650–715MB 的 `.mpeg` 原始档；现有管线不需改动，ffmpeg 写 `.mp3` 会自动选音频流。四集片头/片尾都带 Longines 广告，节选窗口都落在这两段之间（正文分别在 10:50、11:31、12:01、11:53 结束）。伯德那条的开口被音频模型评为「略突兀」，因为切在主持人提问的轮次边界而非段落开头，已在文档中记录。

线上核对：`/api/episodes` 返回 6 条且均 `ready`；四条新节选完整下载后的 SHA-256 与本地一致；`Range: bytes=0-1023` 返回 206；逐字稿与续播锚点分别为 71/12、69/10、68/11、64/9 条，末段文字确认不含广告。9 个已下架旧内容的 id 仍全部 404。`npm run check` 与 69 项项目测试通过；`tests/browser/public-samples.spec.ts` 的条目数断言已从 2 更新为 6，但本地 `.data` 无公开样本数据，仍未执行。

1940–80 年代转录质量明显低于此前的播客素材：肯尼迪那条把 "Senator Lodge" 听成 "senator large"/"senator lange"，四集都把 "Longines" 听成 "launching"/"long gene"。逐字稿按音频生成、不做人工修正，重跑会复现同样错误，已记入文档。

## 公开库按语言页面发布

2026-09-14：前端上线语言感知的公开库。`attribution` 现在有两个语言字段：`language` 是录音本身的语言，`languageVisibility` 是它登在哪些语言页面上。`libraryFor` 按前者排序、按后者筛选，排在后面的其他语言条目带一个语言标记。**没有 `languageVisibility` 的录音只参与排序、永远不被隐藏**——这个字段是给策展的公开库用的，用户自己上传的节目不能因此从自己的播放器里消失。六条现有内容全部标为 `["en","zh-cn"]`，中英文页面都展示。

准备侧一并整理：`scripts/sample-spec.ts` 接管 spec 校验（只允许 https 且 host 限于 `archive.org` 与 `catalog.archives.gov`；`title`/`publisher`/`author`/`sourceUrl`/`license`/`licenseUrl`/`summary`/`sourceSha256` 全部必填），VOA 的兜底署名已删除，缺字段就直接失败而不是按默认来源发布；`scripts/sentence-groups.ts` 让续播锚点的断句同时识别全角 `。！？…`，此前中文逐字稿只能按 25 秒上限硬切。

发布与核对：Worker 版本 `1755c3d1-93ea-4cbf-8412-d9977bd0963b`（`--containers-rollout=none`）。已发布的 6 条 episode 元数据生成于 `languageVisibility` 存在之前，因此先按新 spec 重跑一次 `prepare`（全部命中缓存、无付费调用，六条节选 SHA-256 与线上一致），再重新导入 6 份 seed（各 changes 4 / rows_written 5）。线上 `/api/episodes` 返回 6 条且均 `ready`、均带 `languageVisibility: ["en","zh-cn"]`；抽查两条节选 SHA-256 与本地一致；`/api/health`、`/robots.txt`、`/sitemap.xml`、`/llms.txt`、`/og-image.png` 均 200；浏览器实测中文页列出全部 6 条。`npm run check` 与 90 项测试通过（新增 21 项：语言/可见性 9、spec 校验 7、断句 5）。

未验证：`tests/browser/public-samples.spec.ts` 仍因本地 `.data` 没有公开样本数据而未执行；英文页没有单独在浏览器里核对过（数据层已确认两页可见集相同）。

## 中文公开库：合成语音管线与《红楼梦》样本

2026-09-14：公开库加入第一条中文内容 `hongloumeng-daiyu`（宝黛初见，2:30），并为此新增一条**文本合成**的准备路径。

背景是实测结论：LibriVox 的中文库只有 25 条，且没有红楼梦/三国/水浒/西游；archive.org 上能搜到的【有声書】紅樓夢、三國演義、甄嬛传等条目**全部没有 license 字段**，是商业有声书的未授权上传——文本公有领域不等于录音公有领域。所以古典小说这条线只能自己生成。另外实测 Whisper 的中文表现：白话文（鲁迅）可用但每 2–4 段有字级错误，文言文（聊齋）完全不可用，这也让"逐字稿来自文本而非转录"的合成路径更有价值。

新增：`content/tts-samples.json` + `content/texts/*.txt`（一句一行）+ `scripts/prepare-tts-samples.ts`。逐句合成、逐句 ffprobe 计时、再拼接，所以**逐字稿的时间戳就是实际语音边界**，每句一个 passage 和一个续播锚点；不作转录、不作音频模型复核，分析标记为 `source: "synthesis"`（`engine/src/core.ts` 的联合类型相应扩展）。合成按句缓存于 `.wrangler/tts-cache/`，重跑不产生新调用。同时把 D1 seed 的生成抽成 `scripts/seed-sql.ts`，两条准备路径共用，重构后对同一份 episode 产生的 SQL 逐字节一致（仅 `analysis.version` 随机 UUID 与 `createdAt` 时间戳按设计变化）。

样本用 `gpt-4o-mini-tts`/`coral` 朗读 1791 年《红楼梦》第三回林黛玉初见贾宝玉的 504 字节选，底本取自 Project Gutenberg #24264。Gutenberg 的转写简繁混用、并有三个缺字，因此 `content/texts/` 里是手工规范化过的转写而非直接复制——这一点，以及罥/靥/颦 等生僻字可能被误读，都已写进文档。署名上刻意写明是合成语音：`publisher: "Aside · 合成语音朗读"`、license 文本说明"not a human recording"、stage 为"合成语音 · 按句对齐"。

线上核对：`/api/episodes` 返回 7 条，`hongloumeng-daiyu` 为 `zh` + `languageVisibility: ["zh-cn"]`，其余 6 条为 `en` + `["en","zh-cn"]`；新样本 `source: "synthesis"`、17 passages / 17 anchors、voice feminine；完整下载 SHA-256 与本地一致、`Range` 返回 206。浏览器实测中文页按语言排序把「宝黛初见」排在第一，其余 6 条英文内容的卡片带「英文」标记——这是 `languageVisibility` 与语言标记第一次在线上生效。`npm run check` 与 92 项测试通过（新增 2 项 TTS spec 校验）。

未验证：英文页没有在浏览器里打开核对（按数据推断 `hongloumeng-daiyu` 的 `languageVisibility` 不含 `en`，应被过滤掉，但未实测）；`tests/browser/public-samples.spec.ts` 的条目数断言仍是 6，未随本次更新，且本地 `.data` 无公开样本数据、无法执行。合成语音的实际听感（音色是否合适、多音字是否读对）没有人工听过。

## 中文公开库换成鲁迅：LibriVox 真人朗读

2026-09-14：把上一轮的合成样本 `hongloumeng-daiyu` 下架（R2 对象 + D1 四张表的行），换成两条 LibriVox 真人朗读的鲁迅：`luxun-madmans-diary`（狂人日记，3:45）与 `luxun-ah-q`（阿Q正传第一章，4:10）。合成管线保留在仓库里（`content/tts-samples.json` 置空，代码与文档不动），但不再发布内容——放在真人录音旁边显得机械。

选材结论：把"真人朗读 + 现代中文小说 + 我们能用"三个条件叠起来，**只剩鲁迅**。美国口径是发表年 + 95 年，2026 年刚放开到 1930 年及以前，所以鲁迅 1923《呐喊》/1926《徬徨》等全部已进入公有领域，而 1930 年之后的中文小说（老舍、张爱玲、金庸、以及全部当代文学）都还在版权内。实测也确认没有别的路：archive.org 上排除 LibriVox 后搜 `有聲書/有声书/朗读` 为 0 条；全站 `language:(zho)` + Creative Commons 的中文音频只有 35 条且几乎全是 LibriVox；此前搜到的红楼梦/三国/水浒/甄嬛传条目全部没有 license 字段，是商业有声书盗版。

过程中修掉两个真实问题：

1. **Whisper 对中文有时完全不输出标点**。《阿Q正传》第一次转录 1585 字里一个 `。` 都没有，这会让续播锚点退回 25 秒硬切、逐字稿也没法读。新增 `transcriptionPrompt` 字段（`backend/src/audio-provider.ts` 的 `transcribeAudio` 增加可选 prompt，经 spec 传入），用一段带标点的中文示例引导——同一段音频重转后出现 35 个 `。`。两条鲁迅 spec 都设了。
2. **呐喊的分段不是想当然的**。`calltoarms_01` 是《自叙》而非《狂人日记》；逐段探测开头才发现 02 才是狂人日记、03 是孔乙己、04 是药。节选窗口因此从 01:15（文言小序之后的白话正文起点）开始。

线上核对：`/api/episodes` 返回 8 条；两个新条目为 `zh` + `languageVisibility: ["zh-cn"]`，`source: "provider"`，voice masculine，狂人日记 26 passages/26 anchors、阿Q正传 54 passages/26 anchors（锚点按句切分，说明标点修复生效）；完整下载 SHA-256 与本地一致。浏览器实测中文页把「阿Q正传」「狂人日记」排在最前，其余 6 条英文内容带「英文」标记，红楼梦已从列表消失。`npm run check` 与 92 项测试通过。

未验证：`tests/browser/public-samples.spec.ts` 的条目数断言仍是 6（英文页确实 6 条，两个中文样本 visibility 为 `["zh-cn"]` 会被过滤），但本地 `.data` 无公开样本数据、仍未执行；鲁迅两条的实际听感没有人工听过；逐字稿仍有该读者/素材固有的字级错误（如"须十分小心"→"需十分小心"、"古久先生"→"古九先生"）。

## 首页声波流动与 Hero 过渡

2026-09-14：Hero 声波从整组上下起伏改为波纹在两个固定鼓包内缓慢横向流动（`HeroSoundscape.tsx` 按帧重算路径），离开视口或页面隐藏时停止，交互示意第 2、3 步（说话/暂停）减速停下，`prefers-reduced-motion` 下保持静止。Hero 只发布 `--hero-progress` 与 `--hero-exit`（二次缓入），声波的下沉/压扁/淡出和文案的上移/淡出都由 CSS 计算。两层背景光晕（`.story-pin` 伪元素与 `.hero::after`）左右加渐隐遮罩，去掉距视口边缘 12px 处的硬边；Hero 最小高度收紧、钉住区改为 1:2 的上下留白，按钮到下一屏标题的间距 1440×900 从约 165px 降到 107px，390×844 从约 245px 降到 142px。

`npm run check`、93 项项目测试和滚动叙事浏览器用例通过；本地在 4 倍 CPU 降速下桌面与手机帧 p95 约 17.5ms。生产 Worker `228f2bf5-6c8d-4c7d-a1c6-cc1297fbc385`（`--containers-rollout=none`，保留现有 Container），绑定仍含 `EMAIL`、`ALLOW_UPLOADS=true`。正式域名 `/` 引用 `index-QRrIwGIu.js`、`index-CU7YqdCy.css`，均 200 且 MIME 正确；`/api/health`、`/robots.txt`、`/sitemap.xml`、`/llms.txt`、`/og-image.png` 均 200。线上浏览器实测桌面与手机声波在流动、间距与本地一致、滚动时文案淡出生效、无控制台错误。其余需要后端数据的浏览器用例本轮未执行；动效观感只看了截图，没有录屏人工复核。

## 暖色配色与组件系统

2026-09-14：全站浅色/暗色配色从冷灰改为暖色中性色，品牌绿用于 Hero 标题第二行、Logo（`aside-mark.svg`）与进度；浅色 `--ink-3` 取 `#776b60`（对比度约 4.6:1），比设计稿 `#8b7f73` 略深。新增 `frontend/src/components.css`：胶囊按钮（主/次/文字/中性，以及仅用于语音的渐变描边按钮）、带标题与说明的毛玻璃菜单、分段切换和输入框，颜色与阴影变量集中在 `style.css`。

首页主次按钮、语言菜单、演示区步骤（滑动选中块，位置用 `min()` 限制在轨道内）、示例卡片和登录弹窗（标签改为“邮箱”）先用上新组件；播放器随后改为胶囊播放条（装饰性波形叠在原生进度条下，保留键盘与读屏）、`SpeedSelect.tsx` 倍速菜单、发光对话框和状态标签；侧栏长标题只在悬停或聚焦时滚动；My Space 的上传、加载更多和提示关闭也换成同一套按钮。“跟随播放”保留原有“回到当前播放”按钮逻辑，麦克风按钮文案仍为“开启麦克风”。

`npm run check`、93 项项目测试通过；本地前后端完整 Chrome 回归 36 项中 35 项通过，唯一失败的 `public-samples.spec.ts` 期望 6 张示例卡片而本地数据有 12 张，与本次改动无关（该测试与示例内容未修改）。测试调整两处：登录用例按“邮箱”标签查找；侧栏长标题用例先悬停一行溢出标题再断言滚动。改版中修复英文首页 390px 顶栏溢出 8px、窗口缩小瞬间演示区选中块撑宽页面两个问题。

生产 Worker `6fdc1946-309e-4f55-980c-625c318487a4`（`--containers-rollout=none`，保留现有 Container），绑定仍含 `EMAIL`、`ALLOW_UPLOADS=true`。正式域名 `/` 引用 `index-BsvDV2Uc.js`、`index-CaLDQcpC.css`，均 200 且 MIME 正确；`/aside-mark.svg` 返回新颜色；`/api/health`、`/robots.txt`、`/sitemap.xml`、`/llms.txt`、`/og-image.png` 均 200。线上浏览器在浅色/暗色、1440 与 390 宽度下核对：首页背景变量为新值、主按钮为新组件、无横向溢出；进入示例后播放条贴底、64 条波形、倍速菜单可打开、声音按钮与对话框存在，控制台无错误。未在生产用登录账号或真实麦克风做语音对话。

## 上传音频的内嵌封面

2026-09-14：上传文件自带的封面（ID3 APIC、MP4 covr、FLAC PICTURE，FFmpeg 中标记为 `attached_pic` 的流）在准备音频时重新编码为不超过 600px 的 JPEG，存为 R2 `episodes/{id}/cover.jpg`，节目元数据加 `cover: true`，由 `GET /api/episodes/:id/cover` 返回。云端由媒体容器在 `/prepare` 中提取、容器新增 `/cover`，Workflow 新增 `cover` 步骤写入 R2（容器缓存丢失时先 rehydrate）；提取或写入失败只是没有封面，不会让分析失败。播放卡片的大封面在当前布局中始终隐藏，所以封面显示为底部播放条唱片的盘面，加载失败回退为原唱片样式。本次之前上传的节目不补提封面，无需数据库迁移。

`npm run check`、95 项项目测试、30 项 Cloudflare 测试和 `player.spec.ts` 4 项浏览器用例通过（后者在隔离数据目录、无 API key 的本地前后端上执行，示例节目手动加入封面）。新增测试覆盖真实 FFmpeg 生成的带封面 MP3 提取为 600×400 JPEG、无封面返回 404、容器丢失时分析仍完成、生产 Workflow 经 Worker 返回封面。

本次**包含 Container 发布**（封面提取代码在容器内）：镜像 `sha256:b909d0f105ec43cdb1e34b58ac800553e6aa101e850e0a35fa4c8b168fe772a3`（取代 `a20de65a…`），Container app `a03cceeb-6ffb-4d0f-af94-ce14bd76c7a3` 已修改；生产 Worker `41070fe5-d155-495b-a1c1-96f16493c28a`。发布期间旧容器没有 `/cover`，Workflow 按无封面处理。正式域名 `/` 引用 `index-BuebBj1g.js`、`index-CZcQoEp4.css`，均 200 且 MIME 正确；`/api/health` 为 `liveConfigured=true`、`uploadsEnabled=true`；公开列表 8 条均无封面，`/api/episodes/luxun-ah-q/cover` 返回 404，音频 Range 返回 206。

未验证：没有在生产上传带封面的真实文件走完整分析（会产生付费模型调用），因此云端提取、R2 写入和线上播放条显示封面都只由本地与 Miniflare 测试覆盖；未观察容器实例何时全部切换到新镜像；未在线上浏览器打开播放器核对。

## 播放条波形跟随声音与 Aside 介入提示

2026-09-14：底部播放条的 64 条波形原是按节目 id 生成的固定形状。现在节目音频经 Web Audio 分析器输出，播放时每条按人声频段（100–5000Hz）的实时音量伸缩，暂停后缓回原形。连接分析器后元素的声音只经 Web Audio 输出，所以只在 AudioContext 确认 running 后才接入，否则照常播放、波形静止。两套后端的音频都同源返回，分析器才能读到数据。

同一条波形用来提示 Aside 语音助手（gpt-live-1）已经介入：从打断到请求续播期间波形变暖色（`--wave-b`），颜色从播放头向两侧扩散；连接/识别中有一道光横扫，麦克风状态改为「● Aside 正在加入」；回答时波形跟随 AI 语音的真实输出（复用 `LiveConnection` 原本用于判断出声的分析器），最新一条 Aside 消息的头像外圈发光；轮次之间低幅起伏。唱片只在节目真正出声时旋转。`prefers-reduced-motion` 下只保留颜色和文字。频段计算放在 `frontend/src/audio-levels.ts`，节目与语音共用。

`npm run check`、94 项项目测试和 11 项播放器/监听/手机面板/语言浏览器用例通过；WebRTC 回环用例新增断言：AI 出声时波形进入 agent 状态、头像发光、至少一条被语音推到 0.8 以上（仅起伏达不到），续播后恢复节目颜色。本地另以挂起的 `/live` 请求截图核对了加入阶段的暖色、扫光和文案。

生产 Worker `97ad594c-31bd-4d03-8efa-4b7e339ed815`（`--containers-rollout=none`，保留现有 Container），绑定仍含 `EMAIL`、`ALLOW_UPLOADS=true`。正式域名 `/` 与 `/space` 引用 `index-9zqOMr3U.js`、`index-BnkzDfhJ.css`，均 200 且 MIME 正确，bundle 含新文案；`/api/health` 200，`liveConfigured=true`、`uploadsEnabled=true`。线上浏览器以访客、未开麦克风的只听模式打开 LibriVox 示例并播放：波形逐帧变化、播放进度正常前进、暂停后复位，控制台无错误。

未验证：没有在生产开麦克风做真实语音对话（会产生付费调用），所以加入/回答阶段的线上效果只由本地测试与截图覆盖；测试中 AI 声音是 440Hz 单音，真人语音下的波形节奏和扫光强度未人工看过；iOS Safari 上经 Web Audio 输出的音频在锁屏或后台时可能暂停，未在真机验证。

## 账号上传额度改为每月 100 篇

2026-09-14：登录账号的上传额度从每 UTC 日 5 篇改为每个 UTC 自然月 100 篇（上传中或已完成；取消、被拒不占名额，上个月的不计入），配置项 `DAILY_UPLOAD_LIMIT=5` 换成 `MONTHLY_UPLOAD_LIMIT=100`。`/api/space/episodes` 的 `usedToday`/`dailyLimit` 改为 `usedThisMonth`/`monthlyLimit`，前端与 Worker 同版本发布；侧栏显示「N / 100 篇本月已用」，超额返回「每个账号每月最多上传 100 篇音频」，中英文文案、试用说明与 `llms.txt` 同步。

未改动：全站每 UTC 日 10 篇、每账号每日 10 次/全站 30 次上传尝试、每账号 20 GiB / 全站 100 GiB 存储。因此单个账号一天仍最多 10 篇，并可能占满当天全站名额；整站每月上传分析的费用上限仍由全站每日 10 篇决定，这次改动没有提高它。

`npm run check`、94 项项目测试、28 项 Cloudflare 集成测试和 8 项 Space/账号/语言浏览器用例通过。额度集成用例预置本月另一日的 97 篇（避开全站每日计数）与上个月 3 篇，并发 8 个上传只接受 3 个，拒绝时返回月度提示，取消后可补传，Space 返回 100 / 100。

生产 Worker `a972ee2a-948c-4292-8b66-b43a6f52ef92`（`--containers-rollout=none`，保留现有 Container），绑定显示 `MONTHLY_UPLOAD_LIMIT=100`、`GLOBAL_DAILY_UPLOAD_LIMIT=10`，仍含 `EMAIL`、`ALLOW_UPLOADS=true`。正式域名 `/` 与 `/space` 引用 `index-B8_QdQso.js`（200，`text/javascript`），bundle 含月度文案与字段、不再含 `usedToday`/「篇今日已用」；`/llms.txt` 为 100 uploads per UTC calendar month；`/api/health` 200、`uploadsEnabled=true`；未登录访问 `/api/space/episodes` 与 `POST /api/uploads` 均返回 401。

未验证：没有用生产登录账号查看 Space 的月度字段或实际上传（会触发付费分析），月度计数与超额提示只由本地 Miniflare 集成测试覆盖。

## 全站每日上传上限提高到 2000 篇

2026-09-14：按用户要求，`GLOBAL_DAILY_UPLOAD_LIMIT` 从 10 提高到 2000（两份 Wrangler 配置与代码默认值同步），避免单个账号占满全站当天名额。原先固定为 30 的全站每日上传尝试次数改为全站上限的 3 倍（6000），否则会先于 2000 生效；每账号每天 10 次尝试、每月 100 篇、每账号 20 GiB / 全站 100 GiB 存储、全站每日 10 次分析重试均不变。`npm run check` 与 28 项 Cloudflare 集成测试通过。

生产 Worker `b464f6b4-59d9-4ae1-a3ee-bf0b8a721b04`（`--containers-rollout=none`，保留现有 Container），绑定显示 `GLOBAL_DAILY_UPLOAD_LIMIT=2000`、`MONTHLY_UPLOAD_LIMIT=100`，仍含 `EMAIL`、`ALLOW_UPLOADS=true`；前端无变化，没有上传新静态资源，首页仍引用 `index-B8_QdQso.js`。`/api/health` 200、`liveConfigured=true`、`uploadsEnabled=true`；未登录 `POST /api/uploads` 返回 401。

费用提示：按每小时音频约 $2.2 的分析成本估算，全站每日上限现在允许每天约 $4,400（1 小时节目）到 $22,000（5 小时文件）的分析费用。实际的剩余约束是全站 100 GiB 保留存储（删除会释放）与每账号每月 100 篇（新账号只需邮箱）。建议在 OpenAI 后台设置月度花费上限作为兜底。

未验证：线上没有做登录上传或全站额度耗尽测试。

## 播放器时间轴刻度与 dock 排版

2026-09-15：修复播放器时间轴上方那条看似进度条的实线。`makeAnalysis` 会给每个没有被语义 group 覆盖的 passage 补一个 anchor，247:55 的节目能产生上千个；每个 anchor 渲染成 2px 的 `.timeline-anchor`（`top:-4px`、`--ring-grad`），密度饱和后在波形上方连成一条线，读起来像第二根进度条。改为只画 `confidence >= 0.75` 的语义 group anchor，并按时间轴 1.2%（`MIN_ANCHOR_GAP`）的最小间距抽稀；本地以 1200 个 anchor 的替身节目实测渲染 30 个。anchor 数据本身没动，`findAnchor` 的重播与续播定位仍看完整列表。

同时把 dock 的 grid 从 `"title transport speed" "title transport volume"` 两行改为单行 `"title transport speed volume"`，倍速与音量此前各自落在 transport 中线的上下方，和 dock 里其它元素都不共线；`min-height` 108px → 96px。字号随单行放大：时间码与音量读数 10px → 12px（时间码列宽 40px → 48px、窄屏 36px → 44px 容下 `247:55`），节目标题 12px → 13px。窄屏（≤1000px）另有一套 grid-areas，未受影响。

`npm run check`、143 项项目测试与 8 项 `player-config.spec.ts` 浏览器用例通过。`player.spec.ts` 有 4 项失败，但在改动前的 commit 上 stash 复跑同样失败——这几项需要真实后端与 demo 数据，与本次无关。改动为纯前端，未新增数据库迁移，未执行 `db:cloudflare:production`。

生产 Worker `87fd74a6-d52c-42c5-a4fb-3c3300ce6707`（`--containers-rollout=none`，保留现有 Container）。正式域名 `/` 引用本次构建的 `index-BXzSmehr.css`，线上 CSS 含 `grid-template-areas:"title transport speed volume"` 与 `.dock-progress` 的 `48px minmax(0,1fr) 48px` / `font-size:12px`，JS bundle 含抽稀阈值；`/` 200、`/api/health` 200、`liveConfigured=true`、`uploadsEnabled=true`。

未验证：线上没有打开真实的 247 分钟节目人工查看刻度密度，抽稀效果由本地 1200 anchor 的替身节目和截图覆盖；真实节目的 group 分布不均匀，实际观感可能与替身不同。波形形状仍是 `waveShape()` 用 episode id 哈希生成的装饰图形，与音频内容无关，本次未改。

## 问答成本账本与 admin 查询

后端问答模型改为 `gpt-5.6-luna`（reasoning effort `medium`、service tier `priority`，即 fast mode）之后，每 token 单价约为标准档的两倍，因此需要能核账而不是靠感觉。

每次问答（包括失败的）在 D1 `question_usage` 落一行（migration `0006`）：实际服务档位、模型、轮数，以及 input / cached / output / reasoning token。写入走 `ctx.waitUntil`，失败只丢一行账，不影响回答。保留 90 天，由既有的 `*/5 * * * *` cron 清理。

上线步骤：

```bash
openssl rand -base64 32                 # 生成密钥
echo "ASIDE_ADMIN_KEY=<key>" >> .env    # 本地（已 gitignore）
npx wrangler secret put ADMIN_KEY --config wrangler.production.jsonc
npm run db:cloudflare:production        # 应用 0006 迁移
```

查询：

```bash
node scripts/admin-usage.mjs            # 最近 7 天
node scripts/admin-usage.mjs --days 30 --json
```

仓库内的 `aside-usage` skill 封装了同一个脚本和读数方法。

判读要点：

- **Served tier** 是实际服务的档位，不是请求的档位。出现 `default` 说明 fast mode 被降级到标准速度；`priority+default` 是一次问答中途降级。
- **Audience** 区分匿名试听与登录账号，这是判断试听额度是否可承受的依据。
- **reasoning** 是输出 token 里用于思考的部分，也是 10000 输出预算的实际消耗者。若问答开始报 `Model reply incomplete (max_output_tokens)`，说明预算不够。

`/api/admin/usage` 在 session 与账号解析之前处理，运维调用不会领到试听身份或 Cookie；未配置 `ADMIN_KEY` 时路由返回 404，表现为未挂载。密钥只走 `x-admin-key` 请求头，不进 URL。

## 每日快照

`budgets` 里的试听计数只保留 2 天，`voice_usage` 根本没有时间戳——所以"某天有多少人试过"这个问题，事后无法从持久表重建。`*/5 * * * *` 的 cron 现在会先把这些数字汇总进 `daily_stats`（migration `0007`，long 格式 `(day, metric, value)`），**再**执行原有的清理；顺序不能反。

汇总是按 `(day, metric)` upsert 的，所以每 5 分钟重跑一次只会改写同一行，不会累加。`daily_stats` 很小，不做清理。

指标含义见 `aside-usage` skill。要注意 `trial_visitors_*` 统计的是**真正走到付费路径**的访客（提问或开语音），不是页面访问量——匿名访客在消耗配额之前不落库。页面浏览量需要另外开 Cloudflare Web Analytics，目前没开。

一个 SQLite 细节：`INSERT … SELECT` 后面跟 `ON CONFLICT` 时，如果 SELECT 是 `UNION ALL` 复合查询且末支没有 `WHERE`，解析器无法区分 `ON CONFLICT` 和 join 的 `ON`，会报 `near "DO": syntax error`。`stats.ts` 里那句 `WHERE true` 是必需的，不是冗余。


## 全站 AI 停摆：语音熔断不会过期（2026-09-16）

2026-09-16 约 01:27Z 起，正式域名所有访客都无法提问或开语音，页面提示「AI trials are temporarily paused. You can keep listening.」，播放不受影响。持续时间约 5.5 小时，直到下面两个修复发布。

诊断（都是只读查询）：`GET /api/trial` 返回 `enabled:false`；`GET /api/health` 返回 `liveConfigured:true`，而该字段包含 `AI_ENABLED !== "false"`，所以代码级开关是开的。`trial_control.enabled` = 1，不是人工紧急开关。`trial_breakers` 有 1 行，owner `8db79077-1027-4c09-a036-4eb6b38fe686`（匿名访客），其 live 租约创建于 `2026-09-16T01:28:46Z` 且从未释放，`voice_usage` 对应会话 `finalized=0`。

根因：`enabled()` 用 `SELECT owner FROM trial_breakers LIMIT 1` 判断，**任意一行就让全站暂停**；而 `LiveSupervisor` 只有在拿到供应商 `session.closed` 时才清除该行。会话被供应商丢弃后 `attach()` 永远失败，alarm 每 5 秒重试一次并重新写入熔断行，形成不会自愈的全局停摆。五分钟 Cron 不清理 `trial_breakers`，人工删行会在 5 秒内被写回。

修复（两次发布）：

- `74e9045`：`attach()` 把供应商 404 视为终态（`SessionGone`），走 `retire()` 释放熔断、租约与 DO 状态。发布后仍未恢复 → 说明该会话的失败**不是** 404（是超时或其他状态），这条只覆盖了「供应商明确说会话不存在」的情况。Worker `7bbe7dcf-4fb3-43d2-acb8-933839533a7e`。
- `dd2ce2c`：把「无法确认关闭」从永久改成有界——deadline 后 15 分钟仍无法确认即释放，并 `console.error` 记录原因；释放时**不**把 usage 标为 finalized，供运维继续核对。Worker `a2c82296-c942-4f87-9329-d1c7c18a9797`。

发布后验证：`/api/trial` 返回 `enabled:true`；`trial_breakers` 0 行、live 租约 0 行、`voice_usage` 未确认会话仍为 1 行（保留证据）。清理动作最后一次 `DELETE FROM trial_breakers` 影响 0 行，说明是 DO 的新代码自己清的，不是人工删除。

测试：`npm run check`、161 项单测、37 项 Worker 集成通过。新增 3 条用例覆盖「供应商丢弃会话」「宽限窗口内保留熔断」「超过宽限窗口释放」。第一条做了对照验证：把 `live-supervisor.ts` 还原后该用例失败，加上才通过。

仍然没有边界的一处（未改动，符合现有文档）：`startSession()` 创建结果不明、`state` 里没有 session id 时，`tick()` 会写熔断并 `deleteAlarm()`，之后没有任何代码会清除它，只能人工核对。本次事故的 DO 也呈现「alarm 已停」的特征（`wrangler tail` 30 秒内没有 alarm 事件）。若要彻底消除全站停摆，需要让这条路径同样具备人工可见的告警或超时释放。

未验证：没有用真实麦克风走完一次语音会话（需要 Turnstile 与真机），因此「修复后访客能正常开语音」只由 `enabled:true` 与租约/熔断清零推断。


## SEO 第二轮与语音熔断的第三次修复：发布与线上验收（2026-09-16）

发布内容：`0a32719`（SEO 第二轮 + 文案重复修复）与 `488b6c8`（「创建结果不明」的全局熔断同样有界）。Worker `9d32021f-ef3a-4034-9bc5-008a83ff9a8d`（随后 `722394b` 只把释放日志里的租约 token 换成 owner，发布为 `45684f2d-4d18-487f-b3a5-a71ac750e2c8`），`wrangler deploy --config wrangler.production.jsonc --containers-rollout=none`（保留现有 Container），上传 6 个新文件（含新的前端 bundle 与四个静态 SEO 文件）。`main` 已同步 origin。

线上验收 14 项全部通过（curl，正式域名）：

- `/` 返回注入后的 HTML：`<link rel="canonical" href="https://asidefm.com/" />`，并含 6 条英文录音的 `<a href="/episodes/...">`。
- `/zh` 返回 `<html lang="zh-CN">` 与 `hreflang="zh"`，列出 8 条录音；`阿Q正传` 只出现在中文页，英文页为 0——与 `languageVisibility` 的过滤一致。
- `/sitemap.xml` 含 `https://asidefm.com/episodes/<id>`；节目页返回 `"@type":"PodcastEpisode"` 且 canonical 自指。
- `/episodes/does-not-exist` 与 `/no-such-page` 均 404（软 404 已消除）；`/space` 带 `X-Robots-Tag: noindex, nofollow`。
- `/robots.txt`、静态资源 200；`http://asidefm.com/` 301 到 https；`/api/trial` 返回 `enabled:true`。

未验证：仍未用真实麦克风走完一次语音会话（需要 Turnstile 与真机），因此「访客能正常开语音」只由 `enabled:true`、熔断与租约清零推断。

至此 `trial_breakers` 的三条写入路径都有界：供应商 404（`74e9045`）、attach 无法确认（`dd2ce2c`，deadline 后 15 分钟）、创建结果不明（`488b6c8`，同样 15 分钟且保留租约作为痕迹）。三条都会 `console.error` 记录原因。


## 播客让位（软让位与淡出暂停）：发布与线上验收（2026-09-16）

发布内容：`60ea278`，基于合并后的 `0e51046`（含移动端共用运行时与服务端语音控制）。后端开始判断一段话（服务端控制流 `classifying`，旧路径为 Live 委派）时播客在 150ms 内降到用户音量的 60%，`ignore`、只改配置的指令、手动操作或 2.5 秒无新决定后 300ms 回升；确认为提问、文字提问、按住说话和语音 `pause` 指令改为 250ms 淡出再暂停，打断位置仍取开口时刻。浏览器端让位倍率走 MediaElementSource 与分析器之间的 GainNode，波形随之缩小；移动端 `NativePodcastAudio` 分步调音量，只做了类型检查。细节见 [player-controls.md](player-controls.md#让位软让位与硬让位)。

生产 Worker `1c0560e9-b3e2-4bca-be2d-b05fdd4ea654`，`wrangler deploy --config wrangler.production.jsonc --containers-rollout=none`（保留现有 Container），上传 3 个新文件；`npm run test:mobile-service` 4 项通过。生产 D1 无待应用迁移（`0006_mobile` 已在线上）。`main` 已同步 origin。

发布前：`npm run check`（含移动端类型检查）通过；224 项单元测试、43 项 Cloudflare 集成测试通过；浏览器套件 player-config、voice-remote（18 项）、player、listening-controls、mobile-panels 通过。`vad.spec` 的两条纯音误触发用例在合并前后都失败，与本次无关。

线上验收（curl 与无头 Chrome，正式域名）：`/` 引用 `index-DHwuzSb6.js`、`index-MG_NYjXQ.css`，JS 为 200 且 `text/javascript`，bundle 含让位日志字符串；`/api/health` 200、`liveConfigured=true`；`/api/trial`、`/robots.txt` 200。访客只听模式打开 `chronoscope-byrd` 并播放：音频经 GainNode 链路正常出声、进度前进、波形逐帧变化、暂停后停止，控制台无错误。

未验证：没有在生产用真实麦克风走一次语音打断（需要 Turnstile 与真机），软让位的降音深度和淡出听感需戴耳机实听；移动端适配器没有运行验证。倍速调整会取消续播倒计时的问题（见 IMPLEMENTATION.md 2026-09-16）本次未修。


## 长节目提问与语音判断全部失败：排查与修复（2026-09-17）

现象：用户在一集 248 分钟的私有节目上开麦说话，先报「Voice intent classification failed. Please reconnect the microphone.」且麦克风显示 off；随后再试报「Couldn't answer. Please try again.」，麦克风保持 on。

排查：两条报错分别来自 `backend/src/live-intent.ts` 的判断 catch 和 `cloudflare/src/api.ts` 的流式问答 catch，原先都把异常吞掉、不记原因。`wrangler tail` 显示 `/question` 在 969ms 内返回 200，排除 60 秒超时；本地用同一 key 提问正常，排除模型服务。`question_usage` 最近成功记录都在 4 分钟的公开样本上。把该节目的分析（D1 `artifacts` 49 片、3.09MB、3316 段）拉下来用 `buildContext` 实测：从第 3–5 分钟起几乎所有位置的上下文都是 31–45KB，超过试用 provider 32000 字节的硬限制，模型调用前即被拒绝。体积来自每段 passage 附带、但 `Passage` 类型未声明的 `words` 逐词时间戳（一段 549 字节对 59 字节正文）；`buildContext`、`getPassage`、`searchPodcast` 都把整段对象展开给模型。问答和语音判断共用同一构造器，所以是同一根因，且早于当天的让位发布。

修复与发布：

- `fb5eced`（Worker `7d0974bf-c6a0-40c9-8bfc-695e1fcfc7e3`）：判断失败原因写入服务端日志（`Aside voice intent classification failed`，含 reason、是否超时、第几次判断），前端区分「会话已结束」「判断超时」「其它失败」三种文案。
- `d63d03c`（Worker `17685380-2f8d-4f14-8d79-60e51183e2fa`）：模型只看到 passage 声明的五个字段；`buildContext` 加 24000 字节预算，依次丢旧对话、早期摘录、最旧的近期文字稿，当前段永不丢；流式问答失败同样记录原因（`Aside question failed`）。同一节目实测上下文降到 7–11KB。两次都用 `--containers-rollout=none` 保留现有 Container，`/api/health` 200。

验证：`npm run check`、227 项单元测试（新增 passage 投影、字节预算、会话结束文案三条）、43 项 Cloudflare 集成测试通过。未验证：尚未由用户在该节目上重新开麦实测；`words` 仍保存在分析记录并原样返回给前端，本次只改模型上下文。

补记：`17685380` 上线两分钟后（04:02:21Z），协作者从未含 `d63d03c` 的旧 main 部署了 `de481958-7677-4895-8430-6af0323fa05b`，线上回退到修复之前；04:05Z 用户再次开麦，服务端日志记录 `Trial context too large`（call 1），证实根因判断，也证实回退。04:06:59Z 从当前 main（`2be8361`）重新部署为 `8caf78c0-92a6-44c1-97cd-327bb012e388`，`--containers-rollout=none`，`/api/health` 200。多人部署同一 Worker 没有互斥，发布前应先 `git pull` 并确认 `wrangler deployments list` 的最新版本。


## 移动端音频交接与流式回答：发布（2026-09-17）

发布内容：PR #12（`3c946ce`，含 `87c0e12`、`17f207a`、`1d5ae25`）。服务端只有一处行为变化：`/question` 的请求带 `X-Aside-Answer-Stream: 1` 时，NDJSON 流在 `progress` 与 `result` 之间增加 `answer` 事件，逐段推送回答文本（`engine/src/contracts.ts` 新增该事件类型，`QuestionModel` 增加可选 `onText`）；不带该请求头的客户端收到的事件序列不变。其余改动在 `mobile/`（原生音频会话交接、错误文案、流式显示），不随 Worker 发布。无数据库迁移，Container 代码未改。

发布前先 `git pull`（快进 5 个提交，无冲突），`wrangler deployments list` 确认线上仍是 `8caf78c0`、其后无他人部署。`npm run check`、236 项单元测试、44 项 Cloudflare 集成测试通过。

生产 Worker `00afc10c-9416-472a-ab53-1d79573babe6`，`wrangler deploy --config wrangler.production.jsonc --containers-rollout=none`（保留现有 Container）；`npm run test:mobile-service` 4 项通过。正式域名 `/` 引用 `index-CXzFoCX2.js`、`index-MG_NYjXQ.css`；发布后第一次请求新 JS 返回 404，数秒后稳定为 200、`text/javascript`、476,657 字节，与本地构建一致（与此前记录的静态资源短暂滞后同类）。`/api/health` 200、`liveConfigured=true`、`uploadsEnabled=true`；`/api/trial` 返回 `enabled:true`；`/zh` 200，`/no-such-page` 404。

未验证：没有在生产发起带 `X-Aside-Answer-Stream` 的真实提问（会产生付费调用），`answer` 事件的线上表现只由单元与 Miniflare 集成测试覆盖；移动端改动未在真机上运行验证；未在浏览器里打开线上播放器核对。


## 暂时取消每日试用额度（2026-09-17）

按用户要求，生产暂不限制每日试用次数。新增 Worker 变量 `TRIAL_DAILY_LIMITS`：值为 `"false"` 时，`budget()` 对每身份 5 次、每 IP 10/20 次、全站 10/100 次（语音 / 提问与转写）三档都不再拒绝，但**计数照常累加**，所以 `daily_stats` 的试用指标不受影响。只在 `wrangler.production.jsonc` 里设为 `"false"`；本地配置未设，默认仍然限额。恢复限额：删掉该变量或改为其它值后重新发布，当天已累加的计数会立刻生效。

起因：当天 05:41Z 生产 `budgets` 里两个身份分别用满语音 5/5、转写 5/5 与提问 5/5，全站语音 9/10，页面提示「今日体验额度已用完」。语音控制模式一次连接同时扣 `live` 与 `question` 各一次，消耗比直觉快。

未改动：Turnstile 验证、每分钟速率限制（`burst`）、并发位（`trial_leases`）、Live 时长、全站紧急开关与熔断、上传额度。

生产 Worker `818f7c05-e24a-49f3-b97c-45c6f965f883`，`--containers-rollout=none`，绑定显示 `TRIAL_DAILY_LIMITS="false"`；发布前确认线上仍是 `00afc10c`。`npm run check`、236 项单元测试、45 项 Cloudflare 集成测试通过（新增一条：开关关闭时三类请求在全站池已满的情况下连续 6 次均放行且计数累加，开关恢复后同一池立即拒绝）。`npm run test:mobile-service` 4 项通过，`/api/health` 200，`/api/trial` 返回 `enabled:true`。

费用提示：现在匿名访客的模型花费只受每分钟速率限制与并发位约束，没有每日上限。建议在 OpenAI 后台设月度花费上限兜底，并用 `node scripts/admin-usage.mjs` 留意匿名流量。

未验证：没有在生产用已耗尽额度的身份重新提问或开语音实测（会产生付费调用），放行由集成测试与绑定值推断。


## 服务端语音控制首次真机使用：四个问题的排查与修复（2026-09-17）

背景：服务端语音控制随 09-16 的让位发布上线，当时「未在生产用真实麦克风走一次」。09-17 用户在 248 分钟的私有英文节目上、**外放**、Chrome 桌面实测，先后反馈「语音完全不介入」「wait 不行、等一下要说很多次、stop here 可以」「A request is already running」「介入了但体验退化、说英文回中文」。

取证手段：`question_usage` 的 token 数（本地实测暂停指令可见输出约 25、忽略/等待约 16，可反推每次判断的结果）；新增的服务端日志配合 `wrangler tail`；下载该节目分析后用生产同款模型（`gpt-5.6-luna`）在本地跑同一判断路径。Workers 日志查询 API 拒绝了 Wrangler 的 OAuth 凭据，未绕过。

排除项：判断模型本身——`Wait`/`wait`/`Wait wait`/`Hold on`/`Pause`/`等一下` 单独输入全部判为暂停；4 条英文、1 条中文提问均按提问语言回答。PR #12：`voice-remote` 10 项浏览器回归通过。

1. **被放弃的会话创建占住唯一的语音名额**（`3d831c4`，Worker `01ceebdf`）。创建会话偶发很慢（实测一次 8.9 秒），浏览器已放弃并重建，但旧会话的 `live` 租约要等浏览器最长 35 秒后才上报关闭，期间新建一律 429「已有请求正在进行」。同类：连接期间的本地转写被上一条已取消但服务端仍在跑的转写占位，429 被当作致命错误直接关掉刚建好的会话——这是「会话只活 15–23 秒」「要说很多次」的原因。修复：创建结果返回时若连接已作废，立即经 `usage{closed:true}` 请服务端关闭；`acquire()` 的 429 带 `code: "trial_busy"`，浏览器对 `/live` 与 `/transcribe-question` 每 2 秒重试、最多约 10 秒（额度用完、请求过频不重试）。
2. **外放时播客声进入麦克风**（`6ada992`，Worker `4c8ff85a`）。存档里的用户一句是 ` clients. Sure`——播客台词被当成听者的话转写；短促的 `wait` 在双讲时更容易被回声消除削掉而完全没有转写（一次会话 6 秒内零转写，随后 `等一下` 正常）。修复：服务端语音模式下，本地语音检测一触发就把播客压到 15%（`attention.speechLevel`），同一次让位内只降不升，无转写时 2.5 秒后自行恢复；VAD 仍不分段、不暂停。
3. **语音模型自行接话**（同上）。存档里的助手一句是 `好,我等一下`；日志也显示会话一开始、任何决定之前就有 `session.output_audio.delta`。提示词已要求保持沉默但未被遵守，且该节目的摘要/主持风格与浏览器上下文提示都是中文，用户说英文时它回中文。修复：服务端语音模式下，语音输出只在后台回答交付期间可听、可入对话记录（`answerWindow`）；新的听者输入在回答播完后关闭窗口，回答播放中不被打断。
4. **额度**：见上一节（`TRIAL_DAILY_LIMITS="false"`）。

为取证新增的服务端日志（`b85e9f9`、`8b44e2e`、`a2674da`；不记录听者的话，只记字符数、动作、时序）：`Aside voice input heard`、`Aside voice decision`、`Aside voice decision acknowledged`（含双方 revision/version）、`Aside voice decision dropped before acknowledgement`、`Aside voice acknowledgement discarded with its update`、`Aside voice control ended`、`Aside voice sideband event`（每种重复事件每会话一次）、控制流的请求/取消/拒绝。

修复后同一用户的一次会话（06:28Z）：`wait` 两次均被转写，听到→判为暂停→浏览器确认分别约 2.2+0.4 秒、1.7+0.5 秒。

验证：`npm run check`、240 项单元测试（新增 4 项：放弃的创建立即关闭、仍需要的创建不关闭、开口即深度让位、仅后台回答可听可记；第一项做过去掉修复即失败的对照）、46 项 Cloudflare 集成测试（新增「被拒为 busy → 上报关闭 → 重建成功」）、20 项浏览器回归（voice-remote、player-config、mobile-panels）通过。各次发布均 `--containers-rollout=none`，发布前确认线上版本无他人部署，`/api/health` 200。

未解决 / 未验证：

- 第 2、3 项发布后尚未由用户在外放下实测；15% 是否足以让回声消除放过短词、外放下播客自身会不会触发本地语音检测造成音量起伏，都需要实听。
- 提问从开口到决定约 11 秒：服务端边说边判断，文字每变一次就作废重来（该次第 7、8 次判断白跑），而语音模型在第 4 秒就已认为说完。可改为等「说完」信号再判一次，属交互设计改动，未做。
- 会话创建为何偶发 8.9 秒未查明。
- 英文节目的摘要与主持风格为何生成为中文未查；它会继续把语音模型往中文带，现在只是听不到。
- 同一节目另有一个页面在每 2 秒写入收听进度并被拒（一段时间内 334 次 409）；播放中进度每 250ms 写一次 D1。未见对语音的直接影响，未处理。
- `stop here` 之后播放器仍显示播放中的反馈未能复现或解释。

补记（同日 07:1xZ，`continuous-cold` 修复）：上述第 2、3 项发布后用户仍反馈「说了很多次都没进去」。日志：06:57:49Z 的会话控制流已连上，但 18 秒内服务端零转写（没有任何 `Aside voice input heard`），同时浏览器发了 6 次 `/transcribe-question`（约每 2.5 秒一次）。原因在 `frontend/src/on-demand-voice.ts`：会话连上之前开口会进入本地录音（cold）路径，此时麦克风不接给语音会话；外放时播客声不断触发本地语音检测，每次触发都重启录音并作废上一次转写，于是永远停在 cold，麦克风始终没接上。连续监听（自动模式）下改为：会话连上后，检测器再触发不重启录音、不作废在途转写；第一次转写返回即结束本地阶段（不再要求「此刻没人说话」）；空转写或转写失败只结束本地阶段、不关会话；若连上 4 秒后仍没有在途转写则直接接上麦克风。按需模式（手动）行为不变。新增 3 项单元测试（其中 2 项做过去掉修复即失败的对照），243 项单元测试、13 项相关浏览器回归通过。尚未由用户实测。

## Live 会话改用 Responses 委派（2026-09-18）

背景与设计见 [ADR 0004](adr/0004-responses-delegation.md)。生产 Worker `c87820df-5aa0-444c-a992-c6134eb828a0`（`--containers-rollout=none`，保留现有 Container），发布前确认线上是队友 02:04Z 的 `f60afc3c`（#24），本分支已变基到含 #23、#24 的 main：保留 #23 的字幕归属（`engage` 事件带 `input` 标记，运行时按识别时间戳把 Live 字幕挂回对应问题），#24 的"先放行再答"路径随 LiveIntent 一并退役（其 QuestionService 侧的 `accept_question` 与运行时 `answer` 事件处理保留，服务端不再发出）。首页引用 `index-CRKzFSQd.js`；`/api/health` 200，`liveConfigured=true`；`npm run test:mobile-service` 4 项通过。

本地验证：`npm run check`、300 项单元测试、Cloudflare 集成 50 项（重写 sideband 用例：委派配置、工具回报等执行回报、engage/answered、账本；一次运行中上传额度用例偶发失败，单跑通过）、Playwright voice-remote 19 项与 player 4 项通过。真服务探针：WebSocket 主连接与 aiortc WebRTC 主连接加 sideband 各若干会话，全部委派、工具选择正确，说完到答案开口 1.2 到 2.7 秒，暂停 1.3 秒。

未验证：生产真人麦克风端到端；Live 对中文短控制词的委派稳定性（保留本地快速暂停作保险）；控制类工具后 Live 偶尔的口头确认。取证：`wrangler tail` 中 `Aside voice delegation created`、`Aside voice engage`、`Aside voice tool call`、`Aside voice decision acknowledged`。

## 分享卡片按语言出图，hero 加 Product Hunt 链接（2026-09-18）

起因：在 LinkedIn 粘贴 `https://asidefm.com`，预览是英文标题配中文图。全站只有一张 `og-image.png`，由 `scripts/prepare-og-image.mjs` 写死中文标题渲染，`og:image` 又放在 Worker 按路由改写的 head 区块之外，所以 `/` 和 `/zh` 共用同一张中文图。

改动：脚本一次生成两张 1200×630 卡片，`og-image.png` 改为英文（Follow your curiosity, ask anytime.），新增中文的 `og-image-zh.png`；`og:image`、`twitter:image` 及其 alt 移入 seo:head 区块，`cloudflare/src/seo-html.ts` 的 `seoHead` 按语言选图，`frontend/src/i18n.ts` 在浏览器内切换语言时同步。首页 hero 按钮下方新增一行 Product Hunt 文字链接（内联 SVG 图标，无第三方请求，新标签页打开，带 `utm_source=asidefm&utm_medium=hero`）；推广期结束后删除 `Landing.tsx` 中的 `<a className="hero-note">` 即可。

发布与核对：`npm run check` 与 333 项单元测试通过（新增 1 项英文卡片用例，`/zh` 用例补了图片断言）；hero 链接在本地浏览器截图核对了英文浅色桌面、中文深色桌面与 390 宽手机，无横向溢出。发布前确认线上是队友 06:06Z 的 `a19fefb7`（#31），与 origin/main `de79fb1` 一致，本次提交直接快进到 main（`57f8c5f`）。生产 Worker `de4575a6-72b4-4476-bfa5-e8730c54bbf4`（`--containers-rollout=none`，保留现有 Container）。正式域名 `/` 的 `og:image` 与 `twitter:image` 指向 `og-image.png`，`/zh` 指向 `og-image-zh.png`；两张图均 200 `image/png`，线上 `og-image.png` 的 SHA-1 与本地一致；首页引用 `index-Bt5O4Hj6.js`、`index-jraiRU-3.css`，bundle 内含 Product Hunt 链接；`/api/health`、`/robots.txt`、`/sitemap.xml`、`/llms.txt` 均 200；`npm run test:mobile-service` 4 项通过。

未验证：LinkedIn 等平台会缓存旧预览，需在 Post Inspector 重新抓取后才会显示新图，本次未做；生产页面上的 hero 链接未用浏览器再截图，只核对了 bundle 内容。

## 语音回答后自动续播、播放即监听、人声立即暂停、登录后进入我的空间（2026-09-18）

**自动续播。** #20 起 Live 语音回答后必须说"继续"才恢复节目，因为当时只能靠静音猜测回答是否结束，而 Live 会在查询时停顿。Responses 委派之后后端有了完成信号：`answered` 事件新增 `final`（同一响应里还有工具调用时为 `false`）。浏览器端在 `engage` 后关闭续播窗口，收到最终 `answered` 才打开；此时若语音尚未出声，还要等回答音频播完。之后在续播等待内无人说话就恢复节目。默认等待由 3 秒改为 2 秒（`ASIDE_AUTO_RESUME_MS`，生产读取 Worker 默认值），已朗读的回答不再套用长回答的 8 秒阅读等待。没有完成信号的路径保持原样：服务端直接推送的 `decision: answer` 仍然按住；被新话语取代的委派不会发出 `answered`，因此也不会自动续播。与 #33 的交叉：插话打断回答后仍保持安静（忽略的插话不续播），但这个"按住"只到听众下一个被接受的问题为止，那次回答结束后照常自动续播；用户点"先别继续"的按住不受影响。

**播放即监听。** 从首页或节目库进入时麦克风默认关闭，需要点"开启麦克风"。现在该按钮已删除：每个节目第一次播放时申请麦克风，访客先完成试用验证再开启监听（节目此时已在播放，开启监听会立即连接语音）。拒绝麦克风只提示一次并继续播放，换节目后才会再次询问；关闭验证弹窗则下次播放再提供。

**人声立即暂停。** 本地语音检测到有人说话时，节目原先压低到 15% 音量等待后端判断，现在直接停止。它仍是软让步：播放状态不变；后端判定为旁人闲聊（`ignore`）或 2.5 秒内没有任何识别结果时自动接着播；判定为提问则转为正式打断，位置就是开口的那一刻。等待从说话结束算起，长问题不会被节目盖住；检测器卡住时最多停 30 秒。

**登录后进入我的空间。** 邮箱验证码登录成功后跳转 `/space`，不再弹出个人资料；正在收听某期节目时留在原页面。Google 回调同样跳转 `/space`，只有从个人资料发起的"关联 Google"才回到个人资料。

发布与核对：`npm run check`、342 项单元测试、Cloudflare 集成 50 项通过；浏览器用例中语音、账号、试用、麦克风入口、收听控制、VAD 共 34 项通过（含 #33 的新用例）。全量浏览器运行有两项失败，均与本次改动无关：`player.spec.ts` 的 native WebRTC 用例在改动前的代码上同样失败；`public-samples.spec.ts` 期望 6 条英文示例，而本地后端有 12 条节目数据。发布前确认线上是队友 07:04Z 的 `020ab76c`（#33），与 origin/main `bc951fd` 一致，本分支已变基其上并解决了 `answered` 处理处的冲突（保留 #33 的打断判定，并传入 `final`），快进到 main（`67ab9e3`）。生产 Worker `01d95882-37eb-47ef-97de-7022cf246053`（`--containers-rollout=none`，保留现有 Container）。线上 `/api/health` 的 `autoResumeMs` 为 2000；首页引用 `index-DN2bg9Ls.js`，bundle 内已无"Enable microphone"，含人声暂停逻辑与 `/space` 跳转；`/`、`/zh`、`/space`、两张分享图、`/robots.txt`、`/sitemap.xml`、`/llms.txt` 均 200；`npm run test:mobile-service` 4 项通过。

未验证：生产环境真人麦克风端到端（自动续播的时机、外放时人声暂停是否被节目自身的声音误触发、iPad）；Google 登录回调只有集成测试覆盖。取证：调试日志中的 `Podcast stopped for speech`、`Podcast continued`、`Backend delegated answer`。

## 自动续播被"等待判断"卡住：修复与诊断（2026-09-18）

上一节发布后，线上反馈语音回答结束后仍要说"继续"。没有拿到该次会话的客户端状态，原因未经线上证实；用此前探针保存的真实事件流核对过后端顺序（工具响应与最终文本响应各自 `response.created` → `response.completed`），`answered.final` 在真实流程中为 `true`，问题不在后端。代码中确认了一个会造成同样现象的缺陷：回答结束后本地语音检测一旦触发（咳嗽、"嗯"、外放回声），`liveInputPending(true)` 就关闭续播窗口，而它只会被后端的 `decision` 或 `engage` 清除；没有转写的声音不会产生任何判断，窗口永久关闭。`wait_for_input` 之后听众不再说话也是同样结果。

改动：等待判断的状态在最后一次信号 5 秒后过期（期间仍有人说话则顺延），随后重新打开续播窗口。`voiceDiagnostics().autoResume` 给出等待时长与 `blockedBy` 列表（如 `input awaiting a decision`、`backend still answering`、`held after barge-in`），调试日志在窗口打开或被阻止时各写一行（`Auto-resume in …ms` / `Auto-resume waiting: …`）。

发布与核对：`npm run check`、343 项单元测试通过（新增 1 项：回答后的无转写噪音不再困住节目），语音、VAD、收听控制浏览器用例 28 项通过。发布前线上仍是上一节的 `01d95882`，origin/main 无新提交，快进到 main（`37758dd`）。生产 Worker `b123b79e-69be-4397-9b0e-ccd0e9fa2b4d`（`--containers-rollout=none`）。首页引用 `index-CvYvYDIF.js`，bundle 含新逻辑；`/api/health` 200；`npm run test:mobile-service` 4 项通过。

未验证：这是否就是线上那次不续播的原因。若仍不续播，打开 `?debug` 的语音诊断，读 `autoResume.blockedBy`。外放时回答的回声触发 #33 的插话打断会得到 `held after barge-in`，那是另一条路径，本次未改。

后续调整（同日）：等待判断的过期时间由 5 秒改为 2 秒（`pendingDecisionMs`）。过期后仍要再过续播等待才恢复节目，真实提问合计有 4 秒完成接管；探针实测接管在说完后 1.2 到 2.7 秒。若接管晚于 4 秒，节目会先恢复再被正式打断。343 项单元测试与 23 项语音浏览器用例通过。

发布记录与一次部署冲突：上述 2 秒调整快进到 main（`169893b`），生产 Worker `6c57ab56-114b-4bb8-9b19-ba30b1ae7755`（`--containers-rollout=none`），首页引用 `index-ByL8DSq6.js`，`/api/health` 200，`npm run test:mobile-service` 4 项通过。部署时间线（UTC）：07:34:05 本机部署 `b123b79e`；07:34:50 另一位队友从草稿 PR #29（`codex/continuous-mobile-voice`，基于 `4d8003f`，不含"等待判断过期"修复）部署了 `11ef1749`，覆盖了前者；07:37:53 本次部署又覆盖了它。发布前只核对了 origin/main 无新提交和线上版本号，没有核对该版本的作者，因此没有发现线上已是队友的分支构建。结果：PR #29 中未合并的后端改动（`backend/src/live-delegation.ts`、`live-control.ts`、`cloudflare/src/live-supervisor.ts` 等）目前不在线上，他的移动端联调会受影响；需要他变基到 main 后重新部署，或先合并。以后发布前必须同时核对最新部署的作者与版本。


## Jev 影子评测上线（2026-09-18）

背景：每句听到的话由后端模型判断"忽略 / 等待 / 暂停 / 继续 / 调整播放 / 提问"，真实会话里第一个判断要 0.94 到 1.54 秒；人声立即暂停之后，这段时间就是旁人说话造成的空白。Jev（TypeSafe 的结构化决策模型，2026-09-17 发布）不生成文字，只在给定选项中选择并给出校准置信度。它通过 OpenRouter 可用：`POST https://openrouter.ai/api/alpha/decisions`，模型 `typesafe/jev-1.13`，输入 $0.042/百万 token，输出免费。

离线评测（`npm run eval:jev`，78 句中英文自拟语料，其中约 15 句与提示词示例重合，结果偏乐观）：总体 74/78，英文 37/38，中文 37/40，中文短控制词全对；4 个错判置信度都在 0.39 到 0.52；只采用置信度 ≥ 0.6 的判断时保留 66/78 且全对。本机保持连接的延迟 p50 131ms、p95 215ms、最大 776ms；20 个并发全部成功但最慢 1018ms。每次约 813 输入 token。

可用性风险：接口在 `/api/alpha/` 路径下、标注 beta，可能移动；只有 TypeSafe 一个 provider，没有故障切换；官方文档列有 `529 Overloaded`；没有 SLA、速率限制与数据保留说明；`jev-latest` 会自动换版本，因此固定 `jev-1.13`。

本次上线的只是影子模式，不改变任何行为：`backend/src/jev-shadow.ts` 在后端模型开始处理一句话时同时问 Jev（3 秒放弃），把 Jev 的选择、置信度、耗时与后端的第一个判断写成 `jev_shadow` 表的一行（迁移 `0008`，保留 90 天）。不存用户说的话，只存字符数和是否含汉字。失败（`timeout`、`http_<code>`、`invalid`、`network`）只是被计数的结果。未配置 `OPEN_ROUTER_API_KEY` 时整个功能关闭。

发布与核对：`npm run check`、348 项单元测试（新增影子模块 4 项、协调器 1 项）、Cloudflare 集成 50 项通过。迁移 `0008_jev_shadow.sql` 已应用到生产 D1；`OPEN_ROUTER_API_KEY` 已用 `wrangler secret put` 配置（该命令自身产生了 08:04Z 的一个版本）。发布前线上是另一位队友 07:48Z 从草稿 PR #29 部署的 `3cc34209`（已变基到 main，外加其未合并的移动端后端改动）；经产品负责人确认后仍部署 main（`e4128ae`），生产 Worker `99cfb905-8c75-41f5-ae4c-5866777f657a`（`--containers-rollout=none`）。PR #29 的未合并改动因此再次不在线上。`/`、`/space`、`/api/health` 均 200，`npm run test:mobile-service` 4 项通过，`jev_shadow` 表存在且为空。

未验证：生产上尚无语音会话经过影子路径，第一行数据出现前，Worker 到 OpenRouter 的实际调用未经线上证实。查看方式：

```
npx wrangler d1 execute asidefm --remote --config wrangler.production.jsonc --command \
  "SELECT status, COUNT(*) n, ROUND(AVG(jev_ms)) avg_ms, SUM(agree) agree, SUM(agree IS NOT NULL) compared FROM jev_shadow GROUP BY status"
```

采用门槛（建议）：数百句真实数据上，置信度 ≥ 0.6 的一致率 ≥ 98%，`jev_ms` p95 < 400ms，非 `ok` 比例 < 1%；达标后也只让它接管"忽略"与播放控制，并始终保留后端模型兜底。

## Jev 与移动端兼容部署（2026-09-18）

移动分支 PR #29 已 rebase 到 `25e1621`。发布前重新核对远端 main、生产作者与版本，确认线上为上述 `99cfb905`。从 `7ed30db` 部署 Worker `62fe977a-e6e6-42a2-ad06-dbf1febcb115`，同时包含 Jev 影子评测与移动端尚未合并的语音策略；Web 产品代码与 main 一致。使用 `--containers-rollout=none`，保留媒体容器与现有 Secrets，未重新执行数据库迁移。

该版本还修复了同一问题产生两份后端措辞、Live 只朗读后一份时，移动端完成判断滞留在第一份文字的问题。只在完整候选文字与输出字幕吻合后更新原有回答元数据；原生端仍核对实际播放与音频队列排空。额外的问答轮次和播放工具调用继续拒绝。

验证：421 项本地测试、类型/边界检查、Cloudflare Web/mobile 语音链路和 [完整 CI](https://github.com/qiz029/aside/actions/runs/35323289839) 通过；双端模拟器复用既有 build 38 验证成功，发布后 4 项登录路由/Bearer/Origin 检查通过。iPhone 39、Android 19 无需重装。此次验证未发邮件或调用真实模型。详细证据见 [移动端交付记录](continuous-mobile-delivery.md)。PR #29 仍为 draft；后续从 main 单独部署仍会移除未合并的移动端后端能力，发布前需继续核对作者、版本与源码。

后续修正：`f559178` 阻止移动端的旧工具回执在手动操作、新问题或关闭会话之后重新打开旧回答、补发后台请求。425 项测试、类型检查、Cloudflare sideband 回归及 [CI](https://github.com/qiz029/aside/actions/runs/35324139889) 通过。确认 main 仍为 `25e1621`、线上前序作者/版本为本任务的 `62fe977a` 后，发布 Worker `bb4dd397-dcf6-49d1-8921-1c062ac179db`（保留 Container 与 Secrets），4 项鉴权烟测通过。既有手机版本可直接使用此修复，无新增模型或邮件调用。单路供应商音频的重叠回答边界仍单独记录，不以此修复宣称解决。

## Jev 抢先决定忽略、暂停与继续（2026-09-18）

决定：产品负责人在影子表仍为 0 行（上线后 7 小时无语音流量）时决定不再等影子数据，直接让 Jev 与后端模型并行、并抢先决定。依据只有离线评测：当天重跑 `npm run eval:jev` 为 73/78，p50 205ms、p95 372ms，置信度 ≥ 0.6 保留 65 句全对；5 个错判里 3 个是把播放中的短问题判成"忽略"，置信度最高 0.54。因此门槛定为 0.7（`jevActConfidence`，覆盖 59/78）。

行为：后端模型仍对每句话做判断，Jev 不替代它，也不省后端调用。Jev 的回答先到且置信度 ≥ 0.7 时，`LiveDelegation.actEarly` 立即执行"忽略"（播客继续）、"暂停"或"继续"；后端随后的判断以它自己的为准：同样的忽略不再重复下发，暂停与继续复用已上报的执行结果，判为提问则照常 engage，把刚恢复的播客重新停下并作答。不抢先的情形：后端已先做出判断、用户还在继续说（Jev 看到的是半句话）、有未确认的播放决定、"调整播放"（Jev 不给参数）与"提问"。Jev 超时或失败时行为与此前完全一样。`jev_shadow.acted`（迁移 `0009`）标记 Jev 抢先执行的行，`acted = 1 AND agree = 0` 即用户看到被后端收回的次数：

```
npx wrangler d1 execute asidefm --remote --config wrangler.production.jsonc --command \
  "SELECT jev, COUNT(*) n, SUM(acted) acted, SUM(acted AND agree = 0) taken_back, ROUND(AVG(jev_ms)) jev_ms, ROUND(AVG(backend_ms)) backend_ms FROM jev_shadow WHERE status = 'ok' GROUP BY jev"
```

发布与核对：`npm run check`、354 项单元测试（新增协调器 4 项、Jev 模块 1 项、收听会话 1 项"先忽略后被 engage 推翻"）、Cloudflare 集成 50 项通过。迁移 `0009_jev_acted.sql` 已应用到生产 D1。发布前线上是另一位队友 08:28Z 从草稿 PR #29 部署的 `bb4dd397`（已含 Jev 影子提交，外加其未合并的移动端后端改动）；经产品负责人确认后部署 main（`401b649`），生产 Worker `40a69570-361e-4286-88a4-819a361e97ad`（`--containers-rollout=none`），首页引用 `index-ByL8DSq6.js`（前端无改动）。PR #29 的未合并改动第三次不在线上，需要他变基到 main 后重新部署。`/`、`/space`、`/api/health` 均 200，`npm run test:mobile-service` 4 项通过。

未验证：生产上仍没有语音会话经过 Jev，Worker 到 OpenRouter 的调用、线上延迟和抢先路径都未经线上证实；被推翻的忽略可能丢掉 Live 在此之前缓冲的回答开头，真实听感未测。

## 服务端控制下不再把节目文本交给语音（2026-09-18）

现象：产品负责人在英文节目（Acquired 的 Hermès，约 3 小时 07 分处）用英文问 "Do they make perfume for men"，听到的是中文：先是一段刚播过内容的中文翻译（"……通过最近推出的很多香水，并在百货商店销售……苹果手表战略的进一步延续"），然后才是后端的回答，也是中文；整体感觉很慢。

首批 Jev 线上数据（同一次会话，15:37:48–15:38:09Z，7 行）：Jev 延迟 115–273ms，Worker 到 OpenRouter 的链路已证实可用。抢先 3 次，3 次与后端不一致：两次 Jev 判"忽略"而后端判"等待"（都是不作声，无影响）；一次 Jev 以 0.95 判"继续"而后端按提问处理（一句 9 个字符的话，用 "Continue." 探针复现时后端自己也调了 `resume_podcast`，这类话本身有歧义）。一句 57 个字符的话被后端连续判了 5 次"等待"，Jev 判"忽略"，原文未存，无法确认是什么。样本太小，未据此调整 Jev。

原因：`ListeningSession.sendContext` 在播放中每换一段就向 Live 会话追加一条 `session.thinking.append`，内容是最近三段节目原文、当前句前 160 字和一句中文备注。这是 Responses 委派之前的遗留：服务端控制下 Live 的提示词写的是"你不知道节目内容、必须委派"，手里却有节目文本，于是不委派、直接照着这段文本说话；该节目检查点里存着的 4 句助手回答全是中文（`liveStartupHistory` 会把最近 12 轮带进新会话），再加上中文备注，它就用中文说。

复现（`scripts/live-delegation-probe.ts`，新增 `--history` 与 `--context`，生产提示词 + 该集真实分析 + 同一句英文语音，位置 11260000）：无历史无追加 2/2 英文且委派；只有中文历史 2/2 英文且委派；只有追加 3 次中 1 次无回答、1 次 Live 在后端答案之外自己加了节目内容；追加 + 中文历史 3 次中 2 次后端零输出、Live 自己说话，其中 1 次是中文，与线上听到的前半段几乎逐字相同。干净的探针（无历史、无追加）不能代表生产。

修复（`2fc3ff6`）：服务端控制（自动插话）下 `sendContext` 不再向 Live 追加任何内容，后端指令里的 `recentlyHeard` 窗口不变；客户端委派路径（按住说话等）保留这段上下文，备注改为英文。新增收听会话测试 1 项（去掉修复即失败）。

发布与核对：`npm run check`、355 项单元测试通过。发布前线上是本人 15:33Z 的 `40a69570`，origin/main 无他人新提交；由产品负责人本人执行推送与部署，生产 Worker `6d2870f2-fa97-4c5e-86c4-4b722e1ce9ab`（`--containers-rollout=none`），首页引用 `index-JfT-4BtI.js`。`/`、`/space`、`/api/health` 均 200，`npm run test:mobile-service` 4 项通过。PR #29 的未合并改动仍不在线上。

未验证：修复未经真人线上会话证实。该集检查点里的中文助手回答仍会被带进新会话；只有历史时 2/2 为英文，若线上仍偶发中文，下一步是不再把旧的助手回答作为 Live 的启动历史。
