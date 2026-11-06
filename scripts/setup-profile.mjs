#!/usr/bin/env node
/**
 * Build an isolated dsh home for this PoC.
 *
 * Nothing here touches `~/.dsh`: the shipped `web` profile is only read and
 * copied into `./.dsh-home`, then the local package is linked into two
 * profiles — `anon` (trustLoopback: true) and `anon-off` (trustLoopback:
 * false), the control group that must still answer 401.
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = join(projectRoot, '.dsh-home')
const profilesDir = join(dshHome, 'profiles')
const template = join(homedir(), '.dsh', 'profiles', 'web')
const dshBin = process.env.DSH_BIN ?? 'dsh'

/** `- insert` appends to the root entry list; the loader validates it. */
function patchEntry(trustLoopback) {
  return `- insert:
    - id: bypass-web-token
      name: dsh-bypass-web-token
      inject: ['connection', 'webServer']
      config:
        trustLoopback: ${trustLoopback ? 'true' : 'false'}
`
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

copyProfile(template, anonDir)
console.log(`[setup] copied ${template} -> ${anonDir}`)

console.log('[setup] linking dsh-bypass-web-token into the anon profile')
execFileSync(dshBin, ['plugin', '--profile', 'anon', 'add', projectRoot], {
  stdio: 'inherit',
  env: { ...process.env, DSH_HOME: dshHome },
})

const anonPatch = join(anonDir, 'cordis.patch.yml')
const originalPatch = readFileSync(anonPatch, 'utf8')
writeFileSync(anonPatch, `${originalPatch.trimEnd()}\n${patchEntry(true)}`, 'utf8')

// Control group: identical profile, trustLoopback turned off.
cpSync(anonDir, anonOffDir, { recursive: true, dereference: false })
const anonOffPatch = join(anonOffDir, 'cordis.patch.yml')
writeFileSync(
  anonOffPatch,
  readFileSync(anonOffPatch, 'utf8').replace(
    'trustLoopback: true',
    'trustLoopback: false',
  ),
  'utf8',
)

console.log('')
console.log(`[setup] DSH_HOME=${dshHome}`)
console.log('[setup] profiles ready: anon (trustLoopback: true), anon-off (trustLoopback: false)')
console.log(`[setup] try: DSH_HOME=${dshHome} ${dshBin} --profile anon --no-open --port 18085`)
