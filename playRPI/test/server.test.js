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
  await t.test('GET /volumeData returns the volume from playerConfig (76)', async () => {
    // the preload config sets a NON-default volume — proves it's config-driven
    const res = await fetch(`${BASE}/volumeData`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '76');
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
    assert.equal(await res.text(), '78');
  });

  await t.test('volumeDown lowers volume by 2', async () => {
    const res = await postValue('volumeDown');
    assert.equal(await res.text(), '76');
    const data = await fetch(`${BASE}/volumeData`);
    assert.equal(await data.text(), '76');
  });

  await t.test('volume is clamped at 100 (responds "max")', async () => {
    for (let n = 0; n < 12; n++) await postValue('volumeUp'); // 76 → 100
    const res = await postValue('volumeUp');
    assert.equal(await res.text(), 'max');
    for (let n = 0; n < 12; n++) await postValue('volumeDown'); // back to 76
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

// ---------------------------------------------------------------------------
// PLAY LOOP
//
// The tests above only reach the express half of the player, because the fake
// sound-player never finishes a track. With FAKE_TRACK_MS set it does, which
// drives the actual loop: playSong → 'complete' → loadNextTrack → playSong.
//
// Each scenario boots its OWN player process on its own port: the loop mutates
// module-level state (current index, current playlist, the playlist file), so
// sharing one process between them would make the tests order-dependent.
// ---------------------------------------------------------------------------

let portCursor = PORT + 1;
function nextPort() {
  return portCursor++;
}

function tmpPlaylist(name, tracks) {
  const file = path.join(os.tmpdir(), `tracks-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(file, tracks.join('\n') + '\n', 'utf8');
  return file;
}

/** Boot the real player with the given env; killed and cleaned up after the test. */
function startPlayer(t, port, env) {
  const child = spawn(process.execPath, ['--require', PRELOAD, ENTRY], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  return { child, getOutput: () => output };
}

function makeClient(port) {
  const base = `http://127.0.0.1:${port}`;
  const post = (value) =>
    fetch(`${base}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `value=${value}`,
    });

  return {
    post,
    async waitUp(timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${base}/volumeData`);
          if (res.ok) return;
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('player server did not start in time');
    },
    /** [currentTrackName, '<playlist> list'] — the same call the web remote makes. */
    async nowPlaying() {
      const body = await (await post('whatIsPlaying')).json();
      return { track: body[0], playlist: body[1] };
    },
  };
}

async function waitUntil(fn, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function readFetchLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const skipNoExpress = !expressAvailable && 'node_modules not installed (run npm install)';

test('play loop: the next track starts when the current one finishes', { skip: skipNoExpress }, async (t) => {
  const playlistFile = tmpPlaylist('advance', ['adv1.mp3', 'adv2.mp3', 'adv3.mp3', 'adv4.mp3']);
  t.after(() => fs.rmSync(playlistFile, { force: true }));

  const port = nextPort();
  const { getOutput } = startPlayer(t, port, {
    TEST_PLAYLIST_FILE: playlistFile,
    FAKE_TRACK_MS: '150',
  });
  const client = makeClient(port);
  await client.waitUp();

  // Poll the remote until we've seen the player move on to a different track.
  const seen = new Set();
  const advanced = await waitUntil(async () => {
    const { track } = await client.nowPlaying();
    if (track) seen.add(track);
    return seen.size >= 2;
  });

  assert.ok(advanced, `player never advanced past "${[...seen]}"\n--- player output ---\n${getOutput()}`);
  for (const track of seen) assert.match(track, /^adv[1-4]\.mp3$/);
});

test('play loop: playlist switches when its time window ends', { skip: skipNoExpress }, async (t) => {
  // Two windows meeting at 12:05, fake clock starting at 12:00 and running 60x:
  // the boundary lands ~5 real seconds after the CHILD starts (the clock's zero
  // point is the preload, not this test). That margin is the whole trick — with
  // the boundary one fake minute out, a slow boot would eat it and the player
  // would already be in the late window before the first assertion ran.
  const earlyFile = tmpPlaylist('early', ['early1.mp3', 'early2.mp3']);
  const lateFile = tmpPlaylist('late', ['late1.mp3', 'late2.mp3']);
  t.after(() => {
    fs.rmSync(earlyFile, { force: true });
    fs.rmSync(lateFile, { force: true });
  });

  const port = nextPort();
  const { getOutput } = startPlayer(t, port, {
    TEST_PLAYLISTS_JSON: JSON.stringify([
      { name: 'early', file: earlyFile, start: '00:00', end: '12:05', tableId: 'tbl-EARLY' },
      { name: 'late', file: lateFile, start: '12:05', end: '24:00', tableId: 'tbl-LATE' },
    ]),
    TEST_CLOCK_START: '12:00',
    TEST_CLOCK_SCALE: '60',
    FAKE_TRACK_MS: '400',
  });
  const client = makeClient(port);
  await client.waitUp();

  // Which playlist it booted into is a fact the player logs ONCE, at init — so
  // this holds no matter when the test gets around to looking. Polling the HTTP
  // API for it instead would be a race against the clock.
  assert.match(
    getOutput(),
    /Активный плейлист: "early"/,
    `player did not boot into the early window — boot took longer than the 5s margin?\n--- player output ---\n${getOutput()}`
  );

  // The TRACK name is the real evidence for the switch: the playlist name in
  // the HTTP response is recomputed from the clock, so it would flip to "late"
  // even if the loop never switched lists.
  const switched = await waitUntil(
    async () => {
      const { track } = await client.nowPlaying();
      return /^late[12]\.mp3$/.test(track);
    },
    { timeoutMs: 25000 }
  );

  assert.ok(switched, `player never switched to the late playlist\n--- player output ---\n${getOutput()}`);
  assert.match(getOutput(), /Переключение плейлиста/);
});

test('dislike: the track is removed from the playlist file when it finishes', { skip: skipNoExpress }, async (t) => {
  const tracks = ['dis1.mp3', 'dis2.mp3', 'dis3.mp3'];
  const playlistFile = tmpPlaylist('dislike', tracks);
  const fetchLog = path.join(os.tmpdir(), `fetch-dislike-${Date.now()}.log`);
  t.after(() => {
    fs.rmSync(playlistFile, { force: true });
    fs.rmSync(fetchLog, { force: true });
  });

  const port = nextPort();
  const { getOutput } = startPlayer(t, port, {
    TEST_PLAYLIST_FILE: playlistFile,
    FAKE_TRACK_MS: '400',
    TEST_FETCH_LOG: fetchLog,
  });
  const client = makeClient(port);
  await client.waitUp();

  const body = await (await client.post('dislike')).json();
  assert.equal(body.message, 'dislike scheduled');

  // The deletion happens when the track finishes, not when the vote lands.
  const linesOf = () =>
    fs.readFileSync(playlistFile, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  const removed = await waitUntil(() => linesOf().length === tracks.length - 1);

  assert.ok(removed, `nothing was removed from the playlist file\n--- player output ---\n${getOutput()}`);

  // Exactly one line gone, and it was one of ours — asserting *which* one would
  // be racy: the vote applies to whichever track completes next.
  const left = linesOf();
  const gone = tracks.filter((tr) => !left.includes(tr));
  assert.equal(gone.length, 1);
  assert.ok(tracks.includes(gone[0]));

  // ...and the vote really went out to the cloud function.
  const sentDislike = await waitUntil(() =>
    readFetchLog(fetchLog).some(
      (e) => e.url.endsWith('/updateRecordStatus') && JSON.parse(e.body).newStatus === 'Dislike'
    )
  );
  assert.ok(sentDislike, `dislike was never POSTed\n--- player output ---\n${getOutput()}`);
});

// SIGUSR2 is what deploy/update.mjs sends. Windows cannot deliver it at all
// (libuv rejects the signal), so this one only runs on the platform the
// player actually ships to.
const skipNoSignals =
  skipNoExpress ||
  (process.platform === 'win32' && 'SIGUSR2 cannot be sent on Windows — run this on Linux/the Pi');

test('SIGUSR2: finishes the current track, sends stats, exits 0', { skip: skipNoSignals }, async (t) => {
  const playlistFile = tmpPlaylist('usr2', ['usr1.mp3', 'usr2.mp3', 'usr3.mp3']);
  const fetchLog = path.join(os.tmpdir(), `fetch-usr2-${Date.now()}.log`);
  t.after(() => {
    fs.rmSync(playlistFile, { force: true });
    fs.rmSync(fetchLog, { force: true });
  });

  const port = nextPort();
  const { child, getOutput } = startPlayer(t, port, {
    TEST_PLAYLIST_FILE: playlistFile,
    FAKE_TRACK_MS: '300',
    TEST_FETCH_LOG: fetchLog,
  });
  const client = makeClient(port);
  await client.waitUp();

  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const signalledAt = Date.now();
  child.kill('SIGUSR2');

  const timeout = new Promise((r) => setTimeout(() => r('timeout'), 20000));
  const code = await Promise.race([exited, timeout]);
  const tookMs = Date.now() - signalledAt;

  assert.equal(code, 0, `expected a clean exit, got ${code}\n--- player output ---\n${getOutput()}`);
  assert.match(getOutput(), /Получен SIGUSR2/);

  // The handler holds the process open: current track, then the 2s pause
  // before the final stats POST. An unhandled SIGUSR2 would have killed it
  // instantly, so the elapsed time is the proof that the handler ran.
  assert.ok(tookMs >= 1500, `exited after only ${tookMs}ms — looks like the signal just killed it`);
  assert.match(getOutput(), /Статистика отправлена/);

  // The final stats POST must have gone out BEFORE the process exited.
  const stats = readFetchLog(fetchLog).filter((e) => e.url.endsWith('/updateSongStats'));
  assert.ok(stats.length >= 1, `no stats POST was recorded\n--- player output ---\n${getOutput()}`);
  assert.ok(
    stats.some((e) => e.at >= signalledAt),
    'stats were sent, but none after the signal — the last track was not reported'
  );
});

// ---------------------------------------------------------------------------
// EXIT AND RESTART BRANCHES
//
// These are the paths that fail silently in a venue: the player quietly stops,
// or quietly plays two streams at once. All of them hinge on the clock, on a
// decoding failure, or on the port — none of which need the player refactored.
// ---------------------------------------------------------------------------

/** Same window every day of the week — day numbers are 0=Sun … 6=Sat. */
function everyDay(start, stop) {
  return Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((day) => [day, { start, stop }]));
}

function waitForExit(child, timeoutMs = 30000) {
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code) => resolve(code))),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ]);
}

const countMatches = (text, re) => (text.match(re) || []).length;

test('daySchedule: booted outside the window → never plays, shuts down', { skip: skipNoExpress }, async (t) => {
  const playlistFile = tmpPlaylist('offhours', ['off1.mp3', 'off2.mp3']);
  t.after(() => fs.rmSync(playlistFile, { force: true }));

  const { child, getOutput } = startPlayer(t, nextPort(), {
    TEST_PLAYLIST_FILE: playlistFile,
    TEST_DAY_SCHEDULE_JSON: JSON.stringify(everyDay('08:00', '22:00')),
    TEST_CLOCK_START: '03:00', // deep in the silent hours
    TEST_CLOCK_SCALE: '1',
    FAKE_TRACK_MS: '200',
  });

  const code = await waitForExit(child, 15000);
  assert.equal(code, 0, `expected a clean shutdown, got ${code}\n--- player output ---\n${getOutput()}`);
  assert.match(getOutput(), /не музыкальное время/);
  assert.doesNotMatch(getOutput(), /▶/, 'player started a track outside its schedule');
});

test('daySchedule: session end stops the player with exit 0', { skip: skipNoExpress }, async (t) => {
  const playlistFile = tmpPlaylist('session', ['ses1.mp3', 'ses2.mp3', 'ses3.mp3']);
  t.after(() => fs.rmSync(playlistFile, { force: true }));

  // Clock starts at 12:00 and runs 60x, session stops at 12:03 → ~3s in.
  const { child, getOutput } = startPlayer(t, nextPort(), {
    TEST_PLAYLIST_FILE: playlistFile,
    TEST_DAY_SCHEDULE_JSON: JSON.stringify(everyDay('11:00', '12:03')),
    TEST_CLOCK_START: '12:00',
    TEST_CLOCK_SCALE: '60',
    FAKE_TRACK_MS: '300',
  });

  const code = await waitForExit(child, 30000);
  assert.equal(code, 0, `expected exit 0 at session end, got ${code}\n--- player output ---\n${getOutput()}`);
  assert.match(getOutput(), /Сессия завершена/);
  assert.match(getOutput(), /▶/, 'player should have played before the session ended');
});

test('no playlist window covers the current time → exit 0', { skip: skipNoExpress }, async (t) => {
  const playlistFile = tmpPlaylist('gap', ['gap1.mp3', 'gap2.mp3']);
  t.after(() => fs.rmSync(playlistFile, { force: true }));

  // The only window ends at 12:02, after which nothing covers the clock.
  const { child, getOutput } = startPlayer(t, nextPort(), {
    TEST_PLAYLISTS_JSON: JSON.stringify([
      { name: 'morning', file: playlistFile, start: '00:00', end: '12:02', tableId: 'tbl-M' },
    ]),
    TEST_CLOCK_START: '12:00',
    TEST_CLOCK_SCALE: '60',
    FAKE_TRACK_MS: '300',
  });

  const code = await waitForExit(child, 30000);
  assert.equal(code, 0, `expected exit 0 when no window applies, got ${code}\n--- player output ---\n${getOutput()}`);
  assert.match(getOutput(), /Нет активного плейлиста/);
});

// Regression test. Once the clock leaves every configured window in 24/7 mode,
// activePlaylistConfig is null — and the 'complete' handler used to dereference
// it (`activePlaylistConfig.file`) BEFORE reaching the loadNextTrack branch
// that keeps 24/7 playing, so the safety net was unreachable and the player
// crash-looped once per track for as long as the gap lasted.
test('24/7: a gap between windows must NOT stop the music', { skip: skipNoExpress }, async (t) => {
  const playlistFile = tmpPlaylist('gap247', ['g1.mp3', 'g2.mp3']);
  t.after(() => fs.rmSync(playlistFile, { force: true }));

  const { child, getOutput } = startPlayer(t, nextPort(), {
    TEST_PLAYLISTS_JSON: JSON.stringify([
      { name: 'morning', file: playlistFile, start: '00:00', end: '12:02', tableId: 'tbl-M' },
    ]),
    TEST_MODE_24H: '1',
    TEST_CLOCK_START: '12:00',
    TEST_CLOCK_SCALE: '60',
    FAKE_TRACK_MS: '300',
  });

  // Short budget on purpose: the reinit fires ~2s in, so a working player
  // reaches the 24/7 branch quickly. Waiting 25s just to watch a known crash
  // would tax every run.
  const keptGoing = await waitUntil(() => /но режим 24\/7 — продолжаю/.test(getOutput()), { timeoutMs: 12000 });
  assert.ok(keptGoing, `24/7 player did not survive the gap\n--- player output ---\n${getOutput()}`);
  assert.equal(child.exitCode, null, 'a 24/7 player must never exit on a config gap');
});

test('24/7: a dislike inside a config gap still edits the right playlist file', { skip: skipNoExpress }, async (t) => {
  // The track is playing from a list whose window has already closed, so
  // activePlaylistConfig is null by the time it finishes. The file to edit is
  // remembered when the track STARTS, which is the only moment it is known.
  const tracks = ['gd1.mp3', 'gd2.mp3', 'gd3.mp3'];
  const playlistFile = tmpPlaylist('gapdislike', tracks);
  t.after(() => fs.rmSync(playlistFile, { force: true }));

  const port = nextPort();
  const { getOutput } = startPlayer(t, port, {
    TEST_PLAYLISTS_JSON: JSON.stringify([
      { name: 'morning', file: playlistFile, start: '00:00', end: '12:02', tableId: 'tbl-M' },
    ]),
    TEST_MODE_24H: '1',
    TEST_CLOCK_START: '12:00',
    TEST_CLOCK_SCALE: '60',
    FAKE_TRACK_MS: '300',
  });
  const client = makeClient(port);
  await client.waitUp();

  // Wait until the player is provably past the end of every window.
  const inGap = await waitUntil(() => /но режим 24\/7 — продолжаю/.test(getOutput()), { timeoutMs: 15000 });
  assert.ok(inGap, `player never entered the gap\n--- player output ---\n${getOutput()}`);

  await client.post('dislike');

  const linesOf = () =>
    fs.readFileSync(playlistFile, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  const removed = await waitUntil(() => linesOf().length === tracks.length - 1);

  assert.ok(removed, `dislike in a gap did not edit the file\n--- player output ---\n${getOutput()}`);
  assert.doesNotMatch(getOutput(), /неизвестен файл плейлиста/);
});

test('24/7: reinit at reshuffleAt re-reads the playlists without doubling playback', { skip: skipNoExpress }, async (t) => {
  const playlistFile = tmpPlaylist('reinit', ['r1.mp3', 'r2.mp3', 'r3.mp3']);
  t.after(() => fs.rmSync(playlistFile, { force: true }));

  const TRACK_MS = 400;
  const { child, getOutput } = startPlayer(t, nextPort(), {
    TEST_PLAYLIST_FILE: playlistFile,
    TEST_MODE_24H: '1',
    TEST_RESHUFFLE_AT: '12:02',
    TEST_CLOCK_START: '12:00',
    TEST_CLOCK_SCALE: '60',
    FAKE_TRACK_MS: String(TRACK_MS),
  });

  const reinit = await waitUntil(() => /Конец цикла 24\/7/.test(getOutput()), { timeoutMs: 25000 });
  assert.ok(reinit, `24/7 reinit never happened\n--- player output ---\n${getOutput()}`);

  // The hazard the source comments warn about: if playerInitialization() is
  // followed by another playSong(), the loop forks and every completion starts
  // two more tracks. One chain plays ~1 track per FAKE_TRACK_MS; a forked one
  // grows fast, so a generous ceiling still catches it.
  const before = countMatches(getOutput(), /▶/g);
  const windowMs = 3000;
  await new Promise((r) => setTimeout(r, windowMs));
  const played = countMatches(getOutput(), /▶/g) - before;

  const expected = Math.ceil(windowMs / TRACK_MS); // ~7
  assert.ok(
    played <= expected * 2,
    `playback looks doubled: ${played} tracks in ${windowMs}ms, expected about ${expected}`
  );
  assert.ok(played >= 1, `playback stopped after reinit\n--- player output ---\n${getOutput()}`);
  assert.equal(child.exitCode, null);
});

test('an unplayable track is skipped, the loop keeps going', { skip: skipNoExpress }, async (t) => {
  const playlistFile = tmpPlaylist('broken', ['b1.mp3', 'b2.mp3', 'b3.mp3', 'b4.mp3']);
  t.after(() => fs.rmSync(playlistFile, { force: true }));

  const port = nextPort();
  const { getOutput } = startPlayer(t, port, {
    TEST_PLAYLIST_FILE: playlistFile,
    FAKE_TRACK_MS: '200',
    FAKE_ERROR_EVERY: '2', // every second track refuses to decode
  });
  const client = makeClient(port);
  await client.waitUp();

  const skipped = await waitUntil(() => /Пропускаю трек/.test(getOutput()));
  assert.ok(skipped, `no track was skipped\n--- player output ---\n${getOutput()}`);

  // Surviving the error is the point: the loop must still be moving afterwards.
  const seen = new Set();
  const stillMoving = await waitUntil(async () => {
    const { track } = await client.nowPlaying();
    if (track) seen.add(track);
    return seen.size >= 2;
  });
  assert.ok(stillMoving, `loop stalled after a decode error\n--- player output ---\n${getOutput()}`);
});

test('like: the vote is sent and the playlist file is left alone', { skip: skipNoExpress }, async (t) => {
  const tracks = ['lik1.mp3', 'lik2.mp3', 'lik3.mp3'];
  const playlistFile = tmpPlaylist('like', tracks);
  const fetchLog = path.join(os.tmpdir(), `fetch-like-${Date.now()}.log`);
  t.after(() => {
    fs.rmSync(playlistFile, { force: true });
    fs.rmSync(fetchLog, { force: true });
  });

  const port = nextPort();
  const { getOutput } = startPlayer(t, port, {
    TEST_PLAYLIST_FILE: playlistFile,
    FAKE_TRACK_MS: '400',
    TEST_FETCH_LOG: fetchLog,
  });
  const client = makeClient(port);
  await client.waitUp();

  const body = await (await client.post('like')).json();
  assert.equal(body.message, 'like scheduled');

  const sent = await waitUntil(() =>
    readFetchLog(fetchLog).some(
      (e) => e.url.endsWith('/updateRecordStatus') && JSON.parse(e.body).newStatus === 'Like'
    )
  );
  assert.ok(sent, `like was never POSTed\n--- player output ---\n${getOutput()}`);

  // Unlike a dislike, a like must not touch the playlist.
  const left = fs.readFileSync(playlistFile, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  assert.deepEqual(left, tracks, 'a like must not remove anything from the playlist');
});

test('a busy port fails loudly with exit 1', { skip: skipNoExpress }, async (t) => {
  const net = require('net');
  const playlistFile = tmpPlaylist('busyport', ['bp1.mp3']);
  const port = nextPort();

  // Somebody else (an older instance, in real life) already holds the port.
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, '0.0.0.0', resolve);
  });

  t.after(() => {
    blocker.close();
    fs.rmSync(playlistFile, { force: true });
  });

  const { child, getOutput } = startPlayer(t, port, { TEST_PLAYLIST_FILE: playlistFile });

  const code = await waitForExit(child, 15000);
  assert.equal(code, 1, `expected exit 1 on a busy port, got ${code}\n--- player output ---\n${getOutput()}`);
  assert.match(getOutput(), /Порт \d+ занят/);
});

// ---------------------------------------------------------------------------
// SLOW BRANCHES — deliberately commented out.
//
// Both wait on real timers inside the player (60s and 15s), and neither can be
// sped up: the fake clock only moves `new Date()`, while setTimeout runs on the
// real one. Uncomment when you want to check these two specifically; they add
// well over a minute to the run, which is why they are not part of `npm test`.
// ---------------------------------------------------------------------------

// test('an empty playlist retries a minute later instead of dying', { skip: skipNoExpress }, async (t) => {
//   const playlistFile = tmpPlaylist('empty', []);
//   t.after(() => fs.rmSync(playlistFile, { force: true }));
//
//   const port = nextPort();
//   const { child, getOutput } = startPlayer(t, port, {
//     TEST_PLAYLIST_FILE: playlistFile,
//     FAKE_TRACK_MS: '200',
//   });
//   const client = makeClient(port);
//   await client.waitUp();
//
//   assert.match(getOutput(), /нет треков — повторная попытка через 60 секунд/);
//
//   // 60s later it must try again rather than sit dead or exit.
//   const retried = await waitUntil(
//     () => countMatches(getOutput(), /повторная попытка через 60 секунд/g) >= 2,
//     { timeoutMs: 90000, intervalMs: 1000 }
//   );
//   assert.ok(retried, `player never retried\n--- player output ---\n${getOutput()}`);
//   assert.equal(child.exitCode, null, 'an empty playlist must not kill the player');
// });

// test('dead wifi: a hung POST does not freeze the player (15s withTimeout)', { skip: skipNoExpress }, async (t) => {
//   const playlistFile = tmpPlaylist('hang', ['h1.mp3', 'h2.mp3', 'h3.mp3']);
//   t.after(() => fs.rmSync(playlistFile, { force: true }));
//
//   const port = nextPort();
//   const { child, getOutput } = startPlayer(t, port, {
//     TEST_PLAYLIST_FILE: playlistFile,
//     FAKE_TRACK_MS: '300',
//     TEST_FETCH_HANG: '1', // every POST hangs forever
//   });
//   const client = makeClient(port);
//   await client.waitUp();
//
//   await client.post('like'); // forces the awaited sendLikeDislike path
//
//   // Music comes first: the loop must keep advancing while the POST hangs...
//   const seen = new Set();
//   const kept = await waitUntil(async () => {
//     const { track } = await client.nowPlaying();
//     if (track) seen.add(track);
//     return seen.size >= 2;
//   }, { timeoutMs: 20000 });
//   assert.ok(kept, `player froze on a hung request\n--- player output ---\n${getOutput()}`);
//
//   // ...and the guard must fire rather than await forever.
//   const timedOut = await waitUntil(() => /timeout after 15000ms/.test(getOutput()), {
//     timeoutMs: 30000,
//     intervalMs: 500,
//   });
//   assert.ok(timedOut, `withTimeout never fired\n--- player output ---\n${getOutput()}`);
//   assert.equal(child.exitCode, null);
// });
