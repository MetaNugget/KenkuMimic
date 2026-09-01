// Every adapter returns the same shape:
//   connect(onProgress?), sendAudio(pcmChunk, speakerId), onTranscript(callback), close()
// onProgress is an optional (stage: string) => void callback for staged
// setup work (selfhosted's GPU cold start); adapters with instant/lazy
// connect() (deepgram, assemblyai) simply never call it.
// but internally, each holds one provider connection per concurrently-
// speaking user rather than one shared multiplexed stream — confirmed
// against Deepgram's, AssemblyAI's, and Whisper-server-family real-time
// APIs: a single connection is one continuous mono timeline for all three,
// so per-speaker pooling (see speakerPool.js) isn't a simplification
// choice, it's the only shape their real protocols support. Deepgram alone
// also supports true single-connection multiplexing
// (multichannel=true&channels=N), but that requires a pre-fixed speaker cap
// and bills all N channels continuously including silence, so deepgram.js
// uses the same per-speaker-pool approach as the other two for symmetry.
//
// createAdapter() returns a fresh instance every call, not a shared
// singleton — different guilds can run concurrent sessions (only one *per
// guild* is disallowed), each needing its own independent connection pool.

const PROVIDERS = {
  deepgram: () => require('./deepgram'),
  assemblyai: () => require('./assemblyai'),
  selfhosted: () => require('./selfhosted'),
};

function createAdapter() {
  const provider = process.env.TRANSCRIPTION_PROVIDER;
  const load = PROVIDERS[provider];
  if (!load) {
    throw new Error(
      `Unknown TRANSCRIPTION_PROVIDER: "${provider}" (expected one of: ${Object.keys(PROVIDERS).join(', ')})`,
    );
  }
  return load().createAdapter();
}

module.exports = { createAdapter };
