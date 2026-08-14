'use strict';

/**
 * Preloaded (via `node --require`) into the real player process during
 * integration tests. Replaces everything that touches hardware or the
 * network with inert fakes:
 *
 *   - sound-player   → no mpg123 process is spawned
 *   - mwl-loudness   → no amixer/ALSA calls
 *   - node-fetch     → no cloud function calls
 *   - _playerConfig → points at a temp playlist created by the test
 *
 * Everything below the first variable is OPT-IN: with only TEST_PLAYLIST_FILE
 * set, this behaves exactly as it always did (one playlist, a track that never
 * finishes, real wall clock).
 *
 * Environment variables provided by the test:
 *   TEST_PLAYLIST_FILE  — path to a temp tracks .txt file
 *   FAKE_TRACK_MS       — if > 0, a "track" finishes after this many ms and
 *                         the player's 'complete' handler fires. This is what
 *                         drives the play loop: track advance, playlist
 *                         switching, dislike deletion, graceful restart.
 *   FAKE_ERROR_EVERY    — every Nth track emits 'error' instead of 'complete',
 *                         i.e. a file that won't decode
 *   TEST_PLAYLISTS_JSON — JSON array of playlist configs, replaces the default
 *                         single 'all' playlist
 *   TEST_DAY_SCHEDULE_JSON — JSON daySchedule ({0:{start,stop},...}); without
 *                         it there is no schedule and the playlist windows are
 *                         the only switch, as before
 *   TEST_MODE_24H       — '1' turns on round-the-clock mode
 *   TEST_RESHUFFLE_AT   — 'HH:MM' for the 24/7 reinit moment
 *   TEST_FETCH_HANG     — '1' makes every POST hang forever, so the player's
 *                         15s withTimeout guard can be exercised
 *   TEST_CLOCK_START    — 'HH:MM'; starts a fake clock at that time today
 *   TEST_CLOCK_SCALE    — how much faster the fake clock runs (default 60,
 *                         i.e. one minute of player time per real second).
 *                         Lets a time-window boundary arrive in seconds
 *                         instead of making the test wait for a real minute.
 *   TEST_FETCH_LOG      — file path; every faked POST is appended as JSON
 *                         so the test can assert what was sent, and when
 */

const fs = require('fs');
const { registerMock } = require('./moduleMock');

// Captured before the clock may be replaced below — the log needs real time.
const RealDate = global.Date;

// --- fake clock (opt-in) -----------------------------------------------------
// The player asks `new Date()` on every loop iteration to decide which
// playlist is active, so speeding the clock up is enough to exercise
// time-based behaviour without waiting for real minutes to pass.
if (process.env.TEST_CLOCK_START) {
  const [hour, minute] = process.env.TEST_CLOCK_START.split(':').map(Number);
  const scale = Number(process.env.TEST_CLOCK_SCALE || 60);

  const realStart = RealDate.now();
  const fakeStartDate = new RealDate();
  fakeStartDate.setHours(hour, minute, 0, 0);
  const fakeStart = fakeStartDate.getTime();

  const fakeNow = () => fakeStart + (RealDate.now() - realStart) * scale;

  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length) {
        super(...args);
      } else {
        super(fakeNow());
      }
    }
    static now() {
      return fakeNow();
    }
  }
  global.Date = FakeDate;
}

// --- sound-player fake -----------------------------------------------------
// NOTE: the player calls play() and only THEN registers once('complete'),
// so the completion must be delivered on a later tick — setTimeout is,
// even with a 0ms delay.
const TRACK_MS = Number(process.env.FAKE_TRACK_MS || 0);
const ERROR_EVERY = Number(process.env.FAKE_ERROR_EVERY || 0);

let playCount = 0;

class FakeSoundPlayer {
  constructor(options) {
    this.options = options;
    this.handlers = {};
  }
  play() {
    /* a real player would spawn mpg123 here */
    if (TRACK_MS <= 0) return;

    playCount += 1;
    // Every Nth track is "unplayable" — the real sound-player emits 'error'
    // for a corrupt or missing file, and the player is meant to skip it.
    const fails = ERROR_EVERY > 0 && playCount % ERROR_EVERY === 0;

    setTimeout(() => {
      if (fails) {
        const onError = this.handlers.error;
        if (onError) onError(new Error('fake decode failure'));
        return;
      }
      const onComplete = this.handlers.complete;
      if (onComplete) onComplete();
    }, TRACK_MS);
  }
  once(event, handler) {
    this.handlers[event] = handler;
  }
}
registerMock('sound-player', FakeSoundPlayer);

// --- mwl-loudness fake -------------------------------------------------------
registerMock('mwl-loudness', {
  setVolume() {},
  getVolume() {
    return Promise.resolve(0);
  },
});

// --- node-fetch fake ---------------------------------------------------------
const FETCH_LOG = process.env.TEST_FETCH_LOG;

registerMock('node-fetch', async (url, opts) => {
  if (FETCH_LOG) {
    const entry = { url, body: opts && opts.body, at: RealDate.now() };
    fs.appendFileSync(FETCH_LOG, JSON.stringify(entry) + '\n');
  }
  // Dead wifi: the request never settles, so the player has to rely on its
  // own withTimeout guard instead of hanging forever.
  if (process.env.TEST_FETCH_HANG === '1') {
    return new Promise(() => {});
  }
  return {
    json: async () => ({ ok: true }),
    text: async () => 'ok',
  };
});

// --- playlist config fake ----------------------------------------------------
// Default: one playlist covering the whole day (new HH:MM format), no
// daySchedule — so the player boots whatever the wall clock says.
const playlists = process.env.TEST_PLAYLISTS_JSON
  ? JSON.parse(process.env.TEST_PLAYLISTS_JSON)
  : [
      {
        name: 'all',
        file: process.env.TEST_PLAYLIST_FILE,
        start: '00:00',
        end: '24:00',
        tableId: 'tbl-ALL',
      },
    ];

const playerConfig = {
  baseId: 'base-INTEGRATION',
  playlists,
  mode24h: process.env.TEST_MODE_24H === '1',
  volume: 76,
  reshuffleAt: process.env.TEST_RESHUFFLE_AT || null,
  recentGuard: 30,
};

// Only set daySchedule when a test asks for it: its mere presence switches
// checkingOnReboot to the schedule branch.
if (process.env.TEST_DAY_SCHEDULE_JSON) {
  playerConfig.daySchedule = JSON.parse(process.env.TEST_DAY_SCHEDULE_JSON);
}

registerMock('_playerConfig', playerConfig);
