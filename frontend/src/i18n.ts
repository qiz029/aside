import { useSyncExternalStore } from "react";
export type Locale = "zh" | "en";
export function resolveLocale(
  languages: readonly string[],
  saved?: string | null,
): Locale {
  if (saved === "zh" || saved === "en") return saved;
  for (const language of languages) {
    const base = language.toLowerCase().split(/[-_]/)[0];
    if (base === "zh" || base === "en") return base;
  }
  return "en";
}
/**
 * The path prefix outranks the browser and the saved preference: a shared
 * `/zh` link has to stay Chinese for whoever opens it.
 */
export function localeFromPath(pathname: string): Locale | undefined {
  if (pathname === "/zh" || pathname.startsWith("/zh/")) return "zh";
  if (pathname === "/en" || pathname.startsWith("/en/")) return "en";
  return undefined;
}
function preference() {
  try {
    return localStorage.getItem("aside.locale");
  } catch {
    return null;
  }
}
const pathLocale =
  typeof location === "undefined"
    ? undefined
    : localeFromPath(location.pathname);
let locale =
  pathLocale ??
  resolveLocale(
    typeof navigator === "undefined"
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language],
    preference(),
  );
const listeners = new Set<() => void>();
export function getLocale() {
  return locale;
}
/** The indexable URL of the current interface language. */
export function homeHref(next: Locale = locale) {
  return next === "zh" ? "/zh" : "/";
}
export const titles: Record<Locale, string> = {
  zh: "Aside · 用语音打断播客，随口提问接着听",
  en: "Aside · Interrupt a podcast, ask out loud, keep listening",
};
export const descriptions: Record<Locale, string> = {
  zh: "Aside 是一个可以插话的播客播放器：听到好奇的地方开口提问，AI 结合前文回答，聊完从完整的一句话接着听。",
  en: "Aside is a podcast player you can talk back to: interrupt an episode to ask by voice, keep the conversation going, and resume from a complete sentence.",
};
const spaceTitles: Record<Locale, string> = {
  zh: "我的空间 · Aside",
  en: "Your space · Aside",
};
const indexRobots =
  "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1";
function setMeta(selector: string, content: string) {
  const element = document.head.querySelector(selector);
  if (element) element.setAttribute("content", content);
}
const site = "https://asidefm.com";
/**
 * Each public route carries its own canonical. `/space` has none: it is private
 * and asks not to be indexed.
 */
export function canonicalFor(pathname: string): string | undefined {
  if (pathname === "/space" || pathname.startsWith("/space/")) return undefined;
  const episode = /^\/episodes\/[a-zA-Z0-9-]+/.exec(pathname);
  if (episode) return site + episode[0];
  if (pathname === "/zh" || pathname.startsWith("/zh/")) return `${site}/zh`;
  return `${site}/`;
}
function updateDocument() {
  if (typeof document === "undefined") return;
  const zh = locale === "zh";
  // The signed-in space is private: keep it out of the index and drop the
  // landing canonical so the two pages never claim the same URL.
  const privatePage = location.pathname === "/space";
  document.documentElement.lang = zh ? "zh-CN" : "en";
  document.title = privatePage ? spaceTitles[locale] : titles[locale];
  setMeta('meta[name="description"]', descriptions[locale]);
  setMeta('meta[property="og:title"]', titles[locale]);
  setMeta('meta[property="og:description"]', descriptions[locale]);
  setMeta('meta[property="og:locale"]', zh ? "zh_CN" : "en_US");
  setMeta('meta[property="og:locale:alternate"]', zh ? "en_US" : "zh_CN");
  setMeta('meta[name="twitter:title"]', titles[locale]);
  setMeta('meta[name="twitter:description"]', descriptions[locale]);
  setMeta(
    'meta[name="robots"]',
    privatePage ? "noindex, nofollow" : indexRobots,
  );
  const canonical = document.head.querySelector('link[rel="canonical"]');
  const href = canonicalFor(location.pathname);
  if (!href) canonical?.remove();
  else if (canonical) canonical.setAttribute("href", href);
}
updateDocument();
export function setLocale(next: Locale) {
  locale = next;
  try {
    localStorage.setItem("aside.locale", next);
  } catch {
    /* Private browsing can disable storage. */
  }
  // Language is part of the address on the landing page, so switching it keeps
  // the URL and the interface in step. Episode and space pages have one URL.
  if (typeof location !== "undefined") {
    const path = location.pathname;
    const onHome =
      path === "/" || path === "/zh" || path === "/en" || path === "";
    if (onHome && path !== homeHref(next))
      history.replaceState(
        null,
        "",
        `${homeHref(next)}${location.search}${location.hash}`,
      );
  }
  updateDocument();
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useLocale() {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}
export const english: Record<string, string> = {
  另一台设备更新了进度: "Another device updated your progress",
  继续本机: "Keep this device",
  接着另一设备听: "Use other device",
  中文: "Chinese",
  英文: "English",
  收起详情: "Close details",
  "打开音频库，选择一段开始收听":
    "Open your library and choose something to listen to.",
  音频库: "Library",
  "对话发生过，": "Recorded then.",
  "你依然可以加入。": "Your turn now.",
  "让聆听，多一种可能。": "A new possibility for listening.",
  "向下滚动，看看对话如何发生": "Scroll to see the conversation unfold",
  一起聊下去: "Talk it through",
  "好内容，值得听进去。": "Something worth listening to.",
  "有想法，就加入。": "An idea? You're in.",
  "它听懂的不止这一句。": "More than just your last words.",
  "聊完，刚好接着听。": "Pick up the thread.",
  "访谈、播客、分享。每一段声音，都可以是对话的开始。":
    "Interviews. Podcasts. Talks. Every voice can start a conversation.",
  "一个问题，一点不同意见。让单向的收听，变成双向的交流。":
    "A question. A different take. Turn listening into a two-way conversation.",
  "Aside 结合前面的内容回应，让你的好奇继续往前走。":
    "Aside responds with the context in mind. Follow your curiosity further.",
  "回到刚才完整的一句话，思路和进度都接得上。":
    "Resume at a complete sentence. Keep your place, and your train of thought.",
  "有时候，新的想法不在屏幕里。":
    "Sometimes, new ideas live beyond the screen.",
  "当我们暂时离开屏幕，": "When we step away from the screen,",
  "注意力会转向周围的声音、光线和风。":
    "our attention shifts to the sounds, light and breeze around us.",
  "给思考留一点空间。": "A little room for thought.",
  "这里，留给你的想法。": "A little room for your perspective.",
  "不矛盾。注意力离开屏幕，不一定是更专注。走神，也可能带来新的联想。":
    "Not necessarily. Looking away from a screen doesn't have to mean more focus. A wandering mind can make new connections, too.",
  "选一段，亲自试试": "Pick something. Join in.",
  "听听，聊聊。": "Listen. Join in.",
  上一组音频: "Previous audio samples",
  下一组音频: "Next audio samples",
  调整音频库宽度: "Resize audio library",
  关闭音频库: "Close library",
  公共音频库: "Public library",
  公共音频: "Public audio",
  音频操作: "Audio actions",
  "你的音频，你可以加入的对话。": "Your audio. Conversations you can join.",
  "从音频库上传一段，或先探索公共音频。":
    "Upload from your library, or explore public audio first.",
  探索公共音频: "Explore public audio",
  听这段: "Listen to this",
  分析进度: "Analysis progress",
  开启麦克风: "Enable microphone",
  "从 {time} 开始聊": "Started talking at {time}",
  回到音频: "Returning to the audio",
  只听音频: "Listen only",
  "登录后保存你的音频和收听进度。":
    "Sign in to save your audio and listening progress.",
  "安心听，也可以打字聊聊你的想法。":
    "Settle in and listen, or type what’s on your mind.",
  "或与你有关的经历，都可以从这里聊起。":
    "or an experience of your own. Start here.",
  "一个问题、一点不同意见，": "A question, a different perspective,",
  "听到这里，你想说什么？": "What’s on your mind as you listen?",
  发送消息: "Send message",
  输入消息: "Your message",
  文字稿: "Transcript",
  "听到这里，你也有话想说。": "Recorded then. Interactive now.",
  "暂时没有可收听的示例。": "No samples are available right now.",
  示例音频: "Sample audio",
  "挑一段感兴趣的，听到有想法时，就开口聊聊。":
    "Pick something that interests you. When a thought comes to mind, jump into the conversation.",
  "刚才说的是注意力离开屏幕，不一定是更专注。走神也可能带来新的联想。你走神时，通常会想到什么？":
    "The passage describes attention moving away from the screen, not necessarily becoming more focused. A wandering mind can make new connections too. Where does yours tend to go?",
  "但我散步时反而容易走神，这和刚才说的矛盾吗？":
    "But my mind wanders when I walk. Does that contradict what was just said?",
  一段关于散步与灵感的讨论: "A discussion about walking and inspiration",
  接着听: "Keep listening",
  说说你的想法: "Share a thought",
  听一段: "Listen",
  收听与对话示意: "Preview of listening and conversation",
  "无需注册，先听一段": "No sign-up. Start with a listen.",
  体验示例: "Try a sample",
  "听访谈、课程或讨论时，随时开口。Aside 会结合刚才的内容，和你聊问题、想法与不同意见。聊完，从刚才那句话继续听。":
    "Speak up during an interview, lecture, or discussion. Aside draws on what you just heard to explore your questions, ideas, and different perspectives. Then pick up from the sentence you left.",
  "你也有话想说。": "Interactive now.",
  "让过去的声音，成为此刻的对话": "Past voices. Present conversations.",
  探索: "Explore",
  我的空间: "My space",
  从左侧选择音频开始收听:
    "Choose an audio file from the left to start listening.",
  "正在加载…": "Loading…",
  "登录后，把想听的音频放在这里。":
    "Sign in to keep the audio you want to hear here.",
  "请从右上角登录，随时回来继续收听。":
    "Sign in at the top right and pick up anytime.",
  你的私人音频库: "YOUR PRIVATE LIBRARY",
  "把想听的音频放在这里，听到疑问时随时聊两句。":
    "Bring your audio here. Ask whenever curiosity strikes.",
  上传音频: "Upload audio",
  篇本月已用: "used this month",
  "拖入音频，或选择文件": "Drop audio here, or choose a file",
  "单个音频最长 5 小时 · 文件最大 1 GiB · 每月最多 100 篇":
    "Up to 5 hours and 1 GiB per file · 100 uploads a month",
  选择音频: "Choose audio",
  "音频文件需小于 1 GiB": "The audio file must be under 1 GiB.",
  "文件不能超过 1 GiB": "The file cannot exceed 1 GiB.",
  "单个音频不能超过 5 小时": "An audio file cannot be longer than 5 hours.",
  时长由服务端确认: "Duration will be checked on the server",
  标题: "Title",
  上传并自动分析: "Upload and analyze automatically",
  取消上传: "Cancel upload",
  上传已取消: "Upload cancelled",
  "上传完成，正在启动自动分析…": "Upload complete. Starting analysis…",
  我的音频: "My audio",
  "上传中断，可取消后重新上传":
    "Upload interrupted. Cancel and choose the file again.",
  正在检查音频: "Checking audio",
  可对话: "Ready to talk",
  重试分析: "Retry analysis",
  删除: "Delete",
  取消: "Cancel",
  这里还没有音频: "No audio here yet",
  "上传后会自动分析，无需再点开始。":
    "Analysis starts automatically after upload.",
  加载更多: "Load more",
  "确定删除这篇音频及其分析结果吗？": "Delete this audio and its analysis?",
  请先登录再上传音频: "Sign in before uploading audio.",
  音频仍在检查中或未通过检查:
    "Audio is still being checked or did not pass validation.",
  文件不包含可读取的音轨: "No readable audio track was found.",
  "文件超过 1 GiB 上限": "File exceeds the 1 GiB limit.",
  "个人空间已达到 20 GiB 存储上限，请删除不需要的音频":
    "Your 20 GiB storage is full. Delete audio you no longer need.",
  "今天的全站上传或存储额度已满，请稍后再试":
    "The shared upload or storage allowance is full. Please try again later.",
  "今天的上传尝试次数已用完，请明天再试":
    "Today's upload attempt allowance is exhausted. Please try tomorrow.",
  "上传暂未开放，已保存的音频仍可收听。":
    "Uploads are not open yet. You can still listen to saved audio.",
  验证并上传: "Verify to upload",
  "完成验证后即可上传。每个账号每月最多 100 篇，上传完成后自动分析。":
    "Verify to upload. Each account can upload 100 files a month; analysis starts automatically.",
  "登录 / 注册": "Sign in",
  编辑个人资料: "Edit profile",
  关闭: "Close",
  从这里继续听: "Keep listening from here",
  "登录后保存你的节目和收听进度。":
    "Sign in to keep your episodes and listening progress.",
  "使用 Google 登录": "Continue with Google",
  邮箱: "Email",
  或用邮箱: "Or use email",
  "慢一点，适合外语": "Slower, easier in a second language",
  原速: "Normal speed",
  稍快一点: "A little faster",
  快速过一遍: "Skim through",
  邮件验证码: "Email code",
  更换邮箱或重发: "Change email or resend",
  "请稍候…": "Please wait…",
  验证并登录: "Verify and sign in",
  发送验证码: "Send a code",
  "登录服务暂时不可用，请稍后刷新重试。":
    "Sign-in is temporarily unavailable. Please refresh and try again later.",
  登录服务尚未配置: "Sign-in is not configured yet.",
  个人资料: "Profile",
  更换头像: "Change avatar",
  昵称: "Alias",
  介绍: "About you",
  "说说你喜欢听什么…": "What do you enjoy listening to?",
  保存资料: "Save profile",
  退出登录: "Sign out",
  "请求失败，请重试": "Something went wrong. Try again.",
  "头像不能超过 2 MB": "Avatar must be under 2 MB.",
  "请先用邮件验证码验证邮箱，再从个人资料关联 Google。":
    "Verify this address by email, then link Google from your profile.",
  "关联 Google 账号": "Link Google account",
  节选: "Excerpt",
  转载许可: "Reuse terms",
  下载节选: "Download excerpt",
  下载转写: "Download transcript",
  "未获得麦克风权限，仍可继续收听或打字提问。":
    "Microphone access wasn’t granted. You can keep listening or type a question.",
  让播客成为一场对话: "A podcast you can talk to",
  "好问题，": "Your podcast.",
  "不必等到最后。": "Now a conversation.",
  "听播客时，随时开口问。聊清楚了，再从刚才那句话自然接着听。":
    "Ask whenever curiosity strikes. Talk it through, then pick up right where you left off.",
  试听: "Try a sample",
  "暂时没有可试听节目。": "No samples are available right now.",
  "无需注册 · 打开示例即可收听": "No sign-up. Just press play.",
  如何使用: "How it works",
  收听与提问示意: "Preview of listening and asking",
  交互示意: "Interactive preview",
  听到好奇的地方: "Follow your curiosity",
  "问一句，聊明白": "Ask. Talk it through.",
  从刚才那句继续: "Pick up naturally",
  给思考留一点空间: "A little room to think",
  "暂停一下，聊两句": "A pause for conversation",
  回到完整的一句话: "Back to a complete sentence",
  一段关于散步与灵感的播客: "On walking and finding ideas",
  "“当我们暂时离开屏幕，注意力会转向周围的声音、光线和风。”":
    "“Step away from the screen, and your attention turns to the sounds, light, and breeze around you.”",
  "为什么散步会带来灵感？": "Why does walking spark new ideas?",
  "换个环境，让注意力松下来，原本没联系的想法就有机会碰到一起。":
    "A change of scenery lets your attention wander, giving unrelated ideas a chance to meet.",
  "↶ 留住你的好奇，也留住刚才的进度。":
    "↶ Keep the thought. We’ll keep your place.",
  跟着好奇心走: "A little room for curiosity",
  "听进去，也聊进去。": "More than listening.",
  "选一段节目，像平时一样开始听。":
    "Choose a podcast and settle in, just as you normally would.",
  "一个没听懂的概念，或一个突然冒出的想法，随时问。":
    "An unfamiliar idea or a sudden thought? Ask while it’s fresh.",
  "聊完回到完整的句子，不用自己拖进度条。":
    "Return to a natural sentence boundary, without hunting for your place.",
  从这里开始: "START HERE",
  "留几分钟，试着聊两句。": "A few minutes. A new way to listen.",
  "示例节目可直接收听；首次 AI 提问需完成验证，每天有免费试用额度。":
    "Listen to a sample right away. A quick verification unlocks your daily allowance of free AI questions.",
  示例节目: "Sample episode",
  回到顶部: "Back to top",
  "好问题，不必等到最后。": "Good questions don’t have to wait.",
  "＋ 导入播客": "＋ Import a podcast",
  我的收听: "Your library",
  可以收听: "Ready to listen",
  语音服务已配置: "Voice is ready",
  "本地模式 · 语音服务待配置": "Voice is not configured",
  "耳机听，更自在。": "Best enjoyed with headphones.",
  "你的播客，留一点对话的空间":
    "A little room for conversation in your podcast",
  "听到这里，": "Recorded then.",
  "刚好有个问题。": "A question comes to mind.",
  "带来一期播客。随时开口，聊清楚，":
    "Bring a podcast. Ask whenever you’re curious,",
  "再从刚才那句话继续。": "then pick up right where you left off.",
  "正在导入…": "Importing…",
  "拖入音频，或者点击选择": "Drop audio here, or choose a file",
  "MP3、M4A、WAV 等音频 · 最大 500 MB": "MP3, M4A, WAV and more · Up to 500 MB",
  "01 自动整理内容": "01 Get the context",
  "02 随时插话": "02 Ask anytime",
  "03 自然接着听": "03 Pick up naturally",
  "留白，也是对话。": "Leave room for conversation.",
  "本地演示 · 合成音频 / 预设分段":
    "Demo · Synthesized audio / prepared transcript",
  正在收听: "NOW LISTENING",
  重新分析: "Retry analysis",
  女声: "Feminine voice",
  男声: "Masculine voice",
  "· 自动匹配": "· Automatically matched",
  播放进度: "Playback position",
  播放控制: "Playback controls",
  "播放 / 暂停（空格）": "Play / pause (Space)",
  暂停: "Pause",
  播放: "Play",
  "继续听 ↗": "Keep listening ↗",
  播放速度: "Playback speed",
  音量控制: "Volume controls",
  播客音量: "Podcast volume",
  静音: "Mute",
  取消静音: "Unmute",
  已静音: "Muted",
  收听设置: "Listening settings",
  插话方式: "How to ask",
  自动插话: "Speak naturally",
  按住说话: "Hold to talk",
  只听节目: "Listen only",
  回答后继续: "Resume after answers",
  跟随服务设置: "Use service setting",
  "等 3 秒": "Wait 3 seconds",
  "等 8 秒": "Wait 8 seconds",
  手动继续: "Resume manually",
  "播放时本地监听，开口即可插话":
    "While playing, your mic listens locally. Just speak to ask.",
  "按住录音，松开发送；也可按住空格键操作按钮":
    "Hold to record, release to send. You can also hold Space on the button.",
  "麦克风关闭，仍可打字提问": "Microphone off. You can still type a question.",
  "↶ 聊完从这里继续 ·": "↶ Pick up here after chatting ·",
  "刚才听到：": "You just heard: ",
  聊两句: "Let’s talk",
  麦克风未监听: "Microphone off",
  "开启麦克风…": "Starting microphone…",
  "按住说话 · 待命": "Hold to talk · Ready",
  "● 本地监听": "● Listening locally",
  "● Aside 正在加入": "● Aside is joining",
  "● 正在识别": "● Transcribing",
  "按住说话 · 可继续追问": "Hold to talk · Ask a follow-up",
  "● 语音交流中": "● Voice conversation",
  对话记录: "Conversation",
  "不懂的概念，突然的好奇。": "An unfamiliar idea. A sudden curiosity.",
  "都可以在这里聊。": "There’s room for it here.",
  "语音开启时保持实时连接，可用英语控制播放或提问。":
    "Voice mode stays connected. Speak in English to control playback or ask a question.",
  "按住下方按钮说话，松开后回答。":
    "Hold the button below to speak, then release for an answer.",
  "安心听节目，有问题也可以打字问。":
    "Enjoy the podcast. Type a question whenever you like.",
  "配置服务端 API key 后可语音或文字提问。":
    "Voice and text questions will be available once the service is configured.",
  你: "You",
  正在找相关材料: "Looking up the context",
  "准备好了，再继续听": "Keep listening when you’re ready",
  聊完再接着听: "We’ll pick up after chatting",
  "可以追问，或继续听": "Ask a follow-up or keep listening",
  先别继续: "Wait a moment",
  "开启麦克风…就绪后说话": "Starting microphone… speak when ready",
  "正在录音 · 松开发送": "Recording · Release to send",
  输入问题: "Your question",
  "也可以打字问问…": "Or type a question…",
  发送问题: "Send question",
  "参考材料 ·": "Sources ·",
  开发观察: "Developer details",
  "随时聊两句，再接着听。": "Ask a little. Keep listening.",
  节目逐字稿: "Transcript",
  跟随播放: "Following playback",
  回到当前播放: "Back to current position",
  从这句播放: "Play from this sentence",
  "音频分析完成后，逐字稿会出现在这里。":
    "The transcript will appear here once analysis is complete.",
  已暂停: "Paused",
  正在播放: "Playing",
  正在听你说: "Listening to you",
  正在回答: "Answering",
  还想聊聊吗: "Anything else on your mind?",
  回到节目: "Returning to the podcast",
  连接已断开: "Disconnected",
  开始免费试用: "Try Aside for free",
  "完成验证即可提问。每天 5 次提问，每次语音连接最多 2 分钟。":
    "Verify to start asking. You get 5 questions a day, with voice sessions up to 2 minutes each.",
  继续收听: "Keep listening",
  "无法加载试用验证，请稍后重试":
    "Couldn’t load verification. Please try again later.",
  无法获取试用状态: "Couldn’t check trial availability.",
  "AI 试用暂时关闭，仍可继续收听":
    "AI trials are temporarily paused. You can keep listening.",
  试用验证尚未配置: "Trial verification is not configured yet.",
  "验证已超时，请重试": "Verification timed out. Please try again.",
  已取消试用验证: "Trial verification cancelled.",
  "验证失败，请重试": "Verification failed. Please try again.",
  验证失败: "Verification failed.",
  "验证已过期，请重试": "Verification expired. Please try again.",
  当前仅开放示例节目试听:
    "Uploads are not available yet. Try a sample from the library.",
  "今日体验额度已用完，请明天再试":
    "You’ve used today’s trial allowance. Please try again tomorrow.",
  "请求过于频繁，请一分钟后再试":
    "Too many requests. Please try again in a minute.",
  "已有请求正在进行，或试用繁忙，请稍后再试":
    "A request is already running, or the trial is busy. Please try again shortly.",
  请先完成试用验证: "Please complete verification first.",
  "今日 AI 试用暂时关闭，仍可继续收听":
    "AI trials are paused for today. You can keep listening.",
  "问题或对话过长，请开始新的对话":
    "This question or conversation is too long. Please start a new conversation.",
  新对话: "New conversation",
  正在开启麦克风: "Starting microphone",
  正在连接语音: "Connecting voice",
  正在接收声音: "Hearing audio",
  麦克风已开启: "Microphone on",
  麦克风反馈: "Microphone activity",
  "正在开始新对话…": "Starting new conversation…",
  "清空当前对话，保留播放进度":
    "Clear this conversation and keep your playback position",
  "每次问题录音最多 30 秒":
    "Please keep each recorded question under 30 seconds.",
  "没有识别到完整问题，请再说一次":
    "Couldn’t hear a complete question. Please try again.",
  节目音频未就绪: "The podcast audio isn’t ready yet.",
  没有可转录的本地录音: "There is no recording to transcribe.",
  麦克风未就绪: "The microphone isn’t ready yet.",
  "回答轮次不匹配，请重试": "The answer is out of date. Please try again.",
  回答连接已关闭: "The answer connection has closed.",
  "回答连接中断，请重试": "The answer was interrupted. Please try again.",
  "语音连接已断开，可以继续听节目，或重新尝试提问。":
    "Voice disconnected. Keep listening or try asking again.",
  语音连接启动超时: "The voice connection timed out.",
  请点击页面允许音频播放: "Click the page to allow audio playback.",
  "Live 会话错误": "Voice session error.",
  "无法读取 Live 事件": "Couldn’t read the voice response.",
  语音连接中断: "Voice connection interrupted.",
  语音连接已取消: "Voice connection cancelled.",
  语音会话已结束: "The voice session has ended.",
  "麦克风已断开，请重新开始播放":
    "Microphone disconnected. Please start playback again.",
  "麦克风已断开，请重新开启语音":
    "Microphone disconnected. Please turn voice on again.",
  "服务暂时不可用，请重试":
    "The service is temporarily unavailable. Please try again.",
  "回答失败，请重试": "Couldn’t answer. Please try again.",
  等待分析: "Waiting for analysis",
  分析完成: "Analysis complete",
  等待恢复分析: "Waiting to resume analysis",
  "等待配置 OpenAI": "Waiting for service configuration",
  分析未完成: "Analysis incomplete",
  检查音频: "Checking audio",
  检查音频与分块: "Checking audio and segments",
  检测停顿与分块位置: "Finding pauses and segments",
};
export function translate(text: string, target: Locale): string {
  return target === "zh" ? text : (english[text] ?? text);
}
export function t(text: string): string {
  return translate(text, locale);
}
import { keepListeningHint } from "@aside/player-runtime/recovery-message";
export {
  keepListeningHint,
  withKeepListeningHint,
} from "@aside/player-runtime/recovery-message";
export function message(text: string): string {
  if (locale === "zh" || !text) return text;
  if (english[text]) return english[text];
  const overflow = /^首句录音超过 (\d+) 秒，请分成较短的问题。$/.exec(text);
  if (overflow)
    return `Please keep your question under ${overflow[1]} seconds.`;
  const stage = /^(转录|分析|分析语义与声音)(?:第)? (\d+)\/(\d+)(?: 段)?$/.exec(
    text,
  );
  if (stage)
    return `${stage[1] === "转录" ? "Transcribing" : "Analyzing"} segment ${stage[2]} of ${stage[3]}`;
  const finished = /^已完成 (\d+)\/(\d+) 段$/.exec(text);
  if (finished) return `${finished[1]} of ${finished[2]} segments analyzed`;
  const suffix = keepListeningHint;
  if (text.endsWith(suffix))
    return `${message(text.slice(0, -suffix.length))} You can keep listening or try asking again.`;
  if (text.startsWith("无法开启麦克风："))
    return "Couldn’t start the microphone. Check your browser permissions. You can keep listening.";
  return /\p{Script=Han}/u.test(text)
    ? "Something went wrong. Please try again."
    : text;
}
export function resumeLabel(seconds: number) {
  return locale === "zh"
    ? `${seconds} 秒后继续播放`
    : `Resuming in ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}
