import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompanionConfig } from './config.ts'
import { CommandFailure, runCommand } from './process.ts'

/** Failure the phone can show. Never carries audio bytes or the API key. */
export class TranscribeFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'TranscribeFailure'
  }
}

const AUDIO_PREFIXES = ['audio/', 'video/mp4', 'video/3gpp', 'video/webm', 'application/ogg', 'application/octet-stream']

/**
 * Whether the upload's media type is audio we will hand to ffmpeg.
 *
 * A missing type is accepted: some clients send raw bytes. JSON and text are
 * refused so a mistaken RPC body is not written to disk as a recording.
 */
export function acceptsAudioType(contentType: string | null): boolean {
  if (contentType === null || contentType.trim() === '') return true
  const media = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return AUDIO_PREFIXES.some(prefix => media === prefix || (prefix.endsWith('/') && media.startsWith(prefix)))
}

/**
 * Substitute `{wav}` with a shell-quoted path.
 *
 * The command string is the operator's. The path is ours, and it is the only
 * value interpolated, so a recording cannot change what runs.
 */
export function renderCommand(template: string, wavPath: string): string {
  if (!template.includes('{wav}')) {
    throw new TranscribeFailure('bad-command', 'Transcription command must include {wav}')
  }
  const quoted = `'${wavPath.replaceAll("'", `'\\''`)}'`
  return template.split('{wav}').join(quoted)
}

/**
 * Pull the transcript out of a command's stdout.
 *
 * Handy `--json` prints one object with a `text` field. A stub may print that
 * object or plain text. A JSON object with no text field is an error, so the
 * phone does not insert the raw object into the draft.
 */
export function transcriptFromOutput(stdout: string): string {
  const trimmed = stdout.trim()
  if (trimmed === '') return ''
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    throw new TranscribeFailure('bad-transcript', 'Transcription command did not return JSON')
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of ['text', 'transcript', 'transcription']) {
      const field = record[key]
      if (typeof field === 'string') return field
    }
  }
  throw new TranscribeFailure('bad-transcript', 'Transcription JSON had no text field')
}

async function writeBody(request: Request, dest: string, maxBytes: number): Promise<number> {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) {
    throw new TranscribeFailure('too-large', `Audio is larger than ${maxBytes} bytes`)
  }
  const body = request.body
  if (body === null) throw new TranscribeFailure('empty-audio', 'The upload had no audio')
  const reader = body.getReader()
  const handle = await open(dest, 'w')
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new TranscribeFailure('too-large', `Audio is larger than ${maxBytes} bytes`)
      }
      await handle.write(value)
    }
  } finally {
    await handle.close()
  }
  if (total === 0) throw new TranscribeFailure('empty-audio', 'The upload had no audio')
  return total
}

function publicDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/**
 * Store the upload, convert it to 16 kHz mono WAV, and run the configured command.
 *
 * Temporary files are removed before this returns, including on failure. Nothing
 * about the audio bytes or the transcript is written to [log].
 */
export async function transcribeRequest(
  request: Request,
  config: CompanionConfig,
  log: (message: string) => void,
): Promise<string> {
  if (!acceptsAudioType(request.headers.get('content-type'))) {
    throw new TranscribeFailure('unsupported-type', 'Upload must be an audio file')
  }
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-'))
  const started = Date.now()
  try {
    const input = join(dir, 'upload.bin')
    const wav = join(dir, 'speech.wav')
    const bytes = await writeBody(request, input, config.maxUploadBytes)
    try {
      await runCommand(config.ffmpegPath, [
        '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
        '-i', input,
        '-ac', '1',
        '-ar', '16000',
        '-c:a', 'pcm_s16le',
        wav,
      ], config.ffmpegTimeoutMs, false)
    } catch (error) {
      const code = error instanceof CommandFailure && error.code === 'timeout' ? 'convert-timeout' : 'convert-failed'
      throw new TranscribeFailure(code, `ffmpeg failed: ${publicDetail(error)}`)
    }
    let stdout: string
    try {
      const result = await runCommand(renderCommand(config.transcribeCommand, wav), [], config.transcribeTimeoutMs, true)
      stdout = result.stdout
    } catch (error) {
      const code = error instanceof CommandFailure && error.code === 'timeout' ? 'transcribe-timeout' : 'transcribe-failed'
      throw new TranscribeFailure(code, publicDetail(error))
    }
    const text = transcriptFromOutput(stdout)
    log(`transcribe ok bytes=${bytes} ms=${Date.now() - started}`)
    return text
  } catch (error) {
    if (error instanceof TranscribeFailure) log(`transcribe failed code=${error.code}`)
    else log('transcribe failed code=internal')
    throw error
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
