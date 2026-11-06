/**
 * Pure loopback classification for a bind address / URL host.
 *
 * The plugin must never widen the trust boundary by accident, so this predicate is
 * deliberately strict: only `localhost`, IPv4 `127/8`, IPv6 `::1`, and
 * IPv4-mapped loopback literals count. Wildcard addresses (`0.0.0.0`, `::`),
 * link-local, and any routable address are rejected.
 */

const DOTTED_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const EXPANDED_IPV6_LOOPBACK = /^(?:0{1,4}:){7}0{0,3}1$/
const IPV4_MAPPED_PREFIX = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/

/**
 * Whether a host names the local loopback authority.
 *
 * Accepts bracketed IPv6 literals and `%zone` suffixes because both forms can
 * reach the plugin through CLI/config input.
 *
 * @param host - bind address or URL host.
 * @returns true only for a loopback authority.
 */
export function isLoopbackHost(host: string): boolean {
  if (typeof host !== 'string') return false

  let value = host.trim().toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)

  const zone = value.indexOf('%')
  if (zone !== -1) value = value.slice(0, zone)

  if (value === '') return false
  if (value === 'localhost') return true
  if (value === '::1') return true
  if (EXPANDED_IPV6_LOOPBACK.test(value)) return true

  const mapped = IPV4_MAPPED_PREFIX.exec(value)
  if (mapped !== null) return isLoopbackIPv4(mapped[1]!)

  return isLoopbackIPv4(value)
}

/** Validate a dotted-quad literal and require its first octet to be 127. */
function isLoopbackIPv4(value: string): boolean {
  const match = DOTTED_QUAD.exec(value)
  if (match === null) return false
  for (let index = 1; index <= 4; index += 1) {
    const octet = Number(match[index])
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return false
  }
  return Number(match[1]) === 127
}
