/**
 * Runtime replacement of the Host Connection admission gates.
 *
 * We deliberately do NOT import (or patch) the `HostConnectionService` class:
 * a plugin linked into a profile can end up with a different module instance
 * than the one dsh booted, which makes prototype patches fail silently. The
 * service instance returned by `ctx.get('connection')` is the single source of
 * truth, and every internal caller (`requestRejection`, `admitConnection`, the
 * `/api` route, the WebSocket upgrade) dispatches through `this.admit(...)`, so
 * an own property on the instance shadows the prototype method.
 *
 * This plugin installs a local admission policy, not an auth extension: the
 * override never calls the stock `admit`, never consults `isTrusted`, and never
 * looks at `Host` or `Origin`. Every request that reaches the port is answered
 * with one shared `answer` peer, including cross-origin browser requests and
 * forged `Host` headers.
 *
 * Two more gates are overridden on the same instance:
 *   - `authorizeIndex` (web UI shell) returns `true` for every request.
 *   - `authorizeConnect` (`/connect` launch-token exchange) skips the token
 *     entirely and returns an empty `dsh-session` cookie in its 302.
 *
 * Robustness contract: nothing in this module ever throws to the caller. A
 * failed install logs one line and returns a no-op disposer; a failed request
 * logs once per distinct error signature and falls back to `{ rejection: 401 }`.
 * dsh therefore keeps running with its stock token authentication no matter
 * what shape the internal service has. A missing `authorizeIndex` or
 * `authorizeConnect` is not fatal: the other gates are still patched and only
 * the corresponding stock flow keeps asking for a token.
 *
 * Peer minting has two paths, tried in this order on the first admission:
 * `createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })`, then
 * `publishPeer('answer')` + `peers.delete(id)`. A `createPeer` that throws, or
 * that returns something unusable, is released (best-effort) and the request
 * falls back to the registry path instead of answering 401 for the rest of the
 * process. A Peer that a future `createPeer` mistakenly registers is removed
 * from `peers` before it is handed out, because a registered Peer makes
 * `admitConnection` claim exclusive socket ownership and answer 409 to every
 * second upgrade.
 */
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'

/** Stable log prefix shared with `src/index.ts`. */
export const LOG_PREFIX = '[dsh-local-admission]'

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

/** Interaction modes accepted by `/connect`. */
export type ConnectionInteractions = 'answer' | 'none'

/** Publisher signature used by the stock `authorizeConnect` instance method. */
export type PublishPeer = (interactions: ConnectionInteractions) => string

/**
 * The members of `HostConnectionService` this patch touches. `publishPeer` and
 * `peers` are private in the published types but are stable runtime members.
 */
export interface PatchableConnection {
  admit(request: ConnectionTrustRequest): Admission
  /**
   * Index/UI gate used by `dsh-host-frontend-static`. Optional because a dsh
   * build without the frontend (or a renamed member) must not block the other
   * gates.
   */
  authorizeIndex?(request: unknown, response: unknown): boolean
  /**
   * `/connect` launch-token exchange. Optional for the same reason as
   * `authorizeIndex`; the stock instance method takes `(request, response)`
   * and publishes through `browserAuth`, while the browser-auth class method
   * also accepts `(secure, publish)`.
   */
  authorizeConnect?(
    request: unknown,
    response: unknown,
    secure?: boolean,
    publish?: PublishPeer,
  ): boolean | void
  /**
   * Kept as an optional type member for documentation only: the override never
   * calls it, and a missing implementation does not block activation.
   */
  isTrusted?(request: ConnectionTrustRequest): boolean
  /**
   * Create an unregistered Peer owned by the service. Preferred minting path;
   * when absent the patch falls back to {@link PatchableConnection.publishPeer}
   * plus {@link PatchableConnection.peers}. A build that only exposes this
   * member is still enough to activate (see {@link probeConnection}).
   */
  createPeer?(options: {
    principal?: { kind: 'owner' }
    interactions?: ConnectionInteractions
  }): PeerLike
  /**
   * Stock registry-backed publisher. Optional because a dsh build may rename
   * it, and because a `createPeer`-only build never needs it.
   */
  publishPeer?(interactions?: ConnectionInteractions): string
  /**
   * The service's peer registry. Optional for the same reason as
   * {@link PatchableConnection.publishPeer}; when it is a `Map` the patch both
   * unregisters the fallback Peer and defends against a `createPeer` that
   * registers its result.
   */
  peers?: Map<string, PeerRecord>
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

/** One patched instance method and everything needed to restore it. */
interface MethodPatch<T> {
  /** Whether this install owns the gate. */
  readonly patched: boolean
  /** Whether the member was already an own property at install time. */
  readonly hadOwn: boolean
  /** The member exactly as found at install time. */
  readonly original: T | undefined
}

interface PatchState {
  refs: number
  readonly admit: MethodPatch<AdmitMethod>
  readonly index: MethodPatch<AuthorizeIndexMethod>
  readonly connect: MethodPatch<AuthorizeConnectMethod>
  /**
   * Long-lived owner Peer shared by every admitted request, mirroring the
   * stock `browserPeer`. Deliberately absent from `peers`, so
   * `admitConnection` never claims socket ownership for it.
   */
  sharedPeer: PeerLike | undefined
  /**
   * Runtime error signatures already logged. Each distinct failure is reported
   * once, so a permanently broken member cannot flood the dsh log on a busy
   * port; the set is bounded because a hostile host could otherwise grow it
   * without limit.
   */
  readonly loggedErrors: Set<string>
}

/** `admit` with its receiver typed, kept for exact restoration. */
type AdmitMethod = (
  this: PatchableConnection,
  request: ConnectionTrustRequest,
) => Admission

/** `authorizeIndex` with its receiver typed, kept for exact restoration. */
type AuthorizeIndexMethod = (
  this: PatchableConnection,
  request: unknown,
  response: unknown,
) => boolean

/** `authorizeConnect` with its receiver typed, kept for exact restoration. */
type AuthorizeConnectMethod = (
  this: PatchableConnection,
  request: unknown,
  response: unknown,
  secure?: boolean,
  publish?: PublishPeer,
) => boolean | void

/** Marks the patched instance; `Symbol.for` keeps HMR-created module copies in sync. */
const STATE = Symbol.for('dsh-local-admission/patch-state')

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

/**
 * Format the warning shown when the index gate cannot be overridden.
 *
 * Deliberately not an activation failure: the `/api` and WebSocket gates still
 * work, only the UI shell keeps its token requirement.
 */
export function indexGateMissing(detail?: string): string {
  const suffix = detail === undefined ? '' : ` (${detail})`
  return `${LOG_PREFIX} WARNING: connection.authorizeIndex is missing — the web UI will still require a token${suffix}`
}

/**
 * Format the warning shown when the `/connect` gate cannot be overridden.
 *
 * Like {@link indexGateMissing}, this is not fatal: the `/api` and WebSocket
 * gates still work, only the `/connect` launch-token exchange stays stock.
 */
export function connectGateMissing(detail?: string): string {
  const suffix = detail === undefined ? '' : ` (${detail})`
  return `${LOG_PREFIX} WARNING: connection.authorizeConnect is missing — /connect will still require a launch token${suffix}`
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
 * Best-effort warning line, used when local admission is active on a
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
 * Every property read happens here so a throwing getter (`record.peer`,
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
  // Same rule as {@link readPeerLike}: an empty id cannot key the registry, so
  // a record that claims one is malformed rather than merely unusual.
  if (typeof id !== 'string' || id === '') {
    throw new TypeError(`record.peer.id is ${describeValue(id)}`)
  }

  return peer as PeerLike
}

/** Read a Peer returned by `createPeer` without trusting its shape. */
function readPeerLike(peer: unknown): PeerLike {
  if (peer === null || typeof peer !== 'object') {
    throw new TypeError(`createPeer returned ${describeValue(peer)}`)
  }
  const id = (peer as { id?: unknown }).id
  if (typeof id !== 'string' || id === '') {
    throw new TypeError(`createPeer peer.id is ${describeValue(id)}`)
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
 * Best-effort Peer release shared by every disposal path.
 *
 * Used for the shared Peer on uninstall, for a `createPeer` result that turned
 * out to be unusable, and for a minted Peer that a future build registered.
 * Never throws: the peer may belong to a service that is already tearing down,
 * `dispose` may be absent or not callable, and a returned thenable may reject
 * long after the caller has moved on.
 *
 * @param peer - candidate Peer; non-objects are ignored.
 */
function releasePeer(peer: unknown): void {
  if (peer === null || typeof peer !== 'object') return
  try {
    const dispose = (peer as { dispose?: unknown }).dispose
    if (typeof dispose !== 'function') return
    const result = (dispose as () => unknown).call(peer)
    if (result !== null && typeof result === 'object') {
      ;(result as PromiseLike<unknown>).then(undefined, () => {})
    }
  } catch {
    // Release is best-effort by contract; a failure must not escape.
  }
}

/** A minted Peer that had to be refused, and the stage that produced it. */
interface RegistryConflict {
  readonly stage: string
  readonly error: unknown
}

/**
 * Enforce the "never hand out a registered Peer" invariant.
 *
 * The whole point of the shared Peer is that it is invisible to
 * `admitConnection`; a registered Peer is claimed exclusively (`ownsSocket`)
 * and answers 409 to the next upgrade. Stock `createPeer` returns an
 * unregistered Peer, but that is an implementation detail of one dsh build, so
 * every minted Peer is checked against the live registry before use.
 *
 * A build without a `peers` Map has nothing that could claim ownership, so the
 * check is skipped there. Every property read and call is guarded: a throwing
 * getter or a hostile `Map` must degrade to a rejection, never escape into
 * dsh's request handler.
 *
 * @param connection - patched service instance.
 * @param peer - freshly minted Peer.
 * @returns `undefined` when the Peer is (now) unregistered; otherwise the
 *   stage and error to degrade with.
 */
function ensureUnregistered(
  connection: PatchableConnection,
  peer: PeerLike,
): RegistryConflict | undefined {
  try {
    let registry: unknown
    try {
      registry = (connection as { peers?: unknown }).peers
    } catch (error) {
      return { stage: 'peers', error }
    }
    if (!(registry instanceof Map)) return undefined
    const peers = registry as Map<string, PeerRecord>

    let registered: unknown
    try {
      registered = peers.has(peer.id)
    } catch (error) {
      return { stage: 'peers.has', error }
    }
    if (!registered) return undefined

    try {
      peers.delete(peer.id)
    } catch (error) {
      return { stage: 'peers.delete', error }
    }

    // Do not trust `delete`'s return value: a silently failing registry would
    // still hand dsh an exclusive owner, so re-read the invariant.
    let stillRegistered: unknown
    try {
      stillRegistered = peers.has(peer.id)
    } catch (error) {
      return { stage: 'peers.has', error }
    }
    if (stillRegistered) {
      return {
        stage: 'peers.delete',
        error: new TypeError(
          `peers.delete left the minted peer ${describeValue(peer.id)} registered`,
        ),
      }
    }
    return undefined
  } catch (error) {
    return { stage: 'peers', error }
  }
}

/**
 * Non-throwing preflight for the runtime members the patch depends on.
 *
 * The published type promises these, but a dsh upgrade can rename or hide an
 * internal symbol. Returning a structured result (instead of throwing) lets
 * `apply` log exactly which member broke and stay inert.
 *
 * Required: `admit`. Peer minting needs either `createPeer`, or both
 * `publishPeer` and a `peers` Map. Neither combination present is fatal
 * (fail-closed): the plugin stays inactive rather than admitting requests it
 * cannot serve with a shared, unregistered Peer.
 *
 * `isTrusted` is deliberately not required: the override never calls it.
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

  const hasCreatePeer = typeof candidate.createPeer === 'function'
  const hasPublishPeer = typeof candidate.publishPeer === 'function'

  // No way to mint a Peer at all: refuse to activate instead of handing dsh a
  // gate that can only answer 401.
  if (!hasCreatePeer && !hasPublishPeer) {
    return {
      ok: false,
      stage: 'connection.publishPeer',
      detail: `expected a function, got ${describeValue(candidate.publishPeer)} (and connection.createPeer is ${describeValue(candidate.createPeer)})`,
    }
  }

  // `createPeer` needs no registry; the `publishPeer` path cannot unregister
  // its Peer without one, so it is only usable together with a Map.
  if (!hasCreatePeer && !(candidate.peers instanceof Map)) {
    return {
      ok: false,
      stage: 'connection.peers',
      detail: `expected a Map, got ${describeValue(candidate.peers)} (required when connection.createPeer is absent)`,
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
 * Install the local admission overrides exactly once per connection instance.
 * Repeated installs only bump a reference count, so an HMR reload or a second
 * apply cannot wrap the wrapper.
 *
 * This function never throws. When the preflight fails or a property cannot be
 * written (frozen/read-only instance), it logs one `activation skipped` line
 * and returns a no-op disposer, leaving the stock admission intact.
 *
 * Compatibility wrapper around {@link installAnonymousAdmitResult}; callers
 * that need to know whether the patch really landed must use the latter.
 *
 * @param connection - live `ctx.get('connection')` service instance.
 * @param options - optional diagnostics sink (retained for compatibility).
 * @returns idempotent disposer restoring the original behaviour.
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

  let admitPatch: MethodPatch<AdmitMethod>
  try {
    admitPatch = {
      patched: true,
      hadOwn: Object.hasOwn(patched, 'admit'),
      // Keep the exact function that was there. `bind` would produce a copy,
      // and writing that copy back on uninstall would break identity with the
      // original own property; calling with `patched` covers inherited methods.
      original: patched.admit as AdmitMethod,
    }
  } catch (error) {
    safeError(
      activationSkipped(
        'connection.admit',
        `could not read connection.admit: ${describeError(error)}`,
      ),
    )
    return failed('connection.admit')
  }

  // The UI shell has its own gate (`dsh-host-frontend-static` asks
  // `connection.authorizeIndex`). It is patched on a best-effort basis: a dsh
  // build without it must not lose the other overrides.
  let indexMethod: AuthorizeIndexMethod | undefined
  let indexReadDetail: string | undefined
  let hadOwnIndex = false
  try {
    const candidateIndex = (patched as { authorizeIndex?: unknown }).authorizeIndex
    if (typeof candidateIndex === 'function') {
      hadOwnIndex = Object.hasOwn(patched, 'authorizeIndex')
      indexMethod = candidateIndex as AuthorizeIndexMethod
    }
  } catch (error) {
    indexReadDetail = `could not read connection.authorizeIndex: ${describeError(error)}`
  }
  if (indexMethod === undefined) safeWarn(indexGateMissing(indexReadDetail))

  // `/connect` is a launch-token exchange in stock dsh; the override answers it
  // without reading the token. Also best-effort.
  let connectMethod: AuthorizeConnectMethod | undefined
  let connectReadDetail: string | undefined
  let hadOwnConnect = false
  try {
    const candidateConnect = (patched as { authorizeConnect?: unknown }).authorizeConnect
    if (typeof candidateConnect === 'function') {
      hadOwnConnect = Object.hasOwn(patched, 'authorizeConnect')
      connectMethod = candidateConnect as AuthorizeConnectMethod
    }
  } catch (error) {
    connectReadDetail = `could not read connection.authorizeConnect: ${describeError(error)}`
  }
  if (connectMethod === undefined) safeWarn(connectGateMissing(connectReadDetail))

  const state: PatchState = {
    refs: 1,
    admit: admitPatch,
    index: {
      patched: indexMethod !== undefined,
      hadOwn: hadOwnIndex,
      original: indexMethod,
    },
    connect: {
      patched: connectMethod !== undefined,
      hadOwn: hadOwnConnect,
      original: connectMethod,
    },
    sharedPeer: undefined,
    loggedErrors: new Set<string>(),
  }

  /**
   * Claim the right to log one error signature.
   *
   * @param key - `<stage>:<detail>` signature.
   * @returns `true` the first time this signature is seen.
   */
  const remember = (key: string): boolean => {
    if (state.loggedErrors.has(key)) return false
    if (state.loggedErrors.size >= 64) state.loggedErrors.clear()
    state.loggedErrors.add(key)
    return true
  }

  /** Log once per distinct runtime failure; never throws. */
  const note = (stage: string, error: unknown): void => {
    const detail = describeError(error)
    const key = `${stage}:${detail}`
    if (remember(key)) safeError(requestDegraded(stage, detail))
  }

  /** Refuse the request, logging the failure once per signature. */
  const degrade = (stage: string, error: unknown): Admission => {
    note(stage, error)
    return { rejection: 401 }
  }

  /**
   * Report an unusable `createPeer` once per distinct signature.
   *
   * Deliberately distinct from {@link requestDegraded}: the request is not
   * rejected, it continues down the `publishPeer` path, so a line claiming
   * "returning 401" would be a lie. Logging is throttled by the same
   * {@link PatchState.loggedErrors} set as every other request-path failure, so
   * a permanently broken `createPeer` cannot flood the log, while the first
   * occurrence still names the cause.
   */
  const noteCreatePeerFallback = (error: unknown): void => {
    const detail = describeError(error)
    const key = `createPeer:${detail}`
    if (!remember(key)) return
    safeError(
      `${LOG_PREFIX} createPeer path unusable: ${detail} (falling back to publishPeer)`,
    )
  }

  /**
   * Registry fallback: publish a Peer through the stock method, then unregister
   * it before handing it out. Never throws.
   */
  const mintFromRegistry = (): Admission => {
    let publishPeer: unknown
    try {
      publishPeer = (patched as { publishPeer?: unknown }).publishPeer
    } catch (error) {
      return degrade('publishPeer', error)
    }
    if (typeof publishPeer !== 'function') {
      return degrade(
        'publishPeer',
        new TypeError(`publishPeer is ${describeValue(publishPeer)}, not a function`),
      )
    }

    // Read the registry before publishing: a build without a Map cannot
    // unregister the Peer, so publishing into it would create exactly the
    // exclusive-owner Peer this plugin must avoid.
    let registry: unknown
    try {
      registry = (patched as { peers?: unknown }).peers
    } catch (error) {
      return degrade('peers', error)
    }
    if (!(registry instanceof Map)) {
      return degrade(
        'peers',
        new TypeError(`peers is ${describeValue(registry)}, not a Map`),
      )
    }
    const peers = registry as Map<string, PeerRecord>

    let peerId: string
    try {
      peerId = (publishPeer as PublishPeer).call(patched, 'answer')
    } catch (error) {
      return degrade('publishPeer', error)
    }
    if (typeof peerId !== 'string' || peerId === '') {
      return degrade(
        'publishPeer',
        new TypeError(`publishPeer returned ${describeValue(peerId)} instead of an id`),
      )
    }

    let record: PeerRecord | undefined
    try {
      record = peers.get(peerId)
    } catch (error) {
      return degrade('peers.get', error)
    }

    // The record lookup, the null check, and both property reads run inside one
    // guard: `typeof null === 'object'` and throwing getters must degrade to 401
    // instead of throwing into dsh's request handler.
    let peer: PeerLike
    try {
      peer = readPeerRecord(record)
    } catch (error) {
      return degrade('peer record', error)
    }

    try {
      peers.delete(peerId)
    } catch (error) {
      // A registry that cannot be unregistered still admits this peer, but
      // `ownsSocket` would then serialise sockets. Release the Peer we just
      // published and degrade, rather than leaving an owner behind.
      releasePeer(peer)
      return degrade('peers.delete', error)
    }
    let stillRegistered: unknown
    try {
      stillRegistered = peers.has(peerId)
    } catch (error) {
      releasePeer(peer)
      return degrade('peers.has', error)
    }
    if (stillRegistered) {
      // A delete that silently does nothing would still serve 409 to the next
      // upgrade; fail closed instead of trusting the registry.
      releasePeer(peer)
      return degrade(
        'peers.delete',
        new TypeError(`peers.delete left ${describeValue(peerId)} registered`),
      )
    }

    state.sharedPeer = peer
    return { peer }
  }

  /**
   * Bind `publishPeer` for the `/connect` override.
   *
   * @returns a callable publisher, or `undefined` on a build without one (the
   *   redirect still answers; only the registry publication is skipped).
   */
  const readPublishPeer = (): PublishPeer | undefined => {
    try {
      const candidate = (patched as { publishPeer?: unknown }).publishPeer
      if (typeof candidate !== 'function') return undefined
      return (mode) => (candidate as PublishPeer).call(patched, mode)
    } catch {
      return undefined
    }
  }

  /**
   * The entire admission decision. No stock call, no Host/Origin check.
   *
   * Order is fixed: a disposing host refuses; once minted, the one shared owner
   * Peer answers every request, exactly like the stock `browserPeer`.
   *
   * The Peer is deliberately **not** registered in `peers`. `admitConnection`
   * treats a registered Peer as an exclusive socket owner (`ownsSocket`): the
   * first `/api/remote.mux` upgrade claims it and every other upgrade — a
   * second tab, a second client, or a reconnect racing the old socket — is
   * answered `409 Conflict` until that socket closes. The browser Client then
   * loops on "connection lost", the generation never reaches `ready`, and the
   * session list stays empty. An unregistered Peer makes `admitConnection`
   * return a no-op release for every socket, which is how stock dsh serves any
   * number of browser tabs from one `browserPeer`.
   */
  const admit = (_request: ConnectionTrustRequest): Admission => {
    // 1. A disposing host must not mint new Peers.
    let disposed: boolean
    try {
      disposed = patched.disposed === true
    } catch (error) {
      return degrade('disposed', error)
    }
    if (disposed) return { rejection: 401 }

    // 2. One long-lived owner Peer for the whole process.
    const shared = state.sharedPeer
    if (shared !== undefined) return { peer: shared }

    // 2a. Preferred: mint an unregistered Peer exactly the way the stock
    //     `browserPeer` is built (`createPeer` is a public service method).
    //     A build where `createPeer` is missing, throws, or returns garbage
    //     falls through to the registry path **in the same request**; a broken
    //     `createPeer` must not turn every admission into a 401.
    let createPeer: unknown
    let createPeerReadError: unknown
    try {
      createPeer = (patched as { createPeer?: unknown }).createPeer
    } catch (error) {
      createPeerReadError = error
    }
    if (createPeerReadError !== undefined) {
      noteCreatePeerFallback(createPeerReadError)
    } else if (typeof createPeer === 'function') {
      let created: unknown
      let createdFailed = false
      try {
        created = (createPeer as (options: unknown) => unknown).call(patched, {
          principal: { kind: 'owner' },
          interactions: 'answer',
        })
      } catch (error) {
        createdFailed = true
        noteCreatePeerFallback(error)
      }
      if (!createdFailed) {
        let candidate: PeerLike | undefined
        try {
          candidate = readPeerLike(created)
        } catch (error) {
          // The Peer exists but is unusable (missing/empty id): release it
          // before falling back, otherwise every request leaks one.
          noteCreatePeerFallback(error)
          releasePeer(created)
        }
        if (candidate !== undefined) {
          // Defence in depth: a build whose `createPeer` registers its result
          // would otherwise bring back the 409 exclusivity bug.
          const conflict = ensureUnregistered(patched, candidate)
          if (conflict !== undefined) {
            releasePeer(candidate)
            return degrade(conflict.stage, conflict.error)
          }
          state.sharedPeer = candidate
          return { peer: candidate }
        }
      }
    }

    // 2b. Fallback for a dsh build without a usable `createPeer`: publish
    //     through the stock registry, then immediately unregister the Peer.
    //     The instance keeps owning it (we dispose it on uninstall), while
    //     `admitConnection` sees no record and therefore never claims socket
    //     ownership — the same shape as `browserPeer`.
    return mintFromRegistry()
  }

  /** Best-effort `writeHead` + `end` that never escapes the wrapper. */
  const respond = (
    response: unknown,
    status: number,
    headers: Record<string, string>,
    body?: string,
  ): void => {
    const res = response as
      | { writeHead?: unknown; end?: unknown }
      | null
      | undefined
    if (res === null || typeof res !== 'object') {
      throw new TypeError(`response is ${describeValue(res)}`)
    }
    const writeHead = res.writeHead
    const end = res.end
    if (typeof writeHead !== 'function' || typeof end !== 'function') {
      throw new TypeError('response does not expose writeHead/end')
    }
    ;(writeHead as (status: number, headers: Record<string, string>) => unknown).call(
      res,
      status,
      headers,
    )
    if (body === undefined) (end as () => unknown).call(res)
    else (end as (body: string) => unknown).call(res, body)
  }

  /**
   * `/connect` override: keep the official query parsing and peer publication,
   * answer without the launch-token check, and hand back an empty session
   * cookie.
   */
  const authorizeConnect = (
    request: unknown,
    response: unknown,
    _secure?: boolean,
    publish?: PublishPeer,
  ): boolean | void => {
    try {
      const req = request as { url?: unknown; method?: unknown } | null
      const rawUrl = req !== null && typeof req === 'object' ? req.url : undefined
      const url = new URL(typeof rawUrl === 'string' ? rawUrl : '/', 'http://dsh.invalid')

      const declarations = url.searchParams.getAll('interactions')
      const interactions = declarations[0] ?? 'none'
      if (
        declarations.length > 1 ||
        (interactions !== 'answer' && interactions !== 'none')
      ) {
        respond(
          response,
          400,
          { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
          'interactions must be declared once as answer or none\n',
        )
        return
      }

      if (req?.method !== 'GET' || url.pathname !== '/connect') return false

      // A `createPeer`-only build has no registry publisher; the redirect is
      // still correct because the mux mints its own shared Peer through
      // `createPeer`, so skip publication instead of throwing.
      const publisher: PublishPeer | undefined =
        typeof publish === 'function' ? publish : readPublishPeer()
      publisher?.(interactions)

      respond(response, 302, {
        'cache-control': 'no-store',
        location: './api/remote.mux',
        'referrer-policy': 'no-referrer',
        'set-cookie': 'dsh-session=; Path=/; HttpOnly; SameSite=Lax',
      })
      return
    } catch (error) {
      const detail = describeError(error)
      const key = `authorizeConnect:${detail}`
      if (remember(key)) safeError(requestDegraded('authorizeConnect', detail))
      try {
        respond(response, 401, { 'cache-control': 'no-store' }, 'unauthorized')
      } catch {
        // The response may already be committed or unusable.
      }
      return false
    }
  }

  try {
    patched.admit = admit
    // The index gate answers `true` for every request: no token, no cookie, no
    // redirect. It is a plain own property for the same reason as `admit`.
    if (indexMethod !== undefined) {
      ;(patched as { authorizeIndex?: unknown }).authorizeIndex = () => true
    }
    if (connectMethod !== undefined) {
      ;(patched as { authorizeConnect?: unknown }).authorizeConnect = authorizeConnect
    }
    marked[STATE] = state
  } catch (error) {
    // Roll back anything that may have landed before the write failed, so a
    // half-installed patch cannot survive.
    rollbackMethod(patched, 'admit', state.admit)
    rollbackMethod(patched, 'authorizeIndex', state.index)
    rollbackMethod(patched, 'authorizeConnect', state.connect)
    try {
      delete marked[STATE]
    } catch {
      // Frozen/sealed instance: nothing was written in the first place.
    }
    safeError(
      activationSkipped(
        'install',
        `cannot patch the connection admission gates (frozen or read-only instance): ${describeError(error)}`,
      ),
    )
    return failed('install')
  }

  return { dispose: makeDisposer(patched, state), installed: true }
}

/** Restore one member to its exact pre-install shape; never throws. */
function rollbackMethod<T>(
  connection: PatchableConnection,
  member: 'admit' | 'authorizeIndex' | 'authorizeConnect',
  patch: MethodPatch<T>,
): void {
  if (!patch.patched) return
  try {
    const target = connection as unknown as Record<string, unknown>
    if (patch.hadOwn) target[member] = patch.original
    else delete target[member]
  } catch {
    // Frozen/sealed instance: the write never landed.
  }
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

      rollbackMethod(connection, 'admit', state.admit)
      rollbackMethod(connection, 'authorizeIndex', state.index)
      rollbackMethod(connection, 'authorizeConnect', state.connect)

      const shared = state.sharedPeer
      state.sharedPeer = undefined
      // The service may already be torn down; release is best-effort.
      if (shared !== undefined) releasePeer(shared)

      // The shared Peer is unregistered by design (see `admit`), so it is
      // released here instead of by `admitConnection` on socket close.
    } catch (error) {
      safeError(`${LOG_PREFIX} dispose degraded: ${describeError(error)}`)
    }
  }
}
