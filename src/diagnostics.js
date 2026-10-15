/**
 * Bounded diagnostic log for the retry plugin.
 *
 * WHY THIS EXISTS INSTEAD OF console.log
 * --------------------------------------
 * The long-running service is spawned with `stdio: ["ignore", "ignore", "pipe"]`
 * (`packages/client/src/service-contender.ts`). Its stdout is discarded, and its stderr is kept
 * only as an 8 KB in-memory tail for surfacing a failed start-up. Neither is ever written to
 * `opencode.log`, which is fed by Effect's file logger, not by `console`. A plugin that logs with
 * `console.log` therefore writes into the void, which is why a `verbose` retry can be forced and
 * leave no trace at all.
 *
 * So diagnostics go to their own file. It is deliberately NOT `opencode.log`: appending to that
 * would interleave with the framework's own 50 MB/25 MB trimming, which assumes it owns every
 * line in the file.
 *
 * STORAGE
 * -------
 * Every write passes through `append`, which hard-caps the file at MAX_BYTES by dropping whole
 * lines from the front. No rotation, no temp file, no unbounded growth: a rate-limit episode
 * produces tens of lines, and the cap makes the worst case (a provider 429ing every few seconds
 * for days) cost a fixed ~1 MB rather than filling the disk.
 */

import fs from "node:fs"
import path from "node:path"

/** Hard ceiling on the diagnostic file. Roughly a thousand episodes' worth of lines. */
const MAX_BYTES = 1_048_576

/** Bytes dropped per trim. Large enough that trimming is rare, small enough to stay amortised. */
const KEEP_BYTES = 786_432

/** Longest single field written. Guards against a provider echoing a huge body or header. */
const MAX_FIELD = 512

/**
 * Flattens an unknown value into something safe to serialise, with every string bounded.
 *
 * Deep values are walked rather than handed to `JSON.stringify`, because a string nested inside
 * an object would otherwise bypass the field limit entirely: a provider echoing a large body
 * would put it straight into the file unbounded.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function safe(value, depth = 0) {
  if (value === undefined) return undefined
  if (value === null) return null
  const type = typeof value
  if (type === "string") return value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}…[+${value.length - MAX_FIELD}]` : value
  if (type === "number" || type === "boolean") return value
  if (type === "bigint") return value.toString()
  if (type === "function") return "[function]"
  if (type === "symbol") return value.toString()
  if (value instanceof Error)
    return { name: safe(value.name), message: safe(value.message), stack: safe(value.stack) }
  if (depth >= 6) return "[depth-limit]"
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safe(item, depth + 1))
  if (value instanceof Headers) return headersOf(value)
  if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), safe(v, depth + 1)]))
  if (value instanceof Set) return [...value.values()].slice(0, 50).map((item) => safe(item, depth + 1))
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      // A class instance (Response, URL, ...) would otherwise serialise to an opaque husk.
      return { class: value.constructor?.name ?? "unknown", string: safe(String(value)) }
    }
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [key, item] of Object.entries(value).slice(0, 100)) out[key] = safe(item, depth + 1)
    return out
  }
  return String(value)
}

/**
 * Reads every header of interest off a response, preserving the raw values.
 *
 * The full set matters: `retry-after` can be seconds or an HTTP date, some providers use
 * `retry-after-ms`, and an explicit refusal arrives as `x-should-retry`. Recording all of them
 * means a later reading of this line can reconstruct exactly what `parseRetryAfter` saw without
 * re-running anything.
 *
 * @param {Headers | undefined} headers
 */
function headersOf(headers) {
  if (!headers || typeof headers.forEach !== "function") return undefined
  /** @type {Record<string, string>} */
  const out = {}
  try {
    headers.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value).slice(0, MAX_FIELD)
    })
  } catch {
    return "[unreadable]"
  }
  return out
}

/**
 * Renders an error as both its own fields and its response, so a decline can be attributed.
 *
 * @param {any} error
 */
function errorOf(error) {
  if (!error || typeof error !== "object") return { raw: safe(error) }
  return {
    type: safe(error.type),
    status: safe(error.status),
    message: safe(error.message),
    name: safe(error.name),
    body: typeof error.response?.body === "string" ? safe(error.response.body) : safe(error.response?.body),
    cause: safe(error.cause),
  }
}

/**
 * Creates the append-only diagnostic writer for one plugin instance.
 *
 * @param {string} file absolute path
 * @param {(line: string) => void} onError reports a logging failure without recursing
 */
export function createLogger(file, onError) {
  let broken = false
  let bytes = 0

  /**
   * @param {string} text
   */
  const write = (text) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // The cap is applied on every write rather than on a timer so a burst cannot outrun it.
      let existing = 0
      try {
        existing = fs.statSync(file).size
      } catch {
        existing = 0
      }
      // Byte length, not string length: the cap is about disk, and a provider echoing
      // multi-byte text would otherwise overshoot it by up to threefold.
      const incoming = Buffer.byteLength(text, "utf8")
      if (existing + incoming > MAX_BYTES) {
        const handle = fs.openSync(file, "r+")
        try {
          const start = Math.max(0, existing - KEEP_BYTES)
          const buffer = Buffer.alloc(existing - start)
          if (buffer.length > 0) fs.readSync(handle, buffer, 0, buffer.length, start)
          const body = buffer.toString("utf8")
          // Drop the partial first line so the file never begins mid-record.
          const cut = body.indexOf("\n")
          const kept = cut === -1 ? body : body.slice(cut + 1)
          const next = Buffer.from(`<<trimmed ${new Date().toISOString()}>>\n` + kept + text, "utf8")
          fs.ftruncateSync(handle, 0)
          fs.writeSync(handle, next, 0, next.length, 0)
          bytes = next.length
        } finally {
          fs.closeSync(handle)
        }
        return
      }
      fs.appendFileSync(file, text)
      bytes = existing + incoming
    } catch (cause) {
      // A logger that throws would take the hook down with it, which is the one failure mode
      // that must never happen: it would turn a diagnostic into an outage.
      if (broken) return
      broken = true
      try {
        onError(cause)
      } catch {
        /* nothing left to do */
      }
    }
  }

  return {
    /**
     * @param {string} event stable event name, greppable
     * @param {Record<string, unknown>} [fields]
     */
    log(event, fields) {
      const record = { ts: new Date().toISOString(), event, ...(fields ? safe(fields) : {}) }
      let line
      try {
        line = JSON.stringify(record)
      } catch {
        line = JSON.stringify({ ts: record.ts, event, error: "unserialisable-fields" })
      }
      write(`${line}\n`)
    },
    /** Current size, so a periodic heartbeat can prove the writer is alive. */
    size: () => bytes,
  }
}

export { errorOf, headersOf, safe, MAX_BYTES }