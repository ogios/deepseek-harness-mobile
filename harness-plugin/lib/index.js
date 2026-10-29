import z from '@deepseek-ai/schemastery';
import { BalanceCache, BalanceFailure } from "./balance.js";
import { DEFAULTS, resolveConfig } from "./config.js";
import { TranscribeFailure, transcribeRequest } from "./transcribe.js";
/** Stable Cordis plugin name. The patch row's `name` is the package name. */
export const name = 'mobileCompanion';
/**
 * `connection` mounts `/api` with the browser-session check. Fetch routes
 * registered on it run only after that check, so the phone's existing session
 * cookie (or the relay injecting it) is the only credential.
 */
export const inject = ['connection'];
export const Config = z.object({
    transcribeCommand: z.string().default(DEFAULTS.transcribeCommand)
        .description('Shell command that transcribes a 16 kHz mono WAV. {wav} is replaced with the quoted file path.'),
    transcribeTimeoutMs: z.natural().min(1_000).default(DEFAULTS.transcribeTimeoutMs)
        .description('How long the transcription command may run, in milliseconds.'),
    ffmpegPath: z.string().default(DEFAULTS.ffmpegPath)
        .description('ffmpeg executable used to convert uploads to 16 kHz mono WAV.'),
    ffmpegTimeoutMs: z.natural().min(1_000).default(DEFAULTS.ffmpegTimeoutMs)
        .description('How long ffmpeg may run, in milliseconds.'),
    maxUploadBytes: z.natural().min(1).default(DEFAULTS.maxUploadBytes)
        .description('Maximum accepted upload size, in bytes.'),
    balanceUrl: z.string().default(DEFAULTS.balanceUrl)
        .description('DeepSeek balance endpoint. Override only to point tests at a mock.'),
    balanceCacheMs: z.natural().default(DEFAULTS.balanceCacheMs)
        .description('How long a successful balance response is reused, in milliseconds.'),
    balanceTimeoutMs: z.natural().min(1_000).default(DEFAULTS.balanceTimeoutMs)
        .description('How long the balance request may take, in milliseconds.'),
});
function loggerFor(ctx) {
    const logger = ctx.get?.('logger');
    return (message) => {
        const line = `[dsh-mobile-companion] ${message}`;
        if (typeof logger?.info === 'function')
            logger.info(line);
        else
            console.info(line);
    };
}
function json(body) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        },
    });
}
/**
 * Register the two authenticated routes.
 *
 * Business failures are HTTP 200 with `ok: false` so the phone can read the
 * message. The connection carrier still answers 401/403 before this runs, and
 * an uninstalled plugin is a 404 from the carrier rather than from here.
 */
export function apply(ctx, rawConfig) {
    const config = resolveConfig(rawConfig);
    const cache = new BalanceCache();
    const log = loggerFor(ctx);
    ctx.effect(() => ctx.connection.fetch.register({
        path: '/api/dshMobile/transcribe',
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: async (request) => {
            try {
                const text = await transcribeRequest(request, config, log);
                return json({ ok: true, text });
            }
            catch (error) {
                if (error instanceof TranscribeFailure)
                    return json({ ok: false, error: { code: error.code, message: error.message } });
                log('transcribe failed code=internal');
                return json({ ok: false, error: { code: 'internal', message: 'transcription failed' } });
            }
        },
    }), 'dsh-mobile-companion: transcribe');
    ctx.effect(() => ctx.connection.fetch.register({
        path: '/api/dshMobile/balance',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
            try {
                const snapshot = await cache.get({
                    key: process.env.DEEPSEEK_API_KEY,
                    url: config.balanceUrl,
                    timeoutMs: config.balanceTimeoutMs,
                    cacheMs: config.balanceCacheMs,
                });
                log('balance ok');
                return json({ ok: true, ...snapshot });
            }
            catch (error) {
                if (error instanceof BalanceFailure) {
                    log(`balance failed code=${error.code}`);
                    return json({ ok: false, error: { code: error.code, message: error.message } });
                }
                log('balance failed code=internal');
                return json({ ok: false, error: { code: 'internal', message: 'balance lookup failed' } });
            }
        },
    }), 'dsh-mobile-companion: balance');
}
export default { name, inject, apply, Config };
