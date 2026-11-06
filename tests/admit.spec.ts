import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  installAnonymousAdmit,
  installAnonymousAdmitResult,
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

/** Fake Cordis context with injectable failure modes. */
class FakeContext {
  readonly cleanups: Array<() => unknown> = []
  getErrorFor: { name: string; error: Error } | undefined
  effectThrowsBeforeSetup = false
  effectThrowsAfterSetup = false

  constructor(readonly services: Record<string, unknown> = {}) {}

  get(name: string): unknown {
    if (this.getErrorFor?.name === name) throw this.getErrorFor.error
    return this.services[name]
  }

  effect(setup: () => unknown): () => void {
    if (this.effectThrowsBeforeSetup) throw new Error('effect unavailable at runtime')
    const dispose = setup()
    // Mirror Cordis: only a returned function is registered as a disposer.
    if (typeof dispose === 'function') this.cleanups.push(dispose as () => unknown)
    if (this.effectThrowsAfterSetup) throw new Error('effect exploded after setup')
    return () => {}
  }
}

const loopback = { host: '127.0.0.1' }

let errorSpy: MockInstance<typeof console.error>
let infoSpy: MockInstance<typeof console.info>

function captureConsole(): void {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
}

afterEach(() => {
  vi.restoreAllMocks()
})

function errorMessages(): string[] {
  return errorSpy.mock.calls.map((call) => String(call[0]))
}

function expectActivationSkipped(stage: string): void {
  const messages = errorMessages()
  const hit = messages.filter((message) =>
    message.includes(`activation skipped: ${stage} —`),
  )
  expect(hit).toHaveLength(1)
  expect(hit[0]).toContain('[dsh-bypass-web-token]')
  expect(hit[0]).toContain('(plugin inactive; dsh keeps stock auth)')
}

describe('installAnonymousAdmit', () => {
  it('admits an unauthenticated trusted request as an answering owner peer', () => {
    captureConsole()
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
    captureConsole()
    const connection = new FakeConnection()
    connection.trusted = false
    const dispose = installAnonymousAdmit(connection)

    expect(connection.admit(request)).toEqual({ rejection: 403 })
    expect(connection.published).toHaveLength(0)

    dispose()
  })

  it('never downgrades an authenticated request', () => {
    captureConsole()
    const connection = new FakeConnection()
    const browserPeer: PeerLike = { id: 'browser-peer' }
    connection.authenticated = browserPeer
    const dispose = installAnonymousAdmit(connection)

    expect(connection.admit(request)).toEqual({ peer: browserPeer })
    expect(connection.published).toHaveLength(0)

    dispose()
  })

  it('reuses one peer across requests but republishes after a socket release', () => {
    captureConsole()
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
    captureConsole()
    const connection = new FakeConnection()
    const dispose = installAnonymousAdmit(connection)
    connection.disposed = true

    expect(connection.admit(request)).toEqual({ rejection: 401 })

    dispose()
  })

  it('is idempotent across repeated installs and restores the inherited method', () => {
    captureConsole()
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

  it('restores the exact same function when `admit` was an own property', () => {
    captureConsole()
    const connection = new FakeConnection()
    const originalOwn = (): Admission => ({ rejection: 401 })
    connection.admit = originalOwn

    const dispose = installAnonymousAdmit(connection)
    expect(connection.admit).not.toBe(originalOwn)
    expect('peer' in connection.admit(request)).toBe(true)

    dispose()
    expect(Object.hasOwn(connection, 'admit')).toBe(true)
    // Identity must survive: a bound copy would fail this comparison.
    expect(connection.admit).toBe(originalOwn)
    expect(connection.admit(request)).toEqual({ rejection: 401 })
  })

  it('leaves no own `admit` behind when the original was inherited', () => {
    captureConsole()
    const connection = new FakeConnection()
    expect(Object.hasOwn(connection, 'admit')).toBe(false)

    const dispose = installAnonymousAdmit(connection)
    expect(Object.hasOwn(connection, 'admit')).toBe(true)

    dispose()
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(connection.admit).toBe(FakeConnection.prototype.admit)
  })

  it('disposes the anonymous peer on final uninstall', async () => {
    captureConsole()
    const connection = new FakeConnection()
    const dispose = installAnonymousAdmit(connection)
    const admission = connection.admit(request)
    if (!('peer' in admission)) throw new Error('expected a peer')

    dispose()
    expect(connection.peers.get(admission.peer.id)).toBeUndefined()
    expect(admission.peer.dispose).toHaveBeenCalledTimes(1)
  })

  it('stays inert and logs the stage when publishPeer is unavailable', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.defineProperty(connection, 'publishPeer', {
      value: undefined,
      configurable: true,
    })

    const dispose = installAnonymousAdmit(connection)

    expectActivationSkipped('connection.publishPeer')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(connection.published).toHaveLength(0)
    expect(() => dispose()).not.toThrow()
  })

  it('stays inert and logs the stage when isTrusted is unavailable', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.defineProperty(connection, 'isTrusted', {
      value: undefined,
      configurable: true,
    })

    installAnonymousAdmit(connection)

    expectActivationSkipped('connection.isTrusted')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(connection.isTrusted).toBeUndefined()
  })

  it('stays inert and logs the stage when peers is not a Map', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.defineProperty(connection, 'peers', {
      value: {},
      configurable: true,
    })

    installAnonymousAdmit(connection)

    expectActivationSkipped('connection.peers')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
  })

  it('returns an idempotent no-op disposer when the preflight fails', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.defineProperty(connection, 'publishPeer', {
      value: undefined,
      configurable: true,
    })

    const dispose = installAnonymousAdmit(connection)
    expect(() => {
      dispose()
      dispose()
    }).not.toThrow()
    expectActivationSkipped('connection.publishPeer')
  })

  it('reports installation status and keeps the legacy disposer contract', () => {
    captureConsole()
    const connection = new FakeConnection()

    const result = installAnonymousAdmitResult(connection)
    expect(result.installed).toBe(true)
    expect(result.stage).toBeUndefined()
    expect('peer' in connection.admit(request)).toBe(true)

    const legacy = installAnonymousAdmit(connection)
    expect(typeof legacy).toBe('function')
    legacy()
    result.dispose()

    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(connection.admit(request)).toEqual({ rejection: 401 })
  })

  it('reports a refused install on a frozen instance and never claims success', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.freeze(connection)

    const result = installAnonymousAdmitResult(connection)

    expect(result.installed).toBe(false)
    expect(result.stage).toBe('install')
    expect(Object.getOwnPropertySymbols(connection)).toHaveLength(0)
    expect(() => result.dispose()).not.toThrow()
    expectActivationSkipped('install')
    expect(infoSpy).not.toHaveBeenCalled()
  })

  it('swallows sync throws and async rejections from peer.dispose', async () => {
    captureConsole()
    const connection = new FakeConnection()
    const dispose = installAnonymousAdmit(connection)
    const admission = connection.admit(request)
    if (!('peer' in admission)) throw new Error('expected a peer')

    admission.peer.dispose = vi.fn(() => {
      throw new Error('sync dispose failure')
    }) as unknown as () => Promise<void>
    expect(() => dispose()).not.toThrow()

    const second = new FakeConnection()
    const disposeSecond = installAnonymousAdmit(second)
    const admitted = second.admit(request)
    if (!('peer' in admitted)) throw new Error('expected a peer')
    admitted.peer.dispose = vi.fn(
      () => Promise.reject(new Error('async dispose failure')),
    ) as unknown as () => Promise<void>

    expect(() => disposeSecond()).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
  })
})

describe('plugin module', () => {
  it('exports a Cordis plugin shape', () => {
    expect(name).toBe('bypass-web-token')
    expect(inject).toEqual(['connection', 'webServer'])
    expect((Config as unknown as (value: unknown) => Config)({}).trustLoopback).toBe(
      false,
    )
  })

  it('does nothing when trustLoopback is disabled', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: loopback })

    apply(ctx as never, { trustLoopback: false })

    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(ctx.cleanups).toHaveLength(0)
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('skips activation when ctx.get(webServer) throws', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection })
    ctx.getErrorFor = { name: 'webServer', error: new Error('service store not ready') }

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped("ctx.get('webServer')")
    expect(errorMessages().join('\n')).toContain('service store not ready')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(ctx.cleanups).toHaveLength(0)
  })

  it('skips activation when webServer is unavailable', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection })

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped('webServer')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(ctx.cleanups).toHaveLength(0)
  })

  it('skips activation when webServer.host is missing', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: {} })

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped('webServer.host')
    expect(errorMessages().join('\n')).toContain('got undefined')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(ctx.cleanups).toHaveLength(0)
  })

  it('skips activation when webServer.host is not a string', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: { host: 8080 } })

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped('webServer.host')
    expect(errorMessages().join('\n')).toContain('got number (8080)')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(ctx.cleanups).toHaveLength(0)
  })

  it('skips activation on a non-loopback listener and names the host', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({
      connection,
      webServer: { host: '192.168.1.10' },
    })

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped('webServer.host')
    expect(errorMessages().join('\n')).toContain(
      'trustLoopback requires a loopback listener (got 192.168.1.10)',
    )
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(ctx.cleanups).toHaveLength(0)
    expect(connection.published).toHaveLength(0)
  })

  it('skips activation when ctx.get(connection) throws', () => {
    captureConsole()
    const ctx = new FakeContext({ webServer: loopback })
    ctx.getErrorFor = { name: 'connection', error: new Error('connection store exploded') }

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped("ctx.get('connection')")
    // Sanity: the thrown message is surfaced, not swallowed silently.
    expect(errorMessages().join('\n')).toContain('connection store exploded')
    expect(ctx.cleanups).toHaveLength(0)
  })

  it('skips activation when the connection service is unavailable', () => {
    captureConsole()
    const ctx = new FakeContext({ webServer: loopback })

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped('connection')
    expect(ctx.cleanups).toHaveLength(0)
  })

  it('skips activation when connection.admit is missing', () => {
    captureConsole()
    const publishPeer = vi.fn(() => 'peer-1')
    const connection = {
      peers: new Map(),
      isTrusted: () => true,
      publishPeer,
    } as unknown as PatchableConnection
    const ctx = new FakeContext({ connection, webServer: loopback })

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped('connection.admit')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(ctx.cleanups).toHaveLength(0)
    expect(publishPeer).not.toHaveBeenCalled()
  })

  it('skips activation when connection.admit is not a function', () => {
    captureConsole()
    const publishPeer = vi.fn(() => 'peer-1')
    const connection = {
      admit: {},
      peers: new Map(),
      isTrusted: () => true,
      publishPeer,
    } as unknown as PatchableConnection
    const ctx = new FakeContext({ connection, webServer: loopback })

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped('connection.admit')
    expect(errorMessages().join('\n')).toContain('got [object Object]')
    expect(ctx.cleanups).toHaveLength(0)
    expect(publishPeer).not.toHaveBeenCalled()
  })

  it('skips activation when connection.isTrusted is missing', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.defineProperty(connection, 'isTrusted', {
      value: undefined,
      configurable: true,
    })
    const ctx = new FakeContext({ connection, webServer: loopback })

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped('connection.isTrusted')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(ctx.cleanups).toHaveLength(0)
    expect(connection.published).toHaveLength(0)
  })

  it('skips activation when connection.publishPeer is missing', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.defineProperty(connection, 'publishPeer', {
      value: undefined,
      configurable: true,
    })
    const ctx = new FakeContext({ connection, webServer: loopback })

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped('connection.publishPeer')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(ctx.cleanups).toHaveLength(0)
    expect(connection.published).toHaveLength(0)
  })

  it('skips activation when connection.peers is not a Map', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.defineProperty(connection, 'peers', {
      value: [],
      configurable: true,
    })
    const ctx = new FakeContext({ connection, webServer: loopback })

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped('connection.peers')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(ctx.cleanups).toHaveLength(0)
  })

  it('skips activation when ctx.effect is missing', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = { get: (name: string) => ({ connection, webServer: loopback })[name] }

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped('ctx.effect')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
  })

  it('skips activation when ctx.effect throws before running setup', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: loopback })
    ctx.effectThrowsBeforeSetup = true

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped('ctx.effect')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(ctx.cleanups).toHaveLength(0)
    expect(connection.published).toHaveLength(0)
  })

  it('uninstalls when ctx.effect throws after setup already installed', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: loopback })
    ctx.effectThrowsAfterSetup = true

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped('ctx.effect')
    // The half-installed patch must be rolled back.
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(Object.getOwnPropertySymbols(connection)).toHaveLength(0)
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(connection.peers.size).toBe(0)
  })

  it('skips activation and rolls back when admit cannot be written (frozen instance)', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.freeze(connection)
    const ctx = new FakeContext({ connection, webServer: loopback })

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()

    expectActivationSkipped('install')
    // A refused install must stay the only line in the log: no success info.
    expect(infoSpy).not.toHaveBeenCalled()
    expect(errorMessages()).toHaveLength(1)
    expect(Object.getOwnPropertySymbols(connection)).toHaveLength(0)
    // No disposer registered, because nothing was installed.
    expect(ctx.cleanups).toHaveLength(0)
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(connection.published).toHaveLength(0)
  })

  it('still installs on a loopback listener with a valid admit', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: loopback })

    apply(ctx as never, { trustLoopback: true })

    expect(errorSpy).not.toHaveBeenCalled()
    expect(infoSpy).toHaveBeenCalledOnce()
    expect(Object.hasOwn(connection, 'admit')).toBe(true)
    expect('peer' in connection.admit(request)).toBe(true)
    expect(ctx.cleanups).toHaveLength(1)

    ctx.cleanups[0]!()
    expect(connection.admit(request)).toEqual({ rejection: 401 })
  })

  it('installs on a loopback listener and restores on fiber disposal', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: loopback })

    apply(ctx as never, { trustLoopback: true })
    expect('peer' in connection.admit(request)).toBe(true)

    expect(ctx.cleanups).toHaveLength(1)
    ctx.cleanups[0]!()
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
  })

  it('never grants anonymous admission on any failed preflight path', () => {
    const cases: Array<{ services: Record<string, unknown>; stage: string }> = [
      { services: {}, stage: 'webServer' },
      { services: { webServer: {} }, stage: 'webServer.host' },
      { services: { webServer: { host: '10.0.0.1' } }, stage: 'webServer.host' },
      { services: { webServer: loopback }, stage: 'connection' },
    ]

    for (const testCase of cases) {
      captureConsole()
      const ctx = new FakeContext({ ...testCase.services, connection: testCase.services.connection })
      expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()
      expectActivationSkipped(testCase.stage)
      expect(ctx.cleanups).toHaveLength(0)
      vi.restoreAllMocks()
    }
  })
})

describe('runtime wrapper defence', () => {
  function installed(connection: FakeConnection): () => void {
    const dispose = installAnonymousAdmit(connection)
    expect(Object.hasOwn(connection, 'admit')).toBe(true)
    return dispose
  }

  it('returns 401 when the original admit throws, and logs once per signature', () => {
    captureConsole()
    const connection = new FakeConnection()
    connection.admit = () => {
      throw new Error('stock admit exploded')
    }
    const dispose = installed(connection)

    expect(() => connection.admit(request)).not.toThrow()
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(connection.admit(request)).toEqual({ rejection: 401 })

    const messages = errorMessages()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('request path degraded: admit —')
    expect(messages[0]).toContain('stock admit exploded')
    expect(messages[0]).toContain('(returning 401)')

    dispose()
  })

  it('returns 401 when isTrusted throws', () => {
    captureConsole()
    const connection = new FakeConnection()
    connection.admit = () => ({ rejection: 401 })
    connection.isTrusted = () => {
      throw new Error('trust check exploded')
    }
    const dispose = installed(connection)

    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(errorMessages().some((m) => m.includes('request path degraded: isTrusted —'))).toBe(
      true,
    )

    dispose()
  })

  it('returns 401 when publishPeer throws', () => {
    captureConsole()
    const connection = new FakeConnection()
    connection.publishPeer = () => {
      throw new Error('publish exploded')
    }
    const dispose = installed(connection)

    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(
      errorMessages().some((m) => m.includes('request path degraded: publishPeer —')),
    ).toBe(true)

    dispose()
  })

  it('returns 401 when peers.get throws', () => {
    captureConsole()
    const connection = new FakeConnection()
    vi.spyOn(connection.peers, 'get').mockImplementation(() => {
      throw new Error('registry exploded')
    })
    const dispose = installed(connection)

    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(errorMessages().some((m) => m.includes('request path degraded: peers.get —'))).toBe(
      true,
    )

    dispose()
  })

  it('returns 401 when the published peer record is malformed', () => {
    captureConsole()
    const connection = new FakeConnection()
    connection.publishPeer = () => 'peer-1'
    vi.spyOn(connection.peers, 'get').mockReturnValue({} as PeerRecord)
    const dispose = installed(connection)

    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(
      errorMessages().some((m) => m.includes('request path degraded: peer record —')),
    ).toBe(true)

    dispose()
  })

  it('returns 401 when publishPeer returns a non-string id', () => {
    captureConsole()
    const connection = new FakeConnection()
    connection.publishPeer = () => 42 as unknown as string
    const dispose = installed(connection)

    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(
      errorMessages().some((m) => m.includes('request path degraded: publishPeer —')),
    ).toBe(true)

    dispose()
  })

  it('returns 401 when the disposed flag accessor throws', () => {
    captureConsole()
    const connection = new FakeConnection()
    connection.admit = () => ({ rejection: 401 })
    Object.defineProperty(connection, 'disposed', {
      get() {
        throw new Error('disposed getter exploded')
      },
      configurable: true,
    })
    const dispose = installed(connection)

    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(
      errorMessages().some((m) => m.includes('request path degraded: disposed —')),
    ).toBe(true)

    dispose()
  })

  it('returns 401 when peers.get yields null instead of a record', () => {
    captureConsole()
    const connection = new FakeConnection()
    vi.spyOn(connection.peers, 'get').mockReturnValue(null as unknown as PeerRecord)
    const dispose = installed(connection)

    expect(() => connection.admit(request)).not.toThrow()
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(
      errorMessages().some((m) => m.includes('request path degraded: peer record —')),
    ).toBe(true)

    dispose()
  })

  it('returns 401 when the record.peer getter throws', () => {
    captureConsole()
    const connection = new FakeConnection()
    vi.spyOn(connection.peers, 'get').mockReturnValue({
      get peer(): PeerLike {
        throw new Error('peer getter exploded')
      },
    } as unknown as PeerRecord)
    const dispose = installed(connection)

    expect(() => connection.admit(request)).not.toThrow()
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    const messages = errorMessages()
    expect(messages.some((m) => m.includes('request path degraded: peer record —'))).toBe(
      true,
    )
    expect(messages.join('\n')).toContain('peer getter exploded')

    dispose()
  })

  it('returns 401 when the peer.id getter throws', () => {
    captureConsole()
    const connection = new FakeConnection()
    vi.spyOn(connection.peers, 'get').mockReturnValue({
      peer: {
        get id(): string {
          throw new Error('id getter exploded')
        },
      },
    } as unknown as PeerRecord)
    const dispose = installed(connection)

    expect(() => connection.admit(request)).not.toThrow()
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    const messages = errorMessages()
    expect(messages.some((m) => m.includes('request path degraded: peer record —'))).toBe(
      true,
    )
    expect(messages.join('\n')).toContain('id getter exploded')

    dispose()
  })

  it('returns 401 when the original admit returns a malformed result', () => {
    captureConsole()
    const connection = new FakeConnection()
    connection.admit = () => null as unknown as Admission
    const dispose = installed(connection)

    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(
      errorMessages().some((m) =>
        m.includes('request path degraded: admit — unexpected admission result'),
      ),
    ).toBe(true)

    dispose()
  })
})

describe('log sink safety', () => {
  it('keeps apply from throwing when console.error throws on a failure path', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('log sink exploded')
    })
    vi.spyOn(console, 'info').mockImplementation(() => {})

    const connection = new FakeConnection()
    Object.freeze(connection)
    const ctx = new FakeContext({ connection, webServer: loopback })

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()
    expect(Object.getOwnPropertySymbols(connection)).toHaveLength(0)
    expect(ctx.cleanups).toHaveLength(0)
  })

  it('keeps the wrapper from throwing when console.error throws at request time', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('log sink exploded')
    })

    const connection = new FakeConnection()
    connection.admit = () => {
      throw new Error('stock admit exploded')
    }
    const dispose = installAnonymousAdmit(connection)

    expect(() => connection.admit(request)).not.toThrow()
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(() => dispose()).not.toThrow()
  })

  it('keeps the patch active when console.info throws after a successful install', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('log sink exploded')
    })

    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: loopback })

    expect(() => apply(ctx as never, { trustLoopback: true })).not.toThrow()
    expect(Object.hasOwn(connection, 'admit')).toBe(true)
    expect('peer' in connection.admit(request)).toBe(true)
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
