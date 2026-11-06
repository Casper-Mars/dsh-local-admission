/**
 * Runtime replacement of the Host Connection admission gate.
 *
 * We deliberately do NOT import (or patch) the `HostConnectionService` class:
 * a plugin linked into a profile can end up with a different module instance
 * than the one dsh booted, which makes prototype patches fail silently. The
 * service instance returned by `ctx.get('connection')` is the single source of
 * truth, and every internal caller (`requestRejection`, `admitConnection`, the
 * `/api` route, the WebSocket upgrade) dispatches through `this.admit(...)`, so
 * an own property on the instance shadows the prototype method.
 *
 * Robustness contract: nothing in this module ever throws to the caller. A
 * failed install logs one line and returns a no-op disposer; a failed request
 * logs once per distinct error signature and falls back to `{ rejection: 401 }`.
 * dsh therefore keeps running with its stock token authentication no matter
 * what shape the internal service has.
 */
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'

/** Stable log prefix shared with `src/index.ts`. */
export const LOG_PREFIX = '[dsh-bypass-web-token]'

/**
 * Structural view of a Peer. `@deepseek-ai/dsh-typert-protocol` owns the real
 * type; only identity and lifetime matter here.
 */
export interface PeerLike {
  readonly id: string
  readonly interactions?: 'answer' | 'none'
  dispose?: () => Promise<void>
}

/** Outcome of one admission: the Peer the request speaks for, or a refusal. */
export type Admission =
  | { readonly peer: PeerLike }
  | { readonly rejection: 401 | 403 }

/** Entry shape of the service's private peer registry. */
export interface PeerRecord {
  peer: PeerLike
  ownsSocket?: boolean
}

/**
 * The members of `HostConnectionService` this patch touches. `publishPeer` and
 * `peers` are private in the published types but are stable runtime members.
 */
export interface PatchableConnection {
  admit(request: ConnectionTrustRequest): Admission
  isTrusted(request: ConnectionTrustRequest): boolean
  publishPeer(interactions?: 'answer' | 'none'): string
  peers: Map<string, PeerRecord>
  readonly disposed?: boolean
}

/** Options for {@link installAnonymousAdmit}. */
export interface InstallOptions {
  /**
   * Kept for API compatibility. Non-fatal diagnostics are written with
   * `console.error` so every failure is visible in the dsh log.
   */
  warn?: (message: string) => void
}

/** A check that failed before anything was patched. */
export interface ConnectionProbeFailure {
  readonly ok: false
  /** Which member/shape was wrong, e.g. `connection.admit`. */
  readonly stage: string
  /** Human-readable reason, includes the observed type/value. */
  readonly detail: string
}

/** All runtime members needed by the patch are present and callable. */
export interface ConnectionProbeSuccess {
  readonly ok: true
  readonly connection: PatchableConnection
}

/** Result of the non-throwing preflight probe. */
export type ConnectionProbe = ConnectionProbeFailure | ConnectionProbeSuccess

interface PatchState {
  refs: number
  /** Whether `admit` was already an own property, i.e. someone else patched it. */
  hadOwn: boolean
  /** The method exactly as found at install time (own function or prototype). */
  originalOwn: AdmitMethod
  peerId: string | undefined
  /** Last runtime error signature, used to throttle repeated request logs. */
  lastErrorKey: string | undefined
}

/** `admit` with its receiver typed, so the wrapper can `call` the original. */
type AdmitMethod = (
  this: PatchableConnection,
  request: ConnectionTrustRequest,
) => Admission

/** Marks the patched instance; `Symbol.for` keeps HMR-created module copies in sync. */
const STATE = Symbol.for('dsh-bypass-web-token/patch-state')

/** Disposer returned when nothing was installed. */
const noop = (): void => {}

/** Format the activation-skip line shown once per failed preflight. */
export function activationSkipped(stage: string, detail: string): string {
  return `${LOG_PREFIX} activation skipped: ${stage} — ${detail} (plugin inactive; dsh keeps stock auth)`
}

/** Format the request-degradation line shown once per distinct runtime error. */
export function requestDegraded(stage: string, detail: string): string {
  return `${LOG_PREFIX} request path degraded: ${stage} — ${detail} (returning 401)`
}

/** Message extraction that cannot throw on exotic thrown values. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return '<unprintable value>'
  }
}

/**
 * Write a diagnostic without ever letting the log sink break the caller.
 *
 * A host can replace `console` with a proxy that throws, and a test can install
 * a throwing stub. Diagnostics are best-effort: an admission decision must
 * never depend on the logger succeeding.
 */
export function safeError(message: string): void {
  try {
    console.error(message)
  } catch {
    // Logging is not part of the contract; swallow sink failures.
  }
}

/** Counterpart of {@link safeError} for the single success line. */
export function safeInfo(message: string): void {
  try {
    console.info(message)
  } catch {
    // Same as above.
  }
}

/**
 * Best-effort warning line, used when anonymous admission is active on a
 * non-loopback listener. Like {@link safeError} and {@link safeInfo}, a broken
 * log sink must never turn a successful activation into a failure.
 */
export function safeWarn(message: string): void {
  try {
    console.warn(message)
  } catch {
    // Same as above.
  }
}

/**
 * Read the peer out of a registry record without trusting the record's shape.
 *
 * Every property read happens here so a hostile getter (`record.peer`,
 * `peer.id`) throws inside the caller's `try` instead of escaping to dsh.
 *
 * @param record - value returned by `peers.get(...)`.
 * @returns the peer when the record is structurally usable.
 * @throws TypeError describing the first malformed member.
 */
function readPeerRecord(record: unknown): PeerLike {
  if (record === null || typeof record !== 'object') {
    throw new TypeError(`published peer record is ${describeValue(record)}`)
  }

  const peer = (record as { peer?: unknown }).peer
  if (peer === null || typeof peer !== 'object') {
    throw new TypeError(`record.peer is ${describeValue(peer)}`)
  }

  const id = (peer as { id?: unknown }).id
  if (typeof id !== 'string') {
    throw new TypeError(`record.peer.id is ${describeValue(id)}`)
  }

  return peer as PeerLike
}

/** Type/value description used in preflight log details. */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'string') return JSON.stringify(value)
  if (type === 'function') return 'a function'
  if (type === 'object') {
    try {
      return Object.prototype.toString.call(value)
    } catch {
      return 'an object'
    }
  }
  // undefined / number / boolean / bigint / symbol
  try {
    return String(value)
  } catch {
    return type
  }
}

/**
 * Non-throwing preflight for the runtime members the patch depends on.
 *
 * The published type promises all of these, but a dsh upgrade can rename or
 * hide an internal symbol. Returning a structured result (instead of throwing)
 * lets `apply` log exactly which member broke and stay inert.
 *
 * @param connection - value returned by `ctx.get('connection')`.
 * @returns `{ ok: true, connection }` or `{ ok: false, stage, detail }`.
 */
export function probeConnection(connection: unknown): ConnectionProbe {
  try {
    return inspectConnection(connection)
  } catch (error) {
    // A Proxy/getter on the service object may throw while being inspected.
    return {
      ok: false,
      stage: 'connection',
      detail: `could not inspect the connection service: ${describeError(error)}`,
    }
  }
}

function inspectConnection(connection: unknown): ConnectionProbe {
  if (connection === null || typeof connection !== 'object') {
    return {
      ok: false,
      stage: 'connection',
      detail: `expected the connection service object, got ${describeValue(connection)}`,
    }
  }

  const candidate = connection as Partial<PatchableConnection> & Record<PropertyKey, unknown>

  if (typeof candidate.admit !== 'function') {
    return {
      ok: false,
      stage: 'connection.admit',
      detail: `expected a function, got ${describeValue(candidate.admit)}`,
    }
  }

  if (typeof candidate.isTrusted !== 'function') {
    return {
      ok: false,
      stage: 'connection.isTrusted',
      detail: `expected a function, got ${describeValue(candidate.isTrusted)}`,
    }
  }

  if (typeof candidate.publishPeer !== 'function') {
    return {
      ok: false,
      stage: 'connection.publishPeer',
      detail: `expected a function, got ${describeValue(candidate.publishPeer)}`,
    }
  }

  if (!(candidate.peers instanceof Map)) {
    return {
      ok: false,
      stage: 'connection.peers',
      detail: `expected a Map, got ${describeValue(candidate.peers)}`,
    }
  }

  return { ok: true, connection: connection as PatchableConnection }
}

/**
 * Outcome of one install attempt.
 *
 * `stage` is only present when `installed` is false, so a caller can report
 * exactly what blocked activation. The disposer is always safe to call.
 */
export interface InstallResult {
  /** Idempotent disposer; a no-op when nothing was installed. */
  dispose: () => void
  /** Whether the admission override is active for this connection. */
  installed: boolean
  /** Preflight/install stage that prevented activation. */
  stage?: string
}

/**
 * Install the anonymous admission override exactly once per connection
 * instance. Repeated installs only bump a reference count, so an HMR reload or
 * a second apply cannot wrap the wrapper.
 *
 * This function never throws. When the preflight fails or the property cannot
 * be written (frozen/read-only instance), it logs one `activation skipped`
 * line and returns a no-op disposer, leaving the stock admission intact.
 *
 * Compatibility wrapper around {@link installAnonymousAdmitResult}; callers
 * that need to know whether the patch really landed must use the latter.
 *
 * @param connection - live `ctx.get('connection')` service instance.
 * @param options - optional diagnostics sink (retained for compatibility).
 * @returns idempotent disposer restoring the original admission behaviour.
 */
export function installAnonymousAdmit(
  connection: PatchableConnection,
  options: InstallOptions = {},
): () => void {
  return installAnonymousAdmitResult(connection, options).dispose
}

/**
 * Same as {@link installAnonymousAdmit}, but reports whether the patch was
 * actually installed so `apply` can avoid logging a success that never
 * happened.
 *
 * Never throws.
 *
 * @param connection - live `ctx.get('connection')` service instance.
 * @param options - optional diagnostics sink (retained for compatibility).
 * @returns `{ dispose, installed, stage? }` describing the real outcome.
 */
export function installAnonymousAdmitResult(
  connection: PatchableConnection,
  options: InstallOptions = {},
): InstallResult {
  void options

  const failed = (stage: string): InstallResult => ({
    dispose: noop,
    installed: false,
    stage,
  })

  const probe = probeConnection(connection)
  if (!probe.ok) {
    safeError(activationSkipped(probe.stage, probe.detail))
    return failed(probe.stage)
  }
  const patched = probe.connection

  const marked = patched as unknown as Record<PropertyKey, unknown>

  let existing: PatchState | undefined
  try {
    existing = marked[STATE] as PatchState | undefined
  } catch {
    existing = undefined
  }
  if (existing !== undefined) {
    existing.refs += 1
    return { dispose: makeDisposer(patched, existing), installed: true }
  }

  let hadOwn: boolean
  let originalOwn: AdmitMethod
  try {
    hadOwn = Object.hasOwn(patched, 'admit')
    // Keep the exact function that was there. `bind` would produce a copy, and
    // writing that copy back on uninstall would break identity with the
    // original own property; calling with `patched` covers inherited methods.
    originalOwn = patched.admit as AdmitMethod
  } catch (error) {
    safeError(
      activationSkipped(
        'connection.admit',
        `could not read connection.admit: ${describeError(error)}`,
      ),
    )
    return failed('connection.admit')
  }

  const state: PatchState = {
    refs: 1,
    hadOwn,
    originalOwn,
    peerId: undefined,
    lastErrorKey: undefined,
  }

  /** Log/return once per distinct runtime failure; never throws. */
  const degrade = (stage: string, error: unknown): Admission => {
    const detail = describeError(error)
    const key = `${stage}:${detail}`
    if (state.lastErrorKey !== key) {
      state.lastErrorKey = key
      safeError(requestDegraded(stage, detail))
    }
    return { rejection: 401 }
  }

  const admit = (request: ConnectionTrustRequest): Admission => {
    // 1. The stock gate runs first: a real browser/API credential always wins.
    let admission: Admission
    try {
      admission = originalOwn.call(patched, request)
    } catch (error) {
      return degrade('admit', error)
    }
    if (admission === null || typeof admission !== 'object') {
      return degrade(
        'admit',
        new TypeError(`unexpected admission result: ${describeValue(admission)}`),
      )
    }
    if ('peer' in admission) return admission

    // 2. A disposing host must not mint new Peers.
    let disposed: boolean
    try {
      disposed = patched.disposed === true
    } catch (error) {
      return degrade('disposed', error)
    }
    if (disposed) return admission

    // 3. The Host/Origin fence is not optional.
    let trusted: boolean
    try {
      trusted = patched.isTrusted.call(patched, request)
    } catch (error) {
      return degrade('isTrusted', error)
    }
    if (!trusted) return { rejection: 403 }

    // 4. `admitConnection` looks the peer up by id and deletes it on socket
    //    close, so a released peer must be republished instead of reused.
    let record: PeerRecord | undefined
    try {
      record = state.peerId === undefined ? undefined : patched.peers.get(state.peerId)
    } catch (error) {
      return degrade('peers.get', error)
    }

    if (record === undefined) {
      let peerId: string
      try {
        peerId = patched.publishPeer.call(patched, 'answer')
      } catch (error) {
        return degrade('publishPeer', error)
      }
      if (typeof peerId !== 'string' || peerId === '') {
        return degrade(
          'publishPeer',
          new TypeError(`publishPeer returned ${describeValue(peerId)} instead of an id`),
        )
      }
      state.peerId = peerId
      try {
        record = patched.peers.get(peerId)
      } catch (error) {
        return degrade('peers.get', error)
      }
    }

    // The record lookup, the null check, and both property reads run inside one
    // guard: `typeof null === 'object'` and hostile getters must degrade to 401
    // instead of throwing into dsh's request handler.
    try {
      return { peer: readPeerRecord(record) }
    } catch (error) {
      return degrade('peer record', error)
    }
  }

  try {
    patched.admit = admit
    marked[STATE] = state
  } catch (error) {
    // Roll back anything that may have landed before the write failed, so a
    // half-installed patch cannot survive.
    try {
      if (hadOwn) patched.admit = originalOwn
      else delete (patched as { admit?: unknown }).admit
    } catch {
      // Frozen/sealed instance: nothing was written in the first place.
    }
    try {
      delete marked[STATE]
    } catch {
      // Same as above.
    }
    safeError(
      activationSkipped(
        'install',
        `cannot patch connection.admit (frozen or read-only instance): ${describeError(error)}`,
      ),
    )
    return failed('install')
  }

  return { dispose: makeDisposer(patched, state), installed: true }
}

/** Build one idempotent, never-throwing disposer for a shared patch state. */
function makeDisposer(
  connection: PatchableConnection,
  state: PatchState,
): () => void {
  let called = false
  return () => {
    if (called) return
    called = true

    try {
      state.refs -= 1
      if (state.refs > 0) return

      const marked = connection as unknown as Record<PropertyKey, unknown>
      try {
        delete marked[STATE]
      } catch (error) {
        safeError(`${LOG_PREFIX} dispose degraded: state marker — ${describeError(error)}`)
      }

      try {
        if (state.hadOwn) connection.admit = state.originalOwn
        else delete (connection as { admit?: unknown }).admit
      } catch (error) {
        safeError(`${LOG_PREFIX} dispose degraded: connection.admit — ${describeError(error)}`)
      }

      const peerId = state.peerId
      state.peerId = undefined
      if (peerId === undefined) return

      let record: PeerRecord | undefined
      try {
        record = connection.peers.get(peerId)
      } catch {
        return
      }
      if (record === undefined) return

      try {
        connection.peers.delete(peerId)
      } catch {
        // A closed registry needs no cleanup.
      }

      try {
        const peer = record.peer
        const disposePeer = peer?.dispose
        if (typeof disposePeer === 'function') {
          const result = disposePeer.call(peer)
          // Both a synchronous throw (caught above) and an async rejection
          // must stay silent: the peer may already be gone at shutdown.
          if (
            result !== null &&
            typeof result === 'object' &&
            typeof (result as PromiseLike<void>).then === 'function'
          ) {
            ;(result as PromiseLike<void>).then(undefined, () => {})
          }
        }
      } catch {
        // Nothing left to release.
      }
    } catch (error) {
      safeError(`${LOG_PREFIX} dispose degraded: ${describeError(error)}`)
    }
  }
}
