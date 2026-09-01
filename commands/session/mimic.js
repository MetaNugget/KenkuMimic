const { SlashCommandBuilder } = require('discord.js');
const sessionState = require('../../lib/sessionState');
const transcriptStore = require('../../lib/transcriptStore');
const notesClient = require('../../lib/notesClient');
const transcription = require('../../lib/transcription');
const { startCapture } = require('../../lib/voiceCapture');

const DISCORD_MESSAGE_LIMIT = 2000;

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

async function executeStart(interaction) {
  const guildId = interaction.guildId;

  if (sessionState.hasActiveSession(guildId)) {
    await interaction.reply({
      content: '🐦‍⬛ The flock is already recording a session in this server — wrap that one up with `/mimic end` first.',
      ephemeral: true,
    });
    return;
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    await interaction.reply({
      content: '🐦‍⬛ Join a voice channel first, then call the flock with `/mimic start`.',
      ephemeral: true,
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
        adapter
          .sendAudio(pcmChunk, speakerId)
          .catch((err) => console.error(`[mimic] failed to send audio for speaker ${speakerId}:`, err.message));
      },
    });

    sessionState.finalizeSession(guildId, { sessionId, voiceCapture, transcriptionAdapter: adapter });

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
    await interaction.reply({ content: '🐦‍⬛ No active session in this server to end.', ephemeral: true });
    return;
  }

  // Claimed synchronously, same reasoning as the reserve in executeStart:
  // a second /mimic end landing concurrently must not tear down (or
  // double-bill notesClient for) the same session twice.
  sessionState.endSession(guildId);

  await interaction.deferReply();

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
    await interaction.editReply({ content: '🐦‍⬛ The flock landed, but nobody said a word — no notes to write up.' });
    return;
  }

  const transcriptText = await resolveSpeakerNames(interaction.guild, rawTranscript);

  let notes;
  try {
    notes = await notesClient.generateNotes(transcriptText);
  } catch (err) {
    console.error(`[mimic] notes generation failed for session ${session.sessionId}:`, err);
    await transcriptStore.markFailed(session.sessionId);
    await interaction.editReply({
      content:
        `🐦‍⬛ Recording stopped, but notes generation failed: ${err.message}. The transcript is kept for a couple ` +
        'of days in case this needs a manual retry.',
    });
    return;
  }

  const textChannel = await interaction.client.channels.fetch(session.textChannelId);
  const chunks = chunkText(`🐦‍⬛ Session notes from the flock:\n\n${notes}`, DISCORD_MESSAGE_LIMIT);
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
