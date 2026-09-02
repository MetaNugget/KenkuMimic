const { SlashCommandBuilder, MessageFlags, Routes } = require('discord.js');
const sessionState = require('../../lib/sessionState');
const transcriptStore = require('../../lib/transcriptStore');
const notesClient = require('../../lib/notesClient');
const transcription = require('../../lib/transcription');
const { startCapture } = require('../../lib/voiceCapture');

const DISCORD_MESSAGE_LIMIT = 2000;

const RECORDING_VOICE_STATUS = '🐦‍⬛ Recording for session notes';

// discord.js has no high-level wrapper for this yet — it's a plain REST
// call (PUT /channels/{id}/voice-status, added to Discord's API well after
// this project's discord.js version). Persistent and visible to anyone who
// joins the channel later, unlike the text-channel announcement at
// /mimic start, which only reaches whoever's already looking when it posts.
// Needs the "Set Voice Channel Status" permission — failure here (missing
// permission, channel gone) shouldn't block or unwind session start/end, so
// it's caught and logged rather than thrown.
async function setVoiceChannelStatus(client, channelId, status) {
  try {
    await client.rest.put(`${Routes.channel(channelId)}/voice-status`, { body: { status } });
  } catch (err) {
    console.error(`[mimic] failed to set voice channel status for ${channelId}:`, err.message);
  }
}

// No PCM chunks from any speaker for this long auto-ends the session — the
// backstop for "everyone went to bed and forgot /mimic end", which is far
// more likely than the 6h in-process safety timer in selfhosted.js ever
// firing (that one covers a hung session, not an empty one).
const IDLE_END_MINUTES = Number(process.env.MIMIC_IDLE_TIMEOUT_MINUTES) || 15;
const IDLE_END_MS = IDLE_END_MINUTES * 60 * 1000;

// How often the idle watch checks elapsed silence, not how precisely it
// fires — onPcmChunk arrives ~50 times/sec per speaker, so tracking
// `lastAudioAt` as a plain field write there and checking it from one
// interval per session (instead of a clearTimeout+setTimeout+unref on every
// chunk) is a lot cheaper on a 2GB Pi already running three bots, at the
// cost of the auto-end firing up to this long after the true deadline.
const IDLE_CHECK_INTERVAL_MS = 30_000;

// transcriptStore deliberately stores raw Discord user IDs, not names (see
// its own comment) — resolving them to display names needs a guild member
// lookup, which belongs here, not in a Discord-API-free store module. A
// speaker who left the server between talking and /mimic end can't be
// resolved; that's not fatal, just falls back to a labeled placeholder.
async function resolveSpeakerNames(guild, transcriptText) {
  const ids = [...new Set([...transcriptText.matchAll(/^\[.*?\] (\d+):/gm)].map((m) => m[1]))];
  const names = new Map();

  await Promise.all(
    ids.map(async (id) => {
      try {
        const member = guild.members.cache.get(id) ?? (await guild.members.fetch(id));
        names.set(id, member.displayName);
      } catch {
        names.set(id, `Unknown User (${id})`);
      }
    }),
  );

  return transcriptText.replace(/^\[(.*?)\] (\d+):/gm, (_match, timestamp, id) => `[${timestamp}] ${names.get(id)}:`);
}

// Splits on paragraph, then line, boundaries before falling back to a hard
// cut, so a multi-section notes post reads cleanly across several messages
// instead of breaking mid-sentence.
function chunkText(text, maxLength) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// Shared by the interactive /mimic end path and both auto-end triggers
// (dropped voice connection, idle timeout) — everything from here down is
// identical regardless of what ended the session, only how the result gets
// communicated differs at each call site.
async function teardownAndGenerateNotes(guildId, session, client) {
  await setVoiceChannelStatus(client, session.channelId, null);

  try {
    await session.voiceCapture.stop();
  } catch (err) {
    console.error(`[mimic] error leaving voice for guild ${guildId}:`, err.message);
  }
  try {
    await session.transcriptionAdapter.close();
  } catch (err) {
    console.error(`[mimic] error closing transcription adapter for guild ${guildId} (check for a leaked GPU instance):`, err.message);
  }

  const rawTranscript = await transcriptStore.getTranscriptText(session.sessionId);
  if (!rawTranscript.trim()) {
    await transcriptStore.deleteSession(session.sessionId);
    return { status: 'empty' };
  }

  return { status: 'transcribed', rawTranscript };
}

async function generateNotesOrMarkFailed(session, guild) {
  const transcriptText = await resolveSpeakerNames(guild, session.rawTranscript);
  try {
    return { status: 'ok', notes: await notesClient.generateNotes(transcriptText) };
  } catch (err) {
    console.error(`[mimic] notes generation failed for session ${session.sessionId}:`, err);
    await transcriptStore.markFailed(session.sessionId);
    return { status: 'notes-failed', error: err };
  }
}

// No PCM chunks from any speaker for IDLE_END_MS, or a dropped voice
// connection that didn't recover, ends the session the same way /mimic end
// would but with nobody around to run the command — the GPU keeps billing
// and no audio flows otherwise (see README's cost-control notes).
async function autoEndSession(guildId, client, guild, noticeText) {
  const session = sessionState.getSession(guildId);
  if (!session) return; // already ended, e.g. raced with a manual /mimic end
  sessionState.endSession(guildId);
  clearInterval(session.idleTimer);

  const textChannel = await client.channels.fetch(session.textChannelId).catch((err) => {
    console.error(`[mimic] failed to fetch text channel for guild ${guildId} auto-end:`, err.message);
    return null;
  });
  const post = async (content) => {
    if (!textChannel) return;
    await textChannel.send({ content }).catch((err) => console.error(`[mimic] failed to post auto-end message for guild ${guildId}:`, err.message));
  };

  await post(noticeText);

  const teardown = await teardownAndGenerateNotes(guildId, session, client);
  if (teardown.status === 'empty') {
    await post('🐦‍⬛ No notes to write up — nobody said a word before the flock left.');
    return;
  }

  const result = await generateNotesOrMarkFailed({ ...session, rawTranscript: teardown.rawTranscript }, guild);
  if (result.status === 'notes-failed') {
    await post(
      `🐦‍⬛ Notes generation failed: ${result.error.message}. The transcript is kept for a couple of days in case this needs a manual retry.`,
    );
    return;
  }

  if (textChannel) {
    const chunks = chunkText(`🐦‍⬛ Session notes from the flock:\n\n${result.notes}`, DISCORD_MESSAGE_LIMIT);
    for (const chunk of chunks) {
      await textChannel.send({ content: chunk }).catch((err) => console.error(`[mimic] failed to post notes chunk for guild ${guildId}:`, err.message));
    }
  }
  await transcriptStore.deleteSession(session.sessionId);
}

// Started once right after a session comes up. onPcmChunk just stamps
// session.lastAudioAt on every chunk (a plain field write); this interval is
// the only thing that ever reads it and decides whether to end the session.
function startIdleWatch(guildId, client, guild) {
  const session = sessionState.getSession(guildId);
  if (!session) return;
  session.lastAudioAt = Date.now();
  session.idleTimer = setInterval(() => {
    const current = sessionState.getSession(guildId);
    if (!current) return; // already ended some other way
    if (Date.now() - current.lastAudioAt < IDLE_END_MS) return;
    autoEndSession(
      guildId,
      client,
      guild,
      `🐦‍⬛ No one's said anything in ${IDLE_END_MINUTES} minutes — the flock is calling it and wrapping up the session automatically.`,
    ).catch((err) => console.error(`[mimic] idle auto-end failed for guild ${guildId}:`, err.message));
  }, IDLE_CHECK_INTERVAL_MS);
  session.idleTimer.unref?.();
}

async function executeStart(interaction) {
  const guildId = interaction.guildId;

  if (sessionState.hasActiveSession(guildId)) {
    await interaction.reply({
      content: '🐦‍⬛ The flock is already recording a session in this server — wrap that one up with `/mimic end` first.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    await interaction.reply({
      content: '🐦‍⬛ Join a voice channel first, then call the flock with `/mimic start`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Claimed synchronously, before any await, so a second /mimic start
  // landing concurrently can't slip past the hasActiveSession check above
  // while this one is still mid-setup — see sessionState.js.
  sessionState.reserveSession(guildId, {
    startedBy: interaction.user.id,
    channelId: voiceChannel.id,
    textChannelId: interaction.channelId,
  });

  let sessionId;
  let adapter;

  try {
    // Public, not ephemeral — GPU cold starts can run ~20-60s, and this
    // "thinking" indicator gets replaced by the real consent announcement
    // once the pipeline is actually live, not before.
    await interaction.deferReply();
    await interaction.editReply({ content: '🐦‍⬛ Heard you — gathering the flock for this session...' });

    sessionId = await transcriptStore.createSession({
      guildId,
      channelId: voiceChannel.id,
      textChannelId: interaction.channelId,
      startedBy: interaction.user.id,
    });

    adapter = transcription.createAdapter();
    adapter.onTranscript(({ speakerId, text, timestamp }) => {
      transcriptStore
        .appendLine(sessionId, { speakerId, text, timestamp })
        .catch((err) => console.error(`[mimic] failed to append transcript line for session ${sessionId}:`, err.message));
    });

    // Technical, not kenku-flavored — during a slow or failing GPU cold
    // start these edits are the diagnostic trail: if the pipeline never
    // comes up, whichever stage this message is frozen on is where it
    // stalled. The final editReply below drops back into kenku flavor once
    // the pipeline is actually live.
    await adapter.connect((stage) => interaction.editReply({ content: stage }).catch(() => {}));

    const voiceCapture = await startCapture({
      channel: voiceChannel,
      onPcmChunk: (pcmChunk, speakerId) => {
        const session = sessionState.getSession(guildId);
        if (session) session.lastAudioAt = Date.now();
        adapter
          .sendAudio(pcmChunk, speakerId)
          .catch((err) => console.error(`[mimic] failed to send audio for speaker ${speakerId}:`, err.message));
      },
      onDisconnected: () => {
        autoEndSession(
          guildId,
          interaction.client,
          voiceChannel.guild,
          "🐦‍⬛ The flock got knocked out of the voice channel and couldn't reconnect — wrapping up the session automatically.",
        ).catch((err) => console.error(`[mimic] disconnect auto-end failed for guild ${guildId}:`, err.message));
      },
    });

    sessionState.finalizeSession(guildId, { sessionId, voiceCapture, transcriptionAdapter: adapter });
    startIdleWatch(guildId, interaction.client, voiceChannel.guild);
    await setVoiceChannelStatus(interaction.client, voiceChannel.id, RECORDING_VOICE_STATUS);

    await interaction.editReply({
      content:
        `🐦‍⬛ The flock has landed in ${voiceChannel} and is listening — everything said here gets transcribed for ` +
        'session notes. Run `/mimic end` when the session wraps up.',
    });
  } catch (err) {
    sessionState.endSession(guildId);
    if (adapter) await adapter.close().catch(() => {});
    if (sessionId) await transcriptStore.deleteSession(sessionId).catch(() => {});
    throw err; // index.js's InteractionCreate handler produces the user-facing error reply
  }
}

async function executeEnd(interaction) {
  const guildId = interaction.guildId;
  const session = sessionState.getSession(guildId);

  if (!session) {
    await interaction.reply({ content: '🐦‍⬛ No active session in this server to end.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Claimed synchronously, same reasoning as the reserve in executeStart:
  // a second /mimic end landing concurrently must not tear down (or
  // double-bill notesClient for) the same session twice.
  sessionState.endSession(guildId);
  clearInterval(session.idleTimer);

  await interaction.deferReply();

  const teardown = await teardownAndGenerateNotes(guildId, session, interaction.client);
  if (teardown.status === 'empty') {
    await interaction.editReply({ content: '🐦‍⬛ The flock landed, but nobody said a word — no notes to write up.' });
    return;
  }

  const result = await generateNotesOrMarkFailed({ ...session, rawTranscript: teardown.rawTranscript }, interaction.guild);
  if (result.status === 'notes-failed') {
    await interaction.editReply({
      content:
        `🐦‍⬛ Recording stopped, but notes generation failed: ${result.error.message}. The transcript is kept for a couple ` +
        'of days in case this needs a manual retry.',
    });
    return;
  }

  const textChannel = await interaction.client.channels.fetch(session.textChannelId);
  const chunks = chunkText(`🐦‍⬛ Session notes from the flock:\n\n${result.notes}`, DISCORD_MESSAGE_LIMIT);
  for (const chunk of chunks) {
    await textChannel.send({ content: chunk });
  }

  await transcriptStore.deleteSession(session.sessionId);

  await interaction.editReply({
    content:
      session.textChannelId === interaction.channelId
        ? '🐦‍⬛ Recording stopped — notes posted above.'
        : `🐦‍⬛ Recording stopped — notes posted in <#${session.textChannelId}>.`,
  });
}

// No setDefaultMemberPermissions restriction — anyone in the server can
// start or end a session; a guild admin can still restrict either
// subcommand via Discord's Integrations UI if needed.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('mimic')
    .setDescription('Kenku-powered session transcription and notes for your TTRPG sessions')
    .addSubcommand((sub) =>
      sub.setName('start').setDescription('Join your voice channel and start transcribing the session'),
    )
    .addSubcommand((sub) => sub.setName('end').setDescription('Stop transcribing, leave voice, and post session notes')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'start') return executeStart(interaction);
    if (sub === 'end') return executeEnd(interaction);
  },
};
