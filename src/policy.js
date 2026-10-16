/**
 * Decision logic for the retry hook. Plain ESM with no dependencies and no platform
 * assumptions, so it runs unchanged under Bun, Node, macOS, Linux and Windows, and can be
 * unit tested without OpenCode.
 */

/**
 * How long a directory's activity timer lives when it holds a running session.
 *
 * `packages/core/src/location-activity.ts` seeds an entry per active directory and, at every
 * sweep, interrupts every session still executing in a directory whose entry has expired:
 *
 *   Execution.Interrupted { reason: "inactivity" }
 *
 * The timer is refreshed only by a durable session event that carries a `location`, and the
 * retry loop publishes one per attempt (`session.retry.scheduled` before each sleep,
 * `session.step.started` when the attempt runs), both from inside the session's location. So a
 * wait shorter than this keeps the session alive for as long as the attempts last, and a wait
 * longer than this gets the session killed mid-sleep: the forced wait is itself the thing that
 * kills it.
 */
export const INACTIVITY_TTL_MS = 60 * 60_000

/**
 * The longest a single wait may be without risking the inactivity sweep.
 *
 * The gap between two refreshes is the wait plus the request that follows it, so the ceiling
 * leaves ten minutes of headroom for a slow attempt. Anything longer and the sweep can land
 * inside the sleep, which is exactly the failure this plugin exists to prevent.
 */
export const MAX_SAFE_DELAY_MS = 50 * 60_000

/**
 * Provider requests the framework can make inside one step, counting the first one.
 *
 * `session/runner/retry.ts` builds its schedule as `Schedule.recurs(10)` and consults the retry
 * hook once per recurrence, so the hook is asked about attempts 2 through 11 and never again:
 * past that the schedule is exhausted and the step fails whatever this plugin returns. The
 * continuation below is what carries a session beyond that ceiling.
 */
export const FRAMEWORK_MAX_ATTEMPTS = 11

/** Shortest gap between continuations, so a missed deadline cannot become a hot loop. */
const MIN_CONTINUATION_WAIT_MS = 30_000

export const DEFAULTS = {
  /** Providers the http.response hook is scoped to. Empty means every provider. */
  providers: ["opencode"],
  /**
   * Ceiling for a single wait, and deliberately below `INACTIVITY_TTL_MS`.
   *
   * A provider that advertises a longer wait is not ignored: the plugin waits this long, asks
   * again, and keeps asking at this cadence while the provider's window is open, so the window
   * is covered by a sequence of safe waits instead of one wait that outlives the session.
   */
  maxDelayMs: MAX_SAFE_DELAY_MS,
  /**
   * Provider requests allowed inside one step, counting the first one. The framework never
   * consults the retry hook past `FRAMEWORK_MAX_ATTEMPTS`, so larger values change nothing.
   */
  maxAttempts: FRAMEWORK_MAX_ATTEMPTS,
  /**
   * When a step spends its whole attempt budget while the provider's window is still open,
   * re-enter the session so the work resumes in a fresh step instead of dying with the throttle
   * still in force. Each continuation admits one short notice into the transcript, so the count
   * is bounded rather than open-ended.
   */
  continueAfterBudget: true,
  /**
   * Whether a failed subagent session is continued along with the sessions a user drives.
   *
   * A failed subagent is reported to its parent as a tool result, and the framework's own recovery
   * for an interrupted child (`SessionRestart.recoverSubagent`) resumes the child *and* delivers
   * the completion to the parent, because the parent is what waits on the child. A continuation
   * cannot deliver that second half: it revives the child's own turn only, so a parent that already
   * handled the failure may never read the result.
   *
   * Left on by default, because a subagent holding a long piece of work is exactly the thing a rate
   * limit should not silently kill, and the result stays readable in the child session whatever the
   * parent does. Set it to false to leave subagents to the parent's judgement.
   */
  continueSubagents: true,
  /**
   * How many times one rate-limit episode may be continued. Each continuation buys another
   * `maxAttempts` x `maxDelayMs` of coverage - roughly 9 hours with the defaults - so six of
   * them cover a provider window of a couple of days.
   */
  maxContinuations: 6,
  /** Wait before a continuation. Defaults to `maxDelayMs`, keeping the retry cadence even. */
  continuationWaitMs: undefined,
  verbose: false,
  /**
   * Absolute path for the diagnostic JSONL file. Defaults to the platform data directory beside
   * `opencode.log`. Diagnostics are always written; this only changes where they land.
   */
  diagnosticsFile: undefined,
}

/** Providers only send these when the same request can succeed a little later. */
const THROTTLE_TEXT =
  /rate[-_\s]?limit|too[_\s]?many[_\s]?requests|overloaded|at capacity|try again|resource[-_\s]?exhausted|slow down/i

const MIN_DELAY_MS = 1_000
const BASE_DELAY_MS = 2_000

/**
 * Reads a wait hint out of response headers. `retry-after` is seconds or an HTTP date, and a few
 * providers send milliseconds as `retry-after-ms`. Headers only: response bodies are one-shot
 * streams and are never read here.
 *
 * @param {Headers | Record<string, string> | null | undefined} headers
 * @param {number} [now] epoch milliseconds, injectable for tests
 * @returns {{ delay: number, blocked: boolean }}
 */
export function parseRetryAfter(headers, now = Date.now()) {
  if (!headers) return { delay: 0, blocked: false }
  const get = (name) => {
    if (typeof headers.get === "function") return headers.get(name)
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name)
    return key === undefined ? null : headers[key]
  }

  // An explicit refusal from the provider wins over anything else here.
  if ((get("x-should-retry") ?? "").trim().toLowerCase() === "false") return { delay: 0, blocked: true }

  const millis = (get("retry-after-ms") ?? "").trim()
  // Number(null) is 0 and Number("") is 0, so the header has to be present to be worth reading.
  if (millis !== "" && Number.isFinite(Number(millis))) return { delay: Math.max(0, Math.ceil(Number(millis))), blocked: false }

  const raw = (get("retry-after") ?? "").trim()
  if (raw === "") return { delay: 0, blocked: false }
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return { delay: Math.max(0, Math.ceil(seconds * 1000)), blocked: false }
  const at = Date.parse(raw)
  if (!Number.isNaN(at)) return { delay: Math.max(0, at - now), blocked: false }
  return { delay: 0, blocked: false }
}

/**
 * Whether a failure with no advertised wait still reads as a throttle rather than a hard cap,
 * so an expired plan is not retried into the ground.
 *
 * @param {string} text
 */
export function looksThrottled(text) {
  return THROTTLE_TEXT.test(text ?? "")
}

/**
 * How long to wait before the next attempt.
 *
 * @param {number} attempt 1 for the first retry.
 * @param {number} maxDelayMs
 */
export function backoffDelay(attempt, maxDelayMs = DEFAULTS.maxDelayMs) {
  const step = Math.max(0, Math.floor(attempt) - 1)
  return Math.min(BASE_DELAY_MS * 2 ** step, maxDelayMs)
}

function clampDelay(delay, maxDelayMs) {
  return Math.max(MIN_DELAY_MS, Math.min(Math.ceil(delay), maxDelayMs))
}

const accept = (delay, reason, advertisedDelayMs) => ({ retry: true, delay, reason, advertisedDelayMs })
const decline = (reason) => ({ retry: false, reason })

/**
 * Decides whether to force a retry that OpenCode 2 would not perform itself, and says why.
 *
 * Every exit is labelled. A decline is silent by design at runtime, which is exactly why an
 * unexplained terminal failure is so hard to diagnose: nothing distinguishes "not a throttle"
 * from "provider told us to stop" from "budget spent". `reason` closes that gap.
 *
 * @param {{
 *   attempt: number,
 *   status?: number,
 *   message?: string,
 *   body?: string,
 *   alreadyRetrying?: boolean,
 *   hint?: { delay: number, blocked: boolean } | undefined,
 * }} failure
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{ retry: true, delay: number, reason: string, advertisedDelayMs?: number } | { retry: false, reason: string }}
 */
export function decide(failure, options = {}) {
  const settings = { ...DEFAULTS, ...options }
  if (failure.alreadyRetrying) return decline("opencode-already-retrying")
  if (failure.status !== 429) return decline("not-http-429")
  if (!(failure.attempt <= settings.maxAttempts)) return decline("attempt-budget-spent")

  const hint = failure.hint
  if (hint?.blocked) return decline("provider-said-do-not-retry")
  if (hint && hint.delay > 0)
    return accept(
      clampDelay(hint.delay, settings.maxDelayMs),
      // The provider asked for longer than one wait may safely last, so this plugin paces it
      // instead of honouring it. The distinction matters when reading the log: the wait below is
      // this plugin's number, not the provider's.
      hint.delay > settings.maxDelayMs ? "provider-advertised-wait-paced-to-safe-ceiling" : "provider-advertised-wait",
      hint.delay,
    )

  const text = `${failure.message ?? ""}\n${failure.body ?? ""}`
  if (!looksThrottled(text)) return decline("text-not-throttle-like")
  return accept(
    clampDelay(backoffDelay(failure.attempt, settings.maxDelayMs), settings.maxDelayMs),
    "exponential-backoff",
  )
}

/**
 * @typedef {{
 *   sessionID: string,
 *   openedAt: number,
 *   lastSeenAt: number,
 *   deadlineAt: number,
 *   phases: number,
 *   refreshes: number,
 *   failedAt: number | null,
 * }} Episode
 */

/**
 * Decides whether a throttled session whose step has run out of attempts should be re-entered,
 * and how long to wait first.
 *
 * A step is the framework's unit of retries: at most `maxAttempts` requests, then the step
 * fails and the session goes idle. The provider's window does not care about that boundary, so
 * without this the work dies with the throttle still in force. Re-entering admits a notice and
 * wakes the session, which starts a new step with a fresh attempt budget.
 *
 * The wait never exceeds the retry cadence: the provider's window is a deadline, not a promise,
 * and an early window close is caught by asking again rather than by sleeping until the
 * provider's own estimate.
 *
 * @param {Episode | undefined} episode
 * @param {Partial<typeof DEFAULTS>} [options]
 * @param {number} [now] epoch milliseconds, injectable for tests
 * @returns {{ continue: true, waitMs: number, reason: string } | { continue: false, reason: string }}
 */
export function continuationDecision(episode, options = {}, now = Date.now()) {
  const settings = { ...DEFAULTS, ...options }
  if (!settings.continueAfterBudget) return { continue: false, reason: "continuation-disabled" }
  if (!episode) return { continue: false, reason: "no-open-episode" }
  if (episode.phases >= settings.maxContinuations) return { continue: false, reason: "continuation-budget-spent" }

  const cadence = (() => {
    const configured = Number(settings.continuationWaitMs ?? settings.maxDelayMs)
    // Capped like `maxDelayMs`, and for the same reason: the timer that delivers a continuation is
    // held by the same instance whose directory activity expires, so a wait past the inactivity
    // timer is a continuation that may never arrive.
    return Math.min(Number.isFinite(configured) ? configured : MAX_SAFE_DELAY_MS, MAX_SAFE_DELAY_MS)
  })()
  const remaining = episode.deadlineAt > 0 ? Math.max(0, episode.deadlineAt - now) : cadence
  const waitMs = Math.min(Math.max(MIN_CONTINUATION_WAIT_MS, remaining), cadence)
  return { continue: true, waitMs, reason: "step-budget-spent" }
}

/**
 * Whether a terminal execution failure still reads as the throttle this plugin was deferring.
 *
 * A step that dies for any other reason is left alone: papering over a genuine failure with a
 * continuation would hide it, which is worse than the failure itself.
 *
 * @param {{ type?: unknown, message?: unknown } | undefined} error
 */
export function failureIsThrottle(error) {
  if (!error || typeof error !== "object") return false
  // `provider.quota` is the framework's own classification of a 429 carrying a quota/usage code
  // (OpenCode Zen's free-tier limiter sends `FreeUsageLimitError`). It is the exact failure this
  // plugin forces retries for, so it is accepted on its own.
  if (error.type === "provider.quota") return true
  return looksThrottled(`${error.message ?? ""}`)
}

export { MIN_CONTINUATION_WAIT_MS }
