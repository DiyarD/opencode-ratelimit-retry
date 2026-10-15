# opencode-ratelimit-retry

Restores OpenCode 1.x behaviour: **automatically retry provider rate limits** instead of ending
the turn with a bare error and no countdown.

```
Retrying in 64673s - attempt 1 - Rate limit exceeded. Please try again later.
```

OpenCode 2 has no setting for this. The plugin restores it through documented hooks only, so it
survives OpenCode upgrades.

## The problem it fixes

OpenCode 2 classifies a provider failure and then decides whether another attempt is allowed.
Throttles are retryable, but account caps that share HTTP 429 are deliberately classified as
`QuotaExceeded`, which is terminal. In the AI package, `provider-error.ts` puts
`freeusagelimiterror` and `gousagelimiterror` in `QUOTA_CODES`, checks that set **before** the 429
rule, and returns `QuotaExceededError`; `isRetryable()` then returns `false` for `QuotaExceeded`.

OpenCode Zen's rate limiter answers a throttled request like this:

```http
HTTP/1.1 429 Too Many Requests
retry-after: 64673

{"type":"error","error":{"type":"FreeUsageLimitError",
 "message":"Rate limit exceeded. Please try again later."}}
```

The body code outranks the status, so the turn dies. OpenCode 1 retried the same failure and slept
for the advertised `retry-after`.

## Install

OpenCode 2.0.0 or later (the `retry` hook has existed since 2.0.0).

```sh
opencode plugin add github:DiyarD/opencode-ratelimit-retry
```

That installs it for the current user and keeps it updatable with `opencode plugin update`.
Check it loaded:

```sh
opencode plugin list
```

Alternatively, add it to `opencode.json(c)` yourself:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "github:DiyarD/opencode-ratelimit-retry",
    {
      "package": "github:DiyarD/opencode-ratelimit-retry",
      "options": { "verbose": true }
    }
  ]
}
```

Or copy `index.js` and `src/policy.js` into a plugin directory of your own:

- global: `~/.config/opencode/plugins/ratelimit-retry/` (on Windows: `%USERPROFILE%\.config\opencode\plugins\`)
- one project: `<project>/.opencode/plugins/ratelimit-retry/`

## Options

All optional. Pass them with the object form of a `plugins` entry.

| Option | Default | Meaning |
| --- | --- | --- |
| `providers` | `["opencode"]` | Providers the response hook is scoped to. Use `[]` for every provider. Scoping keeps the extra response handling off providers that cannot produce these failures. |
| `maxDelayMs` | `86400000` (24h) | Ceiling for a single wait. A provider's advertised wait is honoured as-is below this. Lower it to fail fast instead of sitting on a long wait. |
| `maxAttempts` | `5` | Stop forcing retries after this many attempts. Matches OpenCode 1's `RETRY_MAX_RETRIES`. |
| `diagnosticsFile` | platform data dir | Absolute path for the diagnostic log. See [Diagnostics](#diagnostics). |
| `verbose` | `false` | Also echo overrides to the console. Only useful with `--print-logs`; the background service discards its stdout, so the diagnostic file is the reliable channel. |

## Diagnostics

Every decision this plugin makes is written to a JSONL file, whether it forces a retry or declines
one. This is on by default and needs no configuration.

**Where:** `~/.local/share/opencode/ratelimit-retry.jsonl` on Linux and macOS,
`%USERPROFILE%\.local\share\opencode\ratelimit-retry.jsonl` on Windows. Override with
`diagnosticsFile`.

**Why not `console.log`:** it does not work. The background service is spawned with
`stdio: ["ignore", "ignore", "pipe"]`, so its stdout is discarded and its stderr survives only as
an 8 KB in-memory tail. `opencode.log` is written by Effect's file logger and never sees a
plugin's `console` output. A retry can be forced with no trace at all, which is exactly what makes
an unexplained failure undiagnosable after the fact.

**Why not `opencode.log`:** that file is trimmed in place by the framework (50 MB max, 25 MB
retained) on the assumption that it owns every line in it. Appending lines it did not write would
interfere with that, so diagnostics get their own file beside it.

### Storage

Hard-capped at 1 MB. When a write would exceed it, whole lines are dropped from the front and a
`<<trimmed>>` marker is written, so lost history is never silent. A full rate-limit episode (five
retries) is roughly 17 lines / 10 KB; typical use is a few episodes a day.

### What each record contains

| Event | Meaning |
| --- | --- |
| `plugin.setup` | Version, pid, platform, resolved options, and the file being written. |
| `plugin.heartbeat` | Every 30 minutes, proving the plugin is loaded and its hooks are live. |
| `hooks.registered` / `hooks.retry.registered` | Hooks registered, and for which providers. |
| `hooks.*.failed` | A hook failed to register, so no retry can ever be forced. |
| `http.response.429` | The raw 429: every response header, the parsed `retry-after`, and whether it replaced an existing hint. |
| `http.response.throttle-like` | A non-429 failure that still carries a retry hint, the one case this plugin cannot act on. |
| `hint.expired` | A captured hint went stale before it was used. |
| `retry.consulted` | Every consultation, forced or not: attempt, OpenCode's own decision, hint and its age, and the full projected error. |
| `retry.forced` | The wait actually scheduled, and which strategy chose it. |
| `session.identify.failed` | The subagent/parent lookup failed; `subagent` stays `null` rather than guessing. |
| `plugin.dispose` | Hook teardown, listing any session that was mid-episode. |

### Reading a failure

`retry.consulted` is the record that answers "why did this not retry". Its `decision.reason` is one
of:

| Reason | Meaning |
| --- | --- |
| `provider-advertised-wait` | Forced, using the provider's own `retry-after`. |
| `exponential-backoff` | Forced with no advertised wait, so a short ladder was used. |
| `opencode-already-retrying` | OpenCode was already retrying this itself. |
| `not-http-429` | Some other status; this plugin only acts on 429. |
| `attempt-budget-spent` | `maxAttempts` consecutive retries were used. |
| `provider-said-do-not-retry` | The provider sent `x-should-retry: false`. |
| `text-not-throttle-like` | Neither message nor body reads as a throttle (an expired plan, say). |

Every record carries `label`, which reads `subagent:<title>` or `main:<title>` once the session has
been resolved, so a child session's failure is distinguishable from the parent's at a glance. A
`null` means the lookup had not landed yet, not "main".

### If a limit retried and then died anyway

A forced retry is an in-process sleep. If the server restarts during the wait, the retry is lost,
and `SessionRestart` recovers the session with a budget of 10 attempts before terminalising it with
"Execution was interrupted repeatedly and will not be resumed automatically". So check for a
`plugin.setup` record between the `retry.forced` line and the failure: that is a restart, not a
refusal, and it is exactly the case that used to be indistinguishable from a silent decline.

## What it does and does not do

- Only ever **adds** a retry that OpenCode refused. Any failure OpenCode already retries keeps its
  own backoff, jitter and per-step budget untouched.
- Only acts on HTTP 429.
- Waits for the provider's `retry-after` / `retry-after-ms` when present, in seconds or as an HTTP
  date. Zen's free-tier limit advertises "seconds until midnight", so the first wait can be many
  hours. Set `maxDelayMs` if you would rather fail fast.
- Falls back to exponential backoff only when the failure still reads as a throttle, so a hard cap
  such as an expired plan is not retried into the ground.
- Obeys an explicit `x-should-retry: false` from the provider.
- Never reads a response body, so it cannot interfere with streaming.

## How it works

Two documented session hooks, no source patching:

- `http.response` records the provider's `retry-after` (and an explicit `x-should-retry: false`) for
  the session. Headers only.
- `retry` runs after OpenCode proposes its decision and before any retry is scheduled, so it can
  turn a terminal failure into a retryable one.

OpenCode projects the result as `session.retry.scheduled`, which is what the TUI renders as the
"Retrying in Ns" countdown.

## Cross-platform

Linux, macOS and Windows. The plugin uses no filesystem, path, shell or OS-specific API, and the
decision logic lives in `src/policy.js` as a dependency-free module so it is testable without
OpenCode. CI runs the test suite on all three operating systems on Node 20 and 22:

```sh
npm test
```

## Troubleshooting

Read the diagnostic file first, see [Diagnostics](#diagnostics). It answers "was the plugin loaded",
"did it see the 429", and "what did it decide", without needing to reproduce anything.

If the file does not exist at all, the plugin is not loaded: check `opencode plugin list`. Note that
`verbose: true` writes to the console, which the background service discards.

If a rate limit still fails immediately, confirm the provider is one OpenCode classifies as a
terminal quota error, and add its ID to `providers` if it is not `opencode`.

## License

MIT