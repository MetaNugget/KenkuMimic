const { createSpeakerPool } = require('./speakerPool');
const { connectWebSocket } = require('./wsConnect');

const ASSEMBLYAI_URL = 'wss://streaming.assemblyai.com/v3/ws?encoding=pcm_s16le&sample_rate=16000';

function createAssemblyAiAdapter() {
  let transcriptCallback = null;

  async function openConnection(speakerId) {
    // No "Bearer" prefix — AssemblyAI's streaming API takes the raw API key
    // as the Authorization header value.
    const ws = await connectWebSocket(
      ASSEMBLYAI_URL,
      { headers: { Authorization: process.env.ASSEMBLYAI_API_KEY } },
      (err) => console.error(`[assemblyai] connection error for speaker ${speakerId}:`, err.message),
    );

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'Turn' || !msg.end_of_turn) return;
        if (!msg.transcript) return;
        transcriptCallback?.({ speakerId, text: msg.transcript, timestamp: Date.now() });
      } catch (err) {
        console.error(`[assemblyai] failed to parse message for speaker ${speakerId}:`, err.message);
      }
    });

    return ws;
  }

  async function closeConnection(ws) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: 'Terminate' }));
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

module.exports = { createAdapter: createAssemblyAiAdapter };
