'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Integration tests: boot the REAL merged player
 * (node-sound-player-production.js) in a child process with hardware/network
 * modules faked via a preload script, then exercise its HTTP control API the
 * same way the web remote (public/index.html) does.
 *
 * Requires node_modules to be installed (express etc.). If they aren't,
 * the suite is skipped rather than failing — handy for bare checkouts.
 */

const APP_DIR = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'support', 'serverPreload.js');
const ENTRY = path.join(APP_DIR, 'node-sound-player-production.js');
const PORT = 3000 + Math.floor(Math.random() * 5000);
const BASE = `http://127.0.0.1:${PORT}`;

let expressAvailable = true;
try {
  require.resolve('express', { paths: [APP_DIR] });
} catch {
  expressAvailable = false;
}

function postValue(value) {
  return fetch(`${BASE}/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `value=${value}`,
  });
}

async function waitForServer(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/volumeData`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('player server did not start in time');
}

test('player HTTP control API', { skip: !expressAvailable && 'node_modules not installed (run npm install)' }, async (t) => {
  // -- arrange: temp playlist the fake player will "play" -------------------
  const playlistFile = path.join(os.tmpdir(), `tracks-int-${Date.now()}.txt`);
  fs.writeFileSync(playlistFile, 'songA.mp3\nsongB.mp3\nsongC.mp3\n', 'utf8');

  const child = spawn(process.execPath, ['--require', PRELOAD, ENTRY], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: String(PORT), TEST_PLAYLIST_FILE: playlistFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let childOutput = '';
  child.stdout.on('data', (d) => (childOutput += d));
  child.stderr.on('data', (d) => (childOutput += d));

  t.after(() => {
    child.kill('SIGKILL');
    fs.rmSync(playlistFile, { force: true });
  });

  try {
    await waitForServer();
  } catch (err) {
    throw new Error(`${err.message}\n--- player output ---\n${childOutput}`);
  }

  // -- volume reporting ------------------------------------------------------
  await t.test('GET /volumeData returns the initial volume (80)', async () => {
    const res = await fetch(`${BASE}/volumeData`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '80');
  });

  // -- like / dislike scheduling ----------------------------------------------
  await t.test('POST value=like schedules a like for the current track', async () => {
    const res = await postValue('like');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.message, 'like scheduled');
    // One of the playlist tracks must be playing
    assert.match(body.currentTrackName, /^song[ABC]\.mp3$/);
  });

  await t.test('POST value=dislike schedules a dislike', async () => {
    const res = await postValue('dislike');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.message, 'dislike scheduled');
  });

  // -- volume control -----------------------------------------------------------
  await t.test('volumeUp raises volume by 2', async () => {
    const res = await postValue('volumeUp');
    assert.equal(await res.text(), '82');
  });

  await t.test('volumeDown lowers volume by 2', async () => {
    const res = await postValue('volumeDown');
    assert.equal(await res.text(), '80');
    const data = await fetch(`${BASE}/volumeData`);
    assert.equal(await data.text(), '80');
  });

  await t.test('volume is clamped at 100 (responds "max")', async () => {
    for (let n = 0; n < 10; n++) await postValue('volumeUp');
    const res = await postValue('volumeUp');
    assert.equal(await res.text(), 'max');
    for (let n = 0; n < 10; n++) await postValue('volumeDown');
  });

  await t.test('volume is clamped at 0 (responds "min")', async () => {
    for (let n = 0; n < 40; n++) await postValue('volumeDown');
    const res = await postValue('volumeDown');
    assert.equal(await res.text(), 'min');
  });

  // -- "what's playing" fall-through (fixed: used to crash with 500) -----------
  await t.test('unknown value returns current track and playlist name', async () => {
    const res = await postValue('whatIsPlaying');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 2);
    assert.match(body[0], /^song[ABC]\.mp3$/);
    assert.equal(body[1], 'all list');
  });
});
