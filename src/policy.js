/**
 * Decision logic for the retry hook. Plain ESM with no dependencies and no platform
 * assumptions, so it runs unchanged under Bun, Node, macOS, Linux and Windows, and can be
 * unit tested without OpenCode.
 */

export const DEFAULTS = {
  /** Providers the http.response hook is scoped to. Empty means every provider. */
  providers: ["opencode"],
  /**
   * Ceiling for a single wait. 24h by default so a provider's advertised wait is honoured as
   * is: OpenCode Zen's free-tier limiter answers with "seconds until midnight", and re-asking
   * every 15 minutes (OpenCode 2's internal clamp) just burns the attempt budget.
   */
  maxDelayMs: 24 * 60 * 60_000,
  /** OpenCode 1's RETRY_MAX_RETRIES. */
  maxAttempts: 5,
  verbose: false,
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

/**
 * Decides whether to force a retry that OpenCode 2 would not perform itself.
 *
 * Returns undefined whenever OpenCode's own decision should stand, which keeps its backoff,
 * jitter and per-step budget authoritative everywhere this plugin has no opinion.
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
 * @returns {{ retry: true, delay: number } | undefined}
 */
export function decide(failure, options = {}) {
  const settings = { ...DEFAULTS, ...options }
  if (failure.alreadyRetrying) return undefined
  if (failure.status !== 429) return undefined
  if (!(failure.attempt <= settings.maxAttempts)) return undefined

  const hint = failure.hint
  if (hint?.blocked) return undefined

  if (hint && hint.delay > 0) return { retry: true, delay: clampDelay(hint.delay, settings.maxDelayMs) }

  const text = `${failure.message ?? ""}\n${failure.body ?? ""}`
  if (!looksThrottled(text)) return undefined
  return { retry: true, delay: clampDelay(backoffDelay(failure.attempt, settings.maxDelayMs), settings.maxDelayMs) }
}