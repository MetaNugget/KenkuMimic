const crypto = require('node:crypto');
const redis = require('../redisClient');

// Safety net if notes generation fails (see markFailed) — long enough for a
// manual retry, short enough that a repeatedly-failing session doesn't
// linger in Redis forever.
const FAILURE_TTL_SECONDS = 60 * 60 * 48;

function metaKey(sessionId) {
  return `mimic:session:${sessionId}:meta`;
}

function transcriptKey(sessionId) {
  return `mimic:session:${sessionId}:transcript`;
}

async function createSession({ guildId, channelId, textChannelId, startedBy }) {
  const sessionId = crypto.randomUUID();
  await redis.hset(metaKey(sessionId), {
    guildId,
    channelId,
    textChannelId,
    startedBy,
    startedAt: Date.now(),
  });
  return sessionId;
}

// speakerId is stored as the raw Discord user ID, not a display name —
// resolving it to something readable needs a guild member lookup, which is
// a discord.js concern this module deliberately stays free of. That's left
// to whatever builds the notes-generation prompt.
async function appendLine(sessionId, { speakerId, text, timestamp }) {
  const line = `[${new Date(timestamp).toISOString()}] ${speakerId}: ${text}`;
  await redis.rpush(transcriptKey(sessionId), line);
}

async function getTranscriptText(sessionId) {
  const lines = await redis.lrange(transcriptKey(sessionId), 0, -1);
  return lines.join('\n');
}

async function getSessionMeta(sessionId) {
  const meta = await redis.hgetall(metaKey(sessionId));
  return Object.keys(meta).length > 0 ? meta : null;
}

// Notes posted successfully — editing/regenerating notes is out of scope for
// v1, so nothing needs the raw transcript afterward. Delete outright rather
// than leave it to expire.
async function deleteSession(sessionId) {
  await redis.del(metaKey(sessionId), transcriptKey(sessionId));
}

// Notes generation failed — keep the transcript so a bad API call doesn't
// destroy the only copy of the session, but cap it with FAILURE_TTL_SECONDS.
async function markFailed(sessionId) {
  await redis.expire(metaKey(sessionId), FAILURE_TTL_SECONDS);
  await redis.expire(transcriptKey(sessionId), FAILURE_TTL_SECONDS);
}

module.exports = {
  createSession,
  appendLine,
  getTranscriptText,
  getSessionMeta,
  deleteSession,
  markFailed,
};
