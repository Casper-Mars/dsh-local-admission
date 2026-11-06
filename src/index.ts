/**
 * `dsh-connection-anonymous` — PoC plugin.
 *
 * When `trustLoopback` is enabled and the web listener binds a loopback
 * address, unauthenticated requests that pass the Host/Origin fence are
 * admitted as one shared owner Peer with `interactions: 'answer'`. Nothing is
 * forked and no official package is modified: the patch lands on the live
 * `connection` service instance at plugin apply time.
 *
 * Robustness contract: `apply` never throws. Every failed preflight check logs
 * one `activation skipped` line explaining which member broke and leaves the
 * plugin inactive, so the dsh loader never records a failed entry and dsh keeps
 * serving with its stock token authentication.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  LOG_PREFIX,
  activationSkipped,
  describeError,
  installAnonymousAdmit,
  probeConnection,
} from './admit.js'
import { isLoopbackHost } from './guard.js'

export { installAnonymousAdmit } from './admit.js'
export type { Admission, InstallOptions, PatchableConnection, PeerLike } from './admit.js'
export { isLoopbackHost } from './guard.js'

/** Stable Cordis plugin name. */
export const name = 'connection-anonymous'

/**
 * Services read by the plugin.
 *
 * Cordis 4.0.5 only supports a flat required-services list (no
 * `required`/`optional` split), so both stay declared here. If `webServer`
 * disappears entirely the fiber simply never activates — dsh is unaffected.
 * A missing member is still handled defensively below for callers that invoke
 * `apply` directly and for partial service implementations.
 */
export const inject = ['connection', 'webServer']

/** Plugin configuration. */
export interface Config {
  /**
   * Admit unauthenticated loopback requests as an anonymous owner Peer.
   * Defaults to `false`, which leaves the stock 401 behaviour untouched.
   */
  trustLoopback: boolean
}

export const Config: z<Config> = z.object({
  trustLoopback: z.boolean().default(false),
})

/** The only `webServer` member this plugin reads. */
interface WebServerLike {
  readonly host?: string
}

/** Setup callback accepted by `ctx.effect`. */
type EffectSetup = () => (() => void) | void
type EffectMethod = (setup: EffectSetup, label?: string) => unknown

/**
 * Install or remove the admission override for this plugin fiber.
 *
 * Never throws: any failure is logged with the stage that caused it and the
 * plugin stays inactive, leaving dsh on its stock token authentication.
 *
 * @param ctx - plugin context with `connection` and `webServer` injected.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config: Config): void {
  try {
    activate(ctx, config)
  } catch (error) {
    // Last-resort guard: no plugin failure may reach the dsh loader.
    console.error(activationSkipped('unexpected', describeError(error)))
  }
}

function activate(ctx: Context, config: Config): void {
  if (config?.trustLoopback !== true) return

  const skip = (stage: string, detail: string): void => {
    console.error(activationSkipped(stage, detail))
  }

  // 1. webServer lookup itself can throw on a partially initialized context.
  let webServer: unknown
  try {
    webServer = ctx.get('webServer')
  } catch (error) {
    skip("ctx.get('webServer')", describeError(error))
    return
  }
  if (webServer === null || webServer === undefined) {
    skip('webServer', 'service is unavailable')
    return
  }

  // 2. The listener address decides whether anonymous admission is allowed.
  let host: unknown
  try {
    host = (webServer as WebServerLike).host
  } catch (error) {
    skip('webServer.host', describeError(error))
    return
  }
  if (typeof host !== 'string' || host === '') {
    skip(
      'webServer.host',
      `expected a non-empty string, got ${typeof host} (${String(host)})`,
    )
    return
  }
  if (!isLoopbackHost(host)) {
    skip(
      'webServer.host',
      `trustLoopback requires a loopback listener (got ${host})`,
    )
    return
  }

  // 3. connection lookup + structural probe.
  let connection: unknown
  try {
    connection = ctx.get('connection')
  } catch (error) {
    skip("ctx.get('connection')", describeError(error))
    return
  }
  if (connection === null || connection === undefined) {
    skip('connection', 'service is unavailable')
    return
  }

  const probe = probeConnection(connection)
  if (!probe.ok) {
    skip(probe.stage, probe.detail)
    return
  }

  // 4. `ctx.effect` owns the disposer; refuse to patch without it.
  const effect = (ctx as unknown as { effect?: unknown }).effect
  if (typeof effect !== 'function') {
    skip('ctx.effect', `expected a function, got ${typeof effect}`)
    return
  }

  let uninstall: (() => void) | undefined
  try {
    ;(effect as EffectMethod).call(
      ctx,
      () => {
        uninstall = installAnonymousAdmit(probe.connection)
        return uninstall
      },
      'connection-anonymous: connection.admit override',
    )
  } catch (error) {
    // If the setup already ran, undo it rather than leaving a half-active patch.
    try {
      uninstall?.()
    } catch {
      // Disposers are themselves non-throwing; this is belt and braces.
    }
    skip('ctx.effect', describeError(error))
    return
  }

  try {
    console.info(
      `${LOG_PREFIX} loopback listener ${host}: anonymous requests are admitted as an owner peer`,
    )
  } catch (error) {
    try {
      uninstall?.()
    } catch {
      // Ignore: nothing else can be done.
    }
    skip('post-install', describeError(error))
  }
}
