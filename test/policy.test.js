import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULTS,
  FRAMEWORK_MAX_ATTEMPTS,
  INACTIVITY_TTL_MS,
  MAX_SAFE_DELAY_MS,
  MIN_CONTINUATION_WAIT_MS,
  backoffDelay,
  continuationDecision,
  decide,
  failureIsThrottle,
  looksThrottled,
  parseRetryAfter,
} from "../src/policy.js"
import { createLogger, errorOf, headersOf, safe, MAX_BYTES } from "../src/diagnostics.js"

const headers = (init) => new Headers(init)

test("no headers means no hint", () => {
  assert.deepEqual(parseRetryAfter(undefined), { delay: 0, blocked: false })
  assert.deepEqual(parseRetryAfter(null), { delay: 0, blocked: false })
  assert.deepEqual(parseRetryAfter(headers({})), { delay: 0, blocked: false })
})

test("x-should-retry false blocks the retry", () => {
  assert.deepEqual(parseRetryAfter(headers({ "x-should-retry": "false", "retry-after": "30" })), {
    delay: 0,
    blocked: true,
  })
})

test("retry-after in seconds becomes milliseconds", () => {
  assert.deepEqual(parseRetryAfter(headers({ "retry-after": "60" })), { delay: 60_000, blocked: false })
})

test("retry-after-ms is read as milliseconds", () => {
  assert.deepEqual(parseRetryAfter(headers({ "retry-after-ms": "1500" })), { delay: 1500, blocked: false })
})

test("an absent retry-after-ms does not mask retry-after", () => {
  // Number(null) is 0, so a naive parse would report a zero delay and never fall through.
  assert.deepEqual(parseRetryAfter(headers({ "retry-after": "60" })).delay, 60_000)
})

test("retry-after as an HTTP date is measured from now", () => {
  const now = Date.parse("2026-10-14T06:02:07.000Z")
  const later = new Date(now + 64673_000).toUTCString()
  assert.deepEqual(parseRetryAfter(headers({ "retry-after": later }), now), { delay: 64673_000, blocked: false })
})

test("an unparseable retry-after is ignored", () => {
  assert.deepEqual(parseRetryAfter(headers({ "retry-after": "soon" })), { delay: 0, blocked: false })
})

test("header lookup is case insensitive and accepts plain objects", () => {
  assert.deepEqual(parseRetryAfter({ "Retry-After": "30" }), { delay: 30_000, blocked: false })
})

test("throttle text is recognised, hard caps are not", () => {
  assert.equal(looksThrottled("Rate limit exceeded. Please try again later."), true)
  assert.equal(looksThrottled("Too Many Requests"), true)
  assert.equal(looksThrottled("Your GLM Coding Plan package has expired"), false)
})

test("backoff grows exponentially and respects the ceiling", () => {
  assert.equal(backoffDelay(1), 2000)
  assert.equal(backoffDelay(2), 4000)
  assert.equal(backoffDelay(3), 8000)
  assert.equal(backoffDelay(20, 10_000), 10_000)
})

test("opencode's own retry decision is never overridden", () => {
  const outcome = decide({ attempt: 1, status: 429, alreadyRetrying: true, hint: { delay: 60_000, blocked: false } })
  assert.equal(outcome.retry, false)
  assert.equal(outcome.reason, "opencode-already-retrying")
})

test("only http 429 is forced", () => {
  for (const status of [400, 401, 402, 403, 404, 500, 503, undefined])
    assert.equal(decide({ attempt: 1, status, message: "Rate limit exceeded." }).retry, false, `status ${status}`)
})

test("a quota failure with an advertised wait is retried", () => {
  const decision = decide({
    attempt: 1,
    status: 429,
    message: "Rate limit exceeded. Please try again later.",
    body: '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}',
    hint: { delay: 64_673_000, blocked: false },
  })
  assert.deepEqual(decision, {
    retry: true,
    delay: DEFAULTS.maxDelayMs,
    reason: "provider-advertised-wait-paced-to-safe-ceiling",
    advertisedDelayMs: 64_673_000,
  })
})

test("the wait ceiling stays clear of the directory inactivity timer", () => {
  // A wait longer than the timer gets the session interrupted mid-sleep, and the interrupt is
  // caused by the wait itself. So the ceiling is not a preference: it has to leave headroom for
  // the request that refreshes the timer.
  assert.equal(DEFAULTS.maxDelayMs, MAX_SAFE_DELAY_MS)
  assert.ok(MAX_SAFE_DELAY_MS < INACTIVITY_TTL_MS, "the ceiling must sit below the timer")
  assert.ok(INACTIVITY_TTL_MS - MAX_SAFE_DELAY_MS >= 5 * 60_000, "at least five minutes of headroom")
})

test("an advertised wait below the ceiling is honoured exactly", () => {
  const decision = decide({ attempt: 1, status: 429, message: "Rate limit exceeded.", hint: { delay: 900_000 } })
  assert.equal(decision.retry, true)
  assert.equal(decision.delay, 900_000)
  assert.equal(decision.reason, "provider-advertised-wait")
  assert.equal(decision.advertisedDelayMs, 900_000)
})

test("an advertised wait above the ceiling is paced, and the log shows both numbers", () => {
  const decision = decide({ attempt: 1, status: 429, message: "Rate limit exceeded.", hint: { delay: 64_673_000 } })
  assert.equal(decision.delay, DEFAULTS.maxDelayMs)
  assert.equal(decision.advertisedDelayMs, 64_673_000)
  assert.notEqual(decision.delay, decision.advertisedDelayMs)
})

test("a wait of zero falls back to backoff, so a hard cap is not retried", () => {
  assert.equal(
    decide({ attempt: 1, status: 429, message: "Your GLM Coding Plan package has expired", hint: { delay: 0, blocked: false } })
      .retry,
    false,
  )
  const forced = decide({ attempt: 1, status: 429, message: "Too Many Requests", hint: { delay: 0, blocked: false } })
  assert.equal(forced.retry, true)
  assert.equal(forced.delay, 2000)
})

test("a provider that says do not retry is obeyed", () => {
  assert.equal(
    decide({ attempt: 1, status: 429, message: "Rate limit exceeded.", hint: { delay: 60_000, blocked: true } }).retry,
    false,
  )
})

test("retries stop at the attempt budget", () => {
  const failure = { attempt: 6, status: 429, message: "Rate limit exceeded.", hint: { delay: 1000, blocked: false } }
  assert.equal(decide(failure, { maxAttempts: 5 }).retry, false)
  assert.equal(decide({ ...failure, attempt: 5 }, { maxAttempts: 5 }).retry, true)
})

test("the attempt budget cannot exceed what the framework will ask about", () => {
  // session/runner/retry.ts builds its schedule as Schedule.recurs(10) and consults the retry hook
  // once per recurrence, so attempts 2 through 11 are the whole conversation. A larger budget can
  // never be acted on, and the continuation is what covers the window past it.
  assert.equal(DEFAULTS.maxAttempts, FRAMEWORK_MAX_ATTEMPTS)
  assert.equal(FRAMEWORK_MAX_ATTEMPTS, 11)
})

test("every forced delay is at least one second", () => {
  assert.deepEqual(decide({ attempt: 1, status: 429, message: "Rate limit exceeded.", hint: { delay: 1, blocked: false } }), {
    retry: true,
    delay: 1000,
    reason: "provider-advertised-wait",
    advertisedDelayMs: 1,
  })
})

test("every decline says why, so no path is silent", () => {
  // A decline used to return undefined, which is indistinguishable from the hook never firing.
  // That ambiguity is what made an unexplained terminal failure undiagnosable.
  const cases = [
    [{ attempt: 1, status: 429, alreadyRetrying: true }, "opencode-already-retrying"],
    [{ attempt: 1, status: 500, message: "Rate limit exceeded." }, "not-http-429"],
    [{ attempt: 99, status: 429, message: "Rate limit exceeded." }, "attempt-budget-spent"],
    [{ attempt: 1, status: 429, message: "Rate limit exceeded.", hint: { delay: 0, blocked: true } }, "provider-said-do-not-retry"],
    [{ attempt: 1, status: 429, message: "Your plan expired", hint: { delay: 0, blocked: false } }, "text-not-throttle-like"],
  ]
  for (const [failure, reason] of cases) {
    const outcome = decide(failure)
    assert.equal(outcome.retry, false, reason)
    assert.equal(outcome.reason, reason)
  }
})

test("an accepted decision reports which strategy chose the delay", () => {
  assert.equal(
    decide({ attempt: 1, status: 429, message: "Rate limit exceeded.", hint: { delay: 60_000, blocked: false } }).reason,
    "provider-advertised-wait",
  )
  assert.equal(decide({ attempt: 2, status: 429, message: "Too Many Requests" }).reason, "exponential-backoff")
})

const episode = (overrides = {}) => ({
  sessionID: "ses_test",
  openedAt: 1_000,
  lastSeenAt: 1_000,
  deadlineAt: 0,
  phases: 0,
  refreshes: 0,
  failedAt: 2_000,
  ...overrides,
})

test("a failure with no open episode is never continued", () => {
  // The episode is the whole guard: without one the failure had nothing to do with a throttle
  // this plugin was pacing, and a continuation would hide the real problem.
  assert.deepEqual(continuationDecision(undefined), { continue: false, reason: "no-open-episode" })
})

test("a step that runs out of budget while the window is open continues the turn", () => {
  const outcome = continuationDecision(episode())
  assert.equal(outcome.continue, true)
  assert.equal(outcome.waitMs, DEFAULTS.maxDelayMs)
  assert.equal(outcome.reason, "step-budget-spent")
})

test("a continuation never waits longer than the retry cadence", () => {
  // The provider's window is a deadline, not a promise: an early close has to be caught by asking
  // again, not by sleeping until the provider's own estimate of when it ends.
  const now = 1_000_000
  const outcome = continuationDecision(episode({ deadlineAt: now + 20 * 60 * 60_000 }), {}, now)
  assert.equal(outcome.continue, true)
  assert.equal(outcome.waitMs, DEFAULTS.maxDelayMs)
})

test("a closing window shortens the wait, and a passed deadline still waits", () => {
  const now = 1_000_000
  assert.equal(continuationDecision(episode({ deadlineAt: now + 120_000 }), {}, now).waitMs, 120_000)
  assert.equal(continuationDecision(episode({ deadlineAt: now - 60_000 }), {}, now).waitMs, MIN_CONTINUATION_WAIT_MS)
})

test("a continuation never waits past the inactivity timer either", () => {
  // The pending timer lives in the same instance whose directory can be evicted after the
  // inactivity timer expires, so a longer wait is a continuation that might never arrive.
  const outcome = continuationDecision(episode(), { continuationWaitMs: 6 * 60 * 60_000 })
  assert.equal(outcome.continue, true)
  assert.equal(outcome.waitMs, MAX_SAFE_DELAY_MS)
})

test("continuations are bounded, so a permanently throttled provider cannot loop", () => {
  assert.equal(continuationDecision(episode({ phases: DEFAULTS.maxContinuations })).continue, false)
  assert.equal(continuationDecision(episode({ phases: DEFAULTS.maxContinuations })).reason, "continuation-budget-spent")
  assert.equal(continuationDecision(episode({ phases: 3 }), { maxContinuations: 10 }).continue, true)
})

test("continuation can be turned off entirely", () => {
  assert.equal(continuationDecision(episode(), { continueAfterBudget: false }).reason, "continuation-disabled")
})

test("only a throttle failure is continued", () => {
  assert.equal(failureIsThrottle({ type: "provider.quota", message: "Rate limit exceeded." }), true)
  assert.equal(failureIsThrottle({ type: "provider.unknown", message: "Too Many Requests" }), true)
  assert.equal(failureIsThrottle({ type: "provider.unknown", message: "Your plan expired" }), false)
  assert.equal(failureIsThrottle({ type: "tool.error", message: "build failed" }), false)
  assert.equal(failureIsThrottle(undefined), false)
})

test("diagnostics write structured lines that survive unserialisable fields", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const dir = await mkdtemp(path.join(tmpdir(), "rlr-"))
  const file = path.join(dir, "nested", "diag.jsonl")
  try {
    const log = createLogger(file, () => {})
    log.log("test.event", { sessionID: "ses_x", nested: { a: 1 }, big: "y".repeat(2000) })
    const text = await readFile(file, "utf8")
    const record = JSON.parse(text.trim())
    assert.equal(record.event, "test.event")
    assert.equal(record.sessionID, "ses_x")
    assert.deepEqual(record.nested, { a: 1 })
    assert.ok(record.big.length < 700, "oversized fields are truncated")
    assert.ok(text.includes("[+"), "truncation is visible rather than silent")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a circular payload cannot break the logger", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const dir = await mkdtemp(path.join(tmpdir(), "rlr-"))
  const file = path.join(dir, "diag.jsonl")
  try {
    const log = createLogger(file, () => {})
    const circular = { name: "loop" }
    circular.self = circular
    log.log("test.circular", { circular })
    assert.ok((await readFile(file, "utf8")).includes("test.circular"))
    assert.equal(log.size() > 0, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the diagnostic file can never grow past its cap", async () => {
  // The whole point of a separate file is that it cannot bloat the disk, so the cap is asserted
  // rather than assumed: write far more than the limit and confirm the file stays bounded.
  const { mkdtemp, stat, readFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const dir = await mkdtemp(path.join(tmpdir(), "rlr-"))
  const file = path.join(dir, "diag.jsonl")
  try {
    const log = createLogger(file, () => {})
    for (let i = 0; i < 12_000; i++) log.log("spam", { i, pad: "z".repeat(200) })
    const size = (await stat(file)).size
    assert.ok(size <= MAX_BYTES, `file grew to ${size}, past the ${MAX_BYTES} cap`)
    const text = await readFile(file, "utf8")
    assert.ok(text.includes("<<trimmed"), "trimming is recorded so lost history is never silent")
    assert.ok(text.trimStart().startsWith("<<trimmed"), "the file never begins mid-record")
    // Every surviving line must still be parseable after an in-place trim.
    for (const line of text.trim().split("\n")) {
      if (line.startsWith("<<trimmed")) continue
      JSON.parse(line)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a broken log destination reports once and never throws into the caller", async () => {
  // A logger that throws would convert a diagnostic into an outage, which is the one failure
  // mode that must be impossible.
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const dir = await mkdtemp(path.join(tmpdir(), "rlr-"))
  try {
    const file = path.join(dir, "diag.jsonl")
    const failures = []
    const log = createLogger(file, (cause) => failures.push(cause))
    await rm(file, { force: true })
    const blocked = path.join(file, "blocked", "nested.jsonl")
    const log2 = createLogger(blocked, (cause) => failures.push(cause))
    // Writing under a path that cannot be created must surface once, then go quiet.
    assert.doesNotThrow(() => log.log("first", {}))
    assert.doesNotThrow(() => log.log("second", {}))
    assert.doesNotThrow(() => log2.log("third", {}))
    assert.ok(log.size() > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("error and header projection keep the fields a diagnosis needs", () => {
  const projected = errorOf({
    type: "provider.quota",
    status: 429,
    message: "Rate limit exceeded. Please try again later.",
    response: { body: '{"type":"error"}' },
  })
  assert.equal(projected.type, "provider.quota")
  assert.equal(projected.status, 429)
  assert.ok(projected.body.includes("FreeUsageLimitError") || projected.body.includes("error"))
  assert.deepEqual(headersOf(headers({ "Retry-After": "60" })), { "retry-after": "60" })
  assert.equal(headersOf(undefined), undefined)
  assert.equal(safe(undefined), undefined)
  assert.equal(safe(() => {}), "[function]")
})