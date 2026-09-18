# Native acceptance harness

Run from the repository root with Node 24 and FFmpeg/ffprobe on PATH. Start `node --import tsx mobile/tests/server.mjs` and, in a separate process, a Python environment containing `requirements.txt` running `rtc.py`. Both bind only localhost. The fixed email code is `12345678`; production never includes the test Worker wrapper.

Build Release apps with `EXPO_PUBLIC_API_URL=http://127.0.0.1:4311` and `ASIDE_TEST_API=1`. On Android run `adb reverse tcp:4311 tcp:4311`. Use a fresh `example.com` test account for `voice.yaml`, so a restored answer cannot satisfy its assertion. Run one Maestro flow at a time per device. iOS system dialogs may expose a combined label (including the timestamp), so select the whole accessible control.

When building an iOS simulator directly with `xcodebuild`, keep Xcode's simulator
signing enabled (`CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-`, with the same
development team as previous installed test builds). An unsigned app can launch
but lack the application/keychain entitlements required by SecureStore, causing
account restoration to fail before voice is exercised. Use Xcode's signing step
instead of signing only the outer app afterwards. This does not require paid
Apple distribution signing.

The local `ios` and `ios:device` commands regenerate native configuration before
building. Supply an increasing `BUILD_NUMBER` for acceptance packages. When using
`xcodebuild` directly, first run `expo prebuild --platform ios --no-install` with
the same `APP_VARIANT`, `BUILD_NUMBER`, API and test-mode environment. Expo writes
`CFBundleVersion` into the native plist: `CURRENT_PROJECT_VERSION` alone does not
replace a stale generated value. Verify the built app's native version as well as
`EXConstants.bundle/app.config` before installing or distributing it.

```sh
maestro --device DEVICE test -e EMAIL=fresh@example.com mobile/tests/smoke.yaml
maestro --device DEVICE test -e EMAIL=voice-fresh@example.com mobile/tests/voice.yaml
```

- `login.yaml`: sign in an already logged-out app.
- `interaction.yaml`: start the fixture with `STREAM_DELAY_MS=20000`, use a fresh `EMAIL`, and verify that a partial text answer appears before the completed answer while the composer is already empty. The longer interval accommodates Android accessibility calls that can take over ten seconds on software-rendered emulators. This uses native HTTP streaming and the real Worker parser, with synthetic supplier chunks.
- `online-public.yaml`: read-only online candidate smoke. Supply `APP_ID` and an existing public `EPISODE_ID`; verify the real library, transcript and absence of the fixture banner. It does not send email, play audio or call a model, and does not replace the one real signed-in question/synchronization acceptance.
- `online-signed-in.yaml`: after a normal real-mailbox login, run in English with `APP_ID`, `EPISODE_ID` and `EPISODE_TITLE`. Assert authenticated account controls, the exact selected title, play/pause, process-restart login persistence and restoration of the same episode. This writes listening progress and briefly plays audio, but never submits a question or upload. Inspect the restored timestamp and production checkpoint separately; a visible player alone does not prove cloud persistence.
- `login-recovery.yaml`: on an explicit test build, verify invalid email, resend cooldown, wrong/correct code and account restoration after process restart. Supply a unique `EMAIL` for each platform. This still uses the fixture code, not real email delivery.
- `login-offline.yaml` / `login-reconnect.yaml`: after login through port 4311's proxy, stop only that proxy while retaining the fixture process/database on 4313. Run the offline flow, restart the proxy, then run reconnect with the same `EMAIL`. No app data is cleared; successful profile restoration proves that a connection failure did not delete the saved credential.
- `restore.yaml`: after login to an account with a completed sample question, verify its complete conversation.
- `restore-current.yaml`: on an already signed-in fixture app, supply a unique `QUESTION`, `ANSWER` and `POSITION` from another device. Restart the process and match both messages plus the actual playback-position control. Its screenshot path is relative to Maestro's output directory.
- `web-sync.mjs`: with Vite also running, sign into the same `EMAIL` fixture account using the website Cookie flow, compare every stored message to the rendered history, restore the semantic anchor and test both conflict choices against real Worker checkpoint versions. It asserts history survives both choices and no question/transcription/Live request occurs. `PORT`, `WEB_ORIGIN` and `EVIDENCE` select the local services and output JSON. It redirects only the isolated test browser's API requests to the fixture origin.
- `checkpoint.mjs EMAIL [POSITION_MS]`: read or deliberately change a fixture account's sample position to create a native conflict. It never prints the bearer token.
- `upload-android.yaml`: copy a generated WAV named `Aside-upload.wav` to `/sdcard/Download` first. iOS Files uses the app's Documents folder; open the **thumbnail** of the generated file.
- `background-start.yaml`: open the 31-minute silent AAC fixture and put the app in the background.
- `locked-start.yaml`: restart that fixture at its transcript anchor and lock the device. Retain the exact lock timestamp. Wait at least 30 real minutes, then inspect native media state / lock controls and reopen with `background-finish.yaml`. A playing icon alone is insufficient: verify actual position exceeds 30 minutes.
- `voice-resume.yaml` / `voice-capture.yaml`: focused manual-mode checks for an already signed-in app. `voice-resume` explicitly selects manual continuation, verifies the hold survives completed output, then restores the default three-second preference. Silence alone never completes a spoken answer. The manual-mode idle timer releases an unused connection without resuming playback.
- `continuous.mjs ios|android DEVICE`: launch through Maestro, enable conversation, and drive a unique question through the actual Worker control stream and native RTC output. Assert microphone RTP, rendered answer activity, drained PCM before countdown, semantic continuation, retained microphone, visible question/answer and no overlap with podcast playback. Inject a second delegation and real PCM after verified completion; it must not reopen the reply or enter history. Native diagnostics retain `lastDrain`, the measured playout state before the completed answer's gate closes. Set `EXTENDED=1` to also exercise ignored speech, continuous follow-ups on one anchor and the long-answer eight-second wait. `PORT` and `MAESTRO` select the fixture and executable. Evidence defaults to `/tmp/aside-continuous-PLATFORM-native.json`.
- `player-ui.yaml`: compact question tools, opening/closing the composer without losing a draft, playback options, Chinese/English and restoring the default preference. Scroll targets fully into view and verify the selected continuation setting. Run separately in light/dark and at small screen / enlarged text sizes; inspect screenshots for clipping and hierarchy, including the pinned Done button and the last option in the scrollable sheet.
- `composer.mjs ios|android DEVICE`: on an already signed-in fixture app, run `composer-send.yaml` with a unique question. Verify the actual runtime has exactly one newly submitted question and its own completed reply; the native UI must clear the draft and keep it empty after reopening. `PORT`, `MAESTRO` and `EVIDENCE` select the local fixture, executable and JSON output. This uses synthetic supplier output, not a paid model.
- `voice-toolbar.yaml`: after `continuous.mjs` has left the local fixture listening, open a text draft, verify microphone status and Stop remain visible above the keyboard, close/reopen the draft, then press Stop with the keyboard still open. The draft persists, and closing the composer exposes hold-to-talk again.

Set `VARIANT=1` for `continuous.mjs` to reproduce two completed backend
formulations with only the later formulation spoken by Live. The first answer
must not strand completion: the server observes the later tool-free answer and
matching output captions, then updates the original decision's metadata. The
native client still requires matching heard captions and drained PCM before
continuation. This uses the existing protocol and can validate an already-built
fixture app against the current server. Run platforms sequentially against one
fixture server, because session discovery assumes one new voice session at a time.
It does not establish suppression of two actually audible overlapping replies.

`overlap.mjs EVIDENCE_FILE DEVICE` characterizes a different boundary immediately
after `continuous.mjs`, while its microphone/session remains connected. It injects
a second delegation and real PCM while the first answer is still audibly playing.
Use the same `PORT` and `MAESTRO`; `EVIDENCE` selects the output JSON. Both platforms
currently keep the programme paused, expose Continue and recover on a genuine
follow-up. The result also records `extraWasHeard`: it is currently **true**.
These safeguards passing does not mean the additional supplier audio was filtered.
Live's single unlabelled audio stream cannot yet separate that speech from an
unfinished admitted answer. This probe is intentionally separate from the
after-completion duplicate-suppression assertion in `continuous.mjs`.

`phone-call.mjs EVIDENCE_FILE emulator-ID` runs after Android `continuous.mjs`
while that session remains connected. Supply `PORT`, `RTC_PORT` and optionally
`ADB`. It admits a synthetic ten-second reply, injects a GSM call into the Android
emulator, and confirms Android telephony reached RINGING and AudioService released
the actual recorder. It then cancels the call and reopens the app: microphone and
programme stay off beyond the default follow-up window, the anchor and submitted
question survive, and the supplier session is released. It refuses physical device
IDs and never places a real phone call. This tests Android's system-focus path;
it does not establish physical headset routing or iOS telephony behavior.

For a long local acceptance session, `VOICE_SESSION_SECONDS=600 TRIAL_DAILY_LIMITS=false` prevents synthetic provider traffic exhausting the fixture's daily pool. Production authorization/concurrency still executes, and normal quota coverage remains in Worker tests. Close voice or background the app before deliberately terminating an older binary. Current builds also journal and clean up their own abandoned lease on restart.

- `voice-history.yaml`: use an empty checkpoint and `QUESTION_DELAY_MS=15000` to verify a recognized question appears before the answer, survives background cancellation, and restores after restart. Require the user-role bubble rather than the composer's similarly named accessibility label.

The fixture uses the actual production Worker, D1/R2, media decoder and analysis workflow. External transcription/model output is deterministic; the RTC peer transports real audio and data channels. These checks do not measure production model quality/latency, physical audio routes, Apple signing or distribution.

Native CI builds are a separate manually dispatched workflow. Its APK uses an ephemeral validation key and is **not** an update to distributed builds. Local delivery and EAS must retain their fixed private signing credentials.

## Background upload cancellation

To make cancellation observable, run the fixture with `PORT=4313`, then `node mobile/tests/upload-proxy.mjs` on port 4311. Point installed validation binaries at 4311 (and reverse that port on Android). Create the switch file printed by the proxy to delay each upload part for 20 seconds. The proxy consumes request bodies, preserves bearer headers and strips already-decoded compression headers; it contains no production behavior.

Copy `Aside-upload.wav` into Android Downloads / iOS app Documents. Run `upload-background-android.yaml`, or open iOS Files to the app's Documents folder and run `upload-background-ios.yaml` on an iPhone 16 Pro. Verify the localized cancellation message, retry action and server-side `DELETE /uploads/:id` after pressing Home. Remove the switch file and run `upload-retry.yaml`; the selected local file should upload, finish real media analysis and open its transcript. Do not run simultaneous UI flows on one device.

`permission-denied.yaml` explicitly sets `launchApp.permissions.all: deny`: Maestro otherwise grants permissions at launch. `cancel-capture.yaml` and `background-question.yaml` verify cancellation, and reopening must leave the episode paused. For the 30-second cap, retain native recorder start/stop timestamps and read the checkpoint before/after; a previously rendered answer is insufficient evidence of a newly completed turn.

## Live input timeline regression

GPT-Live requires incoming media (silence is sufficient) to advance text-driven speech. The RTC fixture waits for an incoming frame before producing an answer; recvonly transport cannot pass voice acceptance. Run `python mobile/tests/test_rtc.py` in the fixture Python environment to check both the failing recvonly case and successful synthetic-silence case without paid API calls. Both native adapters now supply zero PCM in manual mode and real microphone PCM in continuous mode. Native C and Java queue tests compare exact sample traces for prefix preservation, ignored replies, quiet gaps and overflow. Simulator transport evidence does not establish physical microphone quality, echo cancellation or Bluetooth behavior.
