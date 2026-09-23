# 播放器配置与遥控底层

播放器遥控与人物对话是独立功能。`@aside/engine/player` 提供配置、运行时命令校验和纯计算规则；`ListeningSession` 执行音频操作并协调已有问答的取消。它不依赖人物 profile、模型连接或转录结果，未分析的音频也可执行基础控制。

英文语音遥控由后端通过 GPT-Live sideband 持续接收识别片段，再经独立的 NDJSON 长连接推送经过校验的 `PlayerCommand`。前端执行同一播放器操作，不再通过关键词或委派决定是否提交语音判断。协议和限制见[服务端语音控制](server-voice-control.md)。此模块控制播客原音频；AI 实时语音的语速与重说属于另一条音频链路。

## PlayerConfig

配置属于播放器实例，不属于单集节目或人物。`ListeningSession` 构造参数可接收 `playerConfig`，运行时可通过 `configurePlayer(patch)` 原子校验并更新。配置是只读快照，旧快照不会随操作被修改。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `playbackRate` | `1` | 当前播放倍速 |
| `minRate` / `maxRate` | `0.5` / `2` | 倍速上下限，可在产品支持的 0.5–2 范围内收窄 |
| `rateStep` | `0.1` | “慢一点/快一点”每次调整量，支持 0.01–1 |
| `volume` | `1` | 原音频音量，0–1 |
| `muted` | `false` | 原音频静音，不改变音量数值，也不关闭麦克风 |
| `preservesPitch` | `true` | 调整倍速时保留音高 |
| `seekStepMs` | `10000` | 未指定时长的前进/后退步长 |
| `repeatFallbackMs` | `10000` | 无已开始的语义片段时，重播回退时长 |

直接修改配置时，非法类型、未知字段、非有限数值、不一致的速度上下限会被拒绝，不改变当前配置。`set_rate` 命令接受正的有限数值，并夹在已配置上下限内；`adjust_rate` 相对于当前速度调整。静音和音量独立，设置音量不会自动解除静音。

```ts
const session = new ListeningSession(audio, backend, {
  mode: "off", // 纯播放器也可使用
  playerConfig: {
    playbackRate: 1,
    rateStep: 0.1,
    seekStepMs: 10000,
    repeatFallbackMs: 10000,
  },
});

session.configurePlayer({ playbackRate: 0.8, preservesPitch: true });
session.executePlayerCommand({ type: "adjust_rate", direction: "slower" });
session.executePlayerCommand({ type: "skip", direction: "backward", amountMs: 10000 });
session.executePlayerCommand({ type: "repeat" });
session.executePlayerCommand({ type: "pause" });
session.executePlayerCommand({ type: "play" });

const { playerConfig, state } = session.getSnapshot();
```

浏览器通过 `aside.playerConfig.v1` 保存完整配置。刷新、换集和音频元素重新挂载时复用；损坏或不可用的 localStorage 回退到默认配置。配置不写进单集 checkpoint，也不跨设备同步。React 的倍速菜单、音量滑条和静音按钮读取同一快照。倍速支持显示相对调速产生的 0.9 等非预设速度；音量显示百分比，静音时显示明确状态。音量滑条支持键盘操作，静音后调整音量仍保持静音，取消静音时使用当前音量。前后定位沿用 Transcript 和进度条，不另加跳转按钮。

## 命令语义

| 命令 | 行为 |
| --- | --- |
| `play` | 播放；已有问答打断点时沿用自然续播规则 |
| `pause` | 暂停原音频，取消旧问答与续播倒计时，保留已开启的本地监听及精确位置；语音指令触发时先淡出再停，见“让位” |
| `stop` | 结束收听，关闭麦克风与语音会话；保留节目位置 |
| `set_rate` / `adjust_rate` | 指定倍速 / 按配置步长相对调速，不自动开始播放 |
| `set_volume` / `set_muted` | 调整原音频音量 / 静音 |
| `seek` | 指定毫秒位置；`playback` 可选 `preserve`、`play`、`pause`，默认保持原播放/暂停状态 |
| `skip` | 按 `direction` 前进或后退；可指定 `amountMs`，默认使用 `seekStepMs`，保持原播放/暂停状态 |
| `repeat` | 定位到当前已开始的语义片段并播放；恰好位于下一片段起点时重播前一片段 |

所有定位都限定在 `[0, episode.durationMs]`。当前的语义 anchor 不保证精确到一句或一个词；没有可用 anchor 时按 `repeatFallbackMs` 回退，绝不选择未来的片段起点。连续重播恰逢边界时可以继续回到前一片段。

`pause` 不会主动开启原本关闭的麦克风，也不把已有语音服务配置变成遥控器的前置条件。`listeningActive` 表示整个收听会话是否开启，`state.mode` 表示节目/问答状态；遥控暂停时可以是 `listeningActive: true`、`mode: "paused"`。主播放按钮保留既有“停止整个收听”的行为，调用 `stop`。进度条定位后暂停，显式使用 `playback: "pause"`；Transcript 的“从这句播放”在定位后开始播放。

定位、重播和遥控暂停会撤销旧转录/问答、静音旧语音输出、清除旧续播锚点并递增播放 revision。迟到回答不能改变新位置。前端手动的播放、暂停、定位和换集会取消尚未完成的远程判断，避免旧指令覆盖用户的新选择；手动改倍速、音量或静音只改配置，不取消续播倒计时、进行中的回答或待执行的远程判断（2026-09-22 起）。语音音量与速度调整可在播放中完成。播放器配置在媒体 metadata 加载时重新应用，避免换源后 DOM 默认速度覆盖配置。

## 让位：软让位与硬让位

真人被打断时不会硬生生停住，而是先收一收，确定对方是在跟自己说话再停下。播放器把这个过程拆成两段，参数在 `player-runtime/src/listening-session.ts` 的 `attention` 常量里：

| 阶段 | 触发 | 动作 |
| --- | --- | --- |
| 起声停顿 | 服务端控制下本地检测到有人开口（Web）；移动端同一时刻只降到 15% | Web 立即停住播客（仍是软让位，播放状态不变）；移动端 150ms 内降音 |
| 软让位 | 服务端控制流推送 `classifying`（后端开始判断）；旧的客户端委派路径在收到 Live 委派时 | 150ms 内把播客降到用户音量的 60%，波形同步缩小 |
| 释放 | 决定为 `ignore`；只改配置的遥控批次执行完；手动操作或取消工作；2.5 秒内没有新的判断或决定 | 降音的 300ms 回到原音量；停住的 400ms 淡入继续 |
| 硬让位 | 决定为提问（`answer`）、文字提问、按住说话、语音 `pause` 指令 | 250ms 淡出到静音再暂停 |

`observing`（只是收到片段）不改变让位深度，只更新界面上"在听你说"的临时字幕。`wait` 保持软让位，由保持超时回升。打断位置仍取开口时刻的 `input.positionMs`，淡出多播的几百毫秒不计入续播锚点；语音 `pause` 在淡出结束后把位置退回指令时刻。

浏览器的 `BrowserPodcastAudio` 在 MediaElementSource 和分析器之间插入一个 GainNode 承载让位倍率，用 `linearRampToValueAtTime` 平滑；用户音量继续走 `element.volume`，两者独立。AudioContext 尚未接入时退化为分步调整 `element.volume`，接入后把当前倍率交给 GainNode。移动端的 `NativePodcastAudio` 用分步调整 `player.volume` 实现同一接口。`play()`、`pause()`、换元素或新的 `settle()` 都会作废未完成的淡出；淡出期间忽略新的软让位。手动按钮的暂停和进度条定位仍然立即切断。

后端接下提问（`engage`）时，Web 播放一声很轻的双音提示（`frontend/src/earcon.ts`），让听众在回答开口前就知道被听懂了；移动端暂无（需要加原生触感依赖）。

## 续播：位置与淡入

续播回到打断时所在语义段落的起点，但最多回退 12 秒（`engine/src/core.ts` 的 `resumePoint` 与 `maxResumeRewindMs`）：段落更长时从 12 秒内最早的文稿句首继续，12 秒内没有句首则正好回退 12 秒。聊完续播和起声停顿后的继续都以 400ms 从静音淡入（`resumeFadeMs`，`PodcastAudio.play(fadeInMs)`）。

## 验证

先写行为测试，再实现命令：`tests/player-config.test.ts` 覆盖校验、上下限、相对调速和重播选择；`tests/listening-session.test.ts` 覆盖设备、问答取消和倒计时的组合；适配器与偏好有独立测试。

```bash
npm test
npm run build
npm run test:player-coverage
```

让位的单元测试在 `tests/listening-session.test.ts`（委派和服务端 `classifying` 降音、忽略回升、保持超时、配置指令释放、确认后淡出、语音暂停）和 `tests/podcast-audio.test.ts`（未接入 Web Audio 时的分步淡出、淡出被播放/暂停/换元素作废、GainNode 接线）。GainNode 曲线和听感需要在真实浏览器里戴耳机验证；移动端适配器只有类型检查。

浏览器验证只需启动前端 `npm run dev -w @aside/frontend`，运行 `npx playwright test tests/browser/player-config.spec.ts`。这组测试用模拟 API 和本地 WAV 验证真实音频元素、倍速菜单、换集与刷新，不需要后端、演示数据或模型 API key。


## Live 遥控链路与诊断

完整协议见[服务端语音控制](server-voice-control.md)。打开 `/episodes/<id>?debug` 并展开开发观察：

- `control.owner: server` 表示后端拥有意图判断；`control.status` 显示连接、接收片段、判断和决定。
- `Live heard` 是浏览器收到的 Live 字幕；`Backend received` 是 sideband 收到的累计文本；`Backend classifying` 是实际送入模型的文本。
- 事件依次显示 `Server voice control NDJSON connected`、`Backend sideband transcript received`、`Backend intent classification started`、`Backend intent: ...`、`Backend decision applied: ...`。
- 麦克风 RMS、帧数、轨道状态、WebRTC 字节和音频能量仍用于检查采集与发送。字节增加本身不能证明有语音。

面板不会开启设备或播放音频。额外识别文本只在 `?debug` 时通过控制流显示，不写入 checkpoint 或服务端日志；事件日志只记录状态。服务端会话中的识别文本仅保留在有界内存里，用于判断，关闭时释放。被接受的对话沿用已有历史保存逻辑。
