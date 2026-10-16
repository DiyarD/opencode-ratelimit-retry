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
| `maxDelayMs` | `3000000` (50 min) | Ceiling for a single wait. A provider's advertised wait is honoured as-is below this. It defaults to just under the 60-minute inactivity timer on purpose — see [Why the wait is capped](#why-the-wait-is-capped). Raising it past 60 minutes reintroduces the bug this plugin exists to fix. |
| `maxAttempts` | `11` | Provider requests per step, counting the first. OpenCode's own schedule is `Schedule.recurs(10)` and consults the retry hook once per recurrence, so 11 is the most it can ever act on; larger values change nothing. Lower it to fail fast. |
| `continueAfterBudget` | `true` | When a step spends its whole attempt budget while the provider's window is still open, resume the turn in a fresh step instead of letting the throttle win. See [Continuation](#continuation). |
| `continueSubagents` | `true` | Whether that continuation also applies to subagent sessions. A failed subagent is reported to its parent as a tool result, so a parent that already handled the failure may not read the resumed child's result. See [Continuation](#continuation). |
| `maxContinuations` | `6` | How many times one rate-limit episode may be continued. With the defaults each continuation buys about nine more hours of coverage, so six cover a multi-day window. |
| `continuationWaitMs` | `maxDelayMs` | Wait before a continuation. Kept at the retry cadence so a window that closes early is noticed by asking again, and never longer than the same 50-minute ceiling: the timer that delivers a continuation is held by the instance whose directory activity expires. |
| `diagnosticsFile` | platform data dir | Absolute path for the diagnostic log. See [Diagnostics](#diagnostics). |
| `verbose` | `false` | Also echo overrides to the console. Only useful with `--print-logs`; the background service discards its stdout, so the diagnostic file is the reliable channel. |

## Why the wait is capped

A forced retry is an in-process sleep, and a sleep does not happen in a vacuum. OpenCode keeps an
activity timer per directory (`packages/core/src/location-activity.ts`, 60 minutes) and interrupts
every session still executing in a directory whose timer expired:

```
Execution.Interrupted { reason: "inactivity" }
```

The timer is refreshed only by a durable session event that carries a `location`, and the retry loop
publishes two of those per attempt (`session.retry.scheduled` before the sleep and
`session.step.started` when the attempt runs), both from inside the session's location. So:

- a wait **shorter** than the timer keeps the session alive for as long as attempts remain, because
  each attempt refreshes the timer, and
- a wait **longer** than the timer gets the session killed mid-sleep, with the plugin's own forced
  wait as the cause.

That second case is why this plugin spent its first releases killing its own sessions on long limits:
a provider advertising 13 hours put the session to sleep for 13 hours, and the inactivity sweep
ended it 60 minutes in. `maxDelayMs` therefore defaults to 50 minutes, which leaves ten minutes of
headroom for a slow attempt instead of racing the timer.

A longer advertised window is not ignored, it is **paced**: the plugin waits the ceiling, asks again,
and gets a fresh `retry-after` from the provider. The window is covered by a sequence of safe waits
instead of one wait that outlives the session. Every one of those waits is logged, so the paced
number and the provider's number are always distinguishable.

## Continuation

One step only retries `Schedule.recurs(10)` times (`session/runner/retry.ts`), so ten forced waits —
about nine hours with the defaults — is all the coverage a single step has. A limit that lasts
longer than that would still end the turn, with the throttle obviously still in force.

When a step's budget runs out **and** the failure is still the throttle this plugin was deferring,
the plugin waits out one more retry cadence, admits a short notice into the session, and wakes it.
The turn resumes in a fresh step with a fresh attempt budget, which is the same shape OpenCode
itself uses to continue a turn after a server restart. `maxContinuations` bounds it, so a
permanently throttled provider cannot loop forever.

Nothing here touches a failure that is not a throttle: a step that dies for any other reason is left
exactly as it was. A continuation would hide a real error, which is worse than the error.

### Subagents

A subagent that fails is reported to its parent as a tool result, and the parent decides what happens
next — more precisely, the framework's own recovery for an *interrupted* child
(`SessionRestart.recoverSubagent`) resumes the child **and** delivers the completion to the parent,
because the parent is what waits on it. A continuation can only do the first half: it revives the
child's own turn, and a parent that already moved past the failure may never read the result.

That is the trade-off behind `continueSubagents` (default `true`): a subagent holding a long piece of
work keeps working through the limit and its result stays readable in the child session either way,
but it can duplicate a task the parent has already re-issued, at one provider request per retry
cadence. Set it to `false` to leave failed subagents entirely to the parent.

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
`<<trimmed>>` marker is written, so lost history is never silent. A throttled step (eleven requests)
is roughly 35 lines / 40 KB, and a long episode adds a few records per continuation; typical use is
still a few episodes a day.

### What each record contains

| Event | Meaning |
| --- | --- |
| `plugin.setup` | Version, pid, platform, resolved options, and the file being written. |
| `plugin.heartbeat` | Every 30 minutes, proving the plugin is loaded and its hooks are live, with the count of open episodes and pending continuations. |
| `hooks.registered` / `hooks.retry.registered` | Hooks registered, and for which providers. |
| `hooks.*.failed` | A hook failed to register, so no retry can ever be forced. |
| `config.max-delay-above-inactivity-ttl` | `maxDelayMs` was configured past the 60-minute inactivity timer, which is the failure this plugin exists to prevent. |
| `events.subscribed` / `events.unavailable` | Whether the step-budget continuation is active. Retries themselves work either way. |
| `http.response.429` | The raw 429: every response header, the parsed `retry-after`, and whether it replaced an existing hint. |
| `http.response.throttle-like` | A non-429 failure that still carries a retry hint, the one case this plugin cannot act on. |
| `hint.expired` | A captured hint went stale before it was used. |
| `retry.consulted` | Every consultation, forced or not: attempt, OpenCode's own decision, hint and its age, and the full projected error. |
| `retry.forced` | The wait actually scheduled, which strategy chose it, and the provider's number when the two differ. |
| `episode.opened` | A session was deferred, with the deadline the provider advertised. |
| `episode.closed` | The deferral ended: why, how long it lasted, and how many phases it took. |
| `continuation.decided` / `continuation.scheduled` | A step ran out of budget: whether to resume, after how long, and why not if not. |
| `continuation.sent` / `continuation.failed` | The resume was admitted, or it failed and the episode stayed open at the same phase. |
| `event.handler.failed` / `events.failed` | The event stream broke, so continuations are off for this instance. |
| `session.identify.failed` | The subagent/parent lookup failed; `subagent` stays `null` rather than guessing. |
| `plugin.dispose` | Hook teardown, listing any session that was mid-episode. |

### Reading a failure

`retry.consulted` is the record that answers "why did this not retry". Its `decision.reason` is one
of:

| Reason | Meaning |
| --- | --- |
| `provider-advertised-wait` | Forced, using the provider's own `retry-after`. |
| `provider-advertised-wait-paced-to-safe-ceiling` | Forced, but the provider asked for longer than one wait may safely last, so `maxDelayMs` was used and the provider is asked again at that cadence. `advertisedDelayMs` records what it actually asked for. |
| `exponential-backoff` | Forced with no advertised wait, so a short ladder was used. |
| `opencode-already-retrying` | OpenCode was already retrying this itself. |
| `not-http-429` | Some other status; this plugin only acts on 429. |
| `attempt-budget-spent` | `maxAttempts` requests are used up for this step. |
| `provider-said-do-not-retry` | The provider sent `x-should-retry: false`. |
| `text-not-throttle-like` | Neither message nor body reads as a throttle (an expired plan, say). |

`continuation.decided` reports the same question one level up — whether to resume after a step spent
its budget:

| Reason | Meaning |
| --- | --- |
| `step-budget-spent` | The step failed with the throttle still in force; a continuation is scheduled. |
| `recovery-after-interrupt` | The session was killed by the inactivity sweep rather than by a failure (a suspended machine, say) while it was being deferred; the same continuation recovers it. |
| `continuation-budget-spent` | `maxContinuations` is reached, so the episode ends instead of looping. |
| `continuation-disabled` | `continueAfterBudget` is off. |
| `turn-failed-not-throttle` | The step died of something else, so it is left alone. |
| `turn-succeeded` | The work got through; the episode is over. |
| `subagent-turn-failed` / `subagent-interrupted` | A subagent failed or was interrupted with `continueSubagents` off, so it is left to its parent. |
| `interrupted-by-user` / `session-removed` | Deliberate stops, never resumed. |

Every record carries `label`, which reads `subagent:<title>` or `main:<title>` once the session has
been resolved, so a child session's failure is distinguishable from the parent's at a glance. A
`null` means the lookup had not landed yet, not "main".

### If a limit retried and then died anyway

Work backwards from the failure in the diagnostic file:

1. **Was the plugin loaded at all?** The last `plugin.heartbeat` before the failure dates it. If the
   last heartbeat is older than the incident and there is no `plugin.setup` after it, the plugin was
   not running and nothing else in the file will explain anything.
2. **Did it see the 429?** `http.response.429` carries every header the provider sent.
3. **What did it decide?** `retry.consulted` has one record per consultation with the reason.
4. **Does an episode exist?** `episode.opened` means the plugin was pacing this session, and
   `episode.closed` says how it ended. If a throttle episode was closed with `turn-succeeded`, the
   limit simply lifted. If it was closed with `continuation-budget-spent`, the provider was still
   refusing after `maxContinuations` rounds and the failure is the provider's limit, not the
   plugin's pacing.
5. **Was the wait itself the cause?** A session interrupted with `reason: "inactivity"` in the
   framework log means a single wait outlived the directory's activity timer. That can only happen
   if `maxDelayMs` was raised past 60 minutes (there would be a
   `config.max-delay-above-inactivity-ttl` record at setup saying so), or if the machine was
   suspended mid-wait. The plugin treats the second case as recoverable and continues the turn.
6. **Was it a restart?** A forced retry is an in-process sleep, so if the server restarts during the
   wait the retry is lost; `SessionRestart` then recovers the turn itself, with a budget of 10
   attempts before terminalising it with "Execution was interrupted repeatedly and will not be
   resumed automatically". A `plugin.setup` record between the `retry.forced` line and the failure
   means exactly that — a restart, not a refusal.

## What it does and does not do

- Only ever **adds** a retry that OpenCode refused. Any failure OpenCode already retries keeps its
  own backoff, jitter and per-step budget untouched.
- Only acts on HTTP 429.
- Waits for the provider's `retry-after` / `retry-after-ms` when present, in seconds or as an HTTP
  date. Zen's free-tier limit advertises "seconds until midnight", which is longer than a wait can
  safely last, so those windows are covered by a sequence of waits at `maxDelayMs` (50 minutes)
  instead of one wait that outlives the session. Lower `maxDelayMs` to fail fast.
- Falls back to exponential backoff only when the failure still reads as a throttle, so a hard cap
  such as an expired plan is not retried into the ground.
- Obeys an explicit `x-should-retry: false` from the provider.
- Never reads a response body, so it cannot interfere with streaming.
- Resumes a throttled turn after a step runs out of attempts, but **never** a turn that failed for
  any other reason. A continuation is not a blanket retry.
- Stops after `maxContinuations` rounds rather than looping on a provider that is refusing for good.

## How it works

Three documented entry points, no source patching:

- `http.response` records the provider's `retry-after` (and an explicit `x-should-retry: false`) for
  the session. Headers only.
- `retry` runs after OpenCode proposes its decision and before any retry is scheduled, so it can
  turn a terminal failure into a retryable one.
- The server event stream watches for the terminal failure of a turn this plugin deferred, so a
  window longer than one step's attempt budget is continued rather than lost.

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