/**
 * `dsh-connection-anonymous` — PoC plugin.
 *
 * When `trustLoopback` is enabled and the web listener binds a loopback
 * address, unauthenticated requests that pass the Host/Origin fence are
 * admitted as one shared owner Peer with `interactions: 'answer'`. Nothing is
 * forked and no official package is modified: the patch lands on the live
 * `connection` service instance at plugin apply time.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installAnonymousAdmit, type PatchableConnection } from './admit.js'
import { isLoopbackHost } from './guard.js'

export { installAnonymousAdmit } from './admit.js'
export type { Admission, InstallOptions, PatchableConnection, PeerLike } from './admit.js'
export { isLoopbackHost } from './guard.js'

/** Stable Cordis plugin name. */
export const name = 'connection-anonymous'

/** Services that must be live before the patch can be evaluated. */
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

/**
 * Install or remove the admission override for this plugin fiber.
 *
 * @param ctx - plugin context with `connection` and `webServer` injected.
 * @param config - resolved plugin config (schema defaults applied).
 * @throws when `trustLoopback` is enabled on a non-loopback listener: an
 *   anonymous owner Peer equals full local authority, so the plugin refuses to
 *   activate. The Cordis loader records the failed entry and keeps dsh running
 *   with its stock token authentication — there is no anonymous entry point.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.trustLoopback) return

  const webServer = ctx.get('webServer') as unknown as WebServerLike | undefined
  const host = webServer?.host
  if (typeof host !== 'string' || !isLoopbackHost(host)) {
    const message =
      `[dsh-connection-anonymous] refusing to activate: trustLoopback requires a loopback listener (got ${
        typeof host === 'string' ? host : String(host)
      })`
    console.error(message)
    throw new Error(message)
  }

  const connection = ctx.get('connection') as unknown as
    | PatchableConnection
    | undefined
  if (connection === undefined) {
    throw new Error('[dsh-connection-anonymous] connection service is unavailable')
  }

  ctx.effect(() => {
    console.info(
      `[dsh-connection-anonymous] loopback listener ${host}: anonymous requests are admitted as an owner peer`,
    )
    return installAnonymousAdmit(connection)
  }, 'connection-anonymous: connection.admit override')
}
