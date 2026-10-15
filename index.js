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
import { DEFAULTS, decide, parseRetryAfter } from "./src/policy.js"
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
        rateLimitedSessions: hints.size,
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
      note: "hooks register next; a missing retry hook below means the SDK changed",
    })

    /**
     * @param {string} sessionID
     */
    const identify = (sessionID) => {
      const cached = identity.get(sessionID)
      if (cached) return cached
      /** @type {{ parentID?: string, title?: string, subagent: boolean, resolved: boolean }} */
      const entry = { subagent: false, resolved: false }
      identity.set(sessionID, entry)
      // Fire and forget: resolution must never delay or fail a retry decision.
      void ctx.session
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

        if (!outcome.retry) return

        event.decision = { retry: true, delay: outcome.delay }
        logger.log("retry.forced", {
          ...who,
          agent: event.agent,
          model: event.model,
          attempt: event.attempt,
          reason: outcome.reason,
          delayMs: outcome.delay,
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
      clearInterval(heartbeat)
      for (const registration of registrations) void registration.dispose()
      if (retryHook) void retryHook.dispose()
      logger.log("plugin.dispose", {
        instance,
        pendingHints: hints.size,
        pendingSessions: [...hints.keys()],
        note: "a session listed above was mid-episode when the hooks were torn down",
      })
      hints.clear()
    }
  },
})