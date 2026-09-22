export const CONSENT_VERSION = "2026-09-21";
export const privacyCopy = {
  zh: [
    [
      "隐私与 AI 数据处理",
      "版本：2026-09-21。Aside 保存账号邮箱、昵称、上传的音频、转录、收听进度和问答记录，用于登录、播放、同步和回答问题。",
    ],
    [
      "数据会交给谁",
      "Cloudflare 托管服务和保存数据。上传音频进行分析时，音频片段会发送给 OpenAI 转录和分析；提问时，录音或问题文字，以及相关节目转录和对话上下文会发送给 OpenAI。启用语音意图识别时，转录的发言也可能通过 OpenRouter 发送给 TypeSafe，用于识别暂停、续播或提问意图。",
    ],
    [
      "你的选择",
      "播放已准备好的音频不需要同意 AI 数据处理。上传分析、文字提问和语音对话需要同意。麦克风只在你按住说话或开启随时聊时使用。你可以在「我的」中撤回授权，停止当前语音对话并阻止新的 AI 请求；已经发送的数据无法通过撤回授权收回。",
    ],
    [
      "保存与删除",
      "音频、转录、进度和对话会保存在账号中，直到你删除内容或账号。上传失败时，本机保留文件和上传进度以便重试；取消上传或退出登录会清理待上传的本机文件。删除账号会立即撤销登录并隐藏内容，服务器随后清理文件、记录和登录授权；失败的步骤会自动重试。第三方服务收到的数据受各自的数据保留政策约束。",
    ],
    [
      "联系",
      "可通过项目支持页 github.com/qiz029/aside/issues 联系维护者，请勿在公开反馈中提交私人音频或账号信息。完整说明也可在 asidefm.com/privacy.html 查看。",
    ],
  ],
  en: [
    [
      "Privacy and AI data processing",
      "Version: 2026-09-21. Aside stores your account email, profile, uploaded audio, transcripts, listening progress and conversations to provide sign-in, playback, synchronization and answers.",
    ],
    [
      "Who receives data",
      "Cloudflare hosts the service and stores data. Audio segments are sent to OpenAI for transcription and analysis. Questions send your recording or text, relevant episode transcripts and conversation context to OpenAI. When voice-intent detection is enabled, transcribed speech may also be sent through OpenRouter to TypeSafe to recognize pause, resume or question intent.",
    ],
    [
      "Your choices",
      "Listening to prepared audio does not require AI consent. Upload analysis, text questions and voice conversations do. The microphone is used while you hold to talk or enable hands-free conversation. Withdraw consent in Account to stop the current voice conversation and prevent new AI requests. Withdrawal cannot recall data already sent.",
    ],
    [
      "Retention and deletion",
      "Audio, transcripts, progress and conversations remain in your account until you delete the content or account. Failed uploads retain a local file and progress for retry; cancellation or sign-out clears pending local files. Account deletion immediately revokes sign-in and hides content, then removes files, records and login authorizations. Failed cleanup steps are retried automatically. Data received by third parties is subject to their retention policies.",
    ],
    [
      "Contact",
      "Contact the maintainers through github.com/qiz029/aside/issues. Do not post private audio or account details in public reports. This notice is also available at asidefm.com/privacy.html.",
    ],
  ],
};
