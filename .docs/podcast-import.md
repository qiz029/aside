# RSS 导入与增量文字稿

## 用户路径

iOS：Apple Podcasts 单集分享 → Aside 分享扩展保存链接 → 用户打开 Aside → 登录并同意现有数据处理说明后自动导入、播放。普通 Share Extension 不主动唤起主 App；扩展只把链接写入 App Group，不包含登录凭据。也可以在资料库粘贴单集链接并点“导入并收听”。失败保留链接供重试。

服务端 `POST /api/podcasts/import` 接收 `{url}`。Apple lookup 提供节目 RSS 和单集 GUID；仅按 GUID 或 enclosure URL 精确匹配。分享链接 `t` 参数保留为起播位置，没有该参数时沿用 Aside 自己的收听进度。节目主页、订阅专享内容、已从公开 RSS 移除的单集不猜测替代项。

解析到音源即可播放。iOS 直接读取公开音源且不转发 Aside 授权头；Web 经同源音频代理支持 Range 和音频分析器。网络解析、音源缓冲仍需要时间，“立即播放”表示不等待下载整集或完成 AI 分析。

## 文字稿

优先使用 RSS `podcast:transcript` 提供的 VTT / SRT；可用时直接构造带时间戳文字稿，无需音频转写。无文字稿、下载失败或时间戳不适配时，后台下载音频后走既有转写流程。Apple App 内显示的文字稿不代表 RSS 必然提供同一份文件。

Web 和 iOS 均可在转写、语义分析甚至分析失败时播放和提问。服务端以已提交分块计算覆盖范围，包括没有语音的空片段；不会用最后一句时间戳推断整段完成。工具每次读最新文字稿，缺段时提高所问时间点的待处理分块优先级，已有运行任务不抢占。等待最多 20 秒后返回现有文本、缺失范围和状态。普通知识问题不必调用文字稿工具。

RSS 文字稿没有经过原有声音/语义分析，因此采用默认声音且没有预生成语义锚点。不同地区的动态广告可能改变音频版本与时间轴；当前只检查字幕时间戳是否合法、是否超出节目时长，不保证逐字对齐。

## 运行与验证

- iOS prebuild 插件 `with-podcast-share.cjs` 生成 `PodcastShare` 目标与 App Group：`group.<主 App bundle id>`。发布签名必须为主 App 和扩展启用相同 App Group；扩展 bundle id 为 `<主 App bundle id>.PodcastShare`。
- 云端沿用 `ALLOW_UPLOADS` 和账号权限，限制每天每账号 5 次、全站 200 次导入请求。并发相同单集在同一账号去重。导入先预留最多 256 MiB，下载成功改为实际大小，直接使用发布者文字稿则释放预留；与上传共用空间额度，删除清理后释放。
- 音频下载上限 256 MiB，时长沿用 5 小时限制。云端要求音源返回 Content-Length；不满足时仍可听，后台转写显示失败。RSS / 字幕分别限制为 8 MiB。服务器检查公开域名、DNS 地址与每一跳重定向，不向发布者发送用户凭据。
- `tests/progressive-transcript.test.ts`、`tests/live-delegation.test.ts` 覆盖动态读取与会话取消；`tests/podcast-import.test.ts` 覆盖 RSS 匹配、字幕和资源读取；Cloudflare 集成测试覆盖实际 API、账号隔离、去重、存储和发布者文字稿复用。
- `tests/browser/progressive.spec.ts` 覆盖未完成分析时的播放/问答，以及文字稿更新后对话保留。iOS 的原生分享入口仍需真机分享、登录/授权、前后台切换与实际音源播放验收；模拟器编译不能替代这些验收。
