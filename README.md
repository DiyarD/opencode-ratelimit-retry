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
| `verbose` | `false` | Log every override to the OpenCode log. |

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

Turn on `verbose: true`, restart the service with `opencode service restart`, and check
`~/.local/share/opencode/log/opencode.log` (on Windows: `%USERPROFILE%\.local\share\opencode\log\opencode.log`)
for `[ratelimit-retry]` lines.

If a rate limit still fails immediately, confirm the provider is one OpenCode classifies as a
terminal quota error, and add its ID to `providers` if it is not `opencode`.

## License

MIT