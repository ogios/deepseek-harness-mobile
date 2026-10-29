import { spawn } from 'node:child_process';
/** A command finished, timed out, or produced more output than we will hold. */
export class CommandFailure extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'CommandFailure';
    }
}
const MAX_CAPTURE = 1_000_000;
/**
 * Environment passed to ffmpeg and the transcription command.
 *
 * The harness process holds `DEEPSEEK_API_KEY`. Neither tool needs it, and a
 * child must not inherit it.
 */
export function childEnv(source = process.env) {
    const env = { ...source };
    delete env.DEEPSEEK_API_KEY;
    return env;
}
function killGroup(pid) {
    if (pid === undefined)
        return;
    try {
        process.kill(-pid, 'SIGTERM');
    }
    catch {
        try {
            process.kill(pid, 'SIGTERM');
        }
        catch { /* already gone */ }
    }
}
/**
 * Run a process and capture bounded stdout/stderr.
 *
 * [args] is empty when [command] is a shell script (`shell: true`). The child
 * is its own process group so a timeout can stop grandchildren (ffmpeg, Handy)
 * without signalling the harness.
 */
export function runCommand(command, args, timeoutMs, shell) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            shell,
            detached: true,
            env: childEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let overflow = false;
        const finish = (error, result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            process.off('exit', onParentExit);
            if (error !== undefined)
                reject(error);
            else
                resolve(result ?? { stdout, stderr });
        };
        const onParentExit = () => { killGroup(child.pid); };
        process.on('exit', onParentExit);
        const timer = setTimeout(() => {
            killGroup(child.pid);
            finish(new CommandFailure('timeout', `command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const take = (current, chunk, which) => {
            const next = current + chunk.toString('utf8');
            if (next.length > MAX_CAPTURE) {
                overflow = true;
                killGroup(child.pid);
                return next.slice(0, MAX_CAPTURE);
            }
            return which === 'stdout' ? next : next;
        };
        child.stdout?.on('data', (chunk) => { stdout = take(stdout, chunk, 'stdout'); });
        child.stderr?.on('data', (chunk) => { stderr = take(stderr, chunk, 'stderr'); });
        child.on('error', (error) => {
            finish(new CommandFailure('spawn', error.message));
        });
        child.on('close', (code) => {
            if (overflow) {
                finish(new CommandFailure('output-too-large', 'command output exceeded the capture limit'));
                return;
            }
            if (code !== 0) {
                const detail = stderr.trim().slice(0, 300) || `exit ${code ?? 'unknown'}`;
                finish(new CommandFailure('exit', detail));
                return;
            }
            finish(undefined, { stdout, stderr });
        });
    });
}
