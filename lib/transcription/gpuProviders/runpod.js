// RunPod REST API v2 (https://docs.runpod.io/api-reference-v2/overview).
// v1 retires December 1, 2026, so this is built against v2 despite it still
// being in public beta — it's the only version with runway left.
//
// Auth: `Authorization: Bearer <api_key>`.

const RUNPOD_API_BASE = 'https://api.runpod.io/v2';

// RunPod-hosted hardware, meaningfully pricier than community-hosted.
// COMMUNITY suits a hobby workload; override via env for anyone who wants
// SECURE's guarantees instead.
const DEFAULT_CLOUD_TYPE = 'COMMUNITY';

// Per-candidate-GPU retry loop in startInstance() below. Kept small: this
// is a one-shot session start a human is waiting on in Discord, not a
// background job worth minutes of backoff.
const MAX_ATTEMPTS_PER_CANDIDATE = 3;
const RETRY_BACKOFF_MS = 2000;

class RunpodApiError extends Error {
  constructor(status, path, body, retryAfterMs) {
    super(RunpodApiError._describe(status, path, body));
    this.name = 'RunpodApiError';
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }

  static _describe(status, path, body) {
    switch (status) {
      case 402:
        return `RunPod API error 402 on ${path}: insufficient account balance — top up at runpod.io/console/user/billing. (${body})`;
      case 422:
        return `RunPod API error 422 on ${path}: request body rejected as invalid (this is a code bug, not transient) — ${body}`;
      case 403:
        return `RunPod API error 403 on ${path}: forbidden for this account/resource — ${body}`;
      default:
        return `RunPod API error ${status} on ${path}: ${body}`;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runpodFetch(path, options = {}) {
  const res = await fetch(`${RUNPOD_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GPU_PROVIDER_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // headers.get() returns null when absent, and Number(null) is 0 (not
    // NaN) -- so this must reject non-positive values explicitly, or a
    // missing header silently becomes a zero-delay retry instead of falling
    // through to RETRY_BACKOFF_MS at the call site.
    const retryAfterHeader = Number(res.headers.get('Retry-After'));
    const retryAfterMs =
      Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : undefined;
    throw new RunpodApiError(res.status, path, body, retryAfterMs);
  }
  if (res.status === 204) return null;
  return res.json();
}

// GPU_PROVIDER_TEMPLATE_ID resolves to a RunPod Template (image, disk,
// ports, env — whatever the whisper-server image needs), but a template
// does NOT cover which GPU hardware to rent: RunPod's create-pod API
// requires that separately via gpu.id, e.g. "NVIDIA GeForce RTX 4090". This
// wasn't in the original env var list and needs GPU_PROVIDER_GPU_TYPE_ID
// added to .env.
//
// GPU_PROVIDER_GPU_TYPE_ID may be a comma-separated preference list — e.g.
// "NVIDIA GeForce RTX 4090,NVIDIA RTX A5000" — so a shortage of the first
// choice doesn't just fail the whole session. Retry semantics per RunPod's
// documented error contract: 400 (rule violation or capacity) and a
// 5xx-exhausted candidate move on to the next GPU type; 403 skips it too;
// 429 backs off (using Retry-After if given) and retries the same
// candidate; 5xx retries the same candidate with backoff before moving on;
// 402 (insufficient balance) and 422 (malformed request — deterministic,
// a code bug) abort immediately since no amount of retrying or candidate
// switching fixes either.
//
// CreatePodRequest sets `unevaluatedProperties: false`, so a stray extra
// field in the body below comes back as a 422 rather than being silently
// ignored — don't add one casually.
async function createPodWithGpu(gpuTypeId) {
  const pod = await runpodFetch('/pods', {
    method: 'POST',
    body: JSON.stringify({
      name: `kenkumimic-${Date.now()}`,
      templateId: process.env.GPU_PROVIDER_TEMPLATE_ID,
      gpu: { id: gpuTypeId, count: 1 },
      cloud: process.env.GPU_PROVIDER_CLOUD_TYPE || DEFAULT_CLOUD_TYPE,
    }),
  });
  return { instanceId: pod.id };
}

async function startInstance() {
  const candidates = (process.env.GPU_PROVIDER_GPU_TYPE_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (candidates.length === 0) {
    throw new Error('GPU_PROVIDER_GPU_TYPE_ID is not set');
  }

  let lastErr;
  for (const gpuTypeId of candidates) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_CANDIDATE; attempt++) {
      try {
        return await createPodWithGpu(gpuTypeId);
      } catch (err) {
        lastErr = err;
        if (!(err instanceof RunpodApiError)) throw err;
        if (err.status === 402 || err.status === 422) throw err;

        if (err.status === 429 && attempt < MAX_ATTEMPTS_PER_CANDIDATE) {
          await sleep(err.retryAfterMs ?? RETRY_BACKOFF_MS);
          continue;
        }
        if (err.status >= 500 && attempt < MAX_ATTEMPTS_PER_CANDIDATE) {
          await sleep(RETRY_BACKOFF_MS * attempt);
          continue;
        }
        // 400/403, or a retryable status that exhausted its attempts on
        // this candidate — move on to the next GPU type preference.
        break;
      }
    }
  }
  throw lastErr;
}

async function getInstanceStatus(instanceId) {
  const pod = await runpodFetch(`/pods/${instanceId}`);
  return {
    ready: pod.status === 'RUNNING',
    status: pod.status,
    ports: pod.runtime?.ports ?? [],
  };
}

// RunPod's own "stop" action only pauses compute and keeps billing for
// storage — wrong for a one-shot session pod that's never resumed.
// stopInstance() here means "permanently done with this pod," which is
// RunPod's "terminate" action (equivalent to deleting it).
async function stopInstance(instanceId) {
  await runpodFetch(`/pods/${instanceId}/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'terminate' }),
  });
}

module.exports = { startInstance, getInstanceStatus, stopInstance };
