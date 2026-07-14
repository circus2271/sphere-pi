'use strict';

/**
 * Preloaded (via `node --require`) into the real player process during
 * integration tests. Replaces everything that touches hardware or the
 * network with inert fakes:
 *
 *   - sound-player   → no mpg123 process is spawned
 *   - mwl-loudness   → no amixer/ALSA calls
 *   - node-fetch     → no cloud function calls
 *   - _playlistConfig → points at a temp playlist created by the test
 *
 * Environment variables provided by the test:
 *   TEST_PLAYLIST_FILE — path to a temp tracks .txt file
 */

const { registerMock } = require('./moduleMock');

// --- sound-player fake -----------------------------------------------------
class FakeSoundPlayer {
  constructor(options) {
    this.options = options;
    this.handlers = {};
  }
  play() {
    /* a real player would spawn mpg123 here */
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
registerMock('node-fetch', async () => ({
  json: async () => ({ ok: true }),
  text: async () => 'ok',
}));

// --- playlist config fake ----------------------------------------------------
// One playlist covering the whole day (new HH:MM format), no daySchedule —
// so the player boots whatever the wall clock says when the tests run.
registerMock('_playlistConfig', {
  baseId: 'base-INTEGRATION',
  playlists: [
    {
      name: 'all',
      file: process.env.TEST_PLAYLIST_FILE,
      start: '00:00',
      end: '24:00',
      tableId: 'tbl-ALL',
    },
  ],
  mode24h: false,
  reshuffleAt: null,
  recentGuard: 30,
});
