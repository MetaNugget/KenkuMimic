const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpeakerPool } = require('../lib/transcription/speakerPool');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('send() opens exactly one connection per speaker under a synchronous burst, in order', async () => {
  let openConnectionCalls = 0;
  const sent = [];

  async function openConnection(speakerId) {
    openConnectionCalls++;
    await delay(20); // simulates the two-round-trip WebSocket handshake
    return {
      send(chunk) {
        sent.push(chunk);
      },
    };
  }

  async function closeConnection() {}

  const pool = createSpeakerPool({ openConnection, closeConnection });

  // Fire 10 chunks synchronously, before the handshake above has any chance
  // to resolve -- this is the burst that used to see `undefined` in the
  // connections map and each open its own socket.
  const sends = [];
  for (let i = 0; i < 10; i++) {
    sends.push(pool.send('speaker-1', i));
  }
  await Promise.all(sends);

  assert.equal(openConnectionCalls, 1);
  assert.deepEqual(sent, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  await pool.closeAll();
});

test('a speaker whose connection fails to open retries on the next chunk', async () => {
  let attempt = 0;
  const sent = [];

  async function openConnection() {
    attempt++;
    if (attempt === 1) {
      throw new Error('simulated handshake failure');
    }
    return {
      send(chunk) {
        sent.push(chunk);
      },
    };
  }

  async function closeConnection() {}

  // Short trailing-silence window so the failed attempt's own silence timer
  // (set before openConnection's outcome is known) doesn't linger for the
  // default 1500ms and log a stray "error closing connection" line once it
  // fires against the already-rejected connPromise.
  const pool = createSpeakerPool({ openConnection, closeConnection }, { trailingSilenceMs: 10 });

  await assert.rejects(() => pool.send('speaker-1', 'a'));
  await pool.send('speaker-1', 'b');

  assert.equal(attempt, 2);
  assert.deepEqual(sent, ['b']);

  await pool.closeAll();
});

test('different speakers get independent connections', async () => {
  const opened = [];

  async function openConnection(speakerId) {
    opened.push(speakerId);
    return { send() {} };
  }

  async function closeConnection() {}

  const pool = createSpeakerPool({ openConnection, closeConnection });

  await Promise.all([pool.send('speaker-1', 'x'), pool.send('speaker-2', 'y')]);

  assert.deepEqual(opened.sort(), ['speaker-1', 'speaker-2']);

  await pool.closeAll();
});
