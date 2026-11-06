#!/usr/bin/env node
/**
 * End-to-end proof that the runtime patch works.
 *
 * Two profiles are booted on two addresses each — four boots in total:
 *
 *   loopback anon-off  401/401/401 (stock token auth)
 *   loopback anon      200/404/101 (UI + API admitted, info line, no warning)
 *   LAN      anon-off  401/401/401 (stock token auth, no warning)
 *   LAN      anon      200/404/101 (UI + API admitted, WARNING logged)
 *
 * `anon` has the plugin installed (no config, installing is the switch);
 * `anon-off` is a plain profile without the plugin. Each boot compares three
 * unauthenticated entry points:
 *   GET /                -> the web UI shell (connection.authorizeIndex)
 *   GET /api/__probe__   -> the `/api` HTTP admission gate (connection.admit)
 *   GET /api/remote.mux  -> the WebSocket upgrade gate (admitConnection)
 *
 * `--host 0.0.0.0` is intentionally never used: dsh itself rejects wildcard
 * binds before the plugin is even loaded.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { request } from 'node:http'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = join(projectRoot, '.dsh-home')
const dshBin = process.env.DSH_BIN ?? 'dsh'
const LOOPBACK_PORT = Number(process.env.POC_LOOPBACK_PORT ?? 18085)
const LAN_PORT = Number(process.env.POC_LAN_PORT ?? 18086)
const LOOPBACK = '127.0.0.1'
const START_TIMEOUT_MS = 90_000
const PROBE_TIMEOUT_MS = 5_000
const UPGRADE_TIMEOUT_MS = 20_000

/** First non-internal IPv4 address, mirroring `pnpm setup`. */
function detectLanIpv4() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return undefined
}

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
async function boot(profile, host, port) {
  const args = ['--profile', profile, '--no-open', '--port', String(port)]
  if (host !== LOOPBACK) args.push('--host', host)

  const child = spawn(dshBin, args, {
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

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

/** Plain no-cookie GET of the web UI shell; returns status, type and body. */
function probeIndex(host, port) {
  return new Promise((resolvePromise) => {
    const req = request(
      { host, port, path: '/', method: 'GET', headers: { accept: 'text/html' } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          if (body.length < 4096) body += chunk
        })
        res.once('end', () =>
          resolvePromise({
            status: res.statusCode,
            contentType: String(res.headers['content-type'] ?? ''),
            body,
          }),
        )
      },
    )
    req.setTimeout(PROBE_TIMEOUT_MS, () => req.destroy(new Error('index timeout')))
    req.once('error', () =>
      resolvePromise({ status: undefined, contentType: '', body: '' }),
    )
    req.end()
  })
}

/** Plain no-cookie GET against the `/api` prefix. */
function probeStatus(host, port) {
  return new Promise((resolvePromise) => {
    const req = request(
      { host, port, path: '/api/__probe__', method: 'GET' },
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
function upgradeStatus(host, port) {
  return new Promise((resolvePromise) => {
    const req = request({
      host,
      port,
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
async function waitForUpgrade(profile, host, port, accept) {
  const deadline = Date.now() + UPGRADE_TIMEOUT_MS
  let status = await upgradeStatus(host, port)
  while (Date.now() < deadline) {
    if (accept(status)) return status
    await sleep(250)
    status = await upgradeStatus(host, port)
  }
  log(`  (${profile}) last upgrade status: ${status}`)
  return status
}

async function runProfile(profile, host, port, accept) {
  log(`\n=== ${profile} (${host}:${port}) ===`)
  const server = await boot(profile, host, port)
  try {
    // Wait for the WebSocket gate first: it is mounted later than the `/api`
    // route, so a successful (or 401) upgrade proves the app finished wiring
    // routes. Probing HTTP first can otherwise race the mount and yield a
    // spurious 404. Once the upgrade answers, the `/api` route is present.
    const ws = await waitForUpgrade(profile, host, port, accept)
    const http = await probeStatus(host, port)
    const index = await probeIndex(host, port)

    results.push({ profile, host, port, index: index.status, http, ws })
    log(
      `  status: GET / = ${index.status} (${index.contentType || 'no content-type'}), ` +
        `GET /api/__probe__ = ${http}, GET /api/remote.mux (upgrade) = ${ws}`,
    )
    return { index, http, ws, output: server.getOutput() }
  } finally {
    await stop(server)
  }
}

if (!existsSync(join(dshHome, 'profiles', 'anon'))) {
  console.error('[verify] .dsh-home is missing — run `pnpm setup` first')
  process.exit(1)
}

const lanIp = detectLanIpv4()
if (lanIp === undefined) {
  console.error('[verify] no non-internal IPv4 interface found — cannot run the LAN cases')
  process.exit(1)
}

try {
  // --- loopback -----------------------------------------------------------
  const loopbackOff = await runProfile(
    'anon-off',
    LOOPBACK,
    LOOPBACK_PORT,
    (status) => status === 401,
  )
  check(
    loopbackOff.index.status === 401 &&
      loopbackOff.index.body.includes('dsh web authentication required'),
    `loopback anon-off: GET / is 401 with the token notice (got ${loopbackOff.index.status})`,
  )
  check(
    loopbackOff.http === 401,
    `loopback anon-off: GET /api/__probe__ is 401 (got ${loopbackOff.http})`,
  )
  check(
    loopbackOff.ws === 401,
    `loopback anon-off: GET /api/remote.mux upgrade is 401 (got ${loopbackOff.ws})`,
  )
  check(
    !loopbackOff.output.includes('[dsh-bypass-web-token]'),
    'loopback anon-off: plugin stayed silent',
  )

  const loopbackOn = await runProfile(
    'anon',
    LOOPBACK,
    LOOPBACK_PORT,
    (status) => status === 101,
  )
  check(
    loopbackOn.index.status === 200 &&
      loopbackOn.index.contentType.includes('text/html') &&
      /<html[\s>]/i.test(loopbackOn.index.body),
    `loopback anon: GET / is 200 HTML (got ${loopbackOn.index.status}, ${loopbackOn.index.contentType})`,
  )
  check(
    loopbackOn.http === 404,
    `loopback anon: GET /api/__probe__ is 404 (admitted, got ${loopbackOn.http})`,
  )
  check(
    loopbackOn.ws === 101,
    `loopback anon: GET /api/remote.mux upgrade is 101 (got ${loopbackOn.ws})`,
  )
  check(
    loopbackOn.output.includes(
      `[dsh-bypass-web-token] loopback listener ${LOOPBACK}: anonymous requests are admitted as an owner peer`,
    ),
    'loopback anon: plugin logged the loopback admission notice',
  )
  check(
    !loopbackOn.output.includes('WARNING:'),
    'loopback anon: no non-loopback warning was logged',
  )

  // --- LAN ----------------------------------------------------------------
  const lanOff = await runProfile('anon-off', lanIp, LAN_PORT, (status) => status === 401)
  check(
    lanOff.index.status === 401 &&
      lanOff.index.body.includes('dsh web authentication required'),
    `LAN anon-off: GET / is 401 with the token notice on ${lanIp} (got ${lanOff.index.status})`,
  )
  check(
    lanOff.http === 401,
    `LAN anon-off: GET /api/__probe__ is 401 on ${lanIp} (got ${lanOff.http})`,
  )
  check(
    lanOff.ws === 401,
    `LAN anon-off: GET /api/remote.mux upgrade is 401 on ${lanIp} (got ${lanOff.ws})`,
  )
  check(
    !lanOff.output.includes('[dsh-bypass-web-token]'),
    'LAN anon-off: plugin stayed silent',
  )

  const lanOn = await runProfile('anon', lanIp, LAN_PORT, (status) => status === 101)
  check(
    lanOn.index.status === 200 &&
      lanOn.index.contentType.includes('text/html') &&
      /<html[\s>]/i.test(lanOn.index.body),
    `LAN anon: GET / is 200 HTML on ${lanIp} (got ${lanOn.index.status}, ${lanOn.index.contentType})`,
  )
  check(
    lanOn.http === 404,
    `LAN anon: GET /api/__probe__ is 404 (admitted, got ${lanOn.http})`,
  )
  check(
    lanOn.ws === 101,
    `LAN anon: GET /api/remote.mux upgrade is 101 (got ${lanOn.ws})`,
  )
  check(
    lanOn.output.includes('[dsh-bypass-web-token] WARNING:') &&
      lanOn.output.includes(`non-loopback listener ${lanIp}`),
    'LAN anon: plugin warned about non-loopback owner access',
  )
  check(
    !lanOn.output.includes('activation skipped'),
    'LAN anon: no activation skip was logged',
  )
} catch (error) {
  console.error(`[verify] ${error.stack ?? error}`)
  failures.push(String(error.message ?? error))
}

log('\n=== summary ===')
for (const row of results) {
  log(
    `  ${row.profile.padEnd(9)} ${row.host.padEnd(15)} :${String(row.port).padEnd(6)} index=${String(row.index).padEnd(4)} probe=${String(row.http).padEnd(4)} upgrade=${row.ws}`,
  )
}

if (failures.length > 0) {
  log(`\n[verify] FAILED (${failures.length})`)
  for (const failure of failures) log(`  - ${failure}`)
  process.exit(1)
}

log(
  '\n[verify] OK: loopback anon-off 401/401/401 vs anon 200/404/101; LAN anon-off 401/401/401 vs anon 200/404/101 with WARNING',
)
