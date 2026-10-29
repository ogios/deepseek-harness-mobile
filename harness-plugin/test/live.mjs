/**
 * Boot a real @deepseek-ai/dsh web profile with this plugin installed.
 *
 * The transcription command is a stub. The balance endpoint is a local mock:
 * one boot checks a successful cached lookup, and a second boot checks a
 * failed lookup that must not echo the API key.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dsh = process.env.DSH_BIN ?? 'dsh'
const SECRET = 'sk-CANARY-DO-NOT-LEAK'
const TRANSCRIPT = '你好 hello'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function mockBalance() {
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    const auth = req.headers.authorization ?? ''
    if (req.url === '/fail') {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(`upstream echoed ${auth}`)
      return
    }
    if (!auth.startsWith('Bearer ')) {
      res.writeHead(401)
      res.end('missing authorization')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '12.50', granted_balance: '0.50', topped_up_balance: '12.00' },
      ],
    }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        hits: () => hits,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

async function cookieFor(base, token) {
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? '']
  const pairs = cookies.map(value => value.split(';', 1)[0]).filter(value => value.includes('='))
  assert(pairs.length > 0, `token exchange set no cookie (HTTP ${response.status})`)
  return pairs.join('; ')
}

function waitForReady(child) {
  let logs = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`harness did not print a token\n${logs}`))
    }, 90_000)
    const take = (chunk) => {
      logs += chunk.toString('utf8')
      const match = logs.match(/https?:\/\/[^\s]*\?token=([^\s&]+)/)
      if (match === null) return
      clearTimeout(timer)
      const url = new URL(match[0])
      resolve({
        base: url.origin,
        token: url.searchParams.get('token') ?? match[1],
        logs: () => logs,
      })
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`harness exited ${code} before ready\n${logs}`))
    })
  })
}

async function boot(home, extraEnv) {
  const child = spawn(dsh, ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    env: { ...process.env, DSH_HOME: home, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const ready = await waitForReady(child)
    return {
      child,
      base: ready.base,
      token: ready.token,
      logs: () => {
        // waitForReady closed over the growing string; keep reading.
        return ready.logs()
      },
    }
  } catch (error) {
    child.kill('SIGTERM')
    throw error
  }
}

async function stop(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 5_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

const home = await mkdtemp(join(tmpdir(), 'dsh-companion-home-'))
const work = await mkdtemp(join(tmpdir(), 'dsh-companion-work-'))
const stub = join(work, 'stub.mjs')
await writeFile(stub, `
import { readFileSync } from 'node:fs'
const wav = process.argv[2]
const bytes = readFileSync(wav)
if (bytes.subarray(0, 4).toString() !== 'RIFF') {
  console.error('not a wav')
  process.exit(2)
}
const channels = bytes.readUInt16LE(22)
const rate = bytes.readUInt32LE(24)
if (channels !== 1 || rate !== 16000) {
  console.error('expected 16 kHz mono, got ' + rate + ' ' + channels)
  process.exit(3)
}
process.stdout.write(JSON.stringify({ text: ${JSON.stringify(TRANSCRIPT)} }))
`)
const sample = join(work, 'sample.wav')
const made = spawnSync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=0.25',
  '-ac', '1', sample,
], { stdio: 'ignore' })
assert(made.status === 0, 'ffmpeg could not make a sample')
const sampleBytes = await readFile(sample)

const mock = await mockBalance()
const added = spawnSync(dsh, ['plugin', '--profile', 'web', 'add', root], {
  env: { ...process.env, DSH_HOME: home },
  encoding: 'utf8',
})
if (added.status !== 0) {
  throw new Error(`dsh plugin add failed\n${added.stdout}\n${added.stderr}`)
}

await mkdir(home, { recursive: true })
await writeFile(join(home, '.env'), `DEEPSEEK_API_KEY=${SECRET}\n`)

let session
try {
  session = await boot(home, {
    DSH_MOBILE_TRANSCRIBE_COMMAND: `node ${JSON.stringify(stub)} {wav}`,
    DSH_MOBILE_BALANCE_URL: `${mock.url}/balance`,
  })
  const cookie = await cookieFor(session.base, session.token)

  const anonymous = await fetch(`${session.base}/api/dshMobile/balance`)
  assert(anonymous.status === 401, `unauthenticated balance was HTTP ${anonymous.status}, expected 401`)

  const first = await fetch(`${session.base}/api/dshMobile/balance`, { headers: { cookie } })
  const firstBody = await first.text()
  assert(first.status === 200, `balance HTTP ${first.status}: ${firstBody}`)
  const firstJson = JSON.parse(firstBody)
  assert(firstJson.ok === true, `balance not ok: ${firstBody}`)
  assert(firstJson.currency === 'CNY', `currency ${firstJson.currency}`)
  assert(firstJson.balances?.[0]?.total === '12.50', `total ${firstJson.balances?.[0]?.total}`)
  assert(!firstBody.includes(SECRET), 'balance response contained the API key')
  assert(mock.hits() === 1, `expected one upstream balance call, saw ${mock.hits()}`)

  const second = await fetch(`${session.base}/api/dshMobile/balance`, { headers: { cookie } })
  const secondJson = await second.json()
  assert(secondJson.ok === true, 'cached balance was not ok')
  assert(mock.hits() === 1, `cache missed; upstream calls ${mock.hits()}`)

  const transcribed = await fetch(`${session.base}/api/dshMobile/transcribe`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'audio/wav' },
    body: sampleBytes,
  })
  const transcribedBody = await transcribed.text()
  assert(transcribed.status === 200, `transcribe HTTP ${transcribed.status}: ${transcribedBody}`)
  const transcribedJson = JSON.parse(transcribedBody)
  assert(transcribedJson.ok === true, `transcribe not ok: ${transcribedBody}`)
  assert(transcribedJson.text === TRANSCRIPT, `transcript ${JSON.stringify(transcribedJson.text)}`)

  const logs = session.logs()
  assert(!logs.includes(SECRET), 'harness log contained the API key')
  assert(!logs.includes(TRANSCRIPT), 'harness log contained the transcript')
  assert(!logs.includes('RIFF'), 'harness log contained audio bytes')
} finally {
  if (session !== undefined) await stop(session.child)
}

const hitsAfterSuccess = mock.hits()
let failed
try {
  failed = await boot(home, {
    DSH_MOBILE_TRANSCRIBE_COMMAND: `node ${JSON.stringify(stub)} {wav}`,
    DSH_MOBILE_BALANCE_URL: `${mock.url}/fail`,
    DEEPSEEK_API_KEY: SECRET,
  })
  const cookie = await cookieFor(failed.base, failed.token)
  const response = await fetch(`${failed.base}/api/dshMobile/balance`, { headers: { cookie } })
  const body = await response.text()
  assert(response.status === 200, `failed balance HTTP ${response.status}: ${body}`)
  const json = JSON.parse(body)
  assert(json.ok === false, `failed balance was ok: ${body}`)
  assert(typeof json.error?.message === 'string' && json.error.message.length > 0, `no error message: ${body}`)
  assert(!body.includes(SECRET), `failed balance leaked the key: ${body}`)
  assert(body.includes('[redacted]'), `failed balance did not redact the echoed key: ${body}`)
  assert(mock.hits() > hitsAfterSuccess, 'failed balance did not reach the mock')
  const logs = failed.logs()
  assert(!logs.includes(SECRET), 'failure log contained the API key')
} finally {
  if (failed !== undefined) await stop(failed.child)
  await mock.close()
  await rm(home, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
}

console.log('live harness companion test passed')
