// Deepgram, AssemblyAI, and the self-hosted server all share the same real
// constraint: one underlying connection is one continuous mono audio
// timeline, so concurrent multi-speaker transcription means holding one
// provider connection per concurrently-speaking user, not one shared
// multiplexed stream (confirmed against each provider's real-time API, not
// a simplification choice — see lib/transcription/index.js). This factors
// that pool out so each adapter only implements what's actually
// provider-specific: opening one connection and parsing its messages.

const TRAILING_SILENCE_MS = 1500;

function createSpeakerPool({ openConnection, closeConnection }, { trailingSilenceMs = TRAILING_SILENCE_MS } = {}) {
  const connections = new Map(); // speakerId -> { connPromise, silenceTimer }

  // A speaker whose connection fails to open (bad credentials, provider
  // outage) simply retries on their next audio chunk rather than latching
  // into a broken state — reasonable for transient failures. A persistently
  // failing config will retry on every chunk from that speaker for the rest
  // of the session; acceptable for v1's scale, not backed by a circuit
  // breaker. The rejection handler below is what makes that retry possible:
  // without it, a failed openConnection would leave a permanently-rejected
  // promise latched into the map and every subsequent chunk would just
  // re-reject instead of trying again.
  function send(speakerId, pcmChunk) {
    let entry = connections.get(speakerId);
    if (!entry) {
      // Claimed synchronously, before any await, so the burst of chunks
      // that arrive while the handshake is in flight all see this entry
      // instead of each opening their own connection (same pattern as
      // sessionState.js's reserveSession()).
      entry = { connPromise: openConnection(speakerId), silenceTimer: null };
      connections.set(speakerId, entry);
      entry.connPromise.catch(() => {
        // Also clears this entry's own still-pending silence timer —
        // otherwise it fires later and unconditionally deletes whatever
        // entry occupies this speakerId by then, which could be a
        // healthy connection opened by a subsequent chunk's retry.
        clearTimeout(entry.silenceTimer);
        if (connections.get(speakerId) === entry) connections.delete(speakerId);
      });
    }

    clearTimeout(entry.silenceTimer);
    entry.silenceTimer = setTimeout(() => {
      // Only delete if this entry is still the one in the map — a stale
      // timer from an already-superseded entry (e.g. one whose
      // connPromise rejected and was replaced by a retry) must not evict
      // whatever is there now.
      if (connections.get(speakerId) === entry) connections.delete(speakerId);
      entry.connPromise
        .then(closeConnection)
        .catch((err) =>
          console.error(`[transcription] error closing connection for speaker ${speakerId}:`, err.message),
        );
    }, trailingSilenceMs);

    return entry.connPromise.then((conn) => conn.send(pcmChunk));
  }

  async function closeAll() {
    for (const [speakerId, entry] of connections) {
      clearTimeout(entry.silenceTimer);
      await entry.connPromise
        .then(closeConnection)
        .catch((err) =>
          console.error(`[transcription] error closing connection for speaker ${speakerId}:`, err.message),
        );
    }
    connections.clear();
  }

  return { send, closeAll };
}

module.exports = { createSpeakerPool };
