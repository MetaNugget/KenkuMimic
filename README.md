# KenkuMimic

A kenku-themed Discord bot that joins a TTRPG session's voice channel,
transcribes it per-speaker in near-real-time, and posts AI-generated
session notes once the session wraps up.

## How it works

1. `/mimic start` — joins the voice channel the caller is currently in,
   posts a public announcement in the text channel (this *is* the consent
   notice — recording is never silent), and starts transcribing.
2. Each person's audio is captured and transcribed separately as they
   speak. Discord already separates audio per speaker, so there's no
   diarization step and speaker attribution is exact, including when
   people talk over each other.
3. `/mimic end` — stops capturing, leaves voice, generates structured notes
   (recap, key decisions, NPCs introduced, open threads) from the
   transcript, and posts them to the channel the session started in.
4. Only one session can be active per guild at a time; different guilds can
   run concurrent sessions independently of each other.
5. Anyone in the server can run `/mimic end`, not just whoever ran
   `/mimic start` — restricting it to the original caller would risk
   stranding a live session if they disconnect.
6. The transcript is deleted from Redis once notes post successfully. If
   notes generation fails, it's kept (with a 48h safety expiry) instead of
   lost, so a bad API call doesn't destroy the only copy of the session.

## Architecture

- **Redis-backed transcript, in-memory everything else.** Unlike the
  sibling bot's fully-Redis state, only the transcript text itself survives
  a restart — `mimic:session:{id}:transcript` and `:meta`, via
  [lib/transcriptStore.js](lib/transcriptStore.js). A live
  `@discordjs/voice` connection and an open provider websocket can't be
  serialized into Redis or survive a process restart regardless, so
  [lib/sessionState.js](lib/sessionState.js) tracks the live pieces (voice
  connection, transcription adapter, which guild has an active session) as
  a plain in-memory `Map` instead. There's nothing to gain by round-tripping
  objects that die with the process anyway.
- **Pluggable transcription adapters**
  ([lib/transcription/](lib/transcription/)): `deepgram.js`,
  `assemblyai.js`, and `selfhosted.js` all implement the same
  `connect()` / `sendAudio(pcmChunk, speakerId)` / `onTranscript(callback)`
  / `close()` shape, selected at runtime via `TRANSCRIPTION_PROVIDER`.
  Internally, each holds one provider connection *per concurrently-speaking
  user* ([lib/transcription/speakerPool.js](lib/transcription/speakerPool.js))
  rather than one shared multiplexed stream — not a simplification choice,
  a hard constraint confirmed against Deepgram's and AssemblyAI's real-time
  APIs: a single connection is one continuous mono timeline for both, so
  correct concurrent multi-speaker transcription needs a small connection
  pool per adapter instance, opened per speaker and closed after trailing
  silence.
- **Voice capture** ([lib/voiceCapture.js](lib/voiceCapture.js)):
  subscribes to each speaker's Opus stream individually on `speaking.start`
  rather than mixing the channel down, decodes via `prism-media`, and
  downsamples Discord's 48kHz stereo to 16kHz mono in-process (a boxcar
  average, no ffmpeg subprocess) before handing PCM to whichever adapter is
  active.
- **GPU lifecycle for `selfhosted`**
  ([lib/transcription/gpuProviders/](lib/transcription/gpuProviders/)):
  `startInstance()` / `getInstanceStatus()` / `stopInstance()` behind a
  small interface so the rental provider is just config, not something
  hardcoded into `selfhosted.js`.
- **Notes generation is one adapter, not one per LLM provider**
  ([lib/notesClient.js](lib/notesClient.js)): a plain OpenAI-shaped client
  pointed at a configurable `NOTES_BASE_URL`, since Anthropic, OpenAI, and
  most self-hosted setups (Ollama, llama.cpp server) all speak the same
  chat-completions shape. Every call logs token usage and which
  `base_url`/model handled it, so real per-session cost can be reviewed
  from the logs — there's no live pricing lookup for any provider.
- **Command loader**: same `commands/<category>/*.js` pattern as the
  sibling bot, one command
  ([commands/session/mimic.js](commands/session/mimic.js)) with
  `start`/`end` subcommands.

### GPU provider: why RunPod

RunPod was chosen over Vast.ai and Modal for `selfhosted.js`'s first
integration:

- A managed, catalog-style REST API built for exactly this
  start/poll-health/stop lifecycle, with predictable ~20–60s cold starts —
  matters when players are waiting on `/mimic start`.
- A real **Templates** concept (container image + disk/env/entrypoint
  bundle, referenced by ID) that maps directly onto
  `GPU_PROVIDER_TEMPLATE_ID`.
- Stays in the project's existing Node/Docker stack. Modal is meaningfully
  faster to cold-start (2–4s) and has first-class WebSocket support, but
  apps are defined as Python decorators rather than an arbitrary Docker
  image behind REST — a re-hosting effort, not a drop-in swap, and it would
  add a second language to an otherwise all-Node project.
- Vast.ai is a peer-hosted marketplace, usually cheaper, but offer-based
  (the specific instance requested can be taken before the request lands)
  with cold-start time and uptime varying by host machine.

Built against **RunPod's REST API v2** (`https://api.runpod.io/v2`,
`Authorization: Bearer <key>`) — v1 retired 2026-11-15. `stopInstance()`
uses RunPod's `terminate` action specifically, not `stop`: RunPod's own
`stop` only pauses compute and keeps billing for storage, which is wrong
for a one-shot session pod that's never resumed.

## Discord API gotchas to know about

- **`selfDeaf: false` is required to receive any audio at all** — it's not
  just a presence flag. Get this backwards and the bot silently captures
  nothing, with no error.
- **`receiver.subscribe()` always returns raw Opus packets** — there's no
  PCM shortcut; decoding via `prism-media` is mandatory.
- **The old voice encryption modes are dead.** Discord retired every
  `xsalsa20_poly1305*` mode on 2024-11-18 in favor of
  `aead_xchacha20_poly1305_rtpsize`. `sodium-native` (native binding) is
  the primary encryption dependency here; if it fails to compile (common on
  Pi/ARM), install `@noble/ciphers` as the fallback — **not** `tweetnacl`,
  which never implemented the required cipher and would just fail to
  connect with no clear error.
- **`@discordjs/opus` has no working arm64 Linux prebuilt** as of this
  writing — `opusscript` (WASM, not strictly pure JS) is the Pi fallback if
  the native build fails. Both `@discordjs/voice` and `prism-media`
  auto-detect whichever module is actually installed, so no code changes
  are needed either way.
- **`speaking.start`/`speaking.end` can be flaky** per scattered community
  reports — not something this bot works around, just worth knowing if
  transcription seems to occasionally miss an utterance.
- **Discord's 2000-character message limit**: a full session's notes can
  easily exceed one message, so they're chunked at paragraph/line
  boundaries (`chunkText` in `commands/session/mimic.js`) across as many
  messages as needed.
- **Global vs. guild command registration**: same as the sibling — set
  `GUILD_ID` in `.env` during development so `npm run deploy` updates
  instantly in your test server; unset it for production.

## Known v1 limitations

- Max one active session per guild at a time, by design (see
  `sessionState.js`). Different guilds can still run sessions concurrently.
- No editing or regenerating notes after they're posted.
- No live/incremental note updates during the session — batch at session
  end only.
- **The GPU-side inference server doesn't exist yet.** `selfhosted.js` is a
  complete, working client against a protocol this project defines (raw
  16kHz mono PCM16LE in over WebSocket, JSON `{ transcript, final }` out,
  on port 8000) — but nothing has built the actual (presumably
  faster-whisper-based) server that needs to run inside the RunPod template
  `GPU_PROVIDER_TEMPLATE_ID` points at. Until that exists,
  `TRANSCRIPTION_PROVIDER=selfhosted` will fail at the
  health-check-polling stage of `/mimic start`. That server is realistically
  its own small project (Python, Dockerfile, RunPod template setup).
- **The orphan-cost safety net is incomplete.** RunPod v2 has no
  server-side max-runtime setting to lean on, so `selfhosted.js`'s
  in-process 6-hour timer is the only backstop — and it only helps if the
  bot process is still alive to fire it. A process crash or power loss
  between `connect()` and `close()` can still leak a running, billing pod
  with nothing tracking it. Check the RunPod dashboard periodically,
  especially after an ungraceful restart.
- **Redis must be reachable before starting the bot or running
  `npm run deploy`.** `redisClient.js` connects at require time and, like
  the sibling bot, retries indefinitely by default rather than failing
  fast — if Redis is down, commands just hang with no error instead of
  erroring clearly.
- A persistently misconfigured transcription provider (e.g. a bad API key)
  retries on every audio chunk from a speaker rather than backing off —
  fine at TTRPG-group scale, not backed by a circuit breaker.

## Local setup

### Prerequisites

- Node.js 20+ (see Raspberry Pi deployment below for why 22.x LTS is
  actually recommended)
- A Discord bot token and application (from the
  [Discord Developer Portal](https://discord.com/developers/applications))
- A running Redis server (local or remote)
- Credentials for one transcription provider (Deepgram, AssemblyAI, or a
  RunPod account for `selfhosted` — see the limitation above)
- Credentials for a chat-completions endpoint for notes generation
  (Anthropic, OpenAI, or a self-hosted Ollama/llama.cpp server)

### Installation

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file:
   ```bash
   cp .env.example .env
   ```
   Fill in `TOKEN`, `CLIENT_ID`, `TRANSCRIPTION_PROVIDER` and its
   corresponding keys, and the `NOTES_*` variables. Set `GUILD_ID` to your
   test server's ID for instant command updates while developing.
3. Register slash commands:
   ```bash
   npm run deploy
   ```
4. Start the bot:
   ```bash
   npm start
   ```

### Adding the bot to a server

1. Discord Developer Portal → your app → OAuth2 → URL Generator
2. Scopes: `bot`, `applications.commands`
3. Bot permissions: `Connect` (voice), `Send Messages`, `Embed Links`
4. Open the generated URL and select a server

## Raspberry Pi deployment

This is designed to run comfortably on a Raspberry Pi, alongside
KenkuCawlender and NutBot.

1. **Install Node.js 22.x LTS** (the Raspberry Pi OS apt package is
   usually too old, and Node 20 passed end-of-life in April 2026):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
2. **Install Redis**, if it isn't already running from another project:
   ```bash
   sudo apt-get install -y redis-server
   sudo systemctl enable --now redis-server
   ```
   For durability across a power loss, make sure Redis persistence is
   enabled — check `appendonly yes` in `/etc/redis/redis.conf` (AOF) for
   the strongest guarantee, or confirm RDB snapshotting intervals suit you.
3. **Native dependencies may need the pure-JS/WASM fallback on ARM.** If
   `npm install` fails to compile `@discordjs/opus` or `sodium-native`,
   install their fallbacks instead:
   ```bash
   npm install opusscript @noble/ciphers
   ```
   No `.env` or code changes needed either way — `@discordjs/voice` and
   `prism-media` auto-detect whichever module is actually installed.
4. **Clone the repo, install dependencies, configure `.env`** as above.
   Leave `REDIS_URL` unset to use the local Redis instance, or point it at
   the same instance the other bots use — keys are namespaced under
   `mimic:`, so there's no collision with KenkuCawlender's `cawlender:` or
   NutBot's `nut:count:`.
5. **Run it as a service** with `pm2` so it survives reboots and crashes:
   ```bash
   sudo npm install -g pm2
   pm2 start index.js --name kenkumimic
   pm2 save
   ```
   No need to run `pm2 startup` again if it's already been run for another
   bot on this Pi — that hook is one-time per machine and already covers
   any process added and saved afterward.

## License

ISC
