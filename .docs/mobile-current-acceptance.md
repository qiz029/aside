# 当前移动端验收索引 — 2026-09-18

目标仍为“覆盖所有的差距，然后让我来验收”。本表把原跨端计划与持续对话要求
映射到已有证据，不能用编译成功、模型 fixture 或历史构建代替未完成的验收。
历史记录中的旧版本和旧阻塞应结合本表及[当前交付记录](continuous-mobile-delivery.md)阅读。

## 当前交付

- iPhone：本地签名 Release 43，已通过局域网安装并启动；设备信息确认版本 43，嵌入 JS，生产 API，测试标记与 OTA 关闭。
- Android：[EAS 20](https://expo.dev/accounts/jiahangzhang/projects/aside/builds/3af84051-5f8f-4436-b02d-4c6a56b56392)，固定签名密钥；从 19 覆盖更新成功，线上公开库、逐字稿与账号页检查通过。
- PR 已合入 main `bdc90b1`，437 项应用测试、51 项 Cloudflare 集成测试及类型检查通过。本次未部署：main 的最新[发布记录](deployment.md)为 Worker `6d2870f2`，不含尚未合并的移动端后端；此前 `bb4dd397` 已成为历史记录。现有 iPhone 43 / Android 20 安装包仍来自 `2f7466b`。
- [PR #29](https://github.com/qiz029/aside/pull/29) 仍为草稿。[UI 修复代码 CI](https://github.com/qiz029/aside/actions/runs/35328473929)通过，包含 425 项应用测试、类型检查、Cloudflare 与媒体容器验证。
- `2f7466b` 精简原生提问工具栏，并修复最大字号下音频库及选项的可达性。双端本地候选为 42；[本轮证据](mobile-evidence/compact-ui-2026-09-18.json)区分原生 fixture 与生产包。后端和 Web 产品源码未在这次 UI 修复中改变。

## 功能与证据

| 要求 | 已确认的证据 | 尚未证明或待交验 |
| --- | --- | --- |
| 网站保留、原生独立运行、共享平台无关运行时 | 当前 Web 产品源码与 main 一致；类型和模块边界检查；[构建与签名配置](mobile.md)、[当前包验证](mobile-evidence/continuous-noise-2026-09-18.json) | 无新增工程缺口；不把模拟器包当作可分发包 |
| 邮箱登录、同一业务账号、安全存储、退出与私有资源隔离 | 用户已确认真机邮件登录；当前 CI 覆盖 Cookie/Bearer 隔离、到期、撤销、私有 Range；既有原生登录与断网恢复证据见 [历史验收](mobile-acceptance.md) | 本轮未再发真实邮件；退出和到期场景的原生证据来自较早版本 |
| 音频库、公开与私人音频、逐字稿、后台分析状态 | 当前 Android 20 线上公开库/逐字稿/Account 检查；双端私人上传与播放记录 | 未重复收费的真实长节目分析 |
| 文件上传、进度、取消、重试、后台取消、大小/时长/额度限制 | 双端原生文件选择和延迟上传取消/重试；[真实媒体容器验证](mobile-evidence/release-media-container.txt)；当前 Cloudflare 限制与隔离回归 | 首版前台上传；没有离线下载能力要求 |
| 按住录音、首次授权、松开提交、滑出取消、30 秒上限、M4A 解码 | 双端原生流程；实际录音约 29.5 秒并自动提交；媒体容器拒绝非法和超时文件；[已提交问题持久化](mobile-evidence/submitted-questions-2026-09-17.md) | fixture 转写无法证明所有真实口音/环境的识别质量 |
| 开启持续监听、节目播放时输入保持连接、可见状态与音量 | 双端真实 RTC 输入/输出、原生状态观察；用户已明确确认 iPhone 外放提问工作 | Android 真实麦克风质量与不同物理音频路由仍需用户验收 |
| 人声压低节目，模型接纳后暂停，忽略旁人后恢复音量 | 双端 [连续对话回归](mobile-evidence/continuous-noise-2026-09-18.json)；已有真实外放确认 | fixture 决策不代表生产意图识别准确率 |
| 委派、鉴权控制流、执行回执、过期事件隔离 | 当前 Web/mobile Worker sideband 回归；[旧工具回执修复](mobile-evidence/continuous-stale-tools-2026-09-18.json)覆盖手动操作、新话语和会话关闭 | 不能取消供应商已经产生的费用 |
| 回答音频前缀、字幕随实际输出、缓冲上限、连续追问与固定锚点 | C/Java 原生 PCM 样本测试、双端 RTC 验收、共享运行时的打断和迟到回调测试 | 正在播出的单路音频中混入另一供应商回复，仍无法逐条过滤；回答通道选择待用户回复 |
| 回答播完后 3 秒，长回答至少 8 秒；“先别继续”持续；不明结束时手动续播 | 双端原生 drain 后计时；长回答约 8.05/8.23 秒；[措辞变体回归](mobile-evidence/continuous-variants-2026-09-18.json)约 3.00/3.10 秒；思考、草稿、后台工作及显式 hold 均有运行时回归 | 自然口语续播意图、真实追问体验仍待交验；不能以后台文本完成替代音频完成 |
| 文字发送清空、逐步显示回答、已有语音连接可朗读、纯文字不新建语音 | 双端 42 使用唯一问题匹配运行时的新回答，发送后及重新展开均为空；收起未发送文字会保留草稿；已有流式回归 | 外部模型输出为 fixture；这次输入交互由实际原生界面验证 |
| 后台/锁屏节目播放与控制；后台问答停止采集 | 双端各 1,802 秒原生后台播放；Android 系统媒体控制；iOS 原生 pause/play 与 Now Playing 状态；后台取消和重新前台不自动开麦 | iOS 模拟器不呈现锁屏卡片，独立 AVPlayer 探针也如此；可见卡片仍需真机 |
| 来电、耳机断开暂停；网络失败不自动重发付费问题 | [Android 模拟 GSM 来电](mobile-evidence/continuous-stale-tools-2026-09-18.json)：系统录音器释放、历史/锚点保留、返回后保持关闭；网络和会话恢复测试 | iOS 电话、物理耳机/蓝牙路由仍需实际设备；Android 模拟电话不能代替这些情况 |
| 进度、完整对话、前后台同步、版本冲突明确选择 | 本轮把 Android 的 16 条消息逐条恢复到当前 Web；两种冲突选择后历史不变；iOS 重启恢复同一最新问答与 1:30 进度。[本轮证据](mobile-evidence/current-cross-device-2026-09-18.json) | 本轮跨端 UI 使用本地实际 Worker/D1；线上只读检查确认验收账号的 16 条问题、12 条回答持久化，未冒充新的生产 UI 端到端测试 |
| 中英文、深浅色、键盘、大字、小屏、错误与录音反馈 | 提问入口收拢为工具栏；双端 42 草稿、发送、录音取消及键盘上方关麦通过；SE 最大辅助字号修复固定标题挤压列表和选项面板溢出，滚动选项、选中状态与关闭按钮均验证 | 审美最终由用户验收；辅助标签有缩放上限，阅读正文保留系统大字；证据含正常字号与最大字号的不同构建范围 |
| 测试、真实服务一次闭环、分发、分支与 PR | 当前代码 CI；实际用户外放成功与已保存的云端问答；iPhone 43 / Android 20、现有 PR 与生产发布记录 | 不把合成模型回归称为新增真实模型测试；PR 暂不标记 ready |
| iOS local/internal/testflight 同时维护；Android 可直接分发 | 三渠道配置与独立构建/上传命令；Personal Team 真机签名已用；Android 固定证书更新已验证 | 付费 Apple Ad Hoc / TestFlight 签名及网络安装仍待账号审批；不是当前 local install 的阻塞 |

## 本轮界面实证

完整问答逐条比对通过；以下截图来自安装的原生 App 和当前 Web，内容为验收 fixture。

- [iOS 重启恢复最新问答和 1:30 进度](mobile-screenshots/current-ios-restored-conversation.png)
- [Web 完整历史和冲突选择后的进度](mobile-screenshots/current-web-restored-conversation.png)
- [iOS 小屏、大字与键盘](mobile-screenshots/continuous-ios-small-dark-large-keyboard.png)
- [Android 深色对话与控制区](mobile-screenshots/continuous-android-latest-answer.png)

最新 UI 修复后的原生截图：

- [iOS 提问工具栏](mobile-screenshots/compact-ios42-player.png) / [监听时展开键盘](mobile-screenshots/compact-ios42-keyboard-listening.png)
- [Android 提问工具栏](mobile-screenshots/compact-android42-player.png) / [监听时展开键盘](mobile-screenshots/compact-android42-keyboard-listening.png)
- [Android 20 生产音频库](mobile-screenshots/compact-android20-production-library.png) / [生产逐字稿与工具栏](mobile-screenshots/compact-android20-production-episode.png)
- [SE 最大字号](mobile-screenshots/compact-ios42-small-dark.png) / [可滚动的选项和固定关闭按钮](mobile-screenshots/compact-ios42-small-options.png)

### 剩余决定与验收

回答通道的产品取舍已经单独询问：保留现有 Live 体验并承认供应商单路音频边界，
或改造回答通道以取得每条回答的明确音频边界。尚未收到答复，不默认缩减目标，
也不默认替换已经认可的声音体验。真机音频路由、iOS 可见锁屏卡片和上表列出的
质量项继续开放。目标未完成。
