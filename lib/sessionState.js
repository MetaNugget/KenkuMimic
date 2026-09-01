// Live per-session state, kept in memory rather than Redis (unlike
// transcriptStore.js): a live @discordjs/voice connection and an open
// provider websocket can't be serialized into Redis or survive a process
// restart regardless, so there's nothing to gain by round-tripping them
// through it. Enforces at most one active session per guild — different
// guilds can run concurrent sessions, this just scopes the lock per guild.

const sessions = new Map(); // guildId -> session

function hasActiveSession(guildId) {
  return sessions.has(guildId);
}

// Synchronously claims the guild's session slot before any async setup
// (joining voice, connecting a transcription adapter) begins. Without this,
// two /mimic start calls landing concurrently could both pass a
// hasActiveSession check before either finishes its slow async setup —
// exactly the "more than one active session per guild" scenario v1
// explicitly disallows.
function reserveSession(guildId, { startedBy, channelId, textChannelId }) {
  if (sessions.has(guildId)) {
    throw new Error(`Guild ${guildId} already has an active session`);
  }
  sessions.set(guildId, {
    startedBy,
    channelId,
    textChannelId,
    sessionId: null,
    voiceCapture: null,
    transcriptionAdapter: null,
  });
}

// Fills in the live pieces once async setup completes successfully.
function finalizeSession(guildId, { sessionId, voiceCapture, transcriptionAdapter }) {
  const session = sessions.get(guildId);
  if (!session) {
    throw new Error(`No reserved session for guild ${guildId}`);
  }
  Object.assign(session, { sessionId, voiceCapture, transcriptionAdapter });
  return session;
}

function getSession(guildId) {
  return sessions.get(guildId) ?? null;
}

function endSession(guildId) {
  sessions.delete(guildId);
}

// For process-shutdown cleanup (see index.js) — not for a runtime feature,
// v1 has no admin/list-all-sessions command.
function getAllSessions() {
  return [...sessions.entries()];
}

module.exports = { hasActiveSession, reserveSession, finalizeSession, getSession, endSession, getAllSessions };
