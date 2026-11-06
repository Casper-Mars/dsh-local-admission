import { describe, expect, it } from 'vitest'
import { isLoopbackHost } from '../src/guard.js'

describe('isLoopbackHost', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    ' 127.0.0.1 ',
    '127.0.0.2',
    '127.255.255.254',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::ffff:127.9.9.9',
    '[::1%lo0]',
  ])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true)
  })

  it.each([
    '',
    '   ',
    '0.0.0.0',
    '::',
    '192.168.1.10',
    '10.0.0.5',
    '128.0.0.1',
    '126.0.0.1',
    '127.0.0.256',
    '127.0.0',
    '127.0.0.1.1',
    'example.com',
    'localhost.example.com',
    '::ffff:192.168.1.1',
    '[::ffff:10.0.0.1]',
    'fe80::1%lo0',
  ])('rejects %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false)
  })
})
