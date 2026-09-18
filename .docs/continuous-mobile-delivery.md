# Continuous conversation delivery

Goal: close the native gaps described in the Aside conversation-loop artifact,
then deliver installed iOS and distributable Android candidates for user acceptance.
The compatibility PR #28 is a baseline, not completion of this goal.
User scope correction: do not change Web behavior. Shared runtime extensions must
be opt-in for mobile and preserve the existing Web policy and tests.

Current requirement-by-requirement evidence and open gates:
[mobile acceptance index](mobile-current-acceptance.md). It distinguishes current
regressions, older native evidence, production observations and outstanding device
or product decisions; the historical records below remain dated evidence.

## Main compatibility — 2026-09-18, `bdc90b1`

Merged main through `bdc90b1` into PR #29, preserving the published branch history.
Both deployment histories are retained. Server-controlled voice now universally
uses backend-owned programme context, following main's `2fc3ff6`; the obsolete
mobile-only context switch is removed. Client-controlled and manual questions
keep their context. Native verified completion, speech ducking, fixed continuation
anchors and stale-tool cancellation remain intact.

Main's early Jev ignore/pause/resume decisions and `0009_jev_acted.sql` are included.
The early-decision tests now cover both Web and mobile, including a backend answer
that reverses an early ignore. All 437 application tests and type/module-boundary
checks pass; all 51 local Cloudflare integration tests pass, including the actual
Web/mobile NDJSON and sideband paths. No live model or email is used for these regressions.

This synchronization changes the PR, not the installed native candidates or the
production Worker. Main's deployment record reports Worker
`6d2870f2-fa97-4c5e-86c4-4b722e1ce9ab`, which excludes the unmerged mobile backend;
the earlier `bb4dd397` entry below is historical. Production reconciliation remains
a separate release action. iPhone 43 and Android 20 retain source `2f7466b`.

## Native UI — 2026-09-18, compact question tools

Source `2f7466b` replaces the stacked idle voice heading, text field and recording
row with a compact question toolbar. Drafts survive closing the composer; sending
clears them, and microphone status/Stop remain visible while typing. The hold target
stays in place as capture guidance appears. Library headings now scroll with their
items; the options sheet keeps Done visible while its content scrolls. These fix
observed failures at the maximum accessibility text size on an iPhone SE.

Native build 42 passes both platforms' unique typed submission, manual recording
with an actual new question/reply, ten-second manual hold, explicit resume, slide
cancellation, foreground pause and microphone-off controls above the keyboard.
The preceding build 40 passes actual RTC continuation and completed-answer replay
suppression with the same voice callbacks. Local tests: **425 passed**; types and
[full CI](https://github.com/qiz029/aside/actions/runs/35328473929) pass. Supplier
responses are fixture data; no real model or email was used for this update.

**iPhone Release 43** is signed, installed and launched over the existing local
network pairing. Device information confirms native version 43. API is
`https://asidefm.com`, fixture mode and OTA are off, and the existing profile
contains the user's phone. An initially disconnected development tunnel was
successfully opened; the device does not need reconnecting for this installation.

**[Android 20](https://expo.dev/accounts/jiahangzhang/projects/aside/builds/3af84051-5f8f-4436-b02d-4c6a56b56392)**
is ready for internal distribution. The APK retains certificate
`a1145c78a613303fc04edb9b6352d7a00ffa0b6c971ea59a03f50798df9e597f`,
upgrades version 19, and passes real catalogue, transcript and Account checks
against `https://asidefm.com`. Native version 20 is confirmed after installation;
fixture mode and OTA are off. [Download APK](https://expo.dev/artifacts/eas/cTxZdyzfiibeT3SlAMTAVqJO7IAAhuYemV8qeLWTXNU.apk).
This smoke performs no model, transcription or email request.

Evidence: [compact UI verification](mobile-evidence/compact-ui-2026-09-18.json),
[design review](mobile-design.md), and [current acceptance index](mobile-current-acceptance.md).
The backend remains `f559178` / Worker `bb4dd397-dcf6-49d1-8921-1c062ac179db`.
Web product behavior is unchanged. Supplier audio boundaries and the remaining
physical-device/signing gates below remain open; PR #29 stays a draft.

## Current backend — 2026-09-18, stale tool follow-up correction

Source `f559178` closes a separate application-owned race: a pending playback
tool could finish after a manual playback change, a new utterance or session close,
then admit its old follow-up and request another backend response. All three cases
failed before the correction. Mobile now rechecks the original delegation, input
and playback version after the acknowledgement. It settles an outstanding tool
result without reopening its answer or sending a stale `response.create`.
Current mobile tools and replacement questions still work; Web behavior is retained.

425 tests, type/boundary checks, the Web/mobile Cloudflare sideband regressions
and [full CI](https://github.com/qiz029/aside/actions/runs/35324139889) pass. The
Cloudflare mobile scenario cancels a real pending NDJSON decision, observes its
sideband tool result without a continuation, then completes a new question.

Additional Android system acceptance now passes on the existing build-38 fixture:
an emulator GSM incoming call interrupts an audible ten-second synthetic answer.
Android telephony confirms RINGING; AudioService shows the native recorder active
before the call and released afterwards. Returning to the app leaves the microphone
off and the programme paused beyond the normal follow-up window, preserves the
anchor and question, and releases the supplier session. `phone-call.mjs` repeats
this test and refuses physical device IDs. Native source is unchanged; its fixture
server was `7ed30db`. This validates Android system interruption, not iOS telephony
or physical headset routes.

Remote main was still `25e1621`; the preceding deployment author/version matched
our `62fe977a` publication. Worker `bb4dd397-dcf6-49d1-8921-1c062ac179db` now includes
the stale-tool correction, retaining the media container and Secrets. Four auth
smoke checks pass; iPhone 39 / Android 19 need no rebuild. No real model, email
or telephone call was made. Evidence:
[stale tools and Android interruption](mobile-evidence/continuous-stale-tools-2026-09-18.json).

Unlabelled overlapping supplier speech remains a distinct limitation. The user
has been asked whether to retain Live with this boundary or change the answer
audio channel to obtain per-answer isolation. That architectural choice is pending;
the goal and draft PR remain open.

## Previous backend — 2026-09-18, main `25e1621`

Rebased the mobile branch onto `25e1621` without conflicts, preserving main's
Jev shadow evaluation and deployment documentation. Runtime source `7ed30db`
passes 421 local tests, type/module-boundary checks, both focused Cloudflare
sideband paths and [full CI](https://github.com/qiz029/aside/actions/runs/35323289839).
Web product source still matches main.

Re-reading the successful physical speaker trace found two backend formulations
of one question but only the later formulation in the accumulated spoken captions.
That trace alone does not establish two audible answers. The previous completion
metadata retained the first wording, which could leave an actually completed
reply waiting for manual continuation. The server now observes at most two
additional tool-free formulations and updates the original decision only after
completed text matches output captions. No duplicate turn or player tool is
admitted, and no extra model request is sent by this correction. The native client
still owns heard history and must confirm matching captions and drained PCM.
New input, manual state changes and finished/interrupted answers invalidate the
observer; late events cannot revive an older turn.

The existing iOS/Android build-38 fixture apps both pass this case against the
updated backend, with actual RTC/native playback, one question/answer in history,
no programme/reply overlap and after-completion replay rejection. Observed waits
after native completion: iOS 3,001 ms, Android 3,101 ms (200 ms sampling).
Supplier output is synthetic; this does not measure model quality. The installed
iPhone 39 and distributed Android 19 use the same protocol and need no rebuild
for this server-side correction.

Before deployment, remote main and the production author/version were rechecked:
main was `25e1621`; the preceding Worker was Todd's `99cfb905`, containing Jev
but omitting the unmerged mobile policy. Worker
`62fe977a-e6e6-42a2-ad06-dbf1febcb115` now contains both. Deployment retained the
media container and existing secrets; four read-only mobile-auth/Origin checks
pass. Future main-only deployments can still remove the unmerged mobile policy.
No paid model or email request was made during this validation.

Evidence: [answer-variant compatibility](mobile-evidence/continuous-variants-2026-09-18.json).
The distinct artificial case where two supplier replies actually overlap remains
unresolved, as recorded below. Physical natural continuation, local barge-in
quality, headset/call handling, the visible iOS lock-screen card and paid Apple
distribution remain acceptance items. PR #29 remains a draft.

## Native candidate — 2026-09-18, iPhone 39 / Android 19

Source `b685f13` integrates main through `6164f99`, including the decision-wait
expiry and continuation diagnostics. Unclassified brief input no longer strands
the follow-up window. Mobile retains its native-completion and accepted-answer
blockers, speech ducking, explicit microphone enablement and 3/8-second policy.
Two added regressions show that input expiry cannot bypass unconfirmed native
playout. All 406 local tests, type/boundary checks, the affected 23 Web voice
scenarios and [CI](https://github.com/qiz029/aside/actions/runs/35320848578) pass.
Web product source matches upstream. Earlier full-browser coverage is recorded
below; only the affected voice scenarios were rerun for this final merge.

Both native build-38 fixtures pass actual RTC/native output, completed-answer
replay rejection, ignored speech and anchored follow-ups. The long-answer waits
were observed at 8,050 ms on iOS and 8,233 ms on Android (200 ms sampling).
Normal iPhone 39 is signed, installed and launched, with native/Expo build numbers
verified. Android 19 retains the fixed release certificate, upgrades 18 and passes
read-only real catalogue/transcript/Account checks. Both use production API and
embedded JS with test mode, OTA and temporary diagnostic helpers off.
[Android 19 installation](https://expo.dev/accounts/jiahangzhang/projects/aside/builds/18115024-dfe0-4a7e-8671-4b38389d64ad).
Evidence: [latest candidate verification](mobile-evidence/continuous-noise-2026-09-18.json).

At this candidate's original publication, the deployment author/version was checked against the known
upstream `6c57ab56` deployment. Worker `3cc34209-2d82-4e88-8c5e-a0dedc7beda5` then
contained both that upstream fix and the mobile backend policy; read-only
authentication smoke passes and the media image is retained. A future deployment
from main alone can still remove the unmerged mobile backend changes. PR #29's
source and this deployment must be considered together until integration.

The unfinished-answer duplicate supplier audio limitation remains unresolved;
see the build-34 probe below. Physical natural continuation, local barge-in quality,
headset/call handling and the visible iOS lock-screen card remain user acceptance.
Paid-account Ad Hoc/TestFlight signing remains pending. No agent-paid model or
email request was made in this turn.

## Previous candidate — 2026-09-18, iPhone 37 / Android 18

Integrated main through `4d8003f` in `5dbcfe2`, including backend `answered.final`,
Web's quiet continuation policy and the temporary barge-in hold. Mobile explicitly
keeps speech ducking, a three-second default, at least eight seconds for long
answers and verified native completion. A non-final tool-progress reply cannot
close the audio window or resume playback. A new answered question clears a
barge-in hold; the listener's explicit hold remains until Continue. Mobile still
requires the user to enable continuous capture; Web's play-to-listen change is
preserved as upstream behavior. No Web product source differs from main.

403 local tests, type/boundary checks and both Cloudflare sideband paths pass.
[CI for `cb5774a`](https://github.com/qiz029/aside/actions/runs/35319924745) passes.
The complete Web run passed 69 of 70 scenarios; the remaining scenario contained
an obsolete assertion that spoken replies never auto-resume. Its test now checks
the upstream countdown followed by the listener's explicit hold, and the focused
rerun passed. Web product code was unchanged by that test correction.

Both native build-36 fixtures pass actual RTC/native playback, completed-answer
replay rejection, ignored speech, anchored follow-ups and 3/8-second continuation.
Normal iPhone 37 is signed, installed and launched. Android 18 uses the same fixed
production certificate and production API. Both use embedded JS with fixture mode
and OTA disabled. Android 18 upgrades 17 and passes real catalogue/transcript/Account
checks. [Android 18 installation](https://expo.dev/accounts/jiahangzhang/projects/aside/builds/2086c3fe-2b3b-480c-bd82-0c42320e5a55).
Worker `11ef1749-b9a4-4a87-bc99-a051993b3034` is deployed; authentication smoke
passes and the existing media image is retained. This turn made no paid model or
email request.

Evidence: [latest merged-source verification](mobile-evidence/continuous-upstream-2026-09-18.json).

The unfinished-answer duplicate-audio limitation reproduced below remains open;
the final-answer flag protects completion timing but supplies no per-reply PCM
identity. PR #29 remains a draft. The physical acceptance items below remain
distinct from the passing simulator checks.

## Previous candidate — 2026-09-18, iPhone 35 / Android 17

Merged upstream #33 (`bc951fd`) into `5d74781`, resolving the player conflict while
retaining mobile's asynchronous programme fade before answer playback. Local speech
now cuts an audible reply immediately, preserves its heard prefix and keeps the
programme paused. Regressions exercise both Web's explicit policy and mobile's
verified continuation, including first-connection HTTP replies and a late drain
after interruption. Web source remains identical to upstream.

394 local tests, type/module-boundary checks and all 22 Web voice regressions pass.
[Source CI](https://github.com/qiz029/aside/actions/runs/35318521978) passes, including
Cloudflare and the media container. Both native Release fixtures (build 34) pass
actual RTC input/output, verified drain, after-completion replay suppression,
ignored speech, anchored follow-ups and the long-answer wait. No new paid model
or email requests were made.

The separate `mobile/tests/overlap.mjs` probe now reproduces a remaining limitation
on **both platforms**: a second supplier audio response can be heard while the
first admitted answer is unfinished. Backend admission is rejected, but the single
audio stream has no reply identity for that boundary. Both apps keep the programme
paused, show Continue and recover on a genuine follow-up. These safeguards pass;
**during-playback duplicate audio suppression remains unresolved**. Do not replace
this finding with the passing after-completion replay test.

Normal iPhone Release 35 is signed, installed and launched. Native and Expo versions
both read 35. Android EAS 17 uses the existing production key, upgrades build 16 and
passes real catalogue/transcript/Account checks. Both releases use asidefm.com,
disable test mode and OTA, and contain no temporary diagnostic helper.
[Android 17 installation](https://expo.dev/accounts/jiahangzhang/projects/aside/builds/e7ceac6c-d62f-4a0b-90e0-0cc51a67adbb).
Worker `fc415100-4350-4820-a29b-8f51a4d5d764` contains latest main and mobile changes;
the existing media image is retained and read-only authentication smoke passes.

Evidence: [interruption and release verification](mobile-evidence/continuous-barge-2026-09-18.json).
The user's built-in-speaker confirmation remains recorded below. Natural spoken
continuation, physical quality of the new local interruption behavior, headset/call
handling and the visible iOS lock-screen card remain device acceptance. Paid Apple
Ad Hoc/TestFlight signing remains pending. This candidate does not close every
conversation quality gap; PR #29 remains a draft with the duplicate-audio finding.

## Previous candidate — 2026-09-18, iPhone 33 / Android 16

Mobile now explicitly requests its conversation policy. Responses receives the
initial observed player state and subsequent interruption/assistant transitions,
even when the paused playhead stays within one passage. Native progress ticks and
streaming caption fragments do not resend this context. After the admitted answer's
captions match and native playout drains, the client reports `finished` and closes
that answer's audio window. A later admitted question opens its own window.

A second delegation for the same already-answered input cannot re-engage, append a
second answer or execute player tools. New utterances and new fragments after
wait/ignore remain eligible. Already-started supplier work can still incur usage;
the guard does not claim to cancel that work, and its usage stays in the ledger.

The branch incorporates upstream PR #32 (`d726765`), including explicit transcript
input before a missed-delegation request. Merge conflict resolution retains both
the upstream input assertion and isolated Web/mobile control-stream coverage.
Web source matches upstream; the new conversation policy is mobile-only.
All 21 Web voice regressions pass after the merge.

Verification: 390 local tests, type/module-boundary checks, both Cloudflare control
paths and [source CI](https://github.com/qiz029/aside/actions/runs/35317294850) pass.
Both native simulators pass actual RTC playback with a deliberately repeated
delegation/audio after completion, then genuine follow-ups on the original anchor,
ignored speech and the eight-second long-answer wait. This test uses deterministic
external model output and does not establish natural-language intent accuracy.
It also does not prove suppression of supplier audio that overlaps an unfinished
admitted answer. Agent-paid model calls remain zero.

Normal iPhone Release 33 is signed and installed, with production API and no test
mode or temporary diagnostic helper. Native and Expo build numbers both read 33.
The phone was locked, so automatic launch was refused. Local iOS commands now
regenerate native configuration before building, preventing a stale native plist
version. Android EAS 16 is built with the existing production signing key and
production API, test mode and OTA off. Its APK upgraded the production package
on the emulator, then passed read-only real catalogue/transcript/Account checks.
[Android build 16](https://expo.dev/accounts/jiahangzhang/projects/aside/builds/4b56aa15-5df6-46f7-9d4c-390907ffb945).
Evidence: [current state](mobile-evidence/continuous-state-2026-09-18.json).

Remaining physical acceptance: natural continuation intent, overlapping supplier
reply behavior, headset/call interruption and the visible iOS lock-screen card.
Paid-account Ad Hoc/TestFlight signing remains pending account approval.

## Required acceptance evidence

- [ ] iOS and Android: enable automatic mode once, stream microphone input while
  the podcast plays, show input activity and a clear connection state.
- [ ] Speech ducks the podcast promptly; accepted conversation fades and pauses;
  irrelevant input restores volume without committing a conversation.
- [ ] Continuous Responses delegation uses authenticated control streaming and
  execution acknowledgements; late events cannot affect a replacement session.
- [ ] Buffer answer PCM before admission; play the prefix once, release captions
  with audible output, bound buffering, and surface overflow/errors.
- [ ] Interrupt an answer and ask follow-ups without another hold gesture; retain
  one interruption anchor and preserve submitted/heard conversation history.
- [ ] iOS and Android: completed spoken answers enter the configured 3/8-second
  follow-up countdown; long answers wait at least eight seconds. Backend work,
  unplayed audio, thinking gaps, new speech, drafts and manual hold prevent resume.
  Missing reliable completion evidence requires an explicit, visible Continue.
- [ ] Resume at the semantic anchor, keep continuous input alive, and support the
  next conversation. Manual pause/off/background capture closes the microphone.
- [ ] Text questions clear immediately and stream; when voice is connected,
  speak the answer. Listen-only text questions require no new voice connection.
- [ ] Preserve manual hold/release/slide-cancel/30-second limit and fix Android's
  missing media input clock. Include new-conversation reset and input-level UI.
- [ ] Background podcast playback, lock controls, permission denial, headset/call
  interruption, expiry/reconnect, account isolation and checkpoint sync regressions.
- [ ] Native UI review on both simulators: clear header/content/control hierarchy,
  legible states, accessible controls, keyboard, dark/light and Chinese/English.
- [ ] Unit/runtime, native PCM, browser, Cloudflare, simulator and CI evidence;
  one bounded real end-to-end session after fixture validation, with cost recorded.
- [ ] Production backend deployed only as needed; production-configured iPhone local
  install, fixed-key Android APK/EAS distribution, branch and PR ready for acceptance.

## Implementation notes

Do not apply manual-mode idle cleanup to continuous listening. The current upstream
unconditional spoken-answer hold remains Web's default. Mobile opts into
completion-aware scheduling. GPT-Live has independent backend, caption and audio streams;
backend completion alone cannot establish that the listener heard the answer.

No item is accepted merely because a mock returns a successful response. Native
capture, transport, actual queued output, saved checkpoints and installed artifacts
need their own evidence. Paid calls are reserved for the final bounded smoke.

## Implementation and current evidence — 2026-09-17

Feature branch: `codex/continuous-mobile-voice`. PR: https://github.com/qiz029/aside/pull/29.
No Web source files changed. Shared spoken continuation is opt-in (`verified`);
Web retains its explicit policy. The branch includes compatibility PR #28.

### Native conversation

Implemented continuous microphone capture, local speech activity and volume ducking,
authenticated NDJSON control/acknowledgements, bounded PCM admission queues, paced
captions, verified 3/8/manual continuation, follow-up anchors, connected typed
answers, interruption cleanup, account-bound orphan-session recovery, input meters,
conversation reset and playback-options UI. Manual AAC capture remains available.
Background closes conversation capture and resets microphone consent; subsequent
Play can resume the episode without opening the microphone. Sign-out removes this
account's recovery credential.

The C and Java native queues pass identical sample-trace tests. Extended simulator
runs on both platforms observed actual incoming RTP and rendered output, verified a
drained queue before the continuation timer, ignored irrelevant speech, and retained
one anchor across follow-ups. There was no podcast/answer overlap. Long answers
waited 8.166 seconds on iOS and 8.248 seconds on Android. iOS recovered its own
force-quit session in 2.231 seconds without creating another Live session.
See `mobile-evidence/continuous-native.json`.

These are native transport/coordination results with deterministic external model
responses. They do not measure physical microphone quality, acoustic echo,
Bluetooth routing or production-model accuracy.

### Interaction and visual review

Light/dark, Chinese/English and keyboard/settings flows passed on both platforms.
iPhone SE at the extra-extra-extra-large text setting was inspected for clipping;
its player, composer and settings remained operable. Screenshots are in
`mobile-screenshots/continuous-*`.

Long-history review caught two distinct issues: programmatic iOS scrolling could
turn off following, and FlatList's estimated end position could hide the newest
variable-height reply. The conversation now renders newest-first in an inverted
list, so the latest message is at exact offset zero. User scrolling can still stop
following. A unique-question flow checks the partial stream, empty composer and
completion of that request; actual screenshots are also inspected because native
accessibility alone can expose text outside the visible viewport.

On the final iOS fixture, manual AAC recording/transcription and native answer
playback passed; manual continuation remained paused beyond ten seconds and
resumed only on Continue. Denied permission showed the Settings recovery action.
Backgrounding continuous mode closed it, and subsequent Play kept the microphone
off. Slide cancellation and Android final interaction checks are recorded below
when complete.

### Verification

- 360 unit/application tests passed, including native C/Java queues, late events,
  cancellation, account isolation, request deadlines and checkpoint versions.
- TypeScript and module-boundary checks passed.
- Web regression: one complete run passed all 66 scenarios (3.3 minutes). Earlier
  startup timing flakes passed when rerun; no Web fix was introduced.
- Cloudflare service regression passed in CI. Read-only production checks passed
  for mobile authentication routing, Bearer validation and website Origin checks.
- Final release and duration evidence is still being completed below.

Local acceptance binaries require an explicit loopback test flag and must never be
distributed. Release candidates use `https://asidefm.com`, test flag off, embedded
JS and no OTA updates. Android retains the existing release signing key.
Ad Hoc/TestFlight configuration remains available but paid Apple signing acceptance
is pending the user's account approval.

### Remaining acceptance evidence

- Physical speaker input/answering was confirmed by the user on build 30.
  Remaining quality cases: natural continuation intent and duplicate backend
  answer events for one input; see the comparison notes below.
- Normal iPhone build 31 is signed, installed and launched with diagnostic code
  removed. Android build 15 is built and its fixed signature/upgrade installation verified; keep the remaining quality cases
  visible in PR #29.
- Physical headset/call handling and the visible iOS lock-screen card need device
  confirmation. The current simulator's system commands work (see below).

### Physical continuous-voice acceptance blocker

iPhone build 27 (source `8bc7f96`, production API) was installed. A short Chinese
definition question lowers programme volume but does not pause or answer. The
production sideband observes input transcript fragments but no Responses
delegation or backend question execution for that attempt. The logged character
count describes only the first fragment, not the complete utterance.

Diagnostic build 28 is signed and installed on the same physical iPhone, using
`https://asidefm.com` with the test flag off. The user reproduced intermittent
failure with the iPhone's built-in speaker. One trace recognized the complete
question, admitted a backend answer and rendered native PCM; that answer still
explained the wrong term. Another trace contained incomplete recognized phrases
and repeated `wait_for_input` results without an admitted answer. This is not a
successful release acceptance.
Temporary device-local instrumentation records transcript events,
control events and native/RTC counters; no login credential is recorded. This
diagnostic source is retained only in `/tmp` and removed from the repository
after bundling. The cause and final physical acceptance remain unverified. Do not
mark continuous voice ready or distribute build 28.

### Context-flood reproduction and mobile-only correction

The build-28 trace exposed duplicate programme-context appends at native player
status cadence. During a gap between transcript passages, `current?.startMs` was
`undefined` while the remembered sentinel was `-1`, so every 250 ms tick appended
the same programme text to Live. The backend already maintains Responses'
transcript window from acknowledged player state.

A new runtime regression reproduced 20 duplicate appends during a five-second
gap. Mobile now opts into `liveContext: "server"`: automatic Responses sessions
use that single context owner and still synchronize playhead, seek and pause.
Manual context and Web's default client policy retain their existing behavior.
The reproduction failed before this change and passes after it. All 380 root
tests, type checks and the merged Cloudflare sideband regression pass.

Upstream PR #31 has been merged into this branch. Its missed-delegation fallback
is visible in production, including the unsuccessful physical trace. Adding a
fallback alone therefore does not establish that the full question was heard or
answered. Removing duplicate context is a verified defect correction; its effect
on physical speech recognition and answer quality still needs a bounded device
comparison. Do not treat it as proof that the intermittent failure is fixed.

### Physical build-30 comparison

The user confirmed that built-in-speaker questions now work after installing
diagnostic build 30. Its trace contains no client programme-context appends and
shows a complete short definition question, backend admission and rendered native
answer PCM. The captured session closed normally with supplier-reported Live
usage of 89 seconds. This was the user's existing test; the agent made no new
paid model call. Raw device transcripts remain outside the repository.

This closes the observed speaker-input/no-answer blocker for that bounded test.
It does not prove universal intent accuracy: the trace also contains an ambiguous
spoken continuation interpreted as more explanation (an explicit playback request
subsequently resumed the programme), and two backend answer events for one input.
Track these provider/delegation quality cases separately; do not claim all real
conversation behaviors were verified. Current source CI passes:
https://github.com/qiz029/aside/actions/runs/35314729307.

### Additional fixture evidence

Both platforms completed 30 actual minutes of background native playback: iOS
1,802.17 seconds elapsed with native position 1,805,762.79 ms; Android 1,802.30
seconds elapsed with native position 1,808,758 ms. These duration runs used build
18, with unchanged native programme playback. Android's system media control
subsequently paused playback. On final iOS fixture build 26, operating-system
media commands also paused, played and paused the native AVPlayer; Now Playing
metadata reported rate 0, 1 and 0 with the correct episode. After the play event
settled, the app reported `playing` and its microphone remained off. These are
actual system-command results, not app-button simulations. The simulator does
not render the visible lock-screen card; the earlier independent plain AVPlayer
probe had the same limitation. Card appearance remains a physical-device check.

After merging upstream spoken-answer history ownership, iOS and Android build 26
passed the local native continuous-conversation flow. Android EAS build 14 has
been downloaded, its fixed production certificate verified, and it installed
over the previous production package while retaining app data. Physical voice
acceptance above remains the release blocker.

Android build 26 also passed the unique-question streaming flow: partial text,
cleared composer and complete latest reply. The screenshot was visually checked
to confirm both this question and this answer were inside the viewport.

Android build 26 manual AAC capture, transcription, native answer playback and
manual continuation also passed: playback remained paused beyond ten seconds and
resumed on Continue. These checks use the local fixture.

EAS build 14 passed read-only production UI checks: actual public catalogue and
transcript loaded, no fixture episode appeared, and Account opened without the
test-environment marker. No email or paid model request was made by this check.

Condensed artifact hashes, signing certificate, native duration measurements and
system-command traces: [release evidence](mobile-evidence/continuous-release-2026-09-17.json).

Both updated native fixture builds now pass the continuous RTC playback flow:
iOS build 30 and Android build 31. The normal iPhone build 31 was installed and
launched, its signature and production API configuration verified, and its JS
bundle contains no temporary diagnostic helper. The device-local diagnostic file
was cleared after retaining the local investigation evidence.

Android EAS build 15 uses source `9d7acb1`, the existing release signing
certificate and `https://asidefm.com`, with fixture mode and diagnostic code off.
It successfully upgrades the production package on the Android emulator.
Build: https://expo.dev/accounts/jiahangzhang/projects/aside/builds/2a22f81b-56ad-4cf4-91e2-b3a9aa77f3d8.
Updated verification and hashes: `mobile-evidence/continuous-context-2026-09-17.json`.
