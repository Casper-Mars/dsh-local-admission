#!/usr/bin/env node
/**
 * Build an isolated dsh home for this PoC.
 *
 * Nothing here touches `~/.dsh`: the shipped `web` profile is only read and
 * copied into `./.dsh-home`, then the local package is linked into one profile:
 *
 *   anon       plugin installed  (active on whatever address is bound)
 *   anon-off   plugin NOT installed (control group, stock token auth)
 *
 * The plugin is zero-configuration and ships its own bundle patch, so
 * `dsh plugin add` is the only step: it registers the package in
 * `dsh.profile.bundles` and the bundle layer inserts the entry. The control
 * group simply does not install it.
 *
 * The profile list is deliberately address-agnostic: the plugin has no
 * listener-address admission rule, so the same `anon` profile is booted once on
 * loopback and once with `--host <LAN IP>` by `pnpm verify`. (`--host 0.0.0.0`
 * is rejected by dsh itself, so it is never used here.)
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = join(projectRoot, '.dsh-home')
const profilesDir = join(dshHome, 'profiles')
const template = join(homedir(), '.dsh', 'profiles', 'web')
const dshBin = process.env.DSH_BIN ?? 'dsh'
const pnpmBin = process.env.PNPM_BIN ?? 'pnpm'

/**
 * First non-internal IPv4 address, used by `pnpm verify` for the LAN cases.
 *
 * @returns the address, or undefined when the machine has no LAN interface.
 */
function detectLanIpv4() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return undefined
}

function fail(message) {
  console.error(`[setup] ${message}`)
  process.exit(1)
}

if (!existsSync(join(projectRoot, 'dist', 'index.js'))) {
  fail('dist/index.js is missing — run `pnpm build` first')
}
if (!existsSync(join(template, 'package.json'))) {
  fail(`template profile not found: ${template}`)
}
if (!existsSync(join(template, 'cordis.patch.yml'))) {
  fail(`template patch layer not found: ${template}/cordis.patch.yml`)
}

const lanIp = detectLanIpv4()
if (lanIp === undefined) {
  fail(
    'no non-internal IPv4 interface found — the LAN verification cases need a real LAN address to bind',
  )
}

rmSync(dshHome, { recursive: true, force: true })
mkdirSync(profilesDir, { recursive: true })

/**
 * Copy the template without `node_modules`: pnpm recreates it for the new
 * profile, and the template's relative symlinks would dangle at this depth.
 */
function copyProfile(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (source) => {
      const name = basename(source)
      return name !== 'node_modules' && name !== '.plugin-manager' && name !== '.DS_Store'
    },
  })
}

const anonDir = join(profilesDir, 'anon')
const anonOffDir = join(profilesDir, 'anon-off')

// Control group first: a plain copy of the stock profile with no plugin and
// no patch entry.
copyProfile(template, anonOffDir)
console.log(`[setup] copied ${template} -> ${anonOffDir} (no plugin)`)
console.log('[setup] installing anon-off profile dependencies')
execFileSync(pnpmBin, ['install', '--dir', anonOffDir], {
  stdio: 'inherit',
  env: { ...process.env, DSH_HOME: dshHome },
})

copyProfile(template, anonDir)
console.log(`[setup] copied ${template} -> ${anonDir}`)

console.log('[setup] linking dsh-local-admission into the anon profile')
execFileSync(dshBin, ['plugin', '--profile', 'anon', 'add', projectRoot], {
  stdio: 'inherit',
  env: { ...process.env, DSH_HOME: dshHome },
})

console.log('')
console.log(`[setup] DSH_HOME=${dshHome}`)
console.log(`[setup] LAN address: ${lanIp}`)
console.log('[setup] profiles ready: anon (plugin installed), anon-off (plugin absent)')
console.log(`[setup] try: DSH_HOME=${dshHome} ${dshBin} --profile anon --no-open --port 18085`)
console.log(
  `[setup] LAN: DSH_HOME=${dshHome} ${dshBin} --profile anon --host ${lanIp} --no-open --port 18086`,
)
