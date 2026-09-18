# Mobile compatibility with Responses voice changes

## Reviewed baseline

Synced `codex/mobile-responses-sync` to upstream `main` at `f9d7e65`
(PR #26), including PRs #15–26. The submitted-question persistence fix in
PR #14 is already merged and retained. The remaining open PR #27 only records
a production redeployment; it does not contain another API change.

The website now uses continuously listening GPT-Live with Responses delegation,
server-owned playback decisions and an admission gate for buffered answer audio.
Starting a spoken conversation pauses the episode. Follow-ups retain the anchor;
silence does **not** resume playback. The listener explicitly resumes by voice
or with the Continue control. The shared runtime also applies this hold policy
to native spoken answers.

This describes the current implementation, not the intended product contract.
The intended listening loop includes an automatic follow-up wait (3 seconds,
at least 8 seconds for a long answer, with a persistent manual hold option).
That timer still exists, but `engageLive()` and the spoken branch of
`consumeResult()` call `hold()`, while `scheduleFollowup()` requires `!held`.
Automatic resume after spoken answers is therefore an implementation/product
gap. Removing the hold alone would revive premature resume during thinking or
tool gaps; completion needs a reliable model-and-playback condition first.

## Compatibility and changes

- Native remains manual hold-to-talk: M4A transcription, `/question`, then Live
  spoken output. Its `/live` request omits `control`, so the provider retains
  client delegation. Enabling Responses delegation for native would require a
  separate continuous-input/audio-output implementation.
- Bearer email login, private media, upload and versioned checkpoint contracts
  remain compatible. Saved questions and completed conversation turns continue
  through the shared runtime. No schema or credential migration is needed.
- Production's authenticated Live lifetime is now configured to 1,800 seconds.
  The native adapter previously ignored the 60-second idle lifecycle policy;
  explicit waiting could therefore retain an unused paid connection until the
  server limit. It now releases idle Live resources while leaving playback
  paused and history intact. Recording, pending transcription, backend work and
  audible output prevent idle closure; renewed answer activity resets the timer.
- A remote `session.closed` or failed peer previously left the native instance
  enabled. It now releases the peer/audio ownership and becomes unavailable for
  reuse, allowing the next hold to create a fresh session. Late captions/stats
  are ignored, and a confirmed close is not followed by an unconfirmed duplicate.
- Native shows a paused/follow-up hint and hides the redundant Wait action when
  resume is already held. Expiry errors explain that the listener can ask again
  or resume. The focused Maestro flow now requires explicit resume instead of
  the superseded silence countdown.

## Verification

- `npm test`: 316 passed, including five new native lifecycle regressions. The
  first three new tests failed before the native adapter fix and passed after it.
- `npm run check`: passed (root, module boundaries, Cloudflare and mobile types).
- `npm run test:cloudflare`: 50 passed. The first invocation lacked FFmpeg on
  PATH; rerunning with the installed FFmpeg/ffprobe binaries passed.
- Initial PR CI exposed an upstream sideband test race: `engage` arrives before
  the lookup result on an independent channel, so checking the last tool return
  could see `c1` while expecting `c2`. The test now waits for the expected call ID
  (and continuation event for the first acknowledged control), with a bounded
  timeout, instead of relying on event arrival order or fixed 50 ms sleeps.
- `npm run build -w @aside/frontend`: passed.
- Player and preload coverage gates: passed.
- iPhone 16 Pro / iOS 18.3 simulator: Release build 17 built and installed with
  the updated source and a fresh local Worker/D1/R2 fixture on port 4342.
  Fixture email login and `mobile/tests/voice-resume.yaml` passed. Native capture
  and real WebRTC transport produced a synthetic answer; the episode remained
  paused for ten seconds after the visible reply. Explicit Continue resumed
  from the fixed anchor and retained the completed answer. Screenshots were
  visually inspected.
- Independent Worker checkpoint: version 15, with the first interrupted user
  question and a new completed user/assistant pair (`Question`, `A short answer`).
  The first UI run resumed before output completion and retained only its user
  question. The flow was tightened to observe the full output, wait beyond the
  old automatic-resume window and require the answer after resuming. The passing
  rerun and checkpoint establish persistence, not just transient text visibility.

Screenshots: [paused after the answer](../mobile-screenshots/ios-manual-wait-2026-09-17.png)
and [explicit resume with retained conversation](../mobile-screenshots/ios-explicit-resume-2026-09-17.png).

## Remaining scope and delivery status

Web's optional New conversation control, live microphone-level UI and PCM
admission buffer have not been ported to native. They do not require changing
the current manual API contract. Continuous hands-free conversation on mobile
remains a substantive functional gap with Web: enabling the microphone once,
listening while the episode plays, pausing for conversation and retaining input
when playback resumes requires native input, control-stream and audio-session
work. The pause/resume policy and the lifetime of microphone capture are separate
decisions; this compatibility patch does not deliver that hands-free experience.
The 60-second idle release in this patch belongs to the manual native adapter;
it must not be reused as a reason to close continuous listening between questions.

The existing Android recvonly transport limitation remains: the realistic RTC
fixture requires incoming media before generating spoken output. This iOS/shared
compatibility change does not certify Android spoken-answer playback.

All checks in this review use local fixtures and synthetic model/transcription
output; no paid model requests, real email or production deployment was made.
The connected phone remains on production build 16. Simulator build 17 is a test
artifact, and no new Android package or iPhone installation was distributed.
