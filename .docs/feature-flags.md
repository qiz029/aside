# Feature flags (Cloudflare Flagship)

Aside uses the native `FLAGS` binding; no client-side Flagship keys or SDKs are required. Production app: `asidefm`, ID `ba3d496d-db21-488f-997a-9721386fb03b`. Manage it under Cloudflare **Compute → Flagship → asidefm**. The production binding is in `wrangler.production.jsonc`; this code must be deployed before the flags affect production requests.

## Flags and defaults

| Key                   | Type    | Initial value | Purpose                                                                                                                                 |
| --------------------- | ------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `live_enabled`        | Boolean | true          | Admit new Live voice sessions. Default variation is `off`; the initial 100% rule serves `on`, so disabling the flag stops new sessions. |
| `gemini_live_enabled` | Boolean | false         | Gemini rollout eligibility.                                                                                                             |
| `voice_provider`      | String  | `openai`      | Preferred provider (`openai` or `gemini`).                                                                                              |

Gemini 3.8 Live is implemented using a server-owned WebSocket and PCM audio. Availability requires `GEMINI_API_KEY`, eligibility, provider preference, and an authenticated account. `/api/health` reports the account's available/preferred provider; session creation also requires explicit `pcm: true` capability. Its response's `provider`/`transport` identifies the selected transport. Legacy clients and Android builds without the native PCM bridge retain OpenAI. New iOS builds support PCM and show the updated data-processing notice before using Google.

The production rollout starts with one authenticated account allowlist, managed in Flagship. Both `gemini_live_enabled` and `voice_provider` use the same account rule; all other accounts default to false/OpenAI. Inspect Flagship for the current allowlist rather than storing personal account details in the repository. See [Gemini Live](gemini-live.md) for transport and verification details.

Web and iOS consume health's existing `liveConfigured` decision. The backend re-evaluates flags for **every new Live session**, before reserving a lease or calling the supplier; a disabled gate returns HTTP 403 with `code: feature_disabled`. Old clients cannot bypass this check. Existing sessions, text questions and transcription are not terminated/disabled by this flag. For an emergency stop covering existing sessions, use the existing `trial_control` procedure in [Cloudflare operations](cloudflare.md).

## Targeting dimensions

| Attribute                   | Source                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `targetingKey`, `userId`    | Authenticated account ID, otherwise signed visitor ID. Stable across requests; changes on anonymous-to-account transition.     |
| `authenticated`, `audience` | Server authentication; audience is `account` or `trial`.                                                                       |
| `environment`               | Worker `FEATURE_ENVIRONMENT` (`production` in production config).                                                              |
| `country`                   | Cloudflare's `request.cf.country`; never a client header.                                                                      |
| `platform`                  | Web/iOS/Android client hint; older clients report `unknown`.                                                                   |
| `locale`                    | Client language hint, falling back to Accept-Language. Web sends selected UI language (`zh`/`en`); mobile sends device locale. |
| `appVersion`, `appBuild`    | Mobile client hints; build is numeric when supplied. Requires an app release containing these headers.                         |
| `episodeId`                 | Server-resolved episode on session creation; absent from general health.                                                       |

Custom business dimensions are added in `featureContext` through trusted server attributes. There is deliberately no arbitrary client-supplied attributes endpoint. A future `plan`, `betaTester`, or quota dimension must be loaded from its authoritative server source first. Client hints are for compatibility/rollout, not entitlement enforcement. Use a stable `targetingKey` for percentage bucketing. Conditions are editable in Flagship; adding a new data source still needs code.

Example rule: `platform equals ios AND locale contains zh`, serving Gemini eligibility to 10% bucketed on `targetingKey`. Keep `live_enabled` enabled for users assigned to either provider. Use `userId` for an internal-account allowlist.

## Failure and propagation behavior

No per-user decision is cached between requests. Native binding reads are evaluated concurrently with a 250 ms timeout per read. Missing bindings, missing flags, type mismatch, timeout or provider errors preserve existing voice (`live_enabled=true`), default Gemini eligibility to false and preference to OpenAI. `AI_ENABLED=false` still overrides the Live flag. This availability fallback is not a guaranteed emergency billing cutoff; use `trial_control` for that purpose.

Responses use `Cache-Control: no-store`. Changing a flag can take up to 30 seconds to propagate globally. An open client's UI reflects its latest health snapshot; admission always checks the current server decision. This release does not hot-swap a connected voice session.

## Operations

```sh
# Inspect decisions without calling a voice model.
npx wrangler flagship flags evaluate ba3d496d-db21-488f-997a-9721386fb03b live_enabled --targeting-key USER_ID --context platform=ios --config wrangler.production.jsonc --json

# Stop admission of new Live sessions.
npx wrangler flagship flags disable ba3d496d-db21-488f-997a-9721386fb03b live_enabled --config wrangler.production.jsonc

# Restore the existing targeting rules.
npx wrangler flagship flags enable ba3d496d-db21-488f-997a-9721386fb03b live_enabled --config wrangler.production.jsonc
```

`npm run dev` and the default local Worker config have no binding and use defaults. For interactive local Flagship work create a **separate development app** and bind that app in your local Wrangler config; do not edit production flags to test locally. Cloudflare integration tests use Miniflare's isolated Flagship store and do not alter cloud flags.

Official references: [binding methods](https://developers.cloudflare.com/flagship/binding/methods/), [targeting](https://developers.cloudflare.com/flagship/targeting/), [propagation](https://developers.cloudflare.com/flagship/concepts/), [Wrangler commands](https://developers.cloudflare.com/flagship/reference/wrangler-commands/).
