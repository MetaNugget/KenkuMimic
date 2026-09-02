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

  // Default trailingSilenceMs is fine here: the rejection handler clears
  // the failed attempt's own silence timer synchronously (see the timer-
  // guard regression test below), so it no longer lingers after the entry
  // is gone.
  const pool = createSpeakerPool({ openConnection, closeConnection });

  await assert.rejects(() => pool.send('speaker-1', 'a'));
  await pool.send('speaker-1', 'b');

  assert.equal(attempt, 2);
  assert.deepEqual(sent, ['b']);

  await pool.closeAll();
});

test("a failed attempt's stale silence timer does not evict a healthy retry", async () => {
  const trailingSilenceMs = 200;
  let openCalls = 0;
  const sent = [];
  const closedConns = [];

  async function openConnection() {
    openCalls++;
    if (openCalls === 1) {
      throw new Error('simulated handshake failure');
    }
    const conn = {
      send(chunk) {
        sent.push(chunk);
      },
    };
    return conn;
  }

  async function closeConnection(conn) {
    closedConns.push(conn);
  }

  const pool = createSpeakerPool({ openConnection, closeConnection }, { trailingSilenceMs });

  // entry1 fails; its silence timer was scheduled (then should have been
  // cleared by the rejection handler) at roughly t=0.
  await assert.rejects(() => pool.send('speaker-1', 'a'));
  // entry2 (healthy) is created immediately after, at roughly t=0 too.
  await pool.send('speaker-1', 'b');

  // Keep entry2 alive with sends spaced well under trailingSilenceMs, for
  // well past the point where entry1's silence timer would originally have
  // fired (t=200ms) -- if that stale timer weren't cleared, it would
  // unconditionally delete whatever occupies this speakerId by then, which
  // is entry2, actively in use.
  for (let i = 0; i < 4; i++) {
    await delay(60);
    await pool.send('speaker-1', `chunk-${i}`);
  }

  assert.equal(openCalls, 2); // never evicted and re-opened a third connection
  assert.equal(closedConns.length, 0); // the healthy connection was never closed
  assert.deepEqual(sent, ['b', 'chunk-0', 'chunk-1', 'chunk-2', 'chunk-3']);

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
