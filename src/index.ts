/**
 * `dsh-local-admission` — zero-configuration Cordis plugin.
 *
 * Installing the plugin is the switch: `apply` always tries to install the
 * local admission policy on the live `connection` service. Every request that
 * reaches the port is admitted as one shared owner Peer with
 * `interactions: 'answer'`, no matter which address the web listener binds.
 * The stock `admit` is never called and no `Host`/`Origin` check is performed.
 * Uninstalling the plugin restores the stock behaviour — there is nothing to
 * configure.
 *
 * There is no additional listener-address restriction: the bind address only
 * selects the wording of the activation log line, and a non-loopback listener
 * additionally gets a prominent warning because every client that can reach
 * the port is then treated as the owner principal.
 *
 * Nothing is forked and no official package is modified: the patch lands on the
 * live `connection` service instance at plugin apply time.
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
  installAnonymousAdmitResult,
  probeConnection,
  safeError,
  safeInfo,
  safeWarn,
} from './admit.js'
import { isLoopbackHost } from './guard.js'

export { installAnonymousAdmit, installAnonymousAdmitResult } from './admit.js'
export type {
  Admission,
  InstallOptions,
  InstallResult,
  PatchableConnection,
  PeerLike,
} from './admit.js'
export { isLoopbackHost } from './guard.js'

/** Stable Cordis plugin name. */
export const name = 'local-admission'

/**
 * Services read by the plugin.
 *
 * Only `connection` is required. `webServer` is read optionally for log
 * wording, so a missing or broken `webServer` service can never keep the
 * plugin from activating.
 */
export const inject = ['connection']

/**
 * Cordis requires a config schema export, but this plugin has no options.
 * The schema is deliberately empty: installing the plugin is the only switch.
 */
export const Config = z.object({})

/** The only `webServer` member this plugin reads (for log wording only). */
interface WebServerLike {
  readonly host?: unknown
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
 * @param ctx - plugin context with `connection` injected.
 * @param _config - ignored; the plugin has no options.
 */
export function apply(ctx: Context, _config?: Record<string, never>): void {
  void _config
  try {
    activate(ctx)
  } catch (error) {
    // Last-resort guard: no plugin failure may reach the dsh loader.
    safeError(activationSkipped('unexpected', describeError(error)))
  }
}

function activate(ctx: Context): void {
  const skip = (stage: string, detail: string): void => {
    safeError(activationSkipped(stage, detail))
  }

  // 1. connection lookup + structural probe. This is the only gate: if the
  //    members are present the plugin activates on any listener address.
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

  // 2. `ctx.effect` owns the disposer; refuse to patch without it.
  const effect = (ctx as unknown as { effect?: unknown }).effect
  if (typeof effect !== 'function') {
    skip('ctx.effect', `expected a function, got ${typeof effect}`)
    return
  }

  let installed = false
  let uninstall: (() => void) | undefined
  try {
    ;(effect as EffectMethod).call(
      ctx,
      () => {
        const result = installAnonymousAdmitResult(probe.connection)
        // A refused install must not hand a disposer to the fiber, otherwise
        // the effect lifecycle would imply a patch that never landed.
        if (!result.installed) return
        installed = true
        uninstall = result.dispose
        return result.dispose
      },
      'local-admission: connection.admit override',
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

  // Only report success when the override is really active. A refused install
  // has already logged its own `activation skipped` line, and a "skip" line
  // followed by a "success" line would be a lie.
  if (!installed) return

  // The listener address only selects the log wording.
  // `webServer` is optional and read defensively; a missing service or a
  // throwing getter simply means `unknown`, never a skipped activation.
  const host = readWebHost(ctx)
  if (host !== undefined && isLoopbackHost(host)) {
    safeInfo(
      `${LOG_PREFIX} local admission is active on loopback listener ${host} — clients are treated as the owner principal`,
    )
    return
  }

  safeWarn(
    `${LOG_PREFIX} WARNING: local admission is active on non-loopback listener ${host ?? 'unknown'} — clients that can reach this port are treated as the owner principal`,
  )
  safeInfo(
    `${LOG_PREFIX} non-loopback listener ${host ?? 'unknown'} — local admission is active`,
  )
}

/**
 * Read the bind address for log wording only.
 *
 * Best-effort by design: a missing `webServer` service, a throwing
 * `ctx.get('webServer')`, or a missing/non-string/throwing `host` must never
 * prevent activation, so the caller falls back to `unknown`.
 *
 * @param ctx - plugin context.
 * @returns the bind address, or `undefined` when it cannot be read.
 */
function readWebHost(ctx: Context): string | undefined {
  let webServer: unknown
  try {
    webServer = ctx.get('webServer')
  } catch {
    return undefined
  }
  if (webServer === null || webServer === undefined) return undefined

  try {
    const host = (webServer as WebServerLike).host
    return typeof host === 'string' && host !== '' ? host : undefined
  } catch {
    return undefined
  }
}
