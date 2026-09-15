# Aside mobile

React Native / Expo SDK 54, iOS 15.1+ and Android 7+. Web and mobile share `@aside/engine` and `@aside/player-runtime`; native audio, credentials and file access stay in the mobile workspace. SDK 54 is pinned for Xcode 16.2 compatibility. The app never needs Metro after a Release installation.

## Local setup

Use Node 24 (`package.json` pins Volta), npm, Xcode 16.2+, Java 17, Android SDK and FFmpeg/ffprobe. Run `npm ci`. For iOS install the pinned CocoaPods/JSON gems using `bundle install` inside `mobile`, then use `bundle exec pod install` inside the generated `mobile/ios` directory. UTF-8 locale (`LANG=en_US.UTF-8`) is required by CocoaPods.

The root postinstall applies the one-line upstream [expo-audio paused Now Playing fix](https://github.com/expo/expo/pull/44974) to the pinned SDK 54 dependency. The script is idempotent and requires review if the upstream implementation changes. Without it, iOS system metadata reports a playback rate of 1 while paused. The media Docker image installs only backend/engine workspaces and skips native installation scripts.

- `npm run ios:device -w @aside/mobile`: local iPhone Release build/install. Sign with your Personal Team in Xcode and enable Developer Mode on the phone. Profile expiry requires re-signing, normally after seven days.
- `npm run ios -w @aside/mobile`: select an iOS simulator for Release testing.
- `npm run build:apk:local -w @aside/mobile`: generate an Android Release APK. Requires `JAVA_HOME`, `ANDROID_HOME`, `keytool`, and an installed Android SDK. It creates a persistent private signing key under ignored `mobile/.credentials`; keep a private backup to preserve update compatibility. Losing this key means existing installs cannot accept updates signed with another key.
- `npm run start -w @aside/mobile`: development client workflow only. Expo Go cannot host the native WebRTC module.

`APP_VARIANT=local` uses `com.asidefm.app.dev`; production uses `com.asidefm.app`. API defaults to `https://asidefm.com`. Configure `EXPO_PUBLIC_API_URL` at build time. Never include model keys or signing passwords in Expo public variables.

## iOS distribution

Local signing, Ad Hoc (`internal`) and TestFlight (`testflight`) are maintained together. All build Release binaries with embedded JS. Local uses a separate bundle identifier so it can coexist with a production-channel install. Ad Hoc and TestFlight share the production bundle identifier and replace each other on a device.

After Apple Developer membership is approved:

1. Configure the Expo/EAS project (`EAS_PROJECT_ID`) and register the production bundle identifier in the approved Apple team.
2. `npm run build:internal -w @aside/mobile` registers selected device UDIDs and builds an Ad Hoc IPA. Share its EAS installation link. Adding a device requires re-signing or a new build.
3. `npm run build:testflight -w @aside/mobile` builds for App Store distribution. It does not submit automatically.
4. `npm run submit:testflight -w @aside/mobile` selects and uploads a build to the App Store Connect app. Configure the Apple team, ASC app ID and upload credentials through EAS; do not commit them.
5. Maintain tester groups in App Store Connect. External testers require TestFlight beta review; builds expire after 90 days.

EAS uses remote incrementing build numbers. Local builds use `BUILD_NUMBER`, default 1. No OTA JavaScript update channel is enabled. Builds from a different signing team or bundle identifier do not promise credential or local-storage migration; users sign in to recover server-side audio and checkpoints.

## Backend deployment and compatibility

Apply `0006_mobile.sql` before deploying the Worker. It adds a session kind (`web`/`mobile`) and checkpoint version; old rows start at version 0. Website Cookie authentication retains Origin/CSRF checks. Native Bearer sessions do not require an Origin but must validate their own opaque token. Email start/verify native endpoints share the existing challenges and limits. Tokens are hashed server-side, expire in 30 days, and live in SecureStore on the phone. Logout revokes the current token and clears local private state.

Deploy the media Container with `/question` before setting `MOBILE_AUDIO_ENABLED=true` in the Worker. The default is disabled for rolling-deploy compatibility. Native M4A requests require an account and existing trial budgets. Decoder accepts at most 2 MiB / 30 seconds, has independent bounded concurrency and temporary storage, rejects network input protocols, and revalidates converted PCM WAV before model calls. Web WAV input keeps its existing path. Voice usage `closed` explicitly asks the server supervisor to close a cancelled native session without claiming its final usage has been confirmed.

Checkpoint GET returns `version`; PUT sends that version. A stale write returns 409. Both clients serialize writes and let users choose local or remote state on conflict. Old web bundles must be refreshed after this release: unversioned writes only succeed against version 0. Future rollback must preserve the compare-and-swap contract rather than restoring unconditional writes.

Uploads stream file ranges into the existing R2 multipart endpoints. They are foreground-only; backgrounding cancels an uncompleted upload. After completion is submitted, analysis continues on the server. Shared upload limits remain 1 GiB / 5 hours and per-account quotas.

## Audio lifecycle

The global player survives navigation. `expo-audio` owns podcast media and manual M4A capture; WebRTC is receive-only and never sends the local microphone track. Native stats track received audio energy; automatic resumption is armed only after observed output activity ends. Missing stats leave the user in manual continuation. A production microphone/Bluetooth listening test remains necessary to assess actual playback latency and output-tail timing.

On background entry, podcast playback continues using OS media services and lock-screen controls. Unfinished capture/questions/answers are cancelled, live transport closes, and the episode stays paused at its resume anchor until the user resumes. Permissions are requested only on the first hold; the next hold records. Late permission results cannot begin recording after the finger is released. A question is capped below 30 seconds to allow codec padding. Text questions do not create a Live connection.

## Verification

- `npm run check`: web, shared, Worker and native TypeScript plus import boundaries.
- `npm test`: shared/application tests, including checkpoint concurrency and real M4A decoding. FFmpeg/ffprobe must be on PATH.
- `npm run test:cloudflare`: real local Worker/D1/R2 with model transport fixtures, including bearer revocation and cross-device writes.
- `npm run build`: website regression build.
- Install `mobile/tests/requirements.txt` into an isolated Python environment and run `mobile/tests/rtc.py` for the synthetic WebRTC peer.
- From the repository root run `node --import tsx mobile/tests/server.mjs`. It binds only localhost:4311 (override with `PORT`), seeds public audio fixtures and fixes test-only email codes to `12345678`. Production code never includes this code-delivery override.
- Build simulator binaries with `EXPO_PUBLIC_API_URL=http://127.0.0.1:4311` and `ASIDE_TEST_API=1`. Android requires `adb reverse tcp:4311 tcp:4311` and `adb reverse tcp:4312 tcp:4312` as needed for control transport. Peer ICE connectivity still uses local networking.
- Run Maestro flows in `mobile/tests` on each simulator and save reports outside Git. These exercise production app screens, native playback/recording, real Worker routes and a synthetic model peer; they do not prove real-model answer quality or production speech latency.

Never distribute a test-API binary as the default install. Rebuild without `ASIDE_TEST_API` and without the localhost API URL. Physical Bluetooth, calls, sustained locked-screen battery behavior, Personal Team installation, Ad Hoc and TestFlight signing are separate device/distribution acceptance checks.
