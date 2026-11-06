#!/usr/bin/env node
/**
 * End-to-end proof that the runtime patch works.
 *
 * For both profiles we boot a real dsh web server on the same loopback port and
 * compare two unauthenticated transports:
 *   GET /api/__probe__   -> the `/api` HTTP admission gate
 *   GET /api/remote.mux  -> the WebSocket upgrade gate (admitConnection)
 *
 * Expected: `anon-off` rejects with 401 on both, `anon` passes both (404 for the
 * probe means "admitted, no such endpoint"; 101 means the upgrade was accepted).
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = join(projectRoot, '.dsh-home')
const dshBin = process.env.DSH_BIN ?? 'dsh'
const PORT = Number(process.env.POC_PORT ?? 18085)
const HOST = '127.0.0.1'
const START_TIMEOUT_MS = 90_000
const PROBE_TIMEOUT_MS = 5_000
const UPGRADE_TIMEOUT_MS = 20_000

const failures = []
const results = []

function log(message) {
  console.log(message)
}

function check(condition, message) {
  if (condition) {
    log(`  PASS  ${message}`)
  } else {
    log(`  FAIL  ${message}`)
    failures.push(message)
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** Boot one profile and resolve once the server prints its URL. */
async function boot(profile) {
  const child = spawn(
    dshBin,
    ['--profile', profile, '--no-open', '--port', String(PORT)],
    {
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let output = ''
  let exited
  const exitPromise = new Promise((resolvePromise) => {
    child.once('exit', (code, signal) => {
      exited = { code, signal }
      resolvePromise(exited)
    })
  })

  const ready = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`timed out waiting for "dsh web:" (${profile})`))
    }, START_TIMEOUT_MS)

    const onData = (chunk) => {
      const text = chunk.toString()
      output += text
      process.stdout.write(`  [${profile}] ${text.replace(/\n$/, '')}\n`)
      if (text.includes('dsh web:')) {
        clearTimeout(timer)
        resolvePromise()
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', () => {
      clearTimeout(timer)
      rejectPromise(
        new Error(`dsh exited before becoming ready (${profile}): ${JSON.stringify(exited)}`),
      )
    })
  })

  try {
    await ready
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }

  return {
    child,
    exitPromise,
    getOutput: () => output,
  }
}

async function stop(server) {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  const forced = setTimeout(() => server.child.kill('SIGKILL'), 10_000)
  await server.exitPromise
  clearTimeout(forced)
}

/** Plain no-cookie GET against the `/api` prefix. */
function probeStatus() {
  return new Promise((resolvePromise) => {
    const req = request(
      { host: HOST, port: PORT, path: '/api/__probe__', method: 'GET' },
      (res) => {
        res.resume()
        res.once('end', () => resolvePromise(res.statusCode))
      },
    )
    req.setTimeout(PROBE_TIMEOUT_MS, () => req.destroy(new Error('probe timeout')))
    req.once('error', () => resolvePromise(undefined))
    req.end()
  })
}

/** One WebSocket upgrade handshake, no cookie; resolves to the HTTP status. */
function upgradeStatus() {
  return new Promise((resolvePromise) => {
    const req = request({
      host: HOST,
      port: PORT,
      path: '/api/remote.mux',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
    })
    req.setTimeout(PROBE_TIMEOUT_MS, () => req.destroy(new Error('upgrade timeout')))
    req.once('upgrade', (res, socket) => {
      socket.destroy()
      resolvePromise(res.statusCode ?? 101)
    })
    req.once('response', (res) => {
      res.resume()
      resolvePromise(res.statusCode)
    })
    req.once('error', () => resolvePromise(undefined))
    req.end()
  })
}

/** The upgrade route appears only after `appReady`; retry until it answers. */
async function waitForUpgrade(profile, accept) {
  const deadline = Date.now() + UPGRADE_TIMEOUT_MS
  let status = await upgradeStatus()
  while (Date.now() < deadline) {
    if (accept(status)) return status
    await sleep(250)
    status = await upgradeStatus()
  }
  log(`  (${profile}) last upgrade status: ${status}`)
  return status
}

async function runProfile(profile, accept) {
  log(`\n=== ${profile} ===`)
  const server = await boot(profile)
  try {
    const http = await probeStatus()
    const ws = await waitForUpgrade(profile, accept)

    results.push({ profile, http, ws })
    log(`  status: GET /api/__probe__ = ${http}, GET /api/remote.mux (upgrade) = ${ws}`)
    return { http, ws, output: server.getOutput() }
  } finally {
    await stop(server)
  }
}

if (!existsSync(join(dshHome, 'profiles', 'anon'))) {
  console.error('[verify] .dsh-home is missing — run `pnpm setup` first')
  process.exit(1)
}

let anonOff
let anon
try {
  anonOff = await runProfile('anon-off', (status) => status === 401)
  check(anonOff.http === 401, `anon-off: GET /api/__probe__ is 401 (got ${anonOff.http})`)
  check(anonOff.ws === 401, `anon-off: GET /api/remote.mux upgrade is 401 (got ${anonOff.ws})`)

  anon = await runProfile('anon', (status) => status === 101)
  check(
    anon.http !== undefined && anon.http !== 401 && anon.http !== 403,
    `anon: GET /api/__probe__ passed admission (got ${anon.http}, expected 404)`,
  )
  check(anon.ws === 101, `anon: GET /api/remote.mux upgrade is 101 (got ${anon.ws})`)
  check(
    anon.output.includes('[dsh-bypass-web-token]'),
    'anon: plugin logged its loopback admission notice',
  )
} catch (error) {
  console.error(`[verify] ${error.stack ?? error}`)
  failures.push(String(error.message ?? error))
}

log('\n=== summary ===')
for (const row of results) {
  log(`  ${row.profile.padEnd(8)} probe=${String(row.http).padEnd(4)} upgrade=${row.ws}`)
}

if (failures.length > 0) {
  log(`\n[verify] FAILED (${failures.length})`)
  for (const failure of failures) log(`  - ${failure}`)
  process.exit(1)
}

log('\n[verify] OK: anon-off stays 401; anon is admitted on both transports')
