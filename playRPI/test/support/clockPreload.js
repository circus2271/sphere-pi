'use strict';

/**
 * Preloaded (via `node --require`) into the real player for playlistFile.test.js.
 * Runs the player on a fast fake clock, so a week of schedule takes seconds:
 *
 *   - Date and setTimeout run TEST_SPEED times faster, starting at TEST_START
 *   - sound-player → no mpg123, a "track" just lasts TEST_TRACK_SECONDS
 *   - mwl-loudness → no amixer
 *   - node-fetch   → prints the request as a FETCH line instead of sending it
 */

const { EventEmitter } = require('events');
const { registerMock } = require('./moduleMock');

const speed = Number(process.env.TEST_SPEED);
const realDate = Date;
const realSetTimeout = setTimeout;
const fakeStart = new realDate(process.env.TEST_START).getTime();

// The clock starts once the player has loaded: at this speed a slow start
// would otherwise eat hours of the schedule.
let realStart = null;
setImmediate(() => { realStart = realDate.now(); });
const fakeNow = () => fakeStart + (realStart === null ? 0 : (realDate.now() - realStart) * speed);

global.Date = class extends realDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(fakeNow());
  }
  static now() {
    return fakeNow();
  }
};
global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, (ms || 0) / speed, ...args);

class FakeSoundPlayer extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
  }
  play() {
    setTimeout(() => this.emit('complete'), Number(process.env.TEST_TRACK_SECONDS) * 1000);
  }
}
registerMock('sound-player', FakeSoundPlayer);

registerMock('mwl-loudness', {
  setVolume() {},
  getVolume() {
    return Promise.resolve(0);
  },
});

registerMock('node-fetch', async (url, init) => {
  console.log(`FETCH ${url.split('/').pop()} ${init.body}`);
  return { json: async () => ({ ok: true }), text: async () => 'ok' };
});
