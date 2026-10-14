import assert from "node:assert/strict"
import test from "node:test"

import { DEFAULTS, backoffDelay, decide, looksThrottled, parseRetryAfter } from "../src/policy.js"

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
  assert.equal(decide({ attempt: 1, status: 429, alreadyRetrying: true, hint: { delay: 60_000, blocked: false } }), undefined)
})

test("only http 429 is forced", () => {
  for (const status of [400, 401, 402, 403, 404, 500, 503, undefined])
    assert.equal(decide({ attempt: 1, status, message: "Rate limit exceeded." }), undefined, `status ${status}`)
})

test("a quota failure with an advertised wait is retried", () => {
  const decision = decide({
    attempt: 1,
    status: 429,
    message: "Rate limit exceeded. Please try again later.",
    body: '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}',
    hint: { delay: 64_673_000, blocked: false },
  })
  assert.deepEqual(decision, { retry: true, delay: 64_673_000 })
})

test("an advertised wait is passed through, not clamped to the ceiling", () => {
  // Zen advertises seconds until midnight. Capping this at the 24h ceiling would change nothing,
  // but clamping to a shorter ceiling must visibly shorten the wait.
  assert.equal(DEFAULTS.maxDelayMs, 86_400_000)
  const decision = decide({ attempt: 1, status: 429, message: "Rate limit exceeded.", hint: { delay: 64_673_000 } }, { maxDelayMs: 900_000 })
  assert.deepEqual(decision, { retry: true, delay: 900_000 })
})

test("a wait of zero falls back to backoff, so a hard cap is not retried", () => {
  assert.equal(
    decide({ attempt: 1, status: 429, message: "Your GLM Coding Plan package has expired", hint: { delay: 0, blocked: false } }),
    undefined,
  )
  assert.deepEqual(decide({ attempt: 1, status: 429, message: "Too Many Requests", hint: { delay: 0, blocked: false } }), {
    retry: true,
    delay: 2000,
  })
})

test("a provider that says do not retry is obeyed", () => {
  assert.equal(
    decide({ attempt: 1, status: 429, message: "Rate limit exceeded.", hint: { delay: 60_000, blocked: true } }),
    undefined,
  )
})

test("retries stop at the attempt budget", () => {
  const failure = { attempt: 6, status: 429, message: "Rate limit exceeded.", hint: { delay: 1000, blocked: false } }
  assert.equal(decide(failure), undefined)
  assert.deepEqual(decide({ ...failure, attempt: 5 }), { retry: true, delay: 1000 })
})

test("every forced delay is at least one second", () => {
  assert.deepEqual(decide({ attempt: 1, status: 429, message: "Rate limit exceeded.", hint: { delay: 1, blocked: false } }), {
    retry: true,
    delay: 1000,
  })
})