// RunPod REST API v2 (https://docs.runpod.io/api-reference-v2/overview).
// v1 retires 2026-11-15, so this is built against v2 despite it still being
// in public beta — it's the only version with runway left.
//
// Auth: `Authorization: Bearer <api_key>`.

const RUNPOD_API_BASE = 'https://api.runpod.io/v2';

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
    throw new Error(`RunPod API error ${res.status} on ${path}: ${body}`);
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
async function startInstance() {
  const pod = await runpodFetch('/pods', {
    method: 'POST',
    body: JSON.stringify({
      name: `kenkumimic-${Date.now()}`,
      templateId: process.env.GPU_PROVIDER_TEMPLATE_ID,
      gpu: { id: process.env.GPU_PROVIDER_GPU_TYPE_ID, count: 1 },
    }),
  });
  return { instanceId: pod.id };
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
