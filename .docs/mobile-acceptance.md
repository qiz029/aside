# Mobile acceptance — September 15, 2026

Branch: `codex/mobile-cross-platform`. [Pull request #2](https://github.com/qiz029/aside/pull/2).

Installed **Release** builds were tested on iPhone 16 Pro and iPhone SE 3 simulators (iOS 18.3), and Pixel 6 / API 33 ARM64 Android emulator. JavaScript is embedded; Metro was not used. Tests exercised the real local Worker, D1, R2, FFmpeg media decoder and analysis workflow. External transcription/model results were deterministic fixtures; voice answers used a real receive-only WebRTC peer and audio/data transport.

## Integration with current main

The branch includes upstream `527bc64` (PR #1 player controls, live waveform, monthly upload quota and one-step media segmentation). Its command/configuration policy now lives in the shared listening runtime, retaining native asynchronous seeking, completed-history persistence and conflict protection. The native adapter applies rate, volume, mute and pitch configuration. After merging, both native Release packages were rebuilt and the expanded regression suites rerun. Expanded verification: [132 unit tests](mobile-evidence/merged-unit-tests.txt), [32 Worker tests](mobile-evidence/merged-cloudflare-tests.txt), [44 browser tests](mobile-evidence/merged-browser-tests.txt), [iOS smoke](mobile-evidence/merged-ios-smoke.txt), [Android smoke](mobile-evidence/merged-android-smoke.txt), [iOS voice](mobile-evidence/merged-ios-voice.txt), [Android voice](mobile-evidence/merged-android-voice.txt), [iOS upload](mobile-evidence/merged-ios-upload.txt), [Android upload](mobile-evidence/merged-android-upload.txt). The incoming browser fixture was updated to return versioned checkpoint writes instead of `null`, matching the new production contract.

## Results

| Check | Result / evidence |
| --- | --- |
| TypeScript and shared/native import boundaries | Passed `npm run check` |
| Unit and application regression | **132 passed**, including audio ownership, late events, fixed anchors, asynchronous seeking, cancellation, checkpoint races and real M4A validation |
| Cloudflare integration | **32 passed**, including bearer expiry/revocation, private-media isolation, Range requests and checkpoint compare-and-swap |
| Website browser regression | **44 passed**; production web build passed |
| Native Release compilation / installation | Both platforms passed locally; standalone embedded JS |
| Public library and transport | Both passed: playback/pause, seeking, speed, transcript and navigation |
| Account and private media | Both passed: email code, locale, account, logout, native file picker, multipart upload, real analysis and private transcript/playback |
| Voice question and follow-up | Both passed: native M4A capture, transcription, receive-only RTC answer, manual continuation and natural continuation |
| Recording cap | iOS capture **29.538 s**, Android **29.522 s**; automatically submitted; service checkpoint grew from one complete pair to two complete pairs |
| Permission denial / cancellation | Both passed: denied permission gives Settings recovery, slide-out cancellation, question background cancellation, foreground remains paused |
| Upload background cancellation / retry | Both passed with delayed upload parts: server-side multipart deletion, localized retry explanation, then explicit retry completed analysis and opened the transcript |
| Progress and conversation synchronization | Completed Android history restored in iOS and website; both conflict choices verified against actual Worker versions, including native iOS selection |
| Visual and interaction review | Both: light/dark, Chinese/English, large text, keyboard avoidance, scroll reachability. iPhone SE small-screen verification included |
| Media container | Actual image built and started; `/health` passed; M4A decoded to 16 kHz mono PCM WAV; invalid and 31-second inputs rejected with 422; no question temporary directories remained |

Upload evidence: [iOS cancellation](mobile-evidence/ios-upload-cancelled.txt), [Android cancellation](mobile-evidence/android-upload-cancelled.txt), [iOS retry](mobile-evidence/ios-upload-retry.txt), [Android retry](mobile-evidence/android-upload-retry.txt), [server cancellation/completion requests](mobile-evidence/upload-cancellation-server.txt). The final binaries containing the localized cancellation copy were rebuilt, installed and tested on both platforms.

## Sustained background playback and system controls

A real 31-minute silent AAC file was played without JS-dependent background timing. Timestamps below are test-host PDT on September 15, 2026.

- **Android:** screen off from approximately 12:07:33; at 12:37:35 native playback exceeded 30 minutes. Subsequent media-session state showed playing at 1,825,251 ms, paused at 1,828,178 ms after a system pause, and playback resumed after a system play command. [Playing state](mobile-evidence/android-background-playing.txt), [paused state](mobile-evidence/android-background-paused.txt), [foreground position](mobile-screenshots/android-30min-paused.png).
- **iOS:** playback started at 12:34:31; device locked at 12:35:09–11. At 13:05:14 the system pause command changed the native AVPlayer from Playing to Paused; system play at 13:05:17 and pause at 13:05:21 produced the corresponding native transitions. Reopening showed **30:47**. [Native control log](mobile-evidence/ios-background-controls.txt), [command timestamps](mobile-evidence/ios-system-commands.txt), [foreground position](mobile-screenshots/ios-30min-paused.png).
- The endurance iOS binary preceded the small SDK metadata backport: its old system metadata still said rate 1 while native playback was paused. The final rebuilt binary was separately verified to report rate **0** on pause. Native audio ownership/transport behavior is unchanged by that backport.
- These iOS simulators did not render the visible lock-screen media card, including with an independent plain AVPlayer/MPRemoteCommandCenter probe. Native Now Playing registration, commands and actual playback were verified. Visible lock-screen card layout remains a physical-device check; a simulator screenshot is not claimed as proof of that card.

## Visual evidence

Screenshots are from installed applications, not design mockups. See [design decisions and Apple HIG references](mobile-design.md).

| iOS | Android |
| --- | --- |
| [Small-screen player, dark / large text](mobile-screenshots/ios-dark-large-player.png) | [Player, dark / large text](mobile-screenshots/android-dark-large-player.png) |
| [Account](mobile-screenshots/ios-dark-large-account.png) | [Account](mobile-screenshots/android-dark-large-account.png) |
| [Library](mobile-screenshots/ios-dark-large-library.png) · [Upload](mobile-screenshots/ios-dark-large-upload.png) | [Recording permission recovery](mobile-screenshots/android-microphone-denied.png) |
| [Recording permission recovery](mobile-screenshots/ios-microphone-denied.png) | [Capped follow-up](mobile-screenshots/android-capped-followup.png) |
| [Capped follow-up](mobile-screenshots/ios-capped-followup.png) | [Website synchronized conversation](mobile-screenshots/web-synchronized.png) |
| [Light private player](mobile-screenshots/ios-light-private-player.png) · [Light account](mobile-screenshots/ios-light-account.png) · [Light library](mobile-screenshots/ios-light-library.png) | [Private player after merge](mobile-screenshots/android-merged-private-player.png) |
| [Cancelled upload](mobile-screenshots/ios-upload-cancelled.png) · [Retry completed](mobile-screenshots/ios-upload-retried.png) | [Cancelled upload](mobile-screenshots/android-upload-cancelled.png) · [Retry completed](mobile-screenshots/android-upload-retried.png) |

## Fixes found through native acceptance

- Flattened native recorder options and verified actual recording readiness before showing its timer.
- Serialized audio-session ownership. Late answer cleanup and delayed playback events cannot stop a new capture or restart an intentionally paused episode.
- Kept the native audio session active through ownership transitions instead of allowing SDK delayed deactivation to stop recording.
- Waited for loaded native media before playback; stale async seek/play work is fenced by revisions.
- Dismissed numeric verification keyboard after all eight digits, and kept controls reachable on iPhone SE and at large text sizes.
- Published episode/checkpoint replacement atomically and fenced stale cache writes/queued saves. Conflicts require an explicit choice.
- Used `signal.aborted` for SDK 54 upload cancellation and provided a localized cancellation explanation with retry.
- Backported upstream expo/expo#44974 so paused Now Playing metadata stops advancing.
- Updated media Docker workspace manifests and excluded generated native projects, artifacts and signing credentials from its context.

Initial incorrect-MIME iOS endurance attempts and transient model-fixture failures were excluded from accepted results. The corrected long fixture uses `audio/mp4`. The native fixture fully consumes upstream request bodies; repeated native voice turns were rerun against it. Failed paid questions remain paused and are never automatically retried.

## CI and installation artifacts

- [CI: types, 132 unit/application tests, 32 Cloudflare tests, web build and Docker build](https://github.com/Zhang-JiahangH/aside/actions/runs/35020001141).
- [Both native Release builds](https://github.com/Zhang-JiahangH/aside/actions/runs/35020004213).
- [iOS native metadata backport build](https://github.com/Zhang-JiahangH/aside/actions/runs/35018001221).

CI runs on the contribution fork because the connected GitHub account has read access to the upstream repository. The PR targets `qiz029/aside:main`; no upstream branch protection or production settings were changed.

Local `mobile/artifacts/AsideDev-simulator-validation.zip` and `aside-validation-arm64.apk` are ARM64 simulator/emulator validation artifacts pointing to localhost:4311. They use the local bundle identifier. The local Android key persists in ignored credentials and supports updates. CI's Android key is ephemeral and is for build validation only. See [native harness instructions](../mobile/tests/README.md). Production API builds and signing commands are documented in [mobile setup](mobile.md).

## Separate device / distribution acceptance

No production deployment or Apple distribution is claimed. Apply migration `0006_mobile.sql`, deploy the media container, then enable `MOBILE_AUDIO_ENABLED` on the Worker before production native voice use.

Personal Team installation/trust, physical calls/headphone and Bluetooth interruptions, visible iOS lock-screen controls, battery behavior, Ad Hoc registered-device installation and TestFlight need their actual device/signing environments. Apple paid membership is pending. The local/internal/testflight configurations and separate build/submit commands are present; Ad Hoc and TestFlight are **pending signing acceptance**. Synthetic model fixtures do not establish real-model response quality or end-to-end production latency.
