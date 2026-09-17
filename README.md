<div align="center">

# 🎧 Aside

**听到好奇的地方，随时插话。**

上传 Podcast · 开口提问 · 连续追问 · 从自然断点继续听

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
![Local prototype](https://img.shields.io/badge/status-local%20prototype-orange)

</div>

Aside 是一个可以用语音打断的播客播放器。它先分析整期音频，建立带时间戳的内容地图；你提出问题时，AI 结合当前听到的内容回答，聊完后回到完整的句子继续播放。

## ✨ 可以做什么

- **选择插话方式**：自动插话由后端持续判断实时语音意图；按住说话模式在松手时提交录音；只听节目关闭麦克风，仍可打字提问。手动暂停停止麦克风，语音服务失败不影响原音频的继续播放。
- **围绕节目聊下去**：同一次打断支持多轮对话，Agent 可以检索节目内容和搜索网络。
- **适合听的回答**：简单问题先用两三句话解释，追问再展开；聊超过一分钟时显示打断前已听到的节目原文，帮助接回上下文。
- **延续节目语气**：以节目人物的第一人称视角解释，回答语言跟随用户提问。自动选择偏男声或偏女声的预设声音，不克隆音色。
- **从容续播**：可选回答后等 3 秒、8 秒或手动继续；较长回答至少留 8 秒。倒计时中点击“先别继续”，这一轮追问结束后仍会等你主动继续。说 “continue / go on / 继续” 后约 1.5 秒续播，从语义断点回退开始。
- **歌词式 Transcript**：全文展示、当前段落高亮、自动跟随；聊天自动滚到底部。播放时收起顶部区域，暂停时动画展开。
- **实时语音遥控**：自动模式开始收听时连接 Live，后端通过 sideband 接收语音识别，再沿持续 NDJSON 通道推送控制；旁人聊天不暂停或降音量。按住说话保留录音转写路径。
- **个人 Space（Cloudflare 版）**：通过邮件或 Google 登录，编辑头像、昵称和介绍；左侧查看自己上传的音频，右侧直接使用播放器、逐字稿和该音频的对话记录。上传单篇最长 5 小时、最大 1 GiB，完成后自动分析；每账号每 UTC 日最多 5 篇。

## 🚀 本地启动

需要 **Node.js 24+、npm、FFmpeg（含 ffprobe）**，推荐使用 Chrome。

```bash
npm ci
cp .env.example .env
```

在 `.env` 中填写 `OPENAI_API_KEY`，然后运行：

```bash
npm run dev
```

打开 **http://127.0.0.1:5173**，上传音频，等待分析完成，开始播放并允许麦克风访问。API 默认运行在 `127.0.0.1:4310`。

当前代码使用 `whisper-1` 转录、`gpt-audio-1.5` 分析、`gpt-live-1` 语音交互，以及默认 `gpt-5.6-luna`（reasoning effort `medium`、service tier `priority`）的后端工具调用。运行需要账号具有相应接口和模型权限；模型名称来自本项目配置，不代表所有账号均可使用。

**不调用模型的播放演示（macOS）：**

```bash
npm run demo
```

此命令使用系统 `say` 和 FFmpeg 生成短音频与预制分析。刷新页面即可测试播放和 Transcript；真实 AI 问答仍需要 API Key。

## ⚙️ 常用配置

完整示例见 [`.env.example`](.env.example)。修改后重启开发服务，刷新网页。

| 配置                       | 默认值          | 用途                               |
| -------------------------- | --------------- | ---------------------------------- |
| `ASIDE_BACKEND_MODEL`      | `gpt-5.6-luna`  | 后端问答模型                       |
| `ASIDE_MIC_VAD_THRESHOLD`  | `0.8`           | 本地人声概率阈值，越高越保守       |
| `ASIDE_MIC_VAD_MIN_RMS`    | `0.003`         | VAD 模式的静音过滤底线             |
| `ASIDE_MIC_MIN_SPEECH_MS`  | `120`           | 连续人声达到此时长才打断           |
| `ASIDE_MIC_SILENCE_MS`     | `650`           | 判断一句话结束的静音时长           |
| `ASIDE_AUTO_RESUME_MS`     | `3000`          | 回答结束后的追问等待时间；`0` 禁用 |
| `ASIDE_LIVE_GRACE_MS`      | `5000`          | 续播后保留 Live 会话的时间         |
| `ASIDE_LIVE_IDLE_CLOSE_MS` | `60000`         | 空闲 Live 会话关闭时间             |
| `ASIDE_LIVE_ACCOUNT_SESSION_SECONDS` | `120`（生产 `1800`） | 已登录账号单次 Live 上限，120–3600 秒；游客固定 120 秒。本地服务也使用此配置。 |

页面中的插话方式和续播等待会保存在当前浏览器。选择过续播等待后，它优先于服务端 `ASIDE_AUTO_RESUME_MS`；长回答的延长等待不会覆盖“手动继续”。“开发观察”保留最近 20 次语音回答延迟，区分首次连接和连续追问，计时从本地检测到问题结束至首次回答音频，不包含等待提示。

Live 语音对话不会因静音自动续播：停顿可能是在思考或查询，协议不提供单轮语音完成事件。说“继续播放”或点击“继续收听”才会恢复节目；文字回答仍使用上述续播等待设置。调试中的 `quiet` 只表示当前无声，不能当作回答已完成。

`ASIDE_MIC_VAD_ENABLED=false` 时使用音量检测，此时 `ASIDE_MIC_THRESHOLD` 才是主要触发阈值。建议戴耳机测试，减少节目外放被识别为用户说话。

## 🧩 代码与文档

```text
engine/       领域类型、播放状态机、续播点、上下文与检索规则
backend/      HTTP API、分析任务、模型接入、SQLite 记录与分块音频存储
frontend/     播放器、Transcript、本地麦克风、WebRTC 与交互
scripts/      演示数据、VAD 资源准备、依赖边界检查
tests/        单元/API 测试与浏览器集成测试
.docs/        架构说明、开发指南与设计决策
```

- [架构说明](.docs/architecture.md)：模块边界、分析与问答链路、会话生命周期、存储与限制。
- [Cloudflare 后端](.docs/cloudflare.md)：Workers、D1、R2、Workflows、音频容器与部署步骤。
- [用户账号与个人资料](.docs/accounts.md)：邮件/Google 登录、profile、配置与上线边界。
- [个人 Space](.docs/personal-space.md)：上传、私人音频库、额度与删除清理。
- [开发与验证](.docs/development.md)：运行命令、测试前提、配置和故障定位。
- [服务端语音控制](.docs/server-voice-control.md)：sideband、持续 NDJSON、状态与执行回报、调试和成本边界。
- [播放器配置与遥控底层](.docs/player-controls.md)：播放器级配置、倍速/音量、跳转/重播、暂停与停止，以及后续语音指令接入。
- [ADR 0001 · 初始架构](.docs/adr/0001-interactive-podcast-architecture.md)
- [ADR 0002 · 按需 Live 会话](.docs/adr/0002-on-demand-live-sessions.md)
- [ADR 0003 · 收听与问答状态归属](.docs/adr/0003-listening-and-question-ownership.md)

## 📱 手机端

iPhone 与 Android 原生工程位于 `mobile/`，与网站共享播放和问答运行时。支持本地 Release 安装、Ad Hoc 和 TestFlight 构建配置。环境、签名、后端迁移、模拟器验收及尚需真机验证的边界见[手机端开发与分发](.docs/mobile.md)。

## 🛠️ 验证

```bash
npm test          # 单元与 API 测试
npm run build     # 类型、模块边界检查及前端构建
```

浏览器测试需先生成演示数据并启动开发服务，详见[开发指南](.docs/development.md)。自动化测试覆盖模拟模型响应、真实本地 VAD 和播放交互；不能替代真实语音会话的听感验证。

## 当前边界

本地 Fastify 模式是单用户开发模式。分析任务目前串行执行，长节目需要等待；已完成的分块会缓存，失败后可以重试。多人播客统一使用一个预设声音，人物口吻与语言跟随依赖模型表现。

`.env`、上传音频、分析缓存、数据库、测试产物和生成的 VAD 资源均不进入 Git。音频分析、提问和云端语音交互会将相应内容发送给模型服务；本地 VAD 监听本身不上传音频。Cloudflare 站点已部署匿名试听、账号、profile 与个人 Space；新版 D1 迁移、媒体 Container 和上传开关的发布记录见[生产部署](.docs/deployment.md)。`npm run dev` 仍是单用户 Fastify 开发模式，账号和 Space 的本地验证使用 Cloudflare Worker 模拟环境。

## 📄 License

本项目采用 [Apache License 2.0](LICENSE)。第三方依赖及其模型资源遵循各自的许可证。

### 存储与旧数据迁移

本地持久数据统一在 `.data/aside.sqlite`（可用 `ASIDE_DATA_DIR` 改目录）：节目、逐字稿、分析缓存、问答记录、模型证据和原音频都通过数据库存取。音频按块存储，上传和 Range 播放不需要一次载入整期音频。FFmpeg 只使用运行期间的临时目录。

升级已有项目时，先停止旧后端，再执行一次 `npm run migrate:storage`，然后启动新版本。命令会先备份 SQLite，将旧节目目录中的原音频和处理记录导入数据库，校验音频哈希；可以重复执行，不会覆盖新数据库中已有的记录，也不会删除旧文件。新服务不会回退读取旧目录。新安装无需执行迁移。

云端采用 D1 保存所有文本、分析和状态，R2 保存音频；应用全部 D1 migrations 后再部署。详见 [存储设计与迁移](.docs/storage.md)。
