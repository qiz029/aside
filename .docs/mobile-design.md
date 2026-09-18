# Mobile design and interaction acceptance

Aside uses the existing cream and forest-green identity. The interface follows the platform's familiar navigation, typography and control hierarchy; decorative branding must not compete with the audio or transcript.

## References

- [Apple HIG: Layout](https://developer.apple.com/design/human-interface-guidelines/layout): importance, alignment, grouping, progressive disclosure, safe areas and adaptable layouts.
- [Apple HIG: Typography](https://developer.apple.com/design/human-interface-guidelines/typography): system fonts, legible sizes and a hierarchy that survives text scaling.
- [Apple HIG: Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons): recognizable actions and clear emphasis.
- [Apple HIG: Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars): stable destinations with recognizable labels.

## Decisions

- Library, Upload and Account remain stable destinations. Android Back first returns from a destination or episode before exiting.
- Episode title and content replace the marketing header in the player. The playback control is centered; skip and speed have less visual weight.
- Use system text for UI/content and the existing serif identity only for the small wordmark. No downloaded Apple fonts on Android.
- Transcript and completed conversations share the reading area. A subtle active passage keeps the text readable.
- One fixed question area provides text and deliberate hold-to-record entry. Empty/pending text submission is disabled. Recording shows preparation, elapsed time and cancel guidance. A 64-point movement from the initial touch cancels capture; small finger movements stay within the gesture. The reading pane changes after release, preserving the touch target during recording.
- Resume actions appear only during a question interruption. Leaving the player retains a mini player and the native audio session.
- Upload shows filename, numeric progress, a progress bar and cancellation. Retry reuses the selected local copy.
- Light/dark palettes use semantic surface, text, muted, accent and separator colors. Focus, selected and pressed states have visible feedback.
- Navigation and the playback dock have their own surfaces and separators against the quieter reading background. Incoming answers use a separate bubble, with partial text displayed while it arrives; reading older messages suspends automatic scrolling.
- Error notices overlay the reading area without pushing controls under a held finger. English recovery messages preserve the specific cause rather than replacing native audio errors with a generic failure.

## Required visual and interaction review

On both installed Release apps, review Library, empty library, player transcript, conversation, recording, errors, upload, login and account. Inspect both languages, light/dark appearance and large text. Verify safe areas, readable contrast, untruncated primary actions, keyboard avoidance, touch target separation and scroll reachability. A successful compile or automation assertion alone does not satisfy visual acceptance.

Record actual simulator screenshots and flow reports. Keep unverified device/signing scenarios explicit in the release report.

Manual scrolling temporarily suspends transcript auto-follow. A labeled action returns to the current passage; advancing playback must never repeatedly pull a reader away from the section they chose.

At accessibility text sizes, content remains scalable and scrollable. The brand, navigation labels and transport labels have bounded scaling so the controls retain space for reading; the upload page scrolls to keep file selection and cancellation reachable on an iPhone SE.

## Current review and skill shortlist — 2026-09-18

The current [iOS conversation](mobile-screenshots/current-ios-restored-conversation.png)
and [Android conversation](mobile-screenshots/continuous-android-latest-answer.png)
show distinct reading, header and transport surfaces. Primary controls are readable.
Visual acceptance remains open: the bottom area simultaneously exposes transport,
continuation actions, continuous listening, text entry and hold-to-talk. In the
Android continuation state it takes roughly half the screen. Large message padding
also limits how much conversation is visible. These are hierarchy and density
problems; changing accent colors alone will not resolve them. A future design pass
should prioritize the active listening state and disclose secondary input methods
on demand, while keeping an obvious pause and microphone-off action available.
This review makes no product UI or navigation changes.

Recommended references, inspected at their actual source:

- [Expo native UI](https://github.com/expo/skills/blob/main/plugins/expo/skills/expo-native-ui/SKILL.md): platform controls, semantic surfaces, keyboard access and reachable actions. Use it to evaluate native behavior and visual hierarchy.
- [Expo design system](https://github.com/expo/skills/blob/main/plugins/expo/skills/expo-design-system/SKILL.md): audit existing theme values, repeated components and their interaction states. Extend Aside's existing theme instead of adding a competing theme.

Both belong to the [official Expo repository](https://github.com/expo/skills), which
had 2,539 stars when checked. The [older `building-native-ui` listing](https://skills.sh/expo/skills/building-native-ui)
reports 59.2K installs; that count is not a verified install count for either current
skill name. Current-name counts were unavailable. Popularity supports discovery,
but does not establish the quality of an Aside screen.

Compatibility matters: Aside currently uses Expo SDK 54 and its own navigation.
The current native UI skill includes SDK 56+ `@expo/ui` and Expo Router recipes.
Do not apply those imports or migrate navigation as part of a visual review.
The app's custom PCM and WebRTC modules require native builds; Expo Go is not an
acceptance environment for this app.

Optional targeted installation, following the repository's skills CLI syntax:

```sh
npx skills@latest add expo/skills --skill expo-native-ui --skill expo-design-system
```

No skill or plugin was installed during this review.

## Compact question tools and accessibility correction — 2026-09-18

The follow-up implementation replaces the idle status heading, permanently open
text field and full-width recording row with one question toolbar. Hands-free
conversation is primary; a labeled hold control and a text-entry icon remain
directly reachable. The composer opens on demand and retains an unsent draft when
closed. Active microphone status and Stop remain visible while typing. Recording
guidance appears above a fixed-size hold target, preserving its position as capture
starts. Continuation status and actions share one adaptive row. Completed messages
have less padding, leaving more of the conversation visible.

The maximum iOS accessibility text size revealed additional problems. The library's
fixed heading and filters left too little list space to reach a complete episode
card. They now scroll with the library. The player eyebrow and transport timestamps
use bounded scaling as navigation metadata. Reading text retains system scaling.
The options sheet has a bounded height, a persistent title/Done row, and scrollable
content so the last option can be reached without losing the close action.

Build 40 exercised continuous activation, native RTC, continuation and completed-answer
replay suppression on both platforms. Build 42 includes the subsequent library/large-text corrections:
Android normal-size and iPhone SE maximum-size UI flows pass, including actual
setting selection, draft restoration, keyboard access and both languages. iOS's
unique typed submission, real manual capture, ten-second hold and explicit resume
also pass. Package delivery and remaining verification are tracked in the delivery
record; these local fixtures are not distributed production builds. The review's
remaining live-audio boundary and physical-device gates remain open.
