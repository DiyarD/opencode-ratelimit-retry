/**
 * opencode-ratelimit-retry
 *
 * Restores OpenCode 1.x behaviour: automatically retry provider rate limits instead of ending
 * the turn with a bare error.
 *
 * WHY THIS EXISTS
 * ---------------
 * OpenCode 2 classifies a provider failure first and then asks whether another attempt is
 * allowed. Throttles are retryable, but account caps that share HTTP 429 are deliberately
 * classified as `QuotaExceeded`, which is terminal. In the AI package, `provider-error.ts`
 * declares `QUOTA_CODES` containing `freeusagelimiterror` and `gousagelimiterror`, checks it
 * before the 429 rule, and returns `QuotaExceededError`; `isRetryable()` then returns false for
 * `QuotaExceeded`.
 *
 * OpenCode Zen's rate limiter answers a throttled request with HTTP 429, a `retry-after` header
 * and a typed body:
 *
 *   HTTP/1.1 429 Too Many Requests
 *   retry-after: 41237
 *   {"type":"error","error":{"type":"FreeUsageLimitError",
 *    "message":"Rate limit exceeded. Please try again later."}}
 *
 * The body code wins over the status, so the turn dies with "Rate limit exceeded. Please try
 * again later." and no countdown. There is no setting for this in any version: neither
 * `cli.json` nor `opencode.json` exposes a retry option.
 *
 * OpenCode 1 retried the same failure. Its `session/retry.ts` matched the message against
 * retryable patterns, kept `FreeUsageLimitError` retryable, and slept for the `retry-after`
 * delay the provider advertised.
 *
 * HOW THIS WORKS
 * --------------
 * Two documented session hooks, no source patching, so upgrading OpenCode cannot clobber it:
 *
 *   - `http.response` records the provider's `retry-after` (and an explicit
 *     `x-should-retry: false`) for the session. Headers only.
 *   - `retry` re-enables a retry when OpenCode decided not to retry an HTTP 429, using the
 *     advertised wait. Every failure OpenCode already retries keeps its own policy untouched.
 *
 * OpenCode projects the forced retry as `session.retry.scheduled`, so the TUI shows the same
 * "Retrying in Ns - attempt N - <message>" it showed in 1.x.
 *
 * Cross-platform by construction: no filesystem, path, shell or OS-specific API is used, and
 * the decision logic is a dependency-free module covered by tests on Linux, macOS and Windows.
 */

import { Plugin } from "@opencode/plugin"
import { DEFAULTS, decide, parseRetryAfter } from "./src/policy.js"

/** How long a captured hint stays usable, so a stale wait is never applied. */
const FRESH_MS = 120_000

/**
 * @typedef {{ at: number, delay: number, blocked: boolean }} Hint
 */

export default Plugin.define({
  id: "opencode.ratelimit-retry",
  /**
   * @param {import("@opencode/plugin").Context} ctx
   */
  async setup(ctx) {
    const options = { ...DEFAULTS, ...(ctx.options ?? {}) }
    /** @type {Map<string, Hint>} */
    const hints = new Map()

    /**
     * @param {{ sessionID: string, response: Response }} event
     */
    const capture = (event) => {
      if (event.response.status !== 429) return
      const { delay, blocked } = parseRetryAfter(event.response.headers)
      hints.set(event.sessionID, { at: Date.now(), delay, blocked })
    }

    // Scoping the capture hook keeps the extra response handling off providers that cannot
    // produce these failures. An empty providers list registers it for every provider.
    const registrations = []
    if (options.providers.length === 0) registrations.push(await ctx.session.hook("http.response", capture))
    for (const providerID of options.providers)
      registrations.push(await ctx.session.hook("http.response", capture, { providerID }))

    const retry = await ctx.session.hook("retry", (event) => {
      const hint = hints.get(event.sessionID)
      if (hint && Date.now() - hint.at > FRESH_MS) hints.delete(event.sessionID)

      const decision = decide(
        {
          attempt: event.attempt,
          status: event.error.status,
          message: event.error.message,
          body: event.error.response?.body,
          alreadyRetrying: event.decision.retry,
          hint: hints.get(event.sessionID),
        },
        options,
      )
      if (!decision) return

      event.decision = decision
      if (options.verbose)
        console.log(
          `[ratelimit-retry] ${event.model.providerID}/${event.model.id} attempt ${event.attempt}: retrying in ${Math.round(
            decision.delay / 1000,
          )}s (${event.error.type})`,
        )
    })

    return () => {
      for (const registration of registrations) void registration.dispose()
      void retry.dispose()
      hints.clear()
    }
  },
})