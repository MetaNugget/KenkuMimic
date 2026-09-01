const { createSpeakerPool } = require('./speakerPool');
const { connectWebSocket } = require('./wsConnect');

const DEEPGRAM_URL =
  'wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&punctuate=true&model=nova-2';

function createDeepgramAdapter() {
  let transcriptCallback = null;

  async function openConnection(speakerId) {
    const ws = await connectWebSocket(
      DEEPGRAM_URL,
      { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } },
      (err) => console.error(`[deepgram] connection error for speaker ${speakerId}:`, err.message),
    );

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'Results' || !msg.is_final) return;
        const text = msg.channel?.alternatives?.[0]?.transcript;
        if (!text) return;
        transcriptCallback?.({ speakerId, text, timestamp: Date.now() });
      } catch (err) {
        console.error(`[deepgram] failed to parse message for speaker ${speakerId}:`, err.message);
      }
    });

    return ws;
  }

  async function closeConnection(ws) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: 'CloseStream' }));
    ws.close();
  }

  const pool = createSpeakerPool({ openConnection, closeConnection });

  return {
    async connect() {
      // Nothing to do up front — connections open lazily per speaker.
    },
    async sendAudio(pcmChunk, speakerId) {
      await pool.send(speakerId, pcmChunk);
    },
    onTranscript(callback) {
      transcriptCallback = callback;
    },
    async close() {
      await pool.closeAll();
    },
  };
}

module.exports = { createAdapter: createDeepgramAdapter };
