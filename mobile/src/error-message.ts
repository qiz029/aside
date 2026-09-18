/** Keep the actionable cause visible; a recovery hint must not erase it. */
export function errorMessage(raw: string, locale: string) {
  const zh = locale !== "en";
  const messages: [RegExp, string, string][] = [
    [
      /Network request failed|Failed to fetch|NetworkError|network connection was lost/i,
      "暂时无法连接，请检查网络后重试。",
      "Unable to connect. Check your connection and try again.",
    ],
    [
      /Microphone permission denied|Recording permission has not been granted/i,
      "麦克风权限已关闭。请在设置中允许 Aside 使用麦克风。",
      "Microphone access is off. Allow Aside to use it in Settings.",
    ],
    [
      /session activation failed|failed to change audio state/i,
      "音频会话未能启动，请重试。收听进度已保留。",
      "The audio session couldn't start. Try again; your listening position is saved.",
    ],
    [
      /录音尚未准备好|Hold again after the microphone is ready/i,
      "麦克风还没准备好。请稍候，再按住录音。",
      "The microphone isn't ready yet. Wait a moment, then hold to record again.",
    ],
    [
      /麦克风无法开始录音|Couldn't start the microphone/i,
      "麦克风暂时无法录音，请检查音频输入后重试。",
      "The microphone couldn't start. Check your audio input and try again.",
    ],
    [
      /没有识别到语音|No speech was recognized/i,
      "没有识别到语音，请再按住说一次。",
      "No speech was recognized. Hold to record your question again.",
    ],
    [
      /语音连接启动超时|Voice connection timed out/i,
      "语音连接超时，请检查网络后重新提问。",
      "The voice connection timed out. Check your connection, then ask again.",
    ],
    [
      /Voice session time limit reached|语音连接已断开/i,
      "语音会话已结束。请重新开启语音，或继续听节目。",
      "The voice session ended. Start voice again, or continue listening.",
    ],
    [
      /语音连接中断|Voice disconnected/i,
      "语音连接中断，请重新提问。收听进度已保留。",
      "The voice connection was interrupted. Ask again; your listening position is saved.",
    ],
    [
      /录音无法处理/,
      "录音处理失败，请重新录制。",
      "The recording couldn't be processed. Please record your question again.",
    ],
    [
      /登录已过期/,
      "登录已过期，请重新登录。",
      "Your session has expired. Please sign in again.",
    ],
    [
      /服务暂时不可用|回答失败/,
      "回答服务暂时不可用，请稍后重试。",
      "The answer service is unavailable. Please try again shortly.",
    ],
  ];
  const match = messages.find(([pattern]) => pattern.test(raw));
  if (match) return match[zh ? 1 : 2];
  const cause = raw.replace(/^Error: /, "").replace(/。可以继续听节目.*$/, "");
  // Bilingual native errors already carry an English cause after the slash.
  return cause.includes(" / ")
    ? cause.split(" / ")[zh ? 0 : cause.split(" / ").length - 1]!
    : cause;
}
