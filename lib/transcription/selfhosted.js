const gpuProvider = require('./gpuProviders');
const { createSpeakerPool } = require('./speakerPool');
const { connectWebSocket } = require('./wsConnect');

const HEALTH_POLL_INTERVAL_MS = 5000;
const HEALTH_POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to boot the pod and load the model

// Defense in depth against a leaked, still-billing GPU instance if the bot
// process itself dies between connect() and close() — sessionState.js is
// in-memory, so a crash mid-session loses track of the instance entirely.
// RunPod v2 has no server-side max-runtime setting to lean on instead (see
// README), so this in-process timer is the only safety net, and it only
// helps if the process is still alive to fire it — it doesn't protect
// against the process itself crashing or the Pi losing power.
const MAX_SESSION_HOURS = 6;

// This WebSocket protocol (raw 16kHz mono PCM16LE frames in, JSON
// { transcript, final } out, on this private port) is one this project
// defines for its own server, not a third-party spec — whatever image
// GPU_PROVIDER_TEMPLATE_ID points at needs to speak it. Building that
// server is separate work, not part of this repo — see the README.
const SERVER_PORT_PRIVATE = 8000;

function createSelfhostedAdapter() {
  let transcriptCallback = null;
  let instanceId = null;
  let serverAddress = null; // { ip, port }
  let safetyTimer = null;
  let pool = null;

  async function waitForInstanceReady(onProgress) {
    const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
    let lastStatus = null;
    while (Date.now() < deadline) {
      const status = await gpuProvider.getInstanceStatus(instanceId);
      if (status.status !== lastStatus) {
        lastStatus = status.status;
        onProgress?.(`⚙️ GPU host status: ${status.status}...`);
      }
      if (status.ready) {
        const port = status.ports.find((p) => p.private === SERVER_PORT_PRIVATE);
        if (port?.ip && port?.public) {
          return { ip: port.ip, port: port.public };
        }
      }
      if (status.status === 'ERROR') {
        throw new Error(`GPU instance ${instanceId} entered ERROR status while starting`);
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
    }
    throw new Error(`GPU instance ${instanceId} did not become ready within ${HEALTH_POLL_TIMEOUT_MS}ms`);
  }

  async function openConnection(speakerId) {
    const url = `ws://${serverAddress.ip}:${serverAddress.port}/transcribe?sample_rate=16000`;
    const ws = await connectWebSocket(url, {}, (err) =>
      console.error(`[selfhosted] connection error for speaker ${speakerId}:`, err.message),
    );

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!msg.final || !msg.transcript) return;
        transcriptCallback?.({ speakerId, text: msg.transcript, timestamp: Date.now() });
      } catch (err) {
        console.error(`[selfhosted] failed to parse message for speaker ${speakerId}:`, err.message);
      }
    });

    return ws;
  }

  async function closeConnection(ws) {
    if (ws.readyState !== ws.OPEN) return;
    ws.close();
  }

  return {
    async connect(onProgress) {
      onProgress?.('⚙️ Orchestrating GPU host...');
      const started = await gpuProvider.startInstance();
      instanceId = started.instanceId;
      onProgress?.(`⚙️ GPU host provisioning (pod \`${instanceId}\`)...`);

      safetyTimer = setTimeout(() => {
        console.error(
          `[selfhosted] session exceeded ${MAX_SESSION_HOURS}h safety limit — force-terminating GPU instance ${instanceId}`,
        );
        gpuProvider
          .stopInstance(instanceId)
          .catch((err) => console.error('[selfhosted] safety-net terminate failed:', err.message));
      }, MAX_SESSION_HOURS * 60 * 60 * 1000);
      safetyTimer.unref();

      try {
        serverAddress = await waitForInstanceReady(onProgress);
      } catch (err) {
        // The instance started billing the moment startInstance() returned
        // — if it never becomes usable, tear it down before propagating the
        // error, or it leaks as a paid-for pod nobody is tracking.
        clearTimeout(safetyTimer);
        await gpuProvider
          .stopInstance(instanceId)
          .catch((cleanupErr) =>
            console.error(`[selfhosted] failed to clean up instance ${instanceId} after startup failure:`, cleanupErr.message),
          );
        throw err;
      }

      onProgress?.('⚙️ GPU host ready — connecting inference pipeline...');
      pool = createSpeakerPool({ openConnection, closeConnection });
    },
    async sendAudio(pcmChunk, speakerId) {
      await pool.send(speakerId, pcmChunk);
    },
    onTranscript(callback) {
      transcriptCallback = callback;
    },
    async close() {
      clearTimeout(safetyTimer);
      if (pool) await pool.closeAll();
      if (instanceId) await gpuProvider.stopInstance(instanceId);
    },
  };
}

module.exports = { createAdapter: createSelfhostedAdapter };
