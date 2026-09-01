const { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const prism = require('prism-media');
const { Transform, pipeline } = require('node:stream');

const SILENCE_DURATION_MS = 1000;
const JOIN_TIMEOUT_MS = 20_000;

// Discord sends 48kHz stereo Opus; every STT backend here wants 16kHz mono.
// prism-media ships no resampler, and pulling in an ffmpeg subprocess for a
// plain 3:1 ratio is unnecessary weight on a Pi — downmix stereo (average
// L+R), then average each block of 3 samples, is a cheap boxcar low-pass
// ahead of the decimation. Applied uniformly for every provider: Deepgram
// would accept 48kHz directly, but AssemblyAI silently garbles output on a
// rate mismatch (no error) and self-hosted Whisper needs 16kHz too — one
// shared normalization point is safer than a provider-conditional path.
// Expects buf.length to be an exact multiple of 12 bytes (3 stereo
// 16-bit frames); Downsampler below guarantees that at the call site.
function downsampleTo16kMono(buf) {
  const samplesOut = buf.length / 12;
  const out = Buffer.alloc(samplesOut * 2);

  for (let i = 0; i < samplesOut; i++) {
    let sum = 0;
    for (let j = 0; j < 3; j++) {
      const offset = i * 12 + j * 4;
      const left = buf.readInt16LE(offset);
      const right = buf.readInt16LE(offset + 2);
      sum += (left + right) / 2;
    }
    out.writeInt16LE(Math.round(sum / 3), i * 2);
  }

  return out;
}

// Decoded Opus arrives in arbitrary-sized chunks that aren't guaranteed to
// land on a 12-byte (3-frame) boundary, so leftover bytes carry over to the
// next chunk rather than being dropped or misread.
class Downsampler extends Transform {
  constructor() {
    super();
    this._leftover = Buffer.alloc(0);
  }

  _transform(chunk, encoding, callback) {
    const combined = Buffer.concat([this._leftover, chunk]);
    const groupBytes = Math.floor(combined.length / 12) * 12;

    if (groupBytes > 0) {
      this.push(downsampleTo16kMono(combined.subarray(0, groupBytes)));
    }
    this._leftover = combined.subarray(groupBytes);
    callback();
  }
}

// Joins a voice channel and starts capturing every speaker's audio
// individually — Discord already separates audio per speaker, so this is
// free speaker attribution with no diarization step needed. onPcmChunk is
// called as (pcmChunk, speakerId) with 16kHz mono PCM16LE, matching a
// transcription adapter's sendAudio(pcmChunk, speakerId) signature exactly
// so wiring the two together at the call site is direct.
async function startCapture({ channel, onPcmChunk }) {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false, // required to receive voice data at all, not just a presence flag
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
  } catch (err) {
    connection.destroy();
    throw new Error(`Could not join voice channel ${channel.id}: ${err.message}`);
  }

  connection.on('stateChange', (_oldState, newState) => {
    if (newState.status === VoiceConnectionStatus.Disconnected || newState.status === VoiceConnectionStatus.Destroyed) {
      console.error(`[voiceCapture] voice connection for guild ${channel.guild.id} left state unexpectedly: ${newState.status}`);
    }
  });

  const receiver = connection.receiver;
  const activeStreams = new Set();

  function handleSpeakingStart(userId) {
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_DURATION_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const downsampler = new Downsampler();

    activeStreams.add(opusStream);
    opusStream.once('close', () => activeStreams.delete(opusStream));

    downsampler.on('data', (pcmChunk) => onPcmChunk(pcmChunk, userId));

    // pipeline (not chained .pipe()) so destroying opusStream in stop()
    // properly cascades destruction through decoder and downsampler too.
    pipeline(opusStream, decoder, downsampler, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error(`[voiceCapture] capture pipeline error for speaker ${userId}:`, err.message);
      }
    });
  }

  receiver.speaking.on('start', handleSpeakingStart);

  return {
    connection,
    async stop() {
      receiver.speaking.off('start', handleSpeakingStart);
      for (const stream of activeStreams) stream.destroy();
      connection.destroy();
    },
  };
}

module.exports = { startCapture };
