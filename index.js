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
 * Three documented entry points, no source patching, so upgrading OpenCode cannot clobber it:
 *
 *   - `http.response` records the provider's `retry-after` (and an explicit
 *     `x-should-retry: false`) for the session. Headers only.
 *   - `retry` re-enables a retry when OpenCode decided not to retry an HTTP 429, using the
 *     advertised wait. Every failure OpenCode already retries keeps its own policy untouched.
 *   - the server event stream watches for the terminal failure of a turn this plugin deferred,
 *     so a throttle window longer than one step's attempt budget can be continued rather than
 *     lost (see "CONTINUATION" below).
 *
 * OpenCode projects the forced retry as `session.retry.scheduled`, so the TUI shows the same
 * "Retrying in Ns - attempt N - <message>" it showed in 1.x.
 *
 * WHY THE WAIT IS CAPPED, AND NOT AT 24 HOURS
 * -------------------------------------------
 * A wait does not happen in a vacuum. OpenCode keeps an activity timer per directory
 * (`packages/core/src/location-activity.ts`, 60 minutes) and interrupts every session still
 * executing in a directory whose timer expired:
 *
 *   Execution.Interrupted { reason: "inactivity" }
 *
 * Only a durable session event carrying a `location` refreshes that timer, and the retry loop
 * publishes two per attempt (`session.retry.scheduled` before the sleep, `session.step.started`
 * when the attempt runs), both from inside the session's location. So a wait shorter than the
 * timer keeps the session alive for as long as attempts remain - and a wait longer than the
 * timer gets the session killed mid-sleep, with the plugin's own forced wait as the cause.
 *
 * That is why `maxDelayMs` defaults to 50 minutes rather than to a day: the advertised wait is
 * covered by a sequence of safe waits instead of one wait that outlives the session.
 *
 * CONTINUATION
 * ------------
 * One step may only retry `Schedule.recurs(10)` times (`session/runner/retry.ts`), so a long
 * throttle window eventually exhausts the budget and the step fails with the throttle still in
 * force. When that happens - and only when the failure is still the throttle this plugin was
 * deferring - the plugin waits out one more retry cadence, admits a short notice into the
 * session, and wakes it. The turn resumes in a fresh step with a fresh attempt budget.
 * `maxContinuations` bounds this, so a permanently throttled provider cannot loop forever.
 *
 * DIAGNOSTICS
 * -----------
 * `console.log` is unusable here. The background service is spawned with
 * `stdio: ["ignore", "ignore", "pipe"]`, so its stdout is discarded and its stderr survives only
 * as an 8 KB in-memory tail; `opencode.log` is written by Effect's file logger and never sees a
 * plugin's `console` output. A retry can therefore be forced with no trace whatsoever, which
 * makes an unexplained terminal failure undiagnosable after the fact.
 *
 * So every decision is written to a dedicated, size-capped JSONL file (see `diagnostics.js`).
 * This is the single most important property of the plugin: an unexplained rate-limit failure is
 * exactly the case where the evidence has to survive until someone goes looking for it.
 *
 * Cross-platform by construction: no filesystem assumptions beyond `node:fs`, no shell or
 * OS-specific API, and the decision logic is a dependency-free module covered by tests on Linux,
 * macOS and Windows.
 */

import path from "node:path"
import os from "node:os"

import { Plugin } from "@opencode/plugin"
import {
  DEFAULTS,
  INACTIVITY_TTL_MS,
  continuationDecision,
  decide,
  failureIsThrottle,
  parseRetryAfter,
} from "./src/policy.js"
import { createLogger, errorOf, headersOf, safe } from "./src/diagnostics.js"

/** How long a captured hint stays usable, so a stale wait is never applied. */
const FRESH_MS = 120_000

/**
 * How often to prove the plugin is still loaded and its hooks are still registered.
 *
 * Long enough to be free (a few hundred bytes an hour), short enough that an unexplained failure
 * can be dated: if the last heartbeat precedes the incident, the plugin was not running and no
 * episode record is missing because nothing was ever consulted.
 */
const HEARTBEAT_MS = 30 * 60_000

/**
 * The notice admitted when a throttled turn is continued into a fresh step.
 *
 * Worded like the framework's own restart notice (`CONTINUE_AFTER_SERVER_RESTART`) because it
 * serves the same purpose: the model wakes up mid-task and must pick the thread up rather than
 * treat the notice as its next instruction.
 */
const CONTINUATION_TEXT = [
  "The provider was rate limiting this session, so the turn was paused and is now being resumed automatically.",
  "Continue from where you left off. Do not repeat work that already finished.",
].join("\n")

/**
 * @typedef {{ at: number, delay: number, blocked: boolean }} Hint
 */

/**
 * Resolves where diagnostics are written.
 *
 * The plugin has no access to the server's data directory, so this reproduces the same layout
 * the CLI uses (`Global.Path.data`): `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`.
 * The file lives beside the log directory rather than inside it, so the framework's own 50 MB
 * trimmer never has to reason about lines it did not write.
 *
 * @param {unknown} [configured] explicit override
 */
function resolveLogFile(configured) {
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim()
  const app = "opencode"
  const dataRoot = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(dataRoot, app, "ratelimit-retry.jsonl")
}

export default Plugin.define({
  id: "opencode.ratelimit-retry",
  /**
   * @param {import("@opencode/plugin").Context} ctx
   */
  async setup(ctx) {
    const options = { ...DEFAULTS, ...(ctx.options ?? {}) }
    /** @type {Map<string, Hint>} */
    const hints = new Map()

    // Distinguishes a subagent from the session you are typing in. Resolution failures are logged
    // and cached as "unknown" so a lookup never turns into a silent gap in the record.
    /** @type {Map<string, { parentID?: string, title?: string, subagent: boolean, resolved: boolean }>} */
    const identity = new Map()

    /**
     * Sessions this plugin has deferred at least once and has not seen finish.
     *
     * An episode is what separates "this turn died inside a throttle we were pacing" - worth
     * continuing - from "this turn died because something else went wrong" - never touched.
     *
     * @type {Map<string, import("./src/policy.js").Episode>}
     */
    const episodes = new Map()

    /** One pending continuation per session, so a burst of failures cannot stack timers. */
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    const continuations = new Map()

    const logFile = resolveLogFile(options.diagnosticsFile)
    const instance = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const logger = createLogger(logFile, (cause) => {
      // Deliberately the one thing not routed through the logger, to avoid infinite recursion.
      console.error(`[ratelimit-retry] diagnostic log unavailable at ${logFile}:`, cause)
    })

    const bootAt = Date.now()

    // A plugin that loaded but never fires produces no records at all, which is indistinguishable
    // from a plugin that was never installed. A low-frequency heartbeat closes that gap: its
    // absence dates the last time this code was demonstrably alive.
    const heartbeat = setInterval(() => {
      logger.log("plugin.heartbeat", {
        instance,
        uptimeMs: Date.now() - bootAt,
        logBytes: logger.size(),
        trackedSessions: identity.size,
        pendingHints: hints.size,
        openEpisodes: episodes.size,
        pendingContinuations: continuations.size,
      })
    }, HEARTBEAT_MS)
    // Never hold the process open for a diagnostic.
    if (typeof heartbeat.unref === "function") heartbeat.unref()

    logger.log("plugin.setup", {
      instance,
      pid: process.pid,
      version: ctx.app?.version,
      channel: ctx.app?.channel,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      location: ctx.location?.directory,
      file: logFile,
      options,
      freshMs: FRESH_MS,
      inactivityTtlMs: INACTIVITY_TTL_MS,
      note: "hooks register next; a missing retry hook below means the SDK changed",
    })

    // A wait past the inactivity timer is not a preference, it is the failure this plugin was
    // installed to stop. If it is configured anyway, the log has to say so before it happens.
    if (Number(options.maxDelayMs) > INACTIVITY_TTL_MS)
      logger.log("config.max-delay-above-inactivity-ttl", {
        instance,
        maxDelayMs: options.maxDelayMs,
        inactivityTtlMs: INACTIVITY_TTL_MS,
        note: "a single wait this long outlives the directory's activity timer, which interrupts the session mid-sleep",
      })

    /**
     * @param {string} sessionID
     */
    const identify = (sessionID) => {
      const cached = identity.get(sessionID)
      if (cached) return cached
      /** @type {{ parentID?: string, title?: string, subagent: boolean, resolved: boolean, lookup: Promise<void> }} */
      const entry = { subagent: false, resolved: false, lookup: Promise.resolve() }
      identity.set(sessionID, entry)
      // Fire and forget for the callers that only log: resolution must never delay or fail a retry
      // decision. Callers that gate on the answer use `identifyAsync`.
      entry.lookup = ctx.session
        .get({ sessionID })
        .then((session) => {
          // Accepts both the bare value and the `{ data }` envelope the HTTP client returns.
          const info = session && typeof session === "object" && "data" in session ? session.data : session
          const parentID = info?.parentID
          entry.parentID = typeof parentID === "string" ? parentID : undefined
          entry.title = typeof info?.title === "string" ? info.title : undefined
          entry.subagent = typeof parentID === "string"
          entry.resolved = true
        })
        .catch((cause) => {
          // Left unresolved on purpose: `subagent` stays null, so a record never implies a main
          // session that was never actually confirmed.
          entry.resolved = false
          logger.log("session.identify.failed", { sessionID, error: safe(cause) })
        })
      return entry
    }

    /**
     * Identity, waiting for the first lookup when it has not landed yet.
     *
     * The subagent gate has to be certain rather than fast: the first event of a throttle is
     * exactly when the lookup is still in flight, so reading the cached entry there would answer
     * "not a subagent" for every subagent. The lookup is one indexed read on a session that has
     * already made a provider request, and its failure is already logged by `identify`.
     *
     * @param {string} sessionID
     */
    const identifyAsync = async (sessionID) => {
      const entry = identify(sessionID)
      if (!entry.resolved) await entry.lookup
      return entry
    }

    /**
     * Session identity, resolving the parent/child relationship on first sight.
     *
     * `subagent` is the field that makes a subagent failure legible at all, so a record where the
     * lookup has not landed says so explicitly (`null`) rather than implying "main session".
     *
     * @param {string} sessionID
     */
    const describe = (sessionID) => {
      const entry = identify(sessionID)
      return {
        sessionID,
        subagent: entry.resolved ? entry.subagent : null,
        subagentResolved: entry.resolved,
        parentID: entry.parentID ?? null,
        title: entry.title ?? null,
        label: entry.resolved ? `${entry.subagent ? "subagent" : "main"}:${entry.title ?? sessionID}` : `${sessionID} (identity unresolved)`,
      }
    }

    /**
     * @param {{ sessionID: string, response: Response, model?: any, agent?: any, kind?: string }} event
     */
    const capture = (event) => {
      const status = event.response.status
      if (status !== 429) {
        // Only genuine near-misses are recorded. Logging every successful response would bury the
        // episodes that matter under thousands of lines a day, so the rule is narrow: a status
        // that carries a retry hint or a throttle word is exactly the failure this plugin cannot
        // see otherwise, and must not be invisible.
        const headers = event.response.headers
        const hintish = headers ? headers.get("retry-after") !== null || headers.get("x-ratelimit-remaining") !== null : false
        if (status < 400 || !hintish) return
        logger.log("http.response.throttle-like", {
          ...describe(event.sessionID),
          status,
          kind: event.kind,
          agent: event.agent,
          model: event.model,
          note: "not HTTP 429, so this plugin cannot force a retry for it",
          headers: headersOf(headers),
        })
        return
      }
      const hint = parseRetryAfter(event.response.headers)
      const previous = hints.get(event.sessionID)
      hints.set(event.sessionID, { at: Date.now(), delay: hint.delay, blocked: hint.blocked })
      logger.log("http.response.429", {
        ...describe(event.sessionID),
        status,
        kind: event.kind,
        agent: event.agent,
        model: event.model,
        requestURL: event.request ? safe(String(event.request.url)) : null,
        parsedDelayMs: hint.delay,
        parsedBlocked: hint.blocked,
        replacedExistingHint: previous !== undefined,
        previousAgeMs: previous === undefined ? null : Date.now() - previous.at,
        headers: headersOf(event.response.headers),
      })
    }

    // Scoping the capture hook keeps the extra response handling off providers that cannot
    // produce these failures. An empty providers list registers it for every provider.
    const registrations = []
    try {
      if (options.providers.length === 0) registrations.push(await ctx.session.hook("http.response", capture))
      for (const providerID of options.providers)
        registrations.push(await ctx.session.hook("http.response", capture, { providerID }))
      logger.log("hooks.registered", {
        instance,
        httpResponse: options.providers.length === 0 ? "all-providers" : options.providers,
        count: registrations.length,
      })
    } catch (cause) {
      // Without this hook there is no retry-after, so every decision degrades to backoff. That
      // is a plausible cause of an unexplained failure and must be on the record.
      logger.log("hooks.http.response.failed", { instance, error: safe(cause), options })
    }

    /**
     * Opens or refreshes the episode for a session the plugin (or OpenCode) is waiting out.
     *
     * Refreshing keeps the original `openedAt` and the continuation count: one throttle window is
     * one episode, however many attempts it takes to cover it.
     *
     * @param {string} sessionID
     * @param {number | undefined} deadlineAt epoch milliseconds the provider expects the window to close
     * @param {string} reason
     */
    const openEpisode = (sessionID, deadlineAt, reason) => {
      const now = Date.now()
      const existing = episodes.get(sessionID)
      if (existing) {
        existing.lastSeenAt = now
        existing.refreshes += 1
        if (deadlineAt !== undefined && deadlineAt > existing.deadlineAt) existing.deadlineAt = deadlineAt
        return existing
      }
      /** @type {import("./src/policy.js").Episode} */
      const episode = {
        sessionID,
        openedAt: now,
        lastSeenAt: now,
        deadlineAt: deadlineAt ?? 0,
        phases: 0,
        refreshes: 0,
        failedAt: null,
      }
      episodes.set(sessionID, episode)
      logger.log("episode.opened", {
        ...describe(sessionID),
        reason,
        deadlineAt: episode.deadlineAt > 0 ? episode.deadlineAt : null,
        note: "this session is being deferred; it will be continued if its step budget runs out",
      })
      return episode
    }

    /**
     * @param {string} sessionID
     * @param {string} reason
     * @param {Record<string, unknown>} [fields]
     */
    const closeEpisode = (sessionID, reason, fields) => {
      const episode = episodes.get(sessionID)
      if (!episode) return
      episodes.delete(sessionID)
      const timer = continuations.get(sessionID)
      if (timer !== undefined) {
        clearTimeout(timer)
        continuations.delete(sessionID)
      }
      logger.log("episode.closed", {
        ...describe(sessionID),
        reason,
        phases: episode.phases,
        refreshes: episode.refreshes,
        openMs: Date.now() - episode.openedAt,
        ...(fields ?? {}),
      })
    }

    /**
     * Re-enters a session whose step budget ran out while its provider window is still open.
     *
     * `synthetic` admits a notice and, with `resume`, wakes the session, so the runner starts a
     * new step: a fresh `Schedule.recurs(10)` and a fresh attempt budget. This is the same shape
     * the framework itself uses to continue a turn after a server restart.
     *
     * @param {import("./src/policy.js").Episode} episode
     */
    const sendContinuation = async (episode) => {
      const who = describe(episode.sessionID)
      // Cleared before the call, not after: the resumed turn publishes its own
      // `session.execution.started`, which can reach this loop while the call is still pending, and
      // that arrival must not be mistaken for someone else re-driving the session.
      episode.failedAt = null
      try {
        await ctx.session.synthetic({
          sessionID: episode.sessionID,
          text: CONTINUATION_TEXT,
          description: "Rate limit retry",
          metadata: {
            source: "opencode-ratelimit-retry",
            phase: episode.phases + 1,
            // Spread rather than set to `undefined`: the notice goes through a schema decode on the
            // way to the session, and a present-but-undefined field is not worth the risk.
            ...(episode.deadlineAt > 0 ? { deadlineAt: episode.deadlineAt } : {}),
          },
          resume: true,
        })
        episode.phases += 1
        episode.lastSeenAt = Date.now()
        logger.log("continuation.sent", {
          ...who,
          phase: episode.phases,
          maxContinuations: options.maxContinuations,
          note: "the turn resumes in a fresh step, which resets the attempt budget",
        })
      } catch (cause) {
        // The episode stays open at the same phase, so the next failure tries again. A failed
        // continuation is the one thing that must never be silent.
        episode.failedAt = Date.now()
        logger.log("continuation.failed", { ...who, phase: episode.phases, error: safe(cause) })
      }
    }

    /**
     * Schedules one continuation, replacing any timer already pending for the session.
     *
     * @param {import("./src/policy.js").Episode} episode
     * @param {number} waitMs
     * @param {string} reason
     */
    const scheduleContinuation = (episode, waitMs, reason) => {
      const pending = continuations.get(episode.sessionID)
      if (pending !== undefined) clearTimeout(pending)
      const timer = setTimeout(() => {
        continuations.delete(episode.sessionID)
        // Re-checked at fire time: the session may have finished, been interrupted, or been
        // deleted while this timer was pending.
        const current = episodes.get(episode.sessionID)
        if (current !== episode) return
        void sendContinuation(episode)
      }, waitMs)
      continuations.set(episode.sessionID, timer)
      logger.log("continuation.scheduled", {
        ...describe(episode.sessionID),
        waitMs,
        reason,
        phase: episode.phases + 1,
        firesAt: Date.now() + waitMs,
      })
    }

    /**
     * @param {any} event
     */
    const onServerEvent = async (event) => {
      const type = String(event?.type ?? "")
      if (!type.startsWith("session.")) return
      const sessionID = event?.data?.sessionID
      if (typeof sessionID !== "string") return

      if (type === "session.execution.succeeded") {
        // The work got through. Whatever window this session was in, it is over.
        closeEpisode(sessionID, "turn-succeeded")
        return
      }

      if (type === "session.execution.started") {
        // A start after a recorded failure means someone else already re-drove the session, so a
        // queued continuation is stale.
        const episode = episodes.get(sessionID)
        if (episode && episode.failedAt !== null) {
          closeEpisode(sessionID, "resumed-externally", { failedAgoMs: Date.now() - episode.failedAt })
        }
        return
      }

      if (type === "session.execution.failed") {
        const episode = episodes.get(sessionID)
        if (!episode) return
        if (!failureIsThrottle(event?.data?.error)) {
          // Anything else is left exactly as it was: a continuation would hide a real failure.
          closeEpisode(sessionID, "turn-failed-not-throttle", { error: safe(event?.data?.error) })
          return
        }
        const entry = await identifyAsync(sessionID)
        if (entry.subagent && !options.continueSubagents) {
          closeEpisode(sessionID, "subagent-turn-failed", {
            note: "continueSubagents is off: a failed subagent is a result its parent already has, and the parent owns what happens next",
          })
          return
        }
        episode.failedAt = Date.now()
        const outcome = continuationDecision(episode, options)
        logger.log("continuation.decided", {
          ...describe(sessionID),
          decision: outcome,
          phases: episode.phases,
          deadlineInMs: episode.deadlineAt > 0 ? episode.deadlineAt - Date.now() : null,
          error: safe(event?.data?.error),
        })
        if (!outcome.continue) {
          closeEpisode(sessionID, outcome.reason)
          return
        }
        scheduleContinuation(episode, outcome.waitMs, outcome.reason)
        return
      }

      if (type === "session.execution.interrupted") {
        const reason = event?.data?.reason
        if (reason === "shutdown") {
          // The framework resumes claimed turns at the next boot, and this process is on its way
          // out, so the episode is left to the framework rather than duplicated here.
          logger.log("episode.interrupted", { ...describe(sessionID), reason, note: "shutdown keeps the claim; the next boot resumes the turn" })
          return
        }
        const episode = episodes.get(sessionID)
        if (!episode) return
        if (reason === "inactivity") {
          const entry = await identifyAsync(sessionID)
          if (entry.subagent && !options.continueSubagents) {
            closeEpisode(sessionID, "subagent-interrupted", {
              note: "continueSubagents is off: an interrupted child is its parent's to deal with",
            })
            return
          }
          // The sweep won a race the plugin is supposed to win: a suspended machine, a stalled
          // clock, or a wait configured past the timer. The session is idle, not broken, so the
          // same continuation recovers it - but resumed *now* rather than after a cadence.
          //
          // location-activity.ts interrupts, settles, then re-checks `execution.active` and evicts
          // the location unless new work owns it. A timer would fire into the torn-down scope that
          // this plugin lives in and never arrive; an immediate resume is the one action that can
          // either be admitted during that cleanup or boot the location again.
          episode.failedAt = Date.now()
          const outcome = continuationDecision(episode, options)
          logger.log("continuation.decided", {
            ...describe(sessionID),
            reason,
            decision: outcome,
            phases: episode.phases,
            note: "the session was interrupted by the inactivity sweep, not by a failure; resuming immediately rather than waiting",
          })
          if (!outcome.continue) {
            closeEpisode(sessionID, outcome.reason)
            return
          }
          void sendContinuation(episode)
          return
        }
        closeEpisode(sessionID, `interrupted-by-${String(reason ?? "unknown")}`)
        return
      }

      if (type === "session.deleted") {
        closeEpisode(sessionID, "session-removed")
      }
    }

    // The event stream is what makes a bounded step survivable: without it the plugin would learn
    // about the end of a throttled turn only by being consulted, and it never is.
    let listening = true
    let subscription = null
    try {
      if (typeof ctx.event?.subscribe !== "function") throw new Error("ctx.event.subscribe is unavailable")
      const stream = ctx.event.subscribe()
      if (!stream || typeof stream[Symbol.asyncIterator] !== "function")
        throw new Error("ctx.event.subscribe did not return an async iterable")
      subscription = (async () => {
        try {
          for await (const event of stream) {
            if (!listening) break
            try {
              // Awaited so events keep their order: a continuation scheduled by one event must not
              // race the `execution.started` that follows it.
              await onServerEvent(event)
            } catch (cause) {
              // A handler that throws must not end the subscription: the next failure may be the
              // one that matters.
              logger.log("event.handler.failed", { instance, error: safe(cause) })
            }
          }
          logger.log("events.ended", { instance, note: listening ? "the stream closed on its own" : "disposed" })
        } catch (cause) {
          logger.log("events.failed", {
            instance,
            error: safe(cause),
            note: "without the event stream a throttled turn that exhausts its step budget is not continued",
          })
        }
      })()
      logger.log("events.subscribed", { instance })
    } catch (cause) {
      logger.log("events.unavailable", {
        instance,
        error: safe(cause),
        note: "step-budget continuations are off for this instance; retries themselves are unaffected",
      })
    }

    let retryHook = null
    try {
      retryHook = await ctx.session.hook("retry", (event) => {
        const raw = hints.get(event.sessionID)
        const hintAge = raw === undefined ? null : Date.now() - raw.at
        if (raw && hintAge > FRESH_MS) {
          hints.delete(event.sessionID)
          logger.log("hint.expired", { ...describe(event.sessionID), ageMs: hintAge, freshMs: FRESH_MS })
        }
        const hint = hints.get(event.sessionID)
        const who = describe(event.sessionID)

        // Every consultation is recorded, forced or not. An unlogged decline is indistinguishable
        // from a hook that never fired, which is the ambiguity that made this undiagnosable.
        const outcome = decide(
          {
            attempt: event.attempt,
            status: event.error.status,
            message: event.error.message,
            body: event.error.response?.body,
            alreadyRetrying: event.decision.retry,
            hint,
          },
          options,
        )

        logger.log("retry.consulted", {
          ...who,
          agent: event.agent,
          model: event.model,
          attempt: event.attempt,
          maxAttempts: options.maxAttempts,
          kind: "retry-hook",
          status: event.error.status,
          opencodeDecision: event.decision,
          decision: outcome,
          hint: hint ? { ...hint, ageMs: Date.now() - hint.at } : null,
          error: errorOf(event.error),
          uptimeMs: Date.now() - bootAt,
        })

        // An episode is opened for exactly the failures this plugin would defer for: the ones it
        // forces, and the throttles OpenCode is already retrying (its own budget is just as
        // finite). A provider that explicitly said "do not retry" is never deferred for.
        const deferred =
          outcome.reason !== "provider-said-do-not-retry" &&
          (outcome.retry === true ||
            (outcome.reason === "opencode-already-retrying" &&
              failureIsThrottle({ type: event.error.type, message: event.error.message })))
        if (deferred)
          openEpisode(
            event.sessionID,
            hint && hint.delay > 0 ? Date.now() + hint.delay : undefined,
            outcome.reason,
          )

        if (!outcome.retry) return

        event.decision = { retry: true, delay: outcome.delay }
        logger.log("retry.forced", {
          ...who,
          agent: event.agent,
          model: event.model,
          attempt: event.attempt,
          reason: outcome.reason,
          delayMs: outcome.delay,
          advertisedDelayMs: outcome.advertisedDelayMs ?? null,
          maxDelayMs: options.maxDelayMs,
          note: "OpenCode now sleeps this long before re-issuing; a death during the wait loses the retry",
        })
        if (options.verbose)
          console.log(
            `[ratelimit-retry] ${event.model.providerID}/${event.model.id} attempt ${event.attempt}: retrying in ${Math.round(
              outcome.delay / 1000,
            )}s (${event.error.type})`,
          )
      })
      logger.log("hooks.retry.registered", { instance })
    } catch (cause) {
      logger.log("hooks.retry.failed", { instance, error: safe(cause), note: "no retry will ever be forced" })
    }

    return () => {
      listening = false
      clearInterval(heartbeat)
      for (const timer of continuations.values()) clearTimeout(timer)
      continuations.clear()
      for (const registration of registrations) void registration.dispose()
      if (retryHook) void retryHook.dispose()
      logger.log("plugin.dispose", {
        instance,
        pendingHints: hints.size,
        pendingSessions: [...hints.keys()],
        openEpisodes: episodes.size,
        episodes: [...episodes.values()].map((episode) => ({
          sessionID: episode.sessionID,
          phases: episode.phases,
          deadlineInMs: episode.deadlineAt > 0 ? episode.deadlineAt - Date.now() : null,
        })),
        note: "a session listed above was mid-episode when the hooks were torn down",
      })
      hints.clear()
      episodes.clear()
      if (subscription) void subscription.catch(() => {})
    }
  },
})
