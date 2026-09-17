# 播放器配置与遥控底层

播放器遥控与人物对话是独立功能。`@aside/engine/player` 提供配置、运行时命令校验和纯计算规则；`ListeningSession` 执行音频操作并协调已有问答的取消。它不依赖人物 profile、模型连接或转录结果，未分析的音频也可执行基础控制。

英文语音遥控复用 GPT-Live 的 client delegation：现有后端工具把意图转换成经过校验的 `PlayerCommand`，通过问答 NDJSON 结果传给前端，再使用同一播放器执行层；不直接操作 DOM 或复制播放状态机。此模块只控制播客原音频，AI 实时语音的语速与重说属于另一条音频链路。

## PlayerConfig

短句输入不再依赖本地 VAD 先触发：Live 转写/委派先到时保留输入，稍后到达的本地起声不取消已有判断。`wait / wait wait / hold on / hang on / pause / stop` 等独立短句可以直接触发后端意图分类，不必等待 Live 委派；前端不按关键词直接暂停，仍由后端结合上下文排除旁人对话。重复暂停短句不会反复取消正在处理的请求，补充不同内容时仍取消过期判断。开发观察（URL 加 `?debug`）记录本地起声、收到转写的字符数、委派和后端判断，不在事件日志里保存原话。

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
| `pause` | 暂停原音频，取消旧问答与续播倒计时，保留已开启的本地监听及精确位置 |
| `stop` | 结束收听，关闭麦克风与语音会话；保留节目位置 |
| `set_rate` / `adjust_rate` | 指定倍速 / 按配置步长相对调速，不自动开始播放 |
| `set_volume` / `set_muted` | 调整原音频音量 / 静音 |
| `seek` | 指定毫秒位置；`playback` 可选 `preserve`、`play`、`pause`，默认保持原播放/暂停状态 |
| `skip` | 按 `direction` 前进或后退；可指定 `amountMs`，默认使用 `seekStepMs`，保持原播放/暂停状态 |
| `repeat` | 定位到当前已开始的语义片段并播放；恰好位于下一片段起点时重播前一片段 |

所有定位都限定在 `[0, episode.durationMs]`。当前的语义 anchor 不保证精确到一句或一个词；没有可用 anchor 时按 `repeatFallbackMs` 回退，绝不选择未来的片段起点。连续重播恰逢边界时可以继续回到前一片段。

`pause` 不会主动开启原本关闭的麦克风，也不把已有语音服务配置变成遥控器的前置条件。`listeningActive` 表示整个收听会话是否开启，`state.mode` 表示节目/问答状态；遥控暂停时可以是 `listeningActive: true`、`mode: "paused"`。主播放按钮保留既有“停止整个收听”的行为，调用 `stop`。进度条定位后暂停，显式使用 `playback: "pause"`；Transcript 的“从这句播放”在定位后开始播放。

定位、重播和遥控暂停会撤销旧转录/问答、静音旧语音输出、清除旧续播锚点并递增播放 revision。迟到回答不能改变新位置。前端手动操作会取消尚未完成的远程判断，避免旧指令覆盖用户的新选择。语音音量与速度调整可在播放中完成。播放器配置在媒体 metadata 加载时重新应用，避免换源后 DOM 默认速度覆盖配置。

## 验证

先写行为测试，再实现命令：`tests/player-config.test.ts` 覆盖校验、上下限、相对调速和重播选择；`tests/listening-session.test.ts` 覆盖设备、问答取消和倒计时的组合；适配器与偏好有独立测试。

```bash
npm test
npm run build
npm run test:player-coverage
```

浏览器验证只需启动前端 `npm run dev -w @aside/frontend`，运行 `npx playwright test tests/browser/player-config.spec.ts`。这组测试用模拟 API 和本地 WAV 验证真实音频元素、倍速菜单、换集与刷新，不需要后端、演示数据或模型 API key。


## Live 遥控链路

自动语音模式在用户开启语音并开始收听时提前建立 GPT-Live 连接，连接就绪后麦克风直接通过 WebRTC 送入 Live，不再为正常连续发言单独调用转写。播放恢复后保留该连接，直到用户停止收听、关闭语音、切节目或离开页面；相较原先按需连接，这会增加按时长计费的 Live 用量。按住说话仍使用录音转写；若自动模式下用户在连接就绪前开口，保留原有 WAV/Whisper 首句兜底，不能保证这条冷启动路径达到增量语音延迟。

`session.input_transcript.delta` 累积到当前输入；`session.delegation.created` 触发现有 question 请求，不等待本地 VAD 的 speech-end。后续有意义的转写增量取消旧请求，并用 120ms 防抖合并后重新判断。委派先于转写到达时，等待转写事件补齐；不重复处理同一委派。用户讲话时记录原始位置、发声对象、播放状态和 turnId，意图判断使用这个快照。

检测到声音只开始一轮输入，不暂停播客，也不降音量。Live 和后端都有明确的对话对象指令：和第三方聊天应保持静默，不能把播客内容、引用、否定句当成命令。后端可以返回 `ignore` 或 `wait`；未被确认是系统输入的文字不展示或写入节目 checkpoint。是否正确理解真实车内对话仍需模型音频评测，自动化替身测试不构成语义准确率保证。未新增自动降音量偏好；当前旁边聊天保持用户原有音量。

### NDJSON 合约

复用 `/api/episodes/:id/question` 和现有 `application/x-ndjson`，不增加独立指令连接。请求可选的 `player` 携带 turnId、source、positionMs、wasPlaying、audibleSource、config；老客户端仍然可以不传。

模型通过 `control_podcast` 返回 1–4 个完整、按顺序执行的指令。服务器在整个指令批次校验通过后立即结束模型工具循环，不再请求模型生成确认话语，直接返回终结事件：

```json
{"type":"result","result":{"revision":7,"action":"player_control","commandId":"turn:call","commands":[{"type":"adjust_rate","direction":"slower"}],"answer":"","sources":[],"tools":["control_podcast"]}}
```

`ignore` 和 `wait` 同样作为 result.action 返回，但没有 commands。`wait` 允许同一轮后续转写继续判断；`ignore` 静默结束本轮。混合请求可以带 `followUpQuestion`：前端先执行遥控，再启动内容问答，避免解释生成阻塞暂停等操作。现有 `answer` / `resume` 结果保持兼容。

前端按完整 NDJSON 行解析并校验 revision。当前节目、会话 epoch、请求取消状态一起拦截迟到结果；commandId 与已处理的当前输入防止重复调速。手动定位、调音量、切节目或停止会撤销旧请求。`repeat` 使用用户开口时的位置选择语义锚点。批次先完整校验再执行；反馈为 dispatched，不会把异步 play() 尚未成功的状态宣称为播放成功。播放器自身的 play() 拒绝仍走已有错误处理。

AI 发言速度与原音频倍速严格区分，前者尚未实现。标准播放调整不需要 spoken confirmation。默认仍由后端模型决定是否忽略无关语音，因此必须评测误触发，而非仅看指令格式有效。

### 验证 Live 遥控

```bash
npm run test:remote-coverage
npx playwright test tests/browser/voice-remote.spec.ts tests/browser/player-config.spec.ts
```

浏览器用真实 AudioWorklet、WebRTC 回环和 `<audio>`，只模拟云端转写/委派事件与后端 NDJSON。测试不会调用付费模型；实际 GPT-Live 委派时机、对话对象判断、否定/改口、回声以及端到端延迟需要真实音频评测。
# Voice debugging

English playback words in a longer or mixed-language utterance now select a backend classification candidate even if Live emits no delegation. The backend still owns addressee/negation/quotation checks and the actual decision; candidate detection never changes playback. Streamed whitespace is preserved. General conversation without playback vocabulary still uses Live delegation. Requests use the existing streaming debounce, without requiring local speech-end.

Open `/episodes/<id>?debug`, then expand **开发观察 / Developer view** below the player. The debug flag survives canonical URL replacement and episode selection. Opening diagnostics never starts playback or requests microphone access.

The panel polls local metadata once a second while expanded:

- `bundle`: the exact frontend asset loaded by the browser.
- `session.status`, `error`: whether voice is off, arming, connecting or on, and the current failure.
- `voice.microphone`: selected device label, track/context state, processed frame count, last frame age, RMS and VAD speech probability. Frames must advance; speech should change RMS. Frame processing alone does not prove the signal contains speech.
- `voice.live`: WebRTC/ICE/data-channel state, outgoing track enablement, bytes/packets sent and source audio energy. Byte counts can increase for silence; compare audio energy and local RMS too.
- `events`: local speech start/end, Live event types, transcript character counts, delegation and backend intent results. Diagnostics do not add transcript text, recording uploads or server-side telemetry.
- With `?debug`, the separate `recognition` trace now shows `liveInputText` (raw input deltas including whitespace, before cold/input gating), `conversationInput` (current conversation turn) and `submittedText` (latest text dispatched for classification). `lastInputDisposition` describes the input gate; `requestPending`, `delegationReceived`, `shortPauseCandidate`, `settled` and `acceptedInput` help interpret dispatch. Ordinary event logs still omit recognition text. The extra trace is opt-in, stays in tab memory, retains the last 4,000 characters and 30 deltas of at most 500 characters each, survives stopping for inspection, and clears on reload, episode change or a new voice connection. It is not added to checkpoints or server logs; accepted conversation history follows its existing behavior. No trace is collected on pages without `?debug`.

Reproduce with the listener explicitly starting playback/voice and saying “Wait, wait” once. Leave the panel open to inspect the changing counters. Local input without transmitted energy points to the transport/input path; transmitted energy without Live input events points further downstream. Synthetic browser tests verify the measurement path and NDJSON controls, not real provider recognition accuracy.
