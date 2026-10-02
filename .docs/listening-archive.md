# 个人收听档案（后端）

实现位于 Cloudflare Worker + D1。与现有 `checkpoints` 分开：checkpoint 是可覆盖的恢复状态，archive 是用户主动删除前保留的收听和对话记录。

本阶段只提供后端接口和共享请求类型。Web/iOS 尚未调用这些接口，现有 checkpoint 不会自动导入，也不会因此开始记录历史。下一步在播放器接入上报后，才会实际产生档案。此模块不调用 AI，不生成 ideas；`context` 为后续提炼提供有出处的素材。

## 权限与数据生命周期

- 全部接口要求现有网页登录 cookie 或 iOS Bearer token；游客返回 401。owner 只从认证上下文获取，请求不能指定其他用户。
- 只能写入、读取当前可访问的节目。公共节目上的个人档案也严格按账号隔离。
- 清空当前聊天、更新 checkpoint 不删除档案。用户可删除单个 conversation，或删除某节目的所有收听和对话记录。
- 删除节目会清理相关档案；删除账号会清理其所有档案，包括公共节目上的记录。外键级联负责删除 conversation turns。
- 与短期用量统计不同，档案不受 usage 定时清理影响。原始麦克风音频不在此保存。
- 存储和查询不发送数据给 AI 供应商。后续新增 AI 提炼时，需沿用已有 AI 授权、额度与移动端 consent 检查。

## 播放器接入约定

### 交互不得等待记录

当前数据库操作使用异步 I/O，但记录接口仍然等 D1 写入成功后才返回 200/201，便于客户端可靠确认。它没有接入播放、问答或实时语音请求链，也没有实现客户端后台队列。因此不能把当前状态描述成已经完成端到端异步记录。

后续 Web/iOS 接入必须满足以下约束：

- 播放、暂停、跳转、开始问答、展示回答及恢复播放都不得 `await` 档案请求，也不得等待本地持久化完成。交互逻辑只提交轻量记录到独立队列后继续。
- 队列在后台异步持久化、发送，按 15–30 秒周期提交收听片段，避免逐帧或逐字幕发请求。限制队列大小和并发，限制单次序列化工作量；记录失败不能触发播放器 loading、错误弹窗或语音会话重置。
- 网络发送设置超时；离线、超时、429、5xx 使用带随机抖动的退避重试，保留原 ID 与正文直到得到成功确认。401/403 停止该账号的发送，其他永久性 4xx 不无限重试。conversation 创建成功后才发送其 turns，但用户问答不等待这个顺序。
- 队列严格按账号隔离；退出登录、切换账号或主动删除档案时取消相应请求并清理待发记录，防止误归属或删除后重新上传。页面关闭的发送仅为尽力尝试，不能视为已保存。
- 不把数据库写入简单改成无持久队列保障的服务端后台任务并提前返回“已保存”。记录接口可以等待落库，用户交互不能等待该接口。

接入验收必须覆盖：记录请求持续挂起或失败时播放和问答仍可继续；重复重试不增加记录；慢网下队列有界；账号切换与删除不会重放旧记录。当前这些客户端行为尚未实现或验证。

### 上报内容

1. 仅登录期间采集，上报队列按账号隔离；退出登录后停止采集。不能把游客记录或上一个账号的队列发到新账号。
2. 每次收听生成 `sessionId` UUID。同一段持续可听的播客播放生成一条 event，event 的 UUID 和正文在重试时保持不变。
3. 建议每 15–30 秒上报一次。暂停、跳转、切换节目、助手开始说话、关闭播放器时结束当前片段；跳过的时间和助手说话期间不能算作听过。
4. `startMs/endMs` 是播客媒体坐标，`startedAt/endedAt` 是客户端 Unix 毫秒时间。同一片段不超过五分钟实际时间。倍速播放的媒体跨度与实际时间可不同。
5. 每次“新对话”生成新的 conversation UUID。只提交最终完成或中断的 turn，保留用户/助手角色、文字、节目位置、来源及回答引用。部分流式内容不上传；语音中断只上传已确认展示/听到的文字。
6. turn `sequence` 从 0 递增，不能复用。允许网络乱序送达；读取按 sequence 排序。稳定 UUID + 相同正文重试返回 200，首次写入返回 201；改写相同 ID 或占用相同 sequence 返回 409 `archive_conflict`。

所有写入受 256 KB 请求上限约束。时间位置不能超过节目长度。客户端时间最多允许领先服务端一分钟；离线上报允许历史时间。上报时间和播放片段是客户端报告的数据，不能用作计费或可信行为证明。

## 接口

请求类型从 `@aside/engine/contracts` 导出：`ListeningEvent`、`ArchivedConversation`、`ArchivedTurn`，以及对应的 Zod schemas。

| 方法与路径                                                                              | 用途                                                                 |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `PUT /api/space/listening/events/:eventId`                                              | 保存一个连续收听片段，幂等                                           |
| `GET /api/space/listening?limit=20&cursor=...`                                          | 按最近收听时间列出节目、首次/最近收听时间、累计实际时间及 session 数 |
| `GET /api/space/listening/:episodeId?limit=20&before=...`                               | 按接收顺序倒序分页读取原始 events                                    |
| `GET /api/space/listening/:episodeId/context?startMs=0&endMs=300000&limit=20&after=...` | 获取指定媒体窗口内的已听范围、相关转录原文与对话 turns               |
| `DELETE /api/space/listening/:episodeId`                                                | 删除自己在此节目的全部 archive events、conversations 和 turns        |
| `PUT /api/space/conversations/:conversationId`                                          | 创建独立 conversation，幂等                                          |
| `GET /api/space/conversations?episodeId=...&limit=20&before=...`                        | 分页列出 conversations，episodeId 可省略                             |
| `GET /api/space/conversations/:conversationId?limit=20&afterSequence=...`               | conversation 元数据与按 sequence 递增的 turns                        |
| `PUT /api/space/conversations/:conversationId/turns/:turnId`                            | 保存最终 turn，幂等                                                  |
| `DELETE /api/space/conversations/:conversationId`                                       | 删除 conversation 及其全部 turns                                     |

分页字段分别为 `nextCursor`、`nextBefore`、`nextAfter`、`nextAfterSequence`，末页为 null。`limit` 为 1–100。conversation 的 `afterSequence=0` 有效，不能用真假值判断是否有下一页。最近收听列表是实时视图，并发新增收听时可能调整排序。

收听上报示例：

```json
{
  "episodeId": "episode-id",
  "sessionId": "ab1940bb-ff9d-48a2-9c81-8e6277607f57",
  "startedAt": 1790884800000,
  "endedAt": 1790884815000,
  "startMs": 30000,
  "endMs": 45000
}
```

conversation 创建示例：

```json
{ "episodeId": "episode-id", "atMs": 45000 }
```

turn 示例：

```json
{
  "sequence": 0,
  "role": "user",
  "text": "这里提到的方法，能不能用于我的项目？",
  "atMs": 45000,
  "source": "voice",
  "status": "completed",
  "sources": []
}
```

`sources` 可包含 `{text, startMs?, url?}`。每条 turn 最多 12,000 字符、20 个引用。`status` 为 `completed` 或 `interrupted`。

## Ideas 素材语义

`context` 的窗口最长五分钟，默认从 0 开始到五分钟或节目末尾。返回：

- `episode`：节目元数据及已有的 podcast/attribution 来源。
- `heardRanges`：当前窗口内已听媒体范围的并集，重复收听不会放大覆盖范围。
- `passages`：仅包含与已听范围重叠的转录句子，保留 passage ID 和时间戳。每句附带 `heardRanges` 和 `fullyHeard`。句子只听了一部分时，完整句子只是上下文，不能声称整句已听过。
- `transcriptState`：`processing`、`complete` 或 `failed` 等状态；转录仍在处理时返回当前已有内容，不把缺失原文当成空白节目。
- `turns`：媒体位置处于窗口内的个人对话，附带 conversation ID、turn ID、sequence 和引用。窗口对 turns 包含左右端点，因此可查询节目结束位置的提问。
- `nextAfter`：对话按接收顺序分页，继续使用相同时间窗口；每页重复返回该窗口的原文与覆盖范围。客户端按 conversation ID + sequence 组织对话。

`listenedMs` 是已接收事件的实际播放时间之和，包含重听，并非去重的媒体覆盖时长。此接口不推断“拖到末尾等于全部听完”。

## 本地验证与发布顺序

```sh
npm run check
npm run test:cloudflare
```

本地联调使用 `npm run db:cloudflare:local` 后 `npm run dev:cloudflare`，因为账号体系位于 Worker；无登录的 Fastify 开发服务没有新增个人档案接口。

发布时先应用 `0013_listening_archive.sql`，再发布 Worker。迁移仅新建表和索引，不改写既有 checkpoint，也不回填游客或旧会话数据。本次开发未部署生产环境。
