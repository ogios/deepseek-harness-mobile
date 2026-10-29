# dsh-mobile-companion

A DeepSeek Harness plugin for this fork of DSH Mobile. It adds two routes on the
harness web server the phone is already signed in to:

| Route | Method | What it does |
|---|---|---|
| `/api/dshMobile/transcribe` | POST | Accepts an audio upload, converts it to 16 kHz mono WAV, runs a local transcription command, returns the text |
| `/api/dshMobile/balance` | GET | Reads `DEEPSEEK_API_KEY` and returns the DeepSeek account balance, cached for about 60 seconds |

There is no new port and no new password. Both routes are exact Fetch routes on
the harness `connection` service, so they run only after the existing
browser-session check (401 without a session, 403 when the host fence refuses
the address). A missing plugin is a normal 404, and the app hides the balance
chip in that case.

## Install

On the computer that runs the harness, from a checkout of this fork:

```sh
dsh plugin --profile web add /absolute/path/to/deepseek-harness-mobile/harness-plugin
```

Restart the harness afterwards. A systemd user service is the same command the
unit already runs; the plugin is part of the `web` profile and comes back on
the next start.

`dsh plugin add` forwards to pnpm. pnpm 10 refuses dependency build scripts
until they are allowed. This package ships compiled JavaScript in `lib/` and
does not need a build script. If pnpm still stops on a dependency, allow that
build and run the add again.

Handy and ffmpeg are not installed by the plugin. The computer needs `ffmpeg`
on `PATH`, and the transcription command has to be something the service can
execute. A systemd user unit often has a short `PATH`; if `handy` is not found,
set the command to `/usr/bin/handy`.

Do not also add this plugin to an agent preset's plugin list. The routes belong
to the host process. A preset mounts again for every session, and the second
session would fail with a duplicate route.

## Transcription

The upload may be any audio ffmpeg can read (`audio/*`, `video/mp4`,
`application/octet-stream`). It is always converted to 16 kHz mono 16-bit WAV,
which is what Handy 0.9.8's `--transcribe-file` expects. The default command is:

```sh
handy --transcribe-file {wav} --json
```

`{wav}` is replaced with a shell-quoted temporary path. The command runs with
`sh -c`. It is your command, on your computer; the phone cannot change it.
`DEEPSEEK_API_KEY` is removed from the command's environment.

Handy `--json` prints one object whose `text` field is the transcript. A
non-JSON stdout is used as the transcript, which is how a stub command can
stand in for Handy. Temporary files are deleted when the request finishes,
including when it fails. The plugin does not log the audio or the transcript.

Limits, all configurable: 25 MB upload, 30 s for ffmpeg, 120 s for the
transcription command (the first Handy run loads the model, about a second on
the machine this was written for, then transcribes).

## Balance

`GET https://api.deepseek.com/user/balance` with `Authorization: Bearer` set
from `DEEPSEEK_API_KEY`. DeepSeek Harness loads that variable from `~/.dsh/.env`
when it is not already in the environment. The key is not written to the log
and is not included in the response. A missing key or a failed request returns
`ok: false` with a short message, and is not cached. A success is reused for
60 seconds.

The phone shows the currency and totals. It does not receive the key.

## Configuration

The installed row lives in the profile layer
(`~/.dsh/profiles/web/cordis.patch.yml` unless `DSH_HOME` is set). A patch
replaces that row's whole `config`, so restate every key you still want.

Environment variables override one boot without editing the file. They are read
when the profile loads, so the service has to be restarted after a change.

| Variable | Default |
|---|---|
| `DSH_MOBILE_TRANSCRIBE_COMMAND` | `handy --transcribe-file {wav} --json` |
| `DSH_MOBILE_TRANSCRIBE_TIMEOUT_MS` | `120000` |
| `DSH_MOBILE_FFMPEG` | `ffmpeg` |
| `DSH_MOBILE_FFMPEG_TIMEOUT_MS` | `30000` |
| `DSH_MOBILE_MAX_UPLOAD_BYTES` | `26214400` |
| `DSH_MOBILE_BALANCE_URL` | `https://api.deepseek.com/user/balance` |
| `DSH_MOBILE_BALANCE_CACHE_MS` | `60000` |
| `DSH_MOBILE_BALANCE_TIMEOUT_MS` | `15000` |

Example, Handy on a fixed path and an explicit model:

```yaml
- id: mobileCompanion
  name: 'dsh-mobile-companion'
  config:
    transcribeCommand: '/usr/bin/handy --transcribe-file {wav} --json --model qwen3-asr'
    transcribeTimeoutMs: 120000
    ffmpegPath: ffmpeg
    ffmpegTimeoutMs: 30000
    maxUploadBytes: 26214400
    balanceUrl: 'https://api.deepseek.com/user/balance'
    balanceCacheMs: 60000
    balanceTimeoutMs: 15000
```

`balanceUrl` exists so a test can point at a mock. Leave it at the default.

## Relay

`dsh-relay` (sorsama/deepseek-harness-relay, current `main`, package 0.3.0)
proxies every read, and proxies writes whose path is `/api` or starts with
`/api/`. These routes are under `/api/dshMobile/`, so they are forwarded with
no `extraProxyPaths` entry. They are not in the relay's privileged-method list,
so a paired phone can call them even when `privilegedMethods` is `loopback-only`.

Nothing needs to be added to the relay for this plugin. A future relay that
stopped forwarding unknown `/api/` writes would need `/api/dshMobile` added to
`extraProxyPaths`.

## Develop

```sh
cd harness-plugin
npm install
npm test          # unit tests, including a real ffmpeg conversion and a stub command
npm run test:live # installs the plugin into a temporary profile and boots @deepseek-ai/dsh
```

`test:live` needs `dsh` and `pnpm` on `PATH` (or `DSH_BIN` pointing at the
`dsh` executable) and network access the first time the profile installs the
plugin. It uses a stub transcription command and a local mock of the balance
endpoint, including a failed call. Handy is not required.

The published entry is `lib/index.js`. After changing `src/`, run `npm run build`
and commit `lib/` so `dsh plugin add` of this directory does not need a compile
step on the harness machine.
