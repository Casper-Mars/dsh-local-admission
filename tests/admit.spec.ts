import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  installAnonymousAdmit,
  installAnonymousAdmitResult,
  type Admission,
  type PatchableConnection,
  type PeerLike,
  type PeerRecord,
  type PublishPeer,
} from '../src/admit.js'
import { apply, Config, inject, name } from '../src/index.js'

const request = { headers: {} } as ConnectionTrustRequest

/** Request carrying a cross-origin `Origin` and a forged `Host` header. */
const crossOriginRequest = {
  headers: {
    host: 'evil.example.com',
    origin: 'http://evil.example.com',
  },
} as unknown as ConnectionTrustRequest

/** Minimal stand-in for `HostConnectionService`'s admission surface. */
class FakeConnection implements PatchableConnection {
  readonly peers = new Map<string, PeerRecord>()
  disposed = false
  trusted = true
  authenticated: PeerLike | undefined
  readonly published: Array<{ id: string; interactions: 'answer' | 'none' | undefined }> = []
  /** Every call the plugin let through to the stock index gate. */
  readonly indexCalls: Array<{ request: unknown; response: unknown }> = []
  /** Every call the plugin let through to the stock /connect gate. */
  readonly connectCalls: Array<{ request: unknown; response: unknown }> = []
  private seq = 0

  /** Stock `BrowserAuth.authorizeIndex`: refuses without a token or cookie. */
  authorizeIndex(request: unknown, response: unknown): boolean {
    this.indexCalls.push({ request, response })
    return false
  }

  /** Stock `/connect` exchange: requires a launch token. */
  authorizeConnect(
    request: unknown,
    response: unknown,
    _secure?: boolean,
    _publish?: PublishPeer,
  ): void {
    this.connectCalls.push({ request, response })
    const res = response as {
      writeHead: (status: number, headers?: Record<string, string>) => void
      end: (body?: string) => void
    }
    res.writeHead(401)
    res.end('unauthorized')
  }

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

/** Synthesize the request shape seen by `connection.authorizeConnect`. */
function connectRequest(url: string, method = 'GET'): unknown {
  return { url, method }
}

/** Minimal node:http response double for the `/connect` gate. */
function fakeResponse(): {
  writeHead: MockInstance<(status: number, headers?: Record<string, string>) => void>
  end: MockInstance<(body?: string) => void>
} {
  return { writeHead: vi.fn(), end: vi.fn() }
}

let errorSpy: MockInstance<typeof console.error>
let infoSpy: MockInstance<typeof console.info>
let warnSpy: MockInstance<typeof console.warn>

function captureConsole(): void {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
}

afterEach(() => {
  vi.restoreAllMocks()
})

function errorMessages(): string[] {
  return errorSpy.mock.calls.map((call) => String(call[0]))
}

function warnMessages(): string[] {
  return warnSpy.mock.calls.map((call) => String(call[0]))
}

function expectActivationSkipped(stage: string): void {
  const messages = errorMessages()
  const hit = messages.filter((message) =>
    message.includes(`activation skipped: ${stage} —`),
  )
  expect(hit).toHaveLength(1)
  expect(hit[0]).toContain('[dsh-local-admission]')
  expect(hit[0]).toContain('(plugin inactive; dsh keeps stock auth)')
}

/** Shared success assertions: all three gates landed and one info line was logged. */
function expectActivated(ctx: FakeContext, connection: FakeConnection): void {
  expect(Object.hasOwn(connection, 'admit')).toBe(true)
  expect(Object.hasOwn(connection, 'authorizeIndex')).toBe(true)
  expect(Object.hasOwn(connection, 'authorizeConnect')).toBe(true)

  expect(connection.authorizeIndex!(request, {})).toBe(true)
  expect(connection.indexCalls).toHaveLength(0)

  const response = fakeResponse()
  const publish = vi.fn(() => 'published-by-connect')
  connection.authorizeConnect!(connectRequest('/connect'), response, false, publish)
  expect(publish).toHaveBeenCalledWith('none')
  expect(response.writeHead).toHaveBeenCalledWith(
    302,
    expect.objectContaining({ location: './api/remote.mux' }),
  )

  expect('peer' in connection.admit(request)).toBe(true)
  expect(ctx.cleanups).toHaveLength(1)
  expect(infoSpy).toHaveBeenCalledOnce()
}

describe('installAnonymousAdmit', () => {
  it('admits an unauthenticated request without ever calling the stock admit', () => {
    captureConsole()
    const connection = new FakeConnection()
    const stockAdmit = vi.spyOn(FakeConnection.prototype, 'admit')
    const dispose = installAnonymousAdmit(connection)

    const admission = connection.admit(request)

    expect('peer' in admission).toBe(true)
    if (!('peer' in admission)) throw new Error('expected a peer')
    expect(admission.peer.id).toBe('peer-1')
    expect(admission.peer.interactions).toBe('answer')
    expect(connection.published).toEqual([{ id: 'peer-1', interactions: 'answer' }])
    // The override replaces the gate instead of delegating to it.
    expect(stockAdmit).not.toHaveBeenCalled()

    dispose()
  })

  it('admits cross-origin / forged-Host requests instead of returning 403', () => {
    captureConsole()
    const connection = new FakeConnection()
    connection.trusted = false
    const stockAdmit = vi.spyOn(FakeConnection.prototype, 'admit')
    const dispose = installAnonymousAdmit(connection)

    const admission = connection.admit(crossOriginRequest)

    expect('peer' in admission).toBe(true)
    expect(stockAdmit).not.toHaveBeenCalled()
    expect(connection.trusted).toBe(false)
    expect(connection.published).toHaveLength(1)

    dispose()
  })

  it('ignores an authenticated browser peer and returns the shared local peer', () => {
    captureConsole()
    const connection = new FakeConnection()
    const browserPeer: PeerLike = { id: 'browser-peer' }
    connection.authenticated = browserPeer
    const stockAdmit = vi.spyOn(FakeConnection.prototype, 'admit')
    const dispose = installAnonymousAdmit(connection)

    const admission = connection.admit(request)

    expect('peer' in admission).toBe(true)
    if (!('peer' in admission)) throw new Error('expected a peer')
    expect(admission.peer.id).toBe('peer-1')
    expect(admission.peer).not.toBe(browserPeer)
    expect(stockAdmit).not.toHaveBeenCalled()

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

  it('rejects new peers while the host is disposing', () => {
    captureConsole()
    const connection = new FakeConnection()
    const dispose = installAnonymousAdmit(connection)
    connection.disposed = true

    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(connection.published).toHaveLength(0)

    dispose()
  })

  it('is idempotent and restores all three inherited gates on final uninstall', () => {
    captureConsole()
    const connection = new FakeConnection()
    const first = installAnonymousAdmit(connection)
    const second = installAnonymousAdmit(connection)

    expect(Object.hasOwn(connection, 'admit')).toBe(true)
    expect(Object.hasOwn(connection, 'authorizeIndex')).toBe(true)
    expect(Object.hasOwn(connection, 'authorizeConnect')).toBe(true)
    expect('peer' in connection.admit(request)).toBe(true)

    first()
    // One reference remains: every gate is still patched.
    expect('peer' in connection.admit(request)).toBe(true)
    expect(connection.authorizeIndex!(request, {})).toBe(true)
    const during = fakeResponse()
    const publish = vi.fn(() => 'peer-x')
    connection.authorizeConnect!(connectRequest('/connect'), during, false, publish)
    expect(publish).toHaveBeenCalledOnce()

    second()
    // Fully restored: the prototype methods answer again.
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(Object.hasOwn(connection, 'authorizeIndex')).toBe(false)
    expect(Object.hasOwn(connection, 'authorizeConnect')).toBe(false)
    expect(connection.admit).toBe(FakeConnection.prototype.admit)
    expect(connection.authorizeIndex).toBe(FakeConnection.prototype.authorizeIndex)
    expect(connection.authorizeConnect).toBe(FakeConnection.prototype.authorizeConnect)
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(connection.authorizeIndex!(request, {})).toBe(false)
    expect(connection.indexCalls).toHaveLength(1)
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

  it('opens the web UI index gate and never consults the stock gate', () => {
    captureConsole()
    const connection = new FakeConnection()
    const response = fakeResponse()

    const dispose = installAnonymousAdmit(connection)

    expect(connection.authorizeIndex!(request, response)).toBe(true)
    expect(connection.indexCalls).toHaveLength(0)
    expect(response.writeHead).not.toHaveBeenCalled()

    dispose()
  })

  it('redirects /connect to the mux with an empty cookie and no launch token', () => {
    captureConsole()
    const connection = new FakeConnection()
    const stockConnect = vi.spyOn(FakeConnection.prototype, 'authorizeConnect')
    const response = fakeResponse()
    const publish = vi.fn(() => 'peer-connect')

    const dispose = installAnonymousAdmit(connection)
    connection.authorizeConnect!(connectRequest('/connect?interactions=answer'), response, false, publish)

    expect(stockConnect).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledWith('answer')
    expect(response.writeHead).toHaveBeenCalledOnce()
    const [status, headers] = response.writeHead.mock.calls[0]!
    expect(status).toBe(302)
    expect(headers).toMatchObject({
      'cache-control': 'no-store',
      location: './api/remote.mux',
      'referrer-policy': 'no-referrer',
    })
    const cookie = String(headers?.['set-cookie'])
    expect(cookie).toContain('dsh-session=;')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    // The session cookie value is empty: nothing was signed.
    expect(cookie.slice('dsh-session='.length, cookie.indexOf(';'))).toBe('')
    expect(response.end).toHaveBeenCalledOnce()

    dispose()
  })

  it('defaults /connect interactions to none and publishes it', () => {
    captureConsole()
    const connection = new FakeConnection()
    const response = fakeResponse()
    const publish = vi.fn(() => 'peer-connect')

    const dispose = installAnonymousAdmit(connection)
    connection.authorizeConnect!(connectRequest('/connect'), response, false, publish)

    expect(publish).toHaveBeenCalledWith('none')
    expect(response.writeHead).toHaveBeenCalledWith(302, expect.any(Object))

    dispose()
  })

  it('rejects malformed interactions declarations with 400', () => {
    captureConsole()
    const connection = new FakeConnection()
    const dispose = installAnonymousAdmit(connection)

    for (const url of [
      '/connect?interactions=bogus',
      '/connect?interactions=answer&interactions=none',
    ]) {
      const response = fakeResponse()
      const publish = vi.fn(() => 'peer-connect')
      connection.authorizeConnect!(connectRequest(url), response, false, publish)
      expect(response.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
      expect(response.end).toHaveBeenCalledWith(
        'interactions must be declared once as answer or none\n',
      )
      expect(publish).not.toHaveBeenCalled()
    }

    dispose()
  })

  it('returns false for non-GET or non-/connect requests and publishes nothing', () => {
    captureConsole()
    const connection = new FakeConnection()
    const dispose = installAnonymousAdmit(connection)

    for (const [url, method] of [
      ['/connect', 'POST'],
      ['/other?interactions=answer', 'GET'],
    ] as const) {
      const response = fakeResponse()
      const publish = vi.fn(() => 'peer-connect')
      expect(
        connection.authorizeConnect!(connectRequest(url, method), response, false, publish),
      ).toBe(false)
      expect(publish).not.toHaveBeenCalled()
      expect(response.writeHead).not.toHaveBeenCalled()
    }

    dispose()
  })

  it('restores inherited index and connect gates exactly on final uninstall', () => {
    captureConsole()
    const connection = new FakeConnection()
    expect(Object.hasOwn(connection, 'authorizeIndex')).toBe(false)
    expect(Object.hasOwn(connection, 'authorizeConnect')).toBe(false)

    const dispose = installAnonymousAdmit(connection)
    expect(Object.hasOwn(connection, 'authorizeIndex')).toBe(true)
    expect(Object.hasOwn(connection, 'authorizeConnect')).toBe(true)
    expect(connection.authorizeIndex!(request, {})).toBe(true)

    dispose()
    expect(Object.hasOwn(connection, 'authorizeIndex')).toBe(false)
    expect(Object.hasOwn(connection, 'authorizeConnect')).toBe(false)
    expect(connection.authorizeIndex).toBe(FakeConnection.prototype.authorizeIndex)
    expect(connection.authorizeConnect).toBe(FakeConnection.prototype.authorizeConnect)
  })

  it('restores the exact same gates when they were own properties', () => {
    captureConsole()
    const connection = new FakeConnection()
    const originalIndex = (): boolean => false
    const originalConnect = (): void => {}
    connection.authorizeIndex = originalIndex
    connection.authorizeConnect = originalConnect

    const dispose = installAnonymousAdmit(connection)
    expect(connection.authorizeIndex).not.toBe(originalIndex)
    expect(connection.authorizeConnect).not.toBe(originalConnect)
    expect(connection.authorizeIndex!(request, {})).toBe(true)

    dispose()
    expect(Object.hasOwn(connection, 'authorizeIndex')).toBe(true)
    expect(Object.hasOwn(connection, 'authorizeConnect')).toBe(true)
    expect(connection.authorizeIndex).toBe(originalIndex)
    expect(connection.authorizeConnect).toBe(originalConnect)
    expect(connection.authorizeIndex!(request, {})).toBe(false)
  })

  it('still installs when the index gate is missing, with one warning', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.defineProperty(connection, 'authorizeIndex', {
      value: undefined,
      configurable: true,
    })

    const result = installAnonymousAdmitResult(connection)

    expect(result.installed).toBe(true)
    expect(result.stage).toBeUndefined()
    expect(Object.hasOwn(connection, 'admit')).toBe(true)
    expect(Object.hasOwn(connection, 'authorizeConnect')).toBe(true)
    expect('peer' in connection.admit(request)).toBe(true)
    expect(connection.authorizeIndex).toBeUndefined()
    expect(warnMessages()).toHaveLength(1)
    expect(warnMessages()[0]).toContain(
      'WARNING: connection.authorizeIndex is missing — the web UI will still require a token',
    )
    expect(errorSpy).not.toHaveBeenCalled()

    result.dispose()
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
  })

  it('still installs when the connect gate is missing, with one warning', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.defineProperty(connection, 'authorizeConnect', {
      value: undefined,
      configurable: true,
    })

    const result = installAnonymousAdmitResult(connection)

    expect(result.installed).toBe(true)
    expect(result.stage).toBeUndefined()
    expect(Object.hasOwn(connection, 'admit')).toBe(true)
    expect(Object.hasOwn(connection, 'authorizeIndex')).toBe(true)
    expect(connection.authorizeConnect).toBeUndefined()
    expect('peer' in connection.admit(request)).toBe(true)
    expect(connection.authorizeIndex!(request, {})).toBe(true)
    expect(warnMessages()).toHaveLength(1)
    expect(warnMessages()[0]).toContain(
      'WARNING: connection.authorizeConnect is missing — /connect will still require a launch token',
    )
    expect(errorSpy).not.toHaveBeenCalled()

    result.dispose()
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
  })

  it('warns once, not per install, when an optional gate is missing', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.defineProperty(connection, 'authorizeIndex', {
      value: undefined,
      configurable: true,
    })
    Object.defineProperty(connection, 'authorizeConnect', {
      value: undefined,
      configurable: true,
    })

    const first = installAnonymousAdmit(connection)
    const second = installAnonymousAdmit(connection)

    expect(warnMessages()).toHaveLength(2)
    expect(warnMessages().some((m) => m.includes('authorizeIndex is missing'))).toBe(true)
    expect(warnMessages().some((m) => m.includes('authorizeConnect is missing'))).toBe(true)

    first()
    second()
  })

  it('rolls every gate back when one cannot be written (frozen instance)', () => {
    captureConsole()
    const connection = new FakeConnection()
    const originalConnect = (): void => {}
    connection.authorizeConnect = originalConnect
    Object.freeze(connection)

    const result = installAnonymousAdmitResult(connection)

    expect(result.installed).toBe(false)
    expect(result.stage).toBe('install')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(Object.hasOwn(connection, 'authorizeIndex')).toBe(false)
    expect(connection.authorizeConnect).toBe(originalConnect)
    expect(Object.getOwnPropertySymbols(connection)).toHaveLength(0)
    expectActivationSkipped('install')
    expect(infoSpy).not.toHaveBeenCalled()
    expect(() => result.dispose()).not.toThrow()
  })

  it('rolls back when only the connect gate is read-only', () => {
    captureConsole()
    const connection = new FakeConnection()
    const originalConnect = (): void => {}
    Object.defineProperty(connection, 'authorizeConnect', {
      value: originalConnect,
      writable: false,
      configurable: true,
    })

    const result = installAnonymousAdmitResult(connection)

    expect(result.installed).toBe(false)
    expect(result.stage).toBe('install')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(Object.hasOwn(connection, 'authorizeIndex')).toBe(false)
    expect(connection.authorizeConnect).toBe(originalConnect)
    expect(Object.getOwnPropertySymbols(connection)).toHaveLength(0)
    expectActivationSkipped('install')
  })

  it('disposes the admitted peer on final uninstall', async () => {
    captureConsole()
    const connection = new FakeConnection()
    const dispose = installAnonymousAdmit(connection)
    const admission = connection.admit(request)
    if (!('peer' in admission)) throw new Error('expected a peer')

    dispose()
    expect(connection.peers.get(admission.peer.id)).toBeUndefined()
    expect(admission.peer.dispose).toHaveBeenCalledTimes(1)
  })

  it('does not require isTrusted: a missing method still activates', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.defineProperty(connection, 'isTrusted', {
      value: undefined,
      configurable: true,
    })

    const result = installAnonymousAdmitResult(connection)

    expect(result.installed).toBe(true)
    expect(Object.hasOwn(connection, 'admit')).toBe(true)
    expect(connection.isTrusted).toBeUndefined()
    expect('peer' in connection.admit(crossOriginRequest)).toBe(true)
    expect(errorSpy).not.toHaveBeenCalled()
    result.dispose()
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
    expect(Object.hasOwn(connection, 'authorizeConnect')).toBe(false)
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
  it('exports a zero-config Cordis plugin shape', () => {
    expect(name).toBe('local-admission')
    expect(inject).toEqual(['connection'])
    // Cordis requires a schema export, but it must not declare any option.
    expect(Config({})).toEqual({})
    expect(Object.keys(Config({}))).toHaveLength(0)
  })

  it('activates unconditionally when called without a config argument', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: loopback })

    expect(() => apply(ctx as never)).not.toThrow()

    expectActivated(ctx, connection)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(String(infoSpy.mock.calls[0]![0])).toBe(
      '[dsh-local-admission] local admission is active on loopback listener 127.0.0.1 — clients are treated as the owner principal',
    )
    expect('peer' in connection.admit(request)).toBe(true)
  })

  it('activates unconditionally with an empty config object', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: loopback })

    expect(() => apply(ctx as never, {} as never)).not.toThrow()

    expectActivated(ctx, connection)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('activates on a non-loopback listener with one warning and one info line', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({
      connection,
      webServer: { host: '192.168.1.10' },
    })

    expect(() => apply(ctx as never)).not.toThrow()

    expectActivated(ctx, connection)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnMessages()).toHaveLength(1)
    expect(warnMessages()[0]).toContain(
      'WARNING: local admission is active on non-loopback listener 192.168.1.10',
    )
    expect(String(infoSpy.mock.calls[0]![0])).toContain(
      'non-loopback listener 192.168.1.10',
    )
  })

  it('activates when the webServer service is missing', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection })

    expect(() => apply(ctx as never)).not.toThrow()

    expectActivated(ctx, connection)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnMessages()).toHaveLength(1)
    expect(warnMessages()[0]).toContain('non-loopback listener unknown')
    expect(String(infoSpy.mock.calls[0]![0])).toContain(
      'non-loopback listener unknown',
    )
  })

  it('activates when ctx.get(webServer) throws', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection })
    ctx.getErrorFor = { name: 'webServer', error: new Error('service store not ready') }

    expect(() => apply(ctx as never)).not.toThrow()

    expectActivated(ctx, connection)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnMessages()).toHaveLength(1)
    expect(warnMessages()[0]).toContain('non-loopback listener unknown')
  })

  it('activates when webServer.host is missing, non-string, or throws', () => {
    const variants: unknown[] = [
      {},
      { host: 8080 },
      {
        get host(): string {
          throw new Error('host getter exploded')
        },
      },
    ]

    for (const webServer of variants) {
      captureConsole()
      const connection = new FakeConnection()
      const ctx = new FakeContext({ connection, webServer })

      expect(() => apply(ctx as never)).not.toThrow()

      expectActivated(ctx, connection)
      expect(errorSpy).not.toHaveBeenCalled()
      expect(warnMessages()).toHaveLength(1)
      expect(warnMessages()[0]).toContain('non-loopback listener unknown')
      expect(String(infoSpy.mock.calls[0]![0])).toContain(
        'non-loopback listener unknown',
      )
      vi.restoreAllMocks()
    }
  })

  it('skips activation when ctx.get(connection) throws', () => {
    captureConsole()
    const ctx = new FakeContext({ webServer: loopback })
    ctx.getErrorFor = { name: 'connection', error: new Error('connection store exploded') }

    expect(() => apply(ctx as never)).not.toThrow()

    expectActivationSkipped("ctx.get('connection')")
    // Sanity: the thrown message is surfaced, not swallowed silently.
    expect(errorMessages().join('\n')).toContain('connection store exploded')
    expect(ctx.cleanups).toHaveLength(0)
  })

  it('skips activation when the connection service is unavailable', () => {
    captureConsole()
    const ctx = new FakeContext({ webServer: loopback })

    expect(() => apply(ctx as never)).not.toThrow()

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

    expect(() => apply(ctx as never)).not.toThrow()

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

    expect(() => apply(ctx as never)).not.toThrow()

    expectActivationSkipped('connection.admit')
    expect(errorMessages().join('\n')).toContain('got [object Object]')
    expect(ctx.cleanups).toHaveLength(0)
    expect(publishPeer).not.toHaveBeenCalled()
  })

  it('activates when connection.isTrusted is missing', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.defineProperty(connection, 'isTrusted', {
      value: undefined,
      configurable: true,
    })
    const ctx = new FakeContext({ connection, webServer: loopback })

    expect(() => apply(ctx as never)).not.toThrow()

    expectActivated(ctx, connection)
    expect(errorSpy).not.toHaveBeenCalled()
    // The override never needed it, but the other gates work with a
    // cross-origin request and a forged Host because no such check is consulted.
    expect('peer' in connection.admit(crossOriginRequest)).toBe(true)
    // One shared peer: the second request reuses the answer peer.
    expect(connection.published).toHaveLength(1)
  })

  it('skips activation when connection.publishPeer is missing', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.defineProperty(connection, 'publishPeer', {
      value: undefined,
      configurable: true,
    })
    const ctx = new FakeContext({ connection, webServer: loopback })

    expect(() => apply(ctx as never)).not.toThrow()

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

    expect(() => apply(ctx as never)).not.toThrow()

    expectActivationSkipped('connection.peers')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(ctx.cleanups).toHaveLength(0)
  })

  it('skips activation when ctx.effect is missing', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = { get: (name: string) => ({ connection, webServer: loopback })[name] }

    expect(() => apply(ctx as never)).not.toThrow()

    expectActivationSkipped('ctx.effect')
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
  })

  it('skips activation when ctx.effect throws before running setup', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: loopback })
    ctx.effectThrowsBeforeSetup = true

    expect(() => apply(ctx as never)).not.toThrow()

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

    expect(() => apply(ctx as never)).not.toThrow()

    expectActivationSkipped('ctx.effect')
    // The half-installed patch must be rolled back.
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(Object.hasOwn(connection, 'authorizeConnect')).toBe(false)
    expect(Object.getOwnPropertySymbols(connection)).toHaveLength(0)
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(connection.peers.size).toBe(0)
  })

  it('skips activation and rolls back when admit cannot be written (frozen instance)', () => {
    captureConsole()
    const connection = new FakeConnection()
    Object.freeze(connection)
    const ctx = new FakeContext({ connection, webServer: loopback })

    expect(() => apply(ctx as never)).not.toThrow()

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

    apply(ctx as never)

    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(infoSpy).toHaveBeenCalledOnce()
    expect(String(infoSpy.mock.calls[0]![0])).toBe(
      '[dsh-local-admission] local admission is active on loopback listener 127.0.0.1 — clients are treated as the owner principal',
    )
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

    apply(ctx as never)
    expect('peer' in connection.admit(request)).toBe(true)

    expect(ctx.cleanups).toHaveLength(1)
    ctx.cleanups[0]!()
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(Object.hasOwn(connection, 'authorizeConnect')).toBe(false)
  })

  it('never grants local admission on any failed preflight path', () => {
    const cases: Array<{
      connection: unknown
      stage: string
    }> = [
      {
        connection: undefined,
        stage: 'connection',
      },
      {
        connection: {
          peers: new Map(),
          isTrusted: () => true,
          publishPeer: () => 'p',
        },
        stage: 'connection.admit',
      },
    ]

    for (const testCase of cases) {
      captureConsole()
      const ctx = new FakeContext({
        connection: testCase.connection,
        webServer: loopback,
      })
      expect(() => apply(ctx as never)).not.toThrow()
      expectActivationSkipped(testCase.stage)
      expect(ctx.cleanups).toHaveLength(0)
      vi.restoreAllMocks()
    }
  })
})

describe('non-loopback listeners', () => {
  const lan = { host: '192.168.1.92' }

  it('admits unauthenticated requests on a LAN listener and warns once', () => {
    captureConsole()
    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: lan })

    apply(ctx as never)

    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnMessages()).toHaveLength(1)
    expect(warnMessages()[0]).toContain(
      '[dsh-local-admission] WARNING: local admission is active on non-loopback listener 192.168.1.92',
    )
    expect(warnMessages()[0]).toContain(
      'clients that can reach this port are treated as the owner principal',
    )
    expect(infoSpy).toHaveBeenCalledOnce()
    expect(String(infoSpy.mock.calls[0]![0])).toContain(
      'non-loopback listener 192.168.1.92 — local admission is active',
    )
    expect(Object.hasOwn(connection, 'admit')).toBe(true)
    expect('peer' in connection.admit(request)).toBe(true)
    expect(ctx.cleanups).toHaveLength(1)

    ctx.cleanups[0]!()
    expect(Object.hasOwn(connection, 'admit')).toBe(false)
    expect(connection.admit(request)).toEqual({ rejection: 401 })
  })

  it('does not special-case wildcard binds: the plugin admits them too', () => {
    // dsh itself refuses `--host 0.0.0.0`, so this cannot happen through the
    // CLI. The plugin makes no listener-address decision either way; the
    // warning still names the address.
    for (const host of ['0.0.0.0', '::']) {
      captureConsole()
      const connection = new FakeConnection()
      const ctx = new FakeContext({ connection, webServer: { host } })

      apply(ctx as never)

      expect(errorMessages()).toHaveLength(0)
      expect(warnMessages()).toHaveLength(1)
      expect(warnMessages()[0]).toContain(`non-loopback listener ${host}`)
      expect(Object.hasOwn(connection, 'admit')).toBe(true)
      expect('peer' in connection.admit(request)).toBe(true)
      expect(ctx.cleanups).toHaveLength(1)
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

  it('never calls the stock admit even when the request looks authenticated', () => {
    captureConsole()
    const connection = new FakeConnection()
    connection.authenticated = { id: 'browser-peer' }
    const stockAdmit = vi.spyOn(FakeConnection.prototype, 'admit')
    const dispose = installed(connection)

    expect('peer' in connection.admit(crossOriginRequest)).toBe(true)
    expect(stockAdmit).not.toHaveBeenCalled()

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

    expect(() => apply(ctx as never)).not.toThrow()
    expect(Object.getOwnPropertySymbols(connection)).toHaveLength(0)
    expect(ctx.cleanups).toHaveLength(0)
  })

  it('keeps the wrapper from throwing when console.error throws at request time', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('log sink exploded')
    })

    const connection = new FakeConnection()
    connection.publishPeer = () => {
      throw new Error('publish exploded')
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

    expect(() => apply(ctx as never)).not.toThrow()
    expect(Object.hasOwn(connection, 'admit')).toBe(true)
    expect('peer' in connection.admit(request)).toBe(true)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('keeps the patch active when console.warn throws on a non-loopback install', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('log sink exploded')
    })

    const connection = new FakeConnection()
    const ctx = new FakeContext({ connection, webServer: { host: '192.168.1.92' } })

    expect(() => apply(ctx as never)).not.toThrow()
    expect(Object.hasOwn(connection, 'admit')).toBe(true)
    expect('peer' in connection.admit(request)).toBe(true)
    expect(ctx.cleanups).toHaveLength(1)
  })
})
