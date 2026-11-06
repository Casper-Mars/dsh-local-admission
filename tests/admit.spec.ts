import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it, vi } from 'vitest'
import {
  installAnonymousAdmit,
  type Admission,
  type PatchableConnection,
  type PeerLike,
  type PeerRecord,
} from '../src/admit.js'
import { apply, Config, inject, name } from '../src/index.js'

const request = { headers: {} } as ConnectionTrustRequest

/** Minimal stand-in for `HostConnectionService`'s admission surface. */
class FakeConnection implements PatchableConnection {
  readonly peers = new Map<string, PeerRecord>()
  disposed = false
  trusted = true
  authenticated: PeerLike | undefined
  readonly published: Array<{ id: string; interactions: 'answer' | 'none' | undefined }> = []
  private seq = 0

  admit(_request: ConnectionTrustRequest): Admission {
    if (!this.isTrusted()) return { rejection: 403 }
    if (this.disposed) return { rejection: 401 }
    if (this.authenticated !== undefined) return { peer: this.authenticated }
    return { rejection: 401 }
  }

  isTrusted(): boolean {
    return this.trusted
  }

  publishPeer(interactions?: 'answer' | 'none'): string {
    this.seq += 1
    const id = `peer-${this.seq}`
    const peer: PeerLike = {
      id,
      ...(interactions === undefined ? {} : { interactions }),
      dispose: vi.fn(async () => {}),
    }
    this.peers.set(id, { peer, ownsSocket: false })
    this.published.push({ id, interactions })
    return id
  }
}

/** Fake Cordis context: only `get` and the setup form of `effect` are exercised. */
class FakeContext {
  readonly cleanups: Array<() => unknown> = []

  constructor(readonly services: Record<string, unknown>) {}

  get(name: string): unknown {
    return this.services[name]
  }

  effect(setup: () => unknown): () => void {
    const dispose = setup()
    this.cleanups.push(dispose as () => unknown)
    return () => {}
  }
}

describe('installAnonymousAdmit', () => {
  it('admits an unauthenticated trusted request as an answering owner peer', () => {
    const connection = new FakeConnection()
    const dispose = installAnonymousAdmit(connection)

    const admission = connection.admit(request)

    expect('peer' in admission).toBe(true)
    if (!('peer' in admission)) throw new Error('expected a peer')
    expect(admission.peer.id).toBe('peer-1')
    expect(admission.peer.interactions).toBe('answer')
    expect(connection.published).toEqual([{ id: 'peer-1', interactions: 'answer' }])

    dispose()
  })

  it('keeps the Host/Origin fence: untrusted requests still get 403', () => {
    const connection = new FakeConnection()
    connection.trusted = false
    const dispose = installAnonymousAdmit(connection)

    expect(connection.admit(request)).toEqual({ rejection: 403 })
    expect(connection.published).toHaveLength(0)

    dispose()
  })

  it('never downgrades an authenticated request', () => {
    const connection = new FakeConnection()
    const browserPeer: PeerLike = { id: 'browser-peer' }
    connection.authenticated = browserPeer
    const dispose = installAnonymousAdmit(connection)

    expect(connection.admit(request)).toEqual({ peer: browserPeer })
    expect(connection.published).toHaveLength(0)

    dispose()
  })

  it('reuses one peer across requests but republishes after a socket release', () => {
    const connection = new FakeConnection()
    const dispose = installAnonymousAdmit(connection)

    const first = connection.admit(request)
    const second = connection.admit(request)
    if (!('peer' in first) || !('peer' in second)) throw new Error('expected peers')
    expect(second.peer.id).toBe(first.peer.id)
    expect(connection.published).toHaveLength(1)

    // `admitConnection` deletes the record when the WebSocket closes.
    connection.peers.delete(first.peer.id)

    const third = connection.admit(request)
    if (!('peer' in third)) throw new Error('expected a peer')
    expect(third.peer.id).not.toBe(first.peer.id)
    expect(connection.published).toHaveLength(2)

    dispose()
  })

  it('falls back to the stock rejection while the host is disposing', () => {
    const connection = new FakeConnection()
    const dispose = installAnonymousAdmit(connection)
    connection.disposed = true

    expect(connection.admit(request)).toEqual({ rejection: 401 })

    dispose()
  })

  it('is idempotent across repeated installs and restores the inherited method', () => {
    const connection = new FakeConnection()
    const first = installAnonymousAdmit(connection)
    const second = installAnonymousAdmit(connection)
    expect(Object.hasOwn(connection, 'admit')).toBe(true)

    expect('peer' in connection.admit(request)).toBe(true)

    first()
    // One reference remains: the patch is still installed.
    expect('peer' in connection.admit(request)).toBe(true)

    second()
    // Fully restored: the prototype method answers 401 again.
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(connection.admit(request)).toEqual({ rejection: 401 })
  })

  it('restores a pre-existing own `admit` when one was already installed', () => {
    const connection = new FakeConnection()
    const previous = (): Admission => ({ rejection: 401 })
    connection.admit = previous

    const dispose = installAnonymousAdmit(connection)
    expect(connection.admit).not.toBe(previous)
    expect('peer' in connection.admit(request)).toBe(true)

    dispose()
    expect(Object.hasOwn(connection, 'admit')).toBe(true)
    expect(connection.admit(request)).toEqual({ rejection: 401 })
  })

  it('disposes the anonymous peer on final uninstall', async () => {
    const connection = new FakeConnection()
    const dispose = installAnonymousAdmit(connection)
    const admission = connection.admit(request)
    if (!('peer' in admission)) throw new Error('expected a peer')

    dispose()
    expect(connection.peers.get(admission.peer.id)).toBeUndefined()
    expect(admission.peer.dispose).toHaveBeenCalledTimes(1)
  })

  it('stays inert when the private registry is unavailable', () => {
    const warn = vi.fn()
    const connection = new FakeConnection()
    const broken = { ...connection, publishPeer: undefined } as unknown as PatchableConnection
    Object.setPrototypeOf(broken, FakeConnection.prototype)

    const dispose = installAnonymousAdmit(broken, { warn })
    expect(warn).toHaveBeenCalledOnce()
    expect((broken as unknown as FakeConnection).admit(request)).toEqual({ rejection: 401 })

    dispose()
  })
})

describe('plugin module', () => {
  it('exports a Cordis plugin shape', () => {
    expect(name).toBe('connection-anonymous')
    expect(inject).toEqual(['connection', 'webServer'])
    expect((Config as unknown as (value: unknown) => Config)({}).trustLoopback).toBe(
      false,
    )
  })

  it('does nothing when trustLoopback is disabled', () => {
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: { host: '127.0.0.1' } })

    apply(ctx as never, { trustLoopback: false })

    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(ctx.cleanups).toHaveLength(0)
    expect(connection.admit(request)).toEqual({ rejection: 401 })
  })

  it('fails the boot when trustLoopback meets a non-loopback listener', () => {
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: { host: '192.168.1.10' } })

    expect(() => apply(ctx as never, { trustLoopback: true })).toThrow(
      /requires a loopback listener/,
    )
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
  })

  it('fails the boot when the listener host is missing', () => {
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: {} })

    expect(() => apply(ctx as never, { trustLoopback: true })).toThrow(
      /requires a loopback listener/,
    )
  })

  it('installs on a loopback listener and restores on fiber disposal', () => {
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: { host: '127.0.0.1' } })

    apply(ctx as never, { trustLoopback: true })
    expect('peer' in connection.admit(request)).toBe(true)

    expect(ctx.cleanups).toHaveLength(1)
    ctx.cleanups[0]!()
    expect(connection.admit(request)).toEqual({ rejection: 401 })
  })
})
