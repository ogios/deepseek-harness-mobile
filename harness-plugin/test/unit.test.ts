import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BalanceCache, parseBalancePayload, redactSecret } from '../lib/balance.js'
import { DEFAULTS, resolveConfig } from '../lib/config.js'
import { childEnv, runCommand } from '../lib/process.js'
import { acceptsAudioType, renderCommand, transcriptFromOutput, transcribeRequest } from '../lib/transcribe.js'

test('renderCommand quotes the wav path and nothing else', () => {
  assert.equal(
    renderCommand('handy --transcribe-file {wav} --json', '/tmp/speech.wav'),
    "handy --transcribe-file '/tmp/speech.wav' --json",
  )
  assert.equal(
    renderCommand('cmd {wav}', "/tmp/it's a file.wav"),
    `cmd '/tmp/it'\\''s a file.wav'`,
  )
  assert.throws(() => renderCommand('handy --json', '/tmp/a.wav'), /\{wav\}/)
})

test('transcriptFromOutput reads Handy JSON and plain text', () => {
  assert.equal(transcriptFromOutput('{"text":"你好 hello","load_ms":1}\n'), '你好 hello')
  assert.equal(transcriptFromOutput('{"transcript":"alt"}'), 'alt')
  assert.equal(transcriptFromOutput('  just words  '), 'just words')
  assert.equal(transcriptFromOutput(''), '')
  assert.throws(() => transcriptFromOutput('{"model":"qwen"}'), /no text/)
  assert.throws(() => transcriptFromOutput('{not json'), /not return JSON/)
})

test('acceptsAudioType allows audio and refuses json', () => {
  assert.equal(acceptsAudioType(null), true)
  assert.equal(acceptsAudioType('audio/mp4; codecs=mp4a'), true)
  assert.equal(acceptsAudioType('application/octet-stream'), true)
  assert.equal(acceptsAudioType('application/json'), false)
  assert.equal(acceptsAudioType('text/plain'), false)
})

test('resolveConfig fills defaults and unwraps volatile handles', () => {
  assert.equal(resolveConfig(undefined).transcribeCommand, DEFAULTS.transcribeCommand)
  const resolved = resolveConfig({
    transcribeCommand: { get: () => 'node stub.mjs {wav}' },
    balanceCacheMs: '1500',
  })
  assert.equal(resolved.transcribeCommand, 'node stub.mjs {wav}')
  assert.equal(resolved.balanceCacheMs, 1500)
  assert.equal(resolved.ffmpegPath, 'ffmpeg')
})

test('childEnv strips the DeepSeek key', () => {
  const env = childEnv({ PATH: '/usr/bin', DEEPSEEK_API_KEY: 'sk-secret', HOME: '/home/me' })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/me')
  assert.equal('DEEPSEEK_API_KEY' in env, false)
})

test('parseBalancePayload maps the documented document', () => {
  const snapshot = parseBalancePayload({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '12.50', granted_balance: '0.50', topped_up_balance: '12.00' },
      { currency: 'USD', total_balance: '1.00', granted_balance: '0', topped_up_balance: '1.00' },
    ],
  })
  assert.equal(snapshot.currency, 'CNY')
  assert.equal(snapshot.available, true)
  assert.equal(snapshot.balances[0].toppedUp, '12.00')
  assert.equal(snapshot.balances[1].total, '1.00')
})

test('redactSecret removes the key from an error string', () => {
  assert.equal(redactSecret('failed for sk-secret token', 'sk-secret'), 'failed for [redacted] token')
})

test('BalanceCache reuses a success and retries a failure', async () => {
  const cache = new BalanceCache()
  let calls = 0
  let now = 1_000
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls += 1
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    assert.equal(auth.includes('sk-cached'), true)
    return new Response(JSON.stringify({
      is_available: false,
      balance_infos: [{ currency: 'USD', total_balance: '3', granted_balance: '0', topped_up_balance: '3' }],
    }), { status: 200 })
  }
  const first = await cache.get({
    key: 'sk-cached', url: 'http://balance.test/user/balance', timeoutMs: 1000, cacheMs: 60_000,
    now: () => now, fetchImpl,
  })
  now += 1_000
  const second = await cache.get({
    key: 'sk-cached', url: 'http://balance.test/user/balance', timeoutMs: 1000, cacheMs: 60_000,
    now: () => now, fetchImpl,
  })
  assert.equal(calls, 1)
  assert.equal(second.balances[0].total, first.balances[0].total)
  assert.equal(second.available, false)

  const failing = new BalanceCache()
  let fails = 0
  const failFetch: typeof fetch = async () => {
    fails += 1
    return new Response('sk-fail leaked', { status: 500 })
  }
  await assert.rejects(
    () => failing.get({ key: 'sk-fail', url: 'http://balance.test/x', timeoutMs: 1000, cacheMs: 60_000, fetchImpl: failFetch }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true)
      assert.equal(String((error as Error).message).includes('sk-fail'), false)
      return true
    },
  )
  await assert.rejects(
    () => failing.get({ key: 'sk-fail', url: 'http://balance.test/x', timeoutMs: 1000, cacheMs: 60_000, fetchImpl: failFetch }),
    /HTTP 500/,
  )
  assert.equal(fails, 2)
  await assert.rejects(
    () => failing.get({ key: '  ', url: 'http://balance.test/x', timeoutMs: 1000, cacheMs: 60_000, fetchImpl: failFetch }),
    /DEEPSEEK_API_KEY/,
  )
})

test('runCommand times out and does not keep the child', async () => {
  await assert.rejects(
    () => runCommand('sleep', ['30'], 200, false),
    (error: unknown) => error instanceof Error && error.message.includes('timed out'),
  )
})

test('transcribeRequest converts audio and deletes its temp dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-fixture-'))
  const source = join(dir, 'in.wav')
  const stub = join(dir, 'stub.mjs')
  await writeFile(stub, `
    import { readFileSync } from 'node:fs'
    const wav = process.argv[2]
    const bytes = readFileSync(wav)
    if (bytes.subarray(0, 4).toString() !== 'RIFF') process.exit(2)
    const channels = bytes.readUInt16LE(22)
    const rate = bytes.readUInt32LE(24)
    if (channels !== 1 || rate !== 16000) {
      console.error('bad ' + rate + ' ' + channels)
      process.exit(3)
    }
    process.stdout.write(JSON.stringify({ text: '你好 hello' }))
  `)
  const made = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=0.2',
    '-ac', '2', source,
  ], { stdio: 'ignore' })
  assert.equal(made.status, 0)
  const bytes = await readFile(source)
  const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('dsh-mobile-')))
  const text = await transcribeRequest(new Request('http://dsh.internal/api/dshMobile/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: bytes,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' }), {
    ...DEFAULTS,
    transcribeCommand: `node ${JSON.stringify(stub)} {wav}`,
  }, () => {})
  assert.equal(text, '你好 hello')
  const after = readdirSync(tmpdir()).filter(name => name.startsWith('dsh-mobile-') && !before.has(name))
  assert.deepEqual(after, [])
  await rm(dir, { recursive: true, force: true })
})

test('a non-audio upload is refused before ffmpeg', async () => {
  await assert.rejects(
    () => transcribeRequest(new Request('http://dsh.internal/api/dshMobile/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}'),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }), DEFAULTS, () => {}),
    /audio file/,
  )
})
