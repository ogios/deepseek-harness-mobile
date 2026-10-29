import { createHash } from 'node:crypto'

/** One currency row from `GET /user/balance`. Amounts stay strings, as the API sends them. */
export interface BalanceLine {
  readonly currency: string
  readonly total: string
  readonly granted: string
  readonly toppedUp: string
}

export interface BalanceSnapshot {
  readonly currency: string
  readonly available: boolean
  readonly balances: readonly BalanceLine[]
}

export class BalanceFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BalanceFailure'
  }
}

/** Remove the key if a transport error quoted it. */
export function redactSecret(text: string, secret: string): string {
  if (secret === '') return text
  return text.split(secret).join('[redacted]')
}

function field(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

/**
 * Map the DeepSeek balance document onto the shape the phone renders.
 *
 * Accepts the documented snake_case fields and the camelCase equivalents.
 */
export function parseBalancePayload(body: unknown): BalanceSnapshot {
  if (body === null || typeof body !== 'object') {
    throw new BalanceFailure('bad-balance', 'Balance response was not an object')
  }
  const root = body as Record<string, unknown>
  const infos = root.balance_infos ?? root.balanceInfos
  if (!Array.isArray(infos)) throw new BalanceFailure('bad-balance', 'Balance response had no balances')
  const balances: BalanceLine[] = []
  for (const row of infos) {
    if (row === null || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const currency = field(record, 'currency')
    if (currency === undefined) continue
    balances.push({
      currency,
      total: field(record, 'total_balance', 'totalBalance') ?? '0',
      granted: field(record, 'granted_balance', 'grantedBalance') ?? '0',
      toppedUp: field(record, 'topped_up_balance', 'toppedUpBalance') ?? '0',
    })
  }
  if (balances.length === 0) throw new BalanceFailure('bad-balance', 'Balance response had no balances')
  const available = root.is_available !== false && root.isAvailable !== false
  return { currency: balances[0].currency, available, balances }
}

export interface BalanceRequest {
  readonly key: string | undefined
  readonly url: string
  readonly timeoutMs: number
  readonly cacheMs: number
  readonly now?: () => number
  readonly fetchImpl?: typeof fetch
}

interface CacheEntry {
  readonly fingerprint: string
  readonly at: number
  readonly value: BalanceSnapshot
}

/**
 * Cached balance lookup.
 *
 * Successful responses are reused for [cacheMs]. Failures are not cached.
 * The key is hashed for the cache identity and is never stored or returned.
 */
export class BalanceCache {
  private entry: CacheEntry | null = null
  private flight: Promise<BalanceSnapshot> | null = null
  private flightFingerprint = ''

  async get(request: BalanceRequest): Promise<BalanceSnapshot> {
    const key = request.key?.trim() ?? ''
    if (key === '') {
      throw new BalanceFailure('missing-key', 'DEEPSEEK_API_KEY is not set in the harness environment')
    }
    const fingerprint = createHash('sha256').update(key).digest('hex')
    const now = (request.now ?? Date.now)()
    const cached = this.entry
    if (cached !== null && cached.fingerprint === fingerprint && now - cached.at < request.cacheMs) {
      return cached.value
    }
    if (this.flight !== null && this.flightFingerprint === fingerprint) return this.flight
    this.flightFingerprint = fingerprint
    const pending = this.load(request, key, fingerprint)
    this.flight = pending
    try {
      return await pending
    } finally {
      if (this.flight === pending) this.flight = null
    }
  }

  private async load(request: BalanceRequest, key: string, fingerprint: string): Promise<BalanceSnapshot> {
    const fetchImpl = request.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(request.url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${key}`,
        },
        signal: AbortSignal.timeout(request.timeoutMs),
      })
    } catch (error) {
      const message = redactSecret(error instanceof Error ? error.message : String(error), key)
      throw new BalanceFailure('balance-unavailable', message.slice(0, 300) || 'balance request failed')
    }
    const raw = await response.text()
    if (!response.ok) {
      const detail = redactSecret(raw, key).replace(/\s+/g, ' ').trim().slice(0, 200)
      const suffix = detail === '' ? '' : `: ${detail}`
      throw new BalanceFailure('balance-unavailable', `DeepSeek balance returned HTTP ${response.status}${suffix}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new BalanceFailure('bad-balance', 'DeepSeek balance was not JSON')
    }
    const value = parseBalancePayload(parsed)
    this.entry = { fingerprint, at: (request.now ?? Date.now)(), value }
    return value
  }
}
