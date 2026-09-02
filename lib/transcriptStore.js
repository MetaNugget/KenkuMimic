const crypto = require('node:crypto');
const redis = require('../redisClient');

// Generous enough to be well past any real session (typically a few hours),
// so this is purely a backstop against a crash or power loss stranding a
// session's keys in Redis forever with no other cleanup path — this runs on
// a 2GB Pi with AOF persistence shared across three bots, so that
// accumulates. markFailed() below extends a failed session to the same
// horizon, not a separate, shorter one.
const SESSION_TTL_SECONDS = 60 * 60 * 48;

// Refreshing the TTL on every single appendLine would cost a Redis round
// trip per transcript line for no real benefit — the keys only need to
// outlive the gap until the next refresh, so batching this to every Nth
// line is plenty, and cheap.
const TTL_REFRESH_EVERY_N_LINES = 20;

function metaKey(sessionId) {
  return `mimic:session:${sessionId}:meta`;
}

function transcriptKey(sessionId) {
  return `mimic:session:${sessionId}:transcript`;
}

async function createSession({ guildId, channelId, textChannelId, startedBy }) {
  const sessionId = crypto.randomUUID();
  const pipeline = redis.pipeline();
  pipeline.hset(metaKey(sessionId), {
    guildId,
    channelId,
    textChannelId,
    startedBy,
    startedAt: Date.now(),
  });
  pipeline.expire(metaKey(sessionId), SESSION_TTL_SECONDS);
  await pipeline.exec();
  return sessionId;
}

// speakerId is stored as the raw Discord user ID, not a display name —
// resolving it to something readable needs a guild member lookup, which is
// a discord.js concern this module deliberately stays free of. That's left
// to whatever builds the notes-generation prompt.
async function appendLine(sessionId, { speakerId, text, timestamp }) {
  // Normalise whitespace: this is a single Redis list element parsed back
  // out with a `^`-anchored multiline regex (see mimic.js's
  // resolveSpeakerNames) — an embedded newline from whisper would break
  // that parse.
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  const line = `[${new Date(timestamp).toISOString()}] ${speakerId}: ${normalizedText}`;
  const length = await redis.rpush(transcriptKey(sessionId), line);
  if (length % TTL_REFRESH_EVERY_N_LINES === 0) {
    const pipeline = redis.pipeline();
    pipeline.expire(transcriptKey(sessionId), SESSION_TTL_SECONDS);
    pipeline.expire(metaKey(sessionId), SESSION_TTL_SECONDS);
    await pipeline.exec();
  }
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
// destroy the only copy of the session, but cap it with SESSION_TTL_SECONDS.
async function markFailed(sessionId) {
  const pipeline = redis.pipeline();
  pipeline.expire(metaKey(sessionId), SESSION_TTL_SECONDS);
  pipeline.expire(transcriptKey(sessionId), SESSION_TTL_SECONDS);
  await pipeline.exec();
}

module.exports = {
  createSession,
  appendLine,
  getTranscriptText,
  getSessionMeta,
  deleteSession,
  markFailed,
};
