// Deepgram, AssemblyAI, and the self-hosted server all share the same real
// constraint: one underlying connection is one continuous mono audio
// timeline, so concurrent multi-speaker transcription means holding one
// provider connection per concurrently-speaking user, not one shared
// multiplexed stream (confirmed against each provider's real-time API, not
// a simplification choice — see lib/transcription/index.js). This factors
// that pool out so each adapter only implements what's actually
// provider-specific: opening one connection and parsing its messages.

const TRAILING_SILENCE_MS = 1500;

function createSpeakerPool({ openConnection, closeConnection }) {
  const connections = new Map(); // speakerId -> { conn, silenceTimer }

  // A speaker whose connection fails to open (bad credentials, provider
  // outage) simply retries on their next audio chunk rather than latching
  // into a broken state — reasonable for transient failures. A persistently
  // failing config will retry on every chunk from that speaker for the rest
  // of the session; acceptable for v1's scale, not backed by a circuit
  // breaker.
  async function send(speakerId, pcmChunk) {
    let entry = connections.get(speakerId);
    if (!entry) {
      const conn = await openConnection(speakerId);
      entry = { conn, silenceTimer: null };
      connections.set(speakerId, entry);
    }

    clearTimeout(entry.silenceTimer);
    entry.silenceTimer = setTimeout(() => {
      connections.delete(speakerId);
      closeConnection(entry.conn).catch((err) =>
        console.error(`[transcription] error closing connection for speaker ${speakerId}:`, err.message),
      );
    }, TRAILING_SILENCE_MS);

    entry.conn.send(pcmChunk);
  }

  async function closeAll() {
    for (const [speakerId, entry] of connections) {
      clearTimeout(entry.silenceTimer);
      await closeConnection(entry.conn).catch((err) =>
        console.error(`[transcription] error closing connection for speaker ${speakerId}:`, err.message),
      );
    }
    connections.clear();
  }

  return { send, closeAll };
}

module.exports = { createSpeakerPool };
