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
 */
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'

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
  /** Sink for non-fatal degradations; defaults to `console.warn`. */
  warn?: (message: string) => void
}

interface PatchState {
  refs: number
  /** Whether `admit` was already an own property, i.e. someone else patched it. */
  hadOwn: boolean
  /** The method exactly as found at install time (own function or prototype). */
  originalOwn: AdmitMethod
  peerId: string | undefined
}

/** `admit` with its receiver typed, so the wrapper can `call` the original. */
type AdmitMethod = (
  this: PatchableConnection,
  request: ConnectionTrustRequest,
) => Admission

/** Marks the patched instance; `Symbol.for` keeps HMR-created module copies in sync. */
const STATE = Symbol.for('dsh-connection-anonymous/patch-state')

/**
 * Install the anonymous admission override exactly once per connection
 * instance. Repeated installs only bump a reference count, so an HMR reload or
 * a second apply cannot wrap the wrapper.
 *
 * @param connection - live `ctx.get('connection')` service instance.
 * @param options - optional diagnostics sink.
 * @returns idempotent disposer restoring the original admission behaviour.
 */
export function installAnonymousAdmit(
  connection: PatchableConnection,
  options: InstallOptions = {},
): () => void {
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const marked = connection as unknown as Record<PropertyKey, unknown>

  const existing = marked[STATE] as PatchState | undefined
  if (existing !== undefined) {
    existing.refs += 1
    return makeDisposer(connection, existing)
  }

  const hadOwn = Object.hasOwn(connection, 'admit')
  // Keep the exact function that was there. `bind` would produce a copy, and
  // writing that copy back on uninstall would break identity with the original
  // own property; calling with `connection` covers inherited methods too.
  const originalOwn = connection.admit as AdmitMethod
  const canPublish =
    typeof connection.publishPeer === 'function' && connection.peers instanceof Map
  if (!canPublish) {
    warn(
      '[dsh-connection-anonymous] connection.publishPeer/peers are missing; anonymous admission stays disabled',
    )
  }

  const state: PatchState = { refs: 1, hadOwn, originalOwn, peerId: undefined }

  const admit = (request: ConnectionTrustRequest): Admission => {
    const admission = originalOwn.call(connection, request)
    // 1. Missing internals: keep the stock 401 rather than widening the fence.
    if (!canPublish) return admission
    // 2. A real browser/API credential always wins; never downgrade it.
    if ('peer' in admission) return admission
    // 3. A disposing host must not mint new Peers.
    if (connection.disposed === true) return admission
    // 4. The Host/Origin fence is not optional.
    if (!connection.isTrusted(request)) return { rejection: 403 }

    // 5. `admitConnection` looks the peer up by id and deletes it on socket
    //    close, so a released peer must be republished instead of reused.
    let record =
      state.peerId === undefined ? undefined : connection.peers.get(state.peerId)
    if (record === undefined) {
      state.peerId = connection.publishPeer('answer')
      record = connection.peers.get(state.peerId)
      if (record === undefined) {
        warn(
          '[dsh-connection-anonymous] published peer disappeared; keeping the original rejection',
        )
        return admission
      }
    }
    return { peer: record.peer }
  }

  connection.admit = admit
  marked[STATE] = state

  return makeDisposer(connection, state)
}

/** Build one idempotent disposer for a shared patch state. */
function makeDisposer(
  connection: PatchableConnection,
  state: PatchState,
): () => void {
  let called = false
  return () => {
    if (called) return
    called = true
    state.refs -= 1
    if (state.refs > 0) return

    const marked = connection as unknown as Record<PropertyKey, unknown>
    delete marked[STATE]

    if (state.hadOwn) connection.admit = state.originalOwn
    else delete (connection as { admit?: unknown }).admit

    const record =
      state.peerId === undefined ? undefined : connection.peers.get(state.peerId)
    if (record !== undefined && state.peerId !== undefined) {
      connection.peers.delete(state.peerId)
      void record.peer.dispose?.().catch(() => {
        // A peer disposed by host shutdown can reject; nothing left to do.
      })
    }
    state.peerId = undefined
  }
}
