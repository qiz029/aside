# Aside mobile

React Native / Expo SDK 54, iOS 15.1+ and Android 7+. Web and mobile share `@aside/engine` and `@aside/player-runtime`; native audio, credentials and file access stay in the mobile workspace. SDK 54 is pinned for Xcode 16.2 compatibility. The app never needs Metro after a Release installation.

## Local setup

Use Node 24 (`package.json` pins Volta), npm, Xcode 16.2+, Java 17, Android SDK and FFmpeg/ffprobe. Run `npm ci`. For iOS install the pinned CocoaPods/JSON gems using `bundle install` inside `mobile`, then use `bundle exec pod install` inside the generated `mobile/ios` directory. UTF-8 locale (`LANG=en_US.UTF-8`) is required by CocoaPods.

The root postinstall applies the upstream [expo-audio paused Now Playing fix](https://github.com/expo/expo/pull/44974) and explicitly resets recording mode to `.default` when category options are present. The latter prevents a previous WebRTC `.voiceChat` mode from leaking into a recording session. It also replaces expo-audio's Bluetooth HFP recording option with `.allowBluetoothA2DP`: with a car or headset connected, listening keeps the podcast and the answer on the A2DP output and captures from the iPhone's built-in microphone, instead of moving both directions onto the call-quality HFP link for the whole listening lease. Echo cancellation against an A2DP car route is unverified and needs a physical check. These pinned SDK 54 patches are idempotent and require review when upgrading the dependency. The media Docker image installs only backend/engine workspaces and skips native installation scripts.

- `npm run ios:device -w @aside/mobile`: local iPhone Release build/install. Sign with your Personal Team in Xcode and enable Developer Mode on the phone. Profile expiry requires re-signing, normally after seven days.
- `npm run ios -w @aside/mobile`: select an iOS simulator for Release testing.
- `npm run build:apk:local -w @aside/mobile`: generate an Android Release APK. Requires `JAVA_HOME`, `ANDROID_HOME`, `keytool`, and an installed Android SDK. It creates a persistent private signing key under ignored `mobile/.credentials`; keep a private backup to preserve update compatibility. Losing this key means existing installs cannot accept updates signed with another key.
- `npm run start -w @aside/mobile`: development client workflow only. Expo Go cannot host the native WebRTC module.

`APP_VARIANT=local` uses `com.asidefm.app.dev`; production uses `com.asidefm.app`. API defaults to `https://asidefm.com`. Configure `EXPO_PUBLIC_API_URL` at build time. Never include model keys or signing passwords in Expo public variables.

Local **signing** still defaults to the real online service and shares website accounts. Local **acceptance** is a separate, explicit `ASIDE_TEST_API=1` configuration with temporary fixture accounts and codes. Test builds identify that environment on the Account screen. Production distribution rejects the test flag, and ordinary builds reject localhost or non-HTTPS API URLs. See the current [release readiness correction](mobile-acceptance.md#release-readiness-correction) before installing a build for daily use.

## Android distribution

Android internal releases use the [Aside EAS project](https://expo.dev/accounts/jiahangzhang/projects/aside) under `jiahangzhang`. Run `npm run build:apk -w @aside/mobile` to build a standalone ARM64 APK with the existing release signing key and production API. Share the successful build's installation page with testers. See [Android distribution](android-distribution.md) for prerequisites, update compatibility and release checks.

## iOS distribution

Local signing, Ad Hoc (`internal`) and TestFlight (`testflight`) are maintained together. All build Release binaries with embedded JS. Local uses a separate bundle identifier so it can coexist with a production-channel install. Ad Hoc and TestFlight share the production bundle identifier and replace each other on a device.

After Apple Developer membership is approved:

1. Use the configured Aside Expo/EAS project and register the production bundle identifier in the approved Apple team.
2. `npm run build:internal -w @aside/mobile` registers selected device UDIDs and builds an Ad Hoc IPA. Share its EAS installation link. Adding a device requires re-signing or a new build.
3. `npm run build:testflight -w @aside/mobile` builds for App Store distribution. It does not submit automatically.
4. `npm run submit:testflight -w @aside/mobile` selects and uploads a build to the App Store Connect app. Configure the Apple team, ASC app ID and upload credentials through EAS; do not commit them.
5. Maintain tester groups in App Store Connect. External testers require TestFlight beta review; builds expire after 90 days.

To export an IPA file directly on a Mac, use `npm run build:ipa:internal -w @aside/mobile` for `mobile/Aside-internal.ipa`, or `npm run build:ipa:testflight -w @aside/mobile` for `mobile/Aside-testflight.ipa`. These use the same EAS signing profiles with local compilation and an explicit output file; they never submit automatically. The Ad Hoc IPA installs on registered devices. The TestFlight IPA goes through the separate submission command. Both require the approved Apple team, provisioning credentials and configured EAS project; a simulator `.app` cannot be repackaged into an installable device IPA. Personal Team installation uses the separate `ios:device` command while membership is pending. See [Apple's device-distribution guide](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices).

Android's local build command defaults to the production package `com.asidefm.app`, the online API and the persistent signing key. `APP_VARIANT=local` explicitly selects the separate development package. The build script regenerates native linking outputs when switching variants; it retains signing credentials and dependency build caches.

EAS uses remote incrementing build numbers. Local builds use `BUILD_NUMBER`, default 1. No OTA JavaScript update channel is enabled. Builds from a different signing team or bundle identifier do not promise credential or local-storage migration; users sign in to recover server-side audio and checkpoints.

## Backend deployment and compatibility

Apply `0006_mobile.sql` before deploying the Worker. It adds a session kind (`web`/`mobile`) and checkpoint version; old rows start at version 0. Website Cookie authentication retains Origin/CSRF checks. Native Bearer sessions do not require an Origin but must validate their own opaque token. Email start/verify native endpoints share the existing challenges and limits. Tokens are hashed server-side, expire in 30 days, and live in SecureStore on the phone. Logout revokes the current token and clears local private state.

Deploy the media Container with `/question` before setting `MOBILE_AUDIO_ENABLED=true` in a new Worker environment. An omitted flag disables native recording for rolling-deploy compatibility. Production now explicitly enables it after the decoder rollout. Native M4A requests require an account and existing trial budgets. Decoder accepts at most 2 MiB / 30 seconds, has independent bounded concurrency and temporary storage, rejects network input protocols, and revalidates converted PCM WAV before model calls. Web WAV input keeps its existing path. Voice usage `closed` explicitly asks the server supervisor to close a cancelled native session without claiming its final usage has been confirmed.

The media image includes runtime npm dependencies and the FFmpeg/ffprobe shared libraries. Development dependencies, npm caches and desktop GPU drivers are excluded. `tsx` is an explicit backend runtime dependency because the image executes TypeScript directly. After building an image, run `npm run test:media-container -- aside-media:local` to verify its actual boot, M4A conversion/rejection, episode segmentation, JPEG cover extraction and cleanup. CI runs the same check against its built image; no model calls are involved.

Checkpoint GET returns `version`; PUT sends that version. A stale write returns 409. Both clients serialize writes and let users choose local or remote state on conflict. Old web bundles must be refreshed after this release: unversioned writes only succeed against version 0. Future rollback must preserve the compare-and-swap contract rather than restoring unconditional writes.

Uploads use the existing R2 multipart endpoints and retain acknowledged parts for retry. iOS transfers run through a background URLSession; Android retains its resumable JS transfer. After completion is submitted, analysis continues on the server. Shared upload limits remain 1 GiB / 5 hours and per-account quotas. See the account and upload update below for lifecycle details.

## Audio lifecycle

On iOS, the config plugin includes `native/AsideAudioSession.m` in the application target. The audio coordinator stops WebRTC's audio unit before deactivating/reconfiguring the Expo audio session; only answer playback grants WebRTC permission to restart it. Muting a remote track alone does not release the underlying audio unit. Every generated native build must include this module. Default speaker routing still respects connected headsets.

The global player survives navigation. `expo-audio` owns podcast media and manual M4A capture. **Start** enables foreground continuous conversation: the podcast keeps playing, local speech detection lowers its volume, and the server decides whether to pause for an answer. Accepted follow-ups keep the first question's semantic resume anchor. **Stop** releases the microphone and Live connection; hold-to-talk remains available.

iOS supplies microphone PCM through its custom WebRTC audio device with voice processing. Android's pinned WebRTC 124 adapter intercepts AudioRecord and AudioTrack boundaries through AGP instrumentation. Both platforms buffer output before admission, preserving the first words; captions follow native playout. Manual mode sends a silent media clock without keeping the hardware microphone open between recordings. The native output queue has a 30-second bound; overflow terminates the reply with an actionable error.

Mobile automatic continuation requires the completed backend answer, matching heard captions, and a drained native output queue. It then waits 3 seconds, or at least 8 seconds for a long answer. Player options offer 3 seconds, 8 seconds, or manual continuation. Wait holds the podcast until an explicit Continue. Missing or paraphrased captions require manual continuation. Web retains its existing spoken-resume policy through the shared runtime's default; mobile explicitly opts into this native completion policy.

On background entry, podcast playback continues using OS media services and lock-screen controls. Unfinished capture/questions/answers are cancelled, live transport closes, and the episode stays paused at its resume anchor until the user resumes. Native lifecycle handlers revoke capture even while JavaScript is suspended. System audio interruption closes voice and holds playback; returning to the foreground never opens the microphone automatically. Permissions are requested at the first explicit voice action; after a hold-to-talk permission prompt, the next hold records. Late permission results cannot begin recording after the finger is released. A manual question is capped below 30 seconds to allow codec padding.

After backgrounding, conversation returns to manual mode. Lock-screen Play resumes only the podcast; Start in the foreground explicitly enables continuous capture again. The installation records its own Live session ID in SecureStore. After a process restart it requests closure of that session before another connection; it never enumerates or closes other devices' sessions. Offline cleanup remains pending for the next explicit voice action. Account changes cannot authorize cleanup under a different credential.

Text answers use native `expo/fetch` streaming and opt into NDJSON answer previews with `X-Aside-Answer-Stream: 1`. Old clients retain progress/result compatibility. Partial text stays separate from completed history; cancellation, stale revisions and tool rounds clear it. Only a completed result enters the synchronized checkpoint. The composer clears as soon as submission is accepted, while the answer is still pending.

With voice already connected, typed questions also speak their answers through that connection. Otherwise text questions remain text-only and do not create a Live connection. The conversation follows new content until the listener scrolls into history. Playback settings live in the header menu, and the keyboard leaves the composer visible.

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

## iOS account and upload improvements (2026-09-21)

Apply `0011_mobile_accounts.sql` before deploying this backend. The mobile build
uses `/api/auth/consent` before uploading or sending questions. Listening to
prepared audio remains available without consent. The in-app notice and public
`/privacy.html` are generated from `mobile/src/privacy-policy.ts`; regenerate
with `node --import tsx scripts/generate-privacy.ts`. Configure a verified privacy
contact address before store submission; the current notice links the existing
public project support page and asks users not to post private data there.

Account deletion requires the explicit DELETE confirmation, immediately disables
all sessions and hides owned content. `cleanupAccount` removes original files,
analysis artifacts, avatars, conversations, usage rows, identities and user data;
Apple refresh tokens are revoked first. The existing five-minute scheduled job
retries failed cleanup. Monitor users with a non-null `deleted_at`; a prolonged
provider failure must not be treated as completed deletion. Apple refresh tokens
are encrypted under a key derived from `SESSION_SECRET`; retain this secret until
all such tokens are migrated or revoked when rotating it.

### Enabling Apple sign-in

Apple sign-in is intentionally disabled by default, including Personal Team
builds. No Apple credentials are included in this repository. Until configured,
the app keeps email sign-in and hides the Apple button.

1. In a paid Apple Developer team, enable Sign in with Apple for each intended
   bundle identifier (`com.asidefm.app` and optionally `com.asidefm.app.dev`).
2. Create a Sign in with Apple key. Configure Worker secrets `APPLE_TEAM_ID`,
   `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` (the complete PKCS#8 `.p8` content).
   Configure `APPLE_CLIENT_IDS` as a comma-separated allowlist of those bundle IDs.
   Use `wrangler secret put --config wrangler.production.jsonc` with stdin or the
   interactive prompt; never put private keys in shell arguments or source files.
3. Set `ASIDE_APPLE_SIGN_IN=1` for the EAS/local build, regenerate the native project
   and provisioning profile, install pods, and build a new binary. This flag adds
   the native capability and enables the button only if the backend is configured.
4. On a real device, test first sign-in, returning sign-in, cancellation, hidden
   email, linking to an email account, signing out/in, and deleting the account
   with authorization revocation. Server tests use generated synthetic Apple keys
   and are not evidence of a real Apple login.

An existing email account is never silently merged using an Apple email claim.
Existing listeners sign in with their original email and use the Apple button
in Account to link the identity. The Apple subject is the stable identity;
hidden relay email does not change the linked library. Logging in after trying
to upload or ask restores that intended action and the current question draft.
Manual recording still requires a new press after sign-in.

### Background upload behavior

On iOS, `AsideUploadManager` uses a background URLSession with file-backed
requests. Native delegates advance 8 MiB parts and submit completion without
relying on JavaScript running. A protected, backup-excluded Application Support
manifest records each acknowledged part; its bearer token is in Keychain with
AfterFirstUnlockThisDeviceOnly access. Relaunch reattaches to the same session.
Failed transfers retain their journal and can be retried; the 24-hour server
upload expiry still applies. iOS controls scheduling, and user force-quit can
stop system transfers until the app is opened again.

Android keeps its JS transfer but persists acknowledgements and the selected
file, so returning/retrying can resume parts instead of starting a new upload.
This does not claim Android background execution. Cancel and sign-out clear
local pending files and attempt to abort the server upload. The server also
expires abandoned pending uploads. Successful upload clears local transfer data.

Acceptance: run the account/security tests, resume tests, and an iOS Release
build. On a device, start a multi-part upload, press Home, lock the screen, and
verify the server receives subsequent parts and completion before reopening.
Repeat with a network interruption and process restart; check that the upload ID
and acknowledged parts are reused. Verify cancellation stops further requests.
A simulator/build pass alone does not establish physical-device scheduling.

### Xcode 27 scene lifecycle

`AsideSceneDelegate.swift` owns the single UIKit window and starts Expo's existing
React Native factory from `scene(_:willConnectTo:options:)`. The config plugin
moves window creation out of SDK 54's AppDelegate template and adds the scene
manifest. Cold/warm URL and user-activity events are forwarded to the existing
Expo/React Native linking handlers. Background URLSession events still go through
AppDelegate, including launches that do not create a UI scene.

This fixes the observed `UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`
startup trap when building with Xcode 27. See [Apple's scene migration guidance](https://developer.apple.com/documentation/uikit/transitioning-to-the-uikit-scene-based-life-cycle).
When using the current Xcode locally, the legacy AsyncStorage resource pod also
needs `IPHONEOS_DEPLOYMENT_TARGET=15.1` passed to xcodebuild (some pod targets still
default to 13.4, below this SDK's supported range).
