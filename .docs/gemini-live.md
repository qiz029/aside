# Gemini Live

Cloudflare selects `gemini-3.8-live` for authenticated accounts matching both Flagship rules when `GEMINI_API_KEY` is configured and the client advertises `pcm: true`. Sessions already connected are not switched. Missing configuration, unsupported clients and untargeted accounts retain GPT Live. The local Node backend remains OpenAI; integration tests run the Gemini Worker with isolated D1/Flagship.

## Transport

`POST /api/episodes/:id/live` retains the SDP field for backwards compatibility. A Gemini response contains `provider: gemini`, a `gemini_` session ID, and `transport.websocketUrl`. That URL carries a 30-second, single-use ticket scoped to the owner, episode and session. It never contains a supplier key. The Worker enforces origin checks and the Durable Object consumes the ticket before opening Google's socket.

`GeminiSupervisor` owns the upstream and client connections, enforces the existing live lease/session limit/emergency stop, bounds client message sizes and rates, closes on either disconnect, and releases the lease. Supplier close confirmation controls finalized usage. Google binary JSON frames are explicitly read as ArrayBuffer. Setup has a 15-second timeout. A go-away ends the session; the existing renewable-session flow can establish a fresh session with history, without an automatic reconnect loop.

The protocol adapter reuses `LiveControl` and the application's acknowledgement of playback commands. Cancelled tool responses are suppressed. Audio and transcript events reuse the held-output gate. Context compression triggers at 16,000 tokens and retains 8,000; latest heard passages/player context are refreshed before input. Tools include playback control and heard-transcript lookups, without Google Search grounding. The direct Gemini voice path reasons and speaks with Gemini; typed/manual questions continue using the existing question backend, with Gemini reading the supplied final answer.

Web captures 16 kHz signed little-endian PCM with AudioWorklet and resamples Gemini's 24 kHz output to the device rate. iOS uses the existing voice-processing AVAudioEngine, 48 kHz capture, and native held-output queue. Native generation/epoch ownership prevents old sessions writing into a replacement queue. iOS requires a rebuilt app; an OTA JS update on a binary without `startPcm` cannot activate this transport. Android currently retains OpenAI because it lacks the PCM bridge.

The mobile notice version `2026-10-03` includes Google Gemini. Existing mobile consent remains valid for OpenAI; Gemini requires the updated notice. Revoking consent and account deletion close sessions through the matching provider supervisor.

## Credentials and rollout

Keep `GEMINI_API_KEY` in the ignored local `.env` and the Worker secret of the same name. Do not put it in Expo public variables, frontend assets, Flagship values or logs. Deployment adds the `GEMINI_LIVE` Durable Object binding and `v3` SQLite-class migration; it does not require a D1 schema change.

The existing voice ledger continues tracking session seconds, not Gemini charges. Workers Logs records Google's `usageMetadata` with the model/session ID, without transcripts or audio. Do not price these seconds using GPT Live's per-minute rate: Gemini bills input/output tokens and repeated context.

Verification: unit protocol tests, Miniflare account/capability/ticket/teardown tests, Chrome real AudioWorklet synthetic audio test, and iOS simulator build. Real API checks confirmed setup with all function declarations and Chinese PCM/transcript output. This is not a real-device microphone/echo-cancellation acceptance test.

Official protocol: https://ai.google.dev/api/live

## Deployment verification (2026-10-03)

Worker version: `1171e40a-08f4-4411-880b-8d4f2363ec6e`. Production includes the native `FLAGS` and `GEMINI_LIVE` bindings and the server-only Gemini secret. `GET /api/health` returns 200/no-store and OpenAI for anonymous clients. Flagship evaluation returns true/Gemini for the designated account and false/OpenAI for another account and an anonymous target. The deployed `index-D32X6lr9.js` matches the local production build byte-for-byte (SHA-256 `9accd205daff33513d6c190e26f2190902a19d4530da8893fcb60c2cf7ae91a7`).

79 Cloudflare integration tests passed; protocol/player tests, the native C packet queue test, Chrome AudioWorklet test and iOS simulator build passed. The full Node suite still has the same 7 Android/Java-dependent failures because this machine has no JDK. No TestFlight build was submitted, and no real iPhone microphone conversation was verified.
