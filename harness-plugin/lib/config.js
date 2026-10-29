/**
 * Resolved companion settings.
 *
 * Cordis hands `apply` the schema-resolved object. A volatile handle (an object
 * with `get()`) is unwrapped so a later settings-page edit is still readable.
 * Missing fields fall back to the same defaults the patch and the schema use.
 */
export const DEFAULT_TRANSCRIBE_COMMAND = 'handy --transcribe-file {wav} --json';
export const DEFAULTS = {
    transcribeCommand: DEFAULT_TRANSCRIBE_COMMAND,
    transcribeTimeoutMs: 120_000,
    ffmpegPath: 'ffmpeg',
    ffmpegTimeoutMs: 30_000,
    maxUploadBytes: 25 * 1024 * 1024,
    balanceUrl: 'https://api.deepseek.com/user/balance',
    balanceCacheMs: 60_000,
    balanceTimeoutMs: 15_000,
};
function unwrap(value) {
    if (value !== null && typeof value === 'object' && 'get' in value && typeof value.get === 'function') {
        return unwrap(value.get());
    }
    return value;
}
function text(value, fallback) {
    const raw = unwrap(value);
    return typeof raw === 'string' && raw.trim().length > 0 ? raw : fallback;
}
function whole(value, fallback, min) {
    const raw = unwrap(value);
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(min, Math.floor(parsed));
}
/** Read plugin config, filling anything the loader did not resolve. */
export function resolveConfig(raw) {
    const source = raw !== null && typeof raw === 'object' ? raw : {};
    return {
        transcribeCommand: text(source.transcribeCommand, DEFAULTS.transcribeCommand),
        transcribeTimeoutMs: whole(source.transcribeTimeoutMs, DEFAULTS.transcribeTimeoutMs, 1_000),
        ffmpegPath: text(source.ffmpegPath, DEFAULTS.ffmpegPath),
        ffmpegTimeoutMs: whole(source.ffmpegTimeoutMs, DEFAULTS.ffmpegTimeoutMs, 1_000),
        maxUploadBytes: whole(source.maxUploadBytes, DEFAULTS.maxUploadBytes, 1),
        balanceUrl: text(source.balanceUrl, DEFAULTS.balanceUrl),
        balanceCacheMs: whole(source.balanceCacheMs, DEFAULTS.balanceCacheMs, 0),
        balanceTimeoutMs: whole(source.balanceTimeoutMs, DEFAULTS.balanceTimeoutMs, 1_000),
    };
}
