'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerMock, withDate, withTime } = require('./support/moduleMock');

// ---------------------------------------------------------------------------
// Mocks that must be in place BEFORE _helpers.js is required
// ---------------------------------------------------------------------------

// Fake playlist configuration: a "day" playlist (08:00 → 20:00) and a "night"
// playlist that crosses midnight (20:00 → 02:00 next day, i.e. end '26:00').
// The gap 02:00 → 08:00 is silence.
const fakeConfig = {
  baseId: 'base-TEST',
  playlists: [
    { name: 'day', file: '/tmp/ignored-day.txt', start: '08:00', end: '20:00', tableId: 'tbl-DAY' },
    { name: 'night', file: '/tmp/ignored-night.txt', start: '20:00', end: '26:00', tableId: 'tbl-NIGHT' },
  ],
};
registerMock('_playerConfig', fakeConfig);

// Fake node-fetch that records calls and returns a canned response.
const fetchCalls = [];
let fetchImpl = async (url, opts) => {
  fetchCalls.push({ url, opts });
  return {
    json: async () => ({ ok: true, echoed: JSON.parse(opts.body) }),
    text: async () => 'stats-received',
  };
};
registerMock('node-fetch', (...args) => fetchImpl(...args));

const helpers = require('../_helpers');

// ---------------------------------------------------------------------------
// time primitives: toMinutes / formatTime / isTimeInRange / getPlaylistWindow
// ---------------------------------------------------------------------------

test('toMinutes parses HH:MM with minute precision, including >24:00', () => {
  assert.equal(helpers.toMinutes('00:00'), 0);
  assert.equal(helpers.toMinutes('11:30'), 690);
  assert.equal(helpers.toMinutes('24:00'), 1440);
  assert.equal(helpers.toMinutes('26:00'), 1560); // 02:00 next day
});

test('formatTime renders minutes back to HH:MM, marking next-day times', () => {
  assert.equal(helpers.formatTime(690), '11:30');
  assert.equal(helpers.formatTime(0), '00:00');
  assert.equal(helpers.formatTime(1560), '02:00(след.день)');
});

test('isTimeInRange: plain range, start inclusive, end exclusive', () => {
  const start = helpers.toMinutes('11:30');
  const end = helpers.toMinutes('16:00');
  assert.equal(helpers.isTimeInRange(helpers.toMinutes('11:29'), start, end), false);
  assert.equal(helpers.isTimeInRange(helpers.toMinutes('11:30'), start, end), true);
  assert.equal(helpers.isTimeInRange(helpers.toMinutes('15:59'), start, end), true);
  assert.equal(helpers.isTimeInRange(helpers.toMinutes('16:00'), start, end), false);
});

test('isTimeInRange: end 24:00 means "until midnight"', () => {
  const start = helpers.toMinutes('22:00');
  assert.equal(helpers.isTimeInRange(helpers.toMinutes('23:59'), start, 1440), true);
  assert.equal(helpers.isTimeInRange(helpers.toMinutes('00:00'), start, 1440), false);
});

test('isTimeInRange: end > 24:00 crosses midnight', () => {
  const start = helpers.toMinutes('18:00');
  const end = helpers.toMinutes('27:00'); // 03:00 next day
  assert.equal(helpers.isTimeInRange(helpers.toMinutes('23:00'), start, end), true);
  assert.equal(helpers.isTimeInRange(helpers.toMinutes('01:30'), start, end), true);
  assert.equal(helpers.isTimeInRange(helpers.toMinutes('02:59'), start, end), true);
  assert.equal(helpers.isTimeInRange(helpers.toMinutes('03:00'), start, end), false);
  assert.equal(helpers.isTimeInRange(helpers.toMinutes('17:59'), start, end), false);
});

test('getPlaylistWindow understands both new HH:MM and legacy hour formats', () => {
  assert.deepEqual(
    helpers.getPlaylistWindow({ start: '11:30', end: '26:00' }),
    { startMin: 690, endMin: 1560 }
  );
  // legacy same-day range
  assert.deepEqual(
    helpers.getPlaylistWindow({ startHour: 8, endHour: 20 }),
    { startMin: 480, endMin: 1200 }
  );
  // legacy midnight-crossing range (20 → 2) becomes end-next-day
  assert.deepEqual(
    helpers.getPlaylistWindow({ startHour: 20, endHour: 2 }),
    { startMin: 1200, endMin: 1560 }
  );
});

// ---------------------------------------------------------------------------
// getCurrentPlaylistConfig  (minute-precision playlist selection)
// ---------------------------------------------------------------------------

test('selects the day playlist during day hours', () => {
  withTime(10, 30, () => {
    assert.equal(helpers.getCurrentPlaylistConfig().name, 'day');
  });
  withTime(8, 0, () => {
    // start is inclusive
    assert.equal(helpers.getCurrentPlaylistConfig().name, 'day');
  });
  withTime(19, 59, () => {
    assert.equal(helpers.getCurrentPlaylistConfig().name, 'day');
  });
});

test('selects the night playlist in the evening and across midnight', () => {
  withTime(20, 0, () => {
    // 20:00 is day's exclusive end and night's inclusive start
    assert.equal(helpers.getCurrentPlaylistConfig().name, 'night');
  });
  withTime(23, 30, () => {
    assert.equal(helpers.getCurrentPlaylistConfig().name, 'night');
  });
  withTime(1, 59, () => {
    assert.equal(helpers.getCurrentPlaylistConfig().name, 'night');
  });
});

test('returns null during silent time (02:00 → 08:00)', () => {
  for (const [h, m] of [[2, 0], [3, 30], [7, 59]]) {
    withTime(h, m, () => {
      assert.equal(helpers.getCurrentPlaylistConfig(), null);
    });
  }
});

test('minute-precision boundary: an 11:30 window opens exactly at 11:30', () => {
  const originalPlaylists = fakeConfig.playlists;
  fakeConfig.playlists = [
    { name: 'brunch', file: '/tmp/x.txt', start: '11:30', end: '16:00', tableId: 'tbl-BRUNCH' },
  ];
  try {
    withTime(11, 29, () => assert.equal(helpers.getCurrentPlaylistConfig(), null));
    withTime(11, 30, () => assert.equal(helpers.getCurrentPlaylistConfig().name, 'brunch'));
  } finally {
    fakeConfig.playlists = originalPlaylists;
  }
});

test('getCurrentPlaylistName falls back to "unknown" outside all windows', () => {
  withTime(10, 30, () => assert.equal(helpers.getCurrentPlaylistName(), 'day'));
  withTime(3, 0, () => assert.equal(helpers.getCurrentPlaylistName(), 'unknown'));
});

// ---------------------------------------------------------------------------
// getActiveSession / computeSessionStopDate  (day-of-week schedule)
// Jan 2026: Thu 15, Fri 16, Sat 17
// ---------------------------------------------------------------------------

const schedule = {
  0: { start: '08:55', stop: '23:55' }, // Sun
  1: { start: '07:55', stop: '22:55' }, // Mon
  2: { start: '07:55', stop: '22:55' }, // Tue
  3: { start: '07:55', stop: '22:55' }, // Wed
  4: { start: '07:55', stop: '22:55' }, // Thu
  5: { start: '09:30', stop: '26:00' }, // Fri — plays until 02:00 Saturday
  6: { start: '08:55', stop: '23:55' }, // Sat
};

test('getActiveSession: active inside today\'s window (minute precision)', () => {
  // Thu Jan 15, 07:54 — one minute early
  withDate([2026, 0, 15, 7, 54], () => {
    assert.equal(helpers.getActiveSession(new Date(), schedule), null);
  });
  // Thu Jan 15, 07:55 — opens exactly on the minute
  withDate([2026, 0, 15, 7, 55], () => {
    const session = helpers.getActiveSession(new Date(), schedule);
    assert.ok(session);
    assert.equal(session.startMin, helpers.toMinutes('07:55'));
    assert.equal(session.stopMin, helpers.toMinutes('22:55'));
  });
  // Thu Jan 15, 22:55 — closed again
  withDate([2026, 0, 15, 22, 55], () => {
    assert.equal(helpers.getActiveSession(new Date(), schedule), null);
  });
});

test('getActiveSession: yesterday\'s past-midnight session is still active', () => {
  // Sat Jan 17, 01:15 — Friday's session (stop 26:00 = 02:00 Sat) still on
  withDate([2026, 0, 17, 1, 15], () => {
    const session = helpers.getActiveSession(new Date(), schedule);
    assert.ok(session, 'Friday tail should be active on Saturday 01:15');
    assert.equal(session.stopMin, helpers.toMinutes('26:00'));
    // baseDate is FRIDAY's midnight (the day the session belongs to)
    assert.equal(session.baseDate.getDate(), 16);
  });
  // Sat Jan 17, 02:00 — Friday's tail is over, Saturday hasn't started
  withDate([2026, 0, 17, 2, 0], () => {
    assert.equal(helpers.getActiveSession(new Date(), schedule), null);
  });
});

test('computeSessionStopDate lands on the right calendar day', () => {
  // Friday's session: stop 26:00 → Saturday 02:00
  withDate([2026, 0, 17, 1, 15], () => {
    const session = helpers.getActiveSession(new Date(), schedule);
    const stop = helpers.computeSessionStopDate(session);
    assert.equal(stop.getDate(), 17); // Saturday
    assert.equal(stop.getHours(), 2);
    assert.equal(stop.getMinutes(), 0);
  });
  // Thursday's session: stop 22:55 same day
  withDate([2026, 0, 15, 12, 0], () => {
    const session = helpers.getActiveSession(new Date(), schedule);
    const stop = helpers.computeSessionStopDate(session);
    assert.equal(stop.getDate(), 15);
    assert.equal(stop.getHours(), 22);
    assert.equal(stop.getMinutes(), 55);
  });
});

// ---------------------------------------------------------------------------
// computeNextReinitDate  (24/7 mode)
// ---------------------------------------------------------------------------

test('reinit at explicit reshuffleAt time (wins over playlist end)', () => {
  const config = { reshuffleAt: '05:00', playlists: [{ name: 'all', start: '00:00', end: '24:00' }] };
  // now 14:30 → 05:00 TOMORROW
  withDate([2026, 0, 15, 14, 30], () => {
    const d = helpers.computeNextReinitDate(new Date(), config);
    assert.equal(d.getDate(), 16);
    assert.equal(d.getHours(), 5);
  });
  // now 03:00 → 05:00 TODAY
  withDate([2026, 0, 15, 3, 0], () => {
    const d = helpers.computeNextReinitDate(new Date(), config);
    assert.equal(d.getDate(), 15);
    assert.equal(d.getHours(), 5);
  });
});

test('reinit defaults to the end of the LAST playlist', () => {
  const config = {
    reshuffleAt: null,
    playlists: [
      { name: 'day', start: '07:00', end: '18:00' },
      { name: 'night', start: '18:00', end: '31:00' }, // ends 07:00 next day
    ],
  };
  // now 03:00 → night's end (07:00) is TODAY... end 31:00 = minute 1860,
  // midnight base + 1860 min = 07:00 NEXT day relative to base; since the
  // computed moment (tomorrow 07:00 from today's base) is in the future, keep it.
  withDate([2026, 0, 15, 3, 0], () => {
    const d = helpers.computeNextReinitDate(new Date(), config);
    assert.equal(d.getHours(), 7);
    assert.equal(d.getDate(), 16);
  });

  const allDay = { reshuffleAt: null, playlists: [{ name: 'all', start: '00:00', end: '24:00' }] };
  // single AllDay list ending 24:00 → next midnight
  withDate([2026, 0, 15, 14, 30], () => {
    const d = helpers.computeNextReinitDate(new Date(), allDay);
    assert.equal(d.getDate(), 16);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
  });
});

// ---------------------------------------------------------------------------
// parseTracksList
// ---------------------------------------------------------------------------

test('parseTracksList resolves track names into the music directory', () => {
  const tmp = path.join(os.tmpdir(), `playlist-${Date.now()}.txt`);
  fs.writeFileSync(tmp, 'trackA.mp3\ntrackB.mp3\r\ntrackC.mp3', 'utf8');

  const result = helpers.parseTracksList(tmp);
  fs.unlinkSync(tmp);

  assert.equal(result.length, 3);
  const expectedDir = path.resolve(path.join(__dirname, '..'), 'music');
  assert.equal(result[0], path.join(expectedDir, 'trackA.mp3'));
  assert.equal(result[1], path.join(expectedDir, 'trackB.mp3'));
  assert.equal(result[2], path.join(expectedDir, 'trackC.mp3'));
});

test('parseTracksList drops empty and whitespace-only lines', () => {
  const tmp = path.join(os.tmpdir(), `playlist-${Date.now()}-blank.txt`);
  fs.writeFileSync(tmp, 'one.mp3\n\n   \ntwo.mp3\n', 'utf8');

  const result = helpers.parseTracksList(tmp);
  fs.unlinkSync(tmp);

  assert.equal(result.length, 2);
});

test('parseTracksList returns [] when the playlist file is missing', () => {
  assert.deepEqual(helpers.parseTracksList('/definitely/not/here.txt'), []);
});

// ---------------------------------------------------------------------------
// shuffle
// ---------------------------------------------------------------------------

test('shuffle keeps the same elements (a permutation, nothing lost or added)', () => {
  const input = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const result = helpers.shuffle([...input]);
  assert.equal(result.length, input.length);
  assert.deepEqual([...result].sort(), [...input].sort());
});

test('shuffle actually reorders (statistically)', () => {
  const input = [...Array(10).keys()];
  let movedAtLeastOnce = false;
  for (let n = 0; n < 50; n++) {
    const out = helpers.shuffle([...input]);
    if (out.some((v, idx) => v !== input[idx])) {
      movedAtLeastOnce = true;
      break;
    }
  }
  assert.ok(movedAtLeastOnce, 'shuffle never changed the order in 50 runs');
});

// ---------------------------------------------------------------------------
// deletingTrackFromTXT  (the "dislike" file mutation)
// ---------------------------------------------------------------------------

test('deletingTrackFromTXT removes exactly the disliked track', () => {
  const tmp = path.join(os.tmpdir(), `dislike-${Date.now()}.txt`);
  fs.writeFileSync(tmp, 'keep1.mp3\nbad.mp3\nkeep2.mp3\n', 'utf8');

  helpers.deletingTrackFromTXT('bad.mp3', tmp);

  const after = fs.readFileSync(tmp, 'utf8');
  fs.unlinkSync(tmp);
  assert.equal(after, 'keep1.mp3\nkeep2.mp3');
});

test('deletingTrackFromTXT leaves the file untouched if track not found', () => {
  const tmp = path.join(os.tmpdir(), `dislike-${Date.now()}-nf.txt`);
  fs.writeFileSync(tmp, 'a.mp3\nb.mp3\n', 'utf8');

  helpers.deletingTrackFromTXT('zzz.mp3', tmp);

  const after = fs.readFileSync(tmp, 'utf8');
  fs.unlinkSync(tmp);
  assert.equal(after, 'a.mp3\nb.mp3');
});

// ---------------------------------------------------------------------------
// collectStats
// ---------------------------------------------------------------------------

test('collectStats assembles stats for the current track and playlist', () => {
  const stats = withTime(10, 30, () =>
    helpers.collectStats('cool-song', { scheduled: false, newStatus: null }, 4)
  );

  assert.equal(stats.baseId, 'base-TEST');
  assert.equal(stats.tableId, 'tbl-DAY');
  assert.equal(stats.songName, 'cool-song');
  assert.equal(stats.currentIndex, 4);
  assert.equal(stats.playlistName, 'day');
  assert.equal(stats.deviceUniqueId, os.hostname());
  assert.ok(!('newStatus' in stats), 'no newStatus when nothing is scheduled');
});

test('collectStats includes newStatus when a like/dislike is scheduled', () => {
  const stats = withTime(22, 15, () =>
    helpers.collectStats('night-song', { scheduled: true, newStatus: 'Dislike' }, 0)
  );

  assert.equal(stats.newStatus, 'Dislike');
  assert.equal(stats.tableId, 'tbl-NIGHT');
  assert.equal(stats.playlistName, 'night');
});

test('collectStats survives silent hours (tableId falls back to "unknown")', () => {
  // Regression test: this used to crash with "Cannot read properties of null"
  const stats = withTime(4, 0, () =>
    helpers.collectStats('late-song', { scheduled: false, newStatus: null }, 0)
  );
  assert.equal(stats.tableId, 'unknown');
  assert.equal(stats.playlistName, 'unknown');
});

test('tableId: playerConfig top-level value is used, per-playlist overrides it', () => {
  const originalPlaylists = fakeConfig.playlists;
  fakeConfig.tableId = 'tbl-GLOBAL';
  fakeConfig.playlists = [
    { name: 'plain', file: '/tmp/x.txt', start: '08:00', end: '12:00' }, // no own tableId
    { name: 'special', file: '/tmp/y.txt', start: '12:00', end: '20:00', tableId: 'tbl-SPECIAL' },
  ];
  try {
    const plain = withTime(9, 0, () =>
      helpers.collectStats('a', { scheduled: false, newStatus: null }, 0)
    );
    assert.equal(plain.tableId, 'tbl-GLOBAL');

    const special = withTime(13, 0, () =>
      helpers.collectStats('b', { scheduled: false, newStatus: null }, 0)
    );
    assert.equal(special.tableId, 'tbl-SPECIAL');
  } finally {
    fakeConfig.playlists = originalPlaylists;
    delete fakeConfig.tableId;
  }
});

// ---------------------------------------------------------------------------
// sendLikeDislike / sendSongStats  (network boundary, fetch is mocked)
// ---------------------------------------------------------------------------

test('sendLikeDislike POSTs JSON to the updateRecordStatus endpoint', async () => {
  fetchCalls.length = 0;
  const payload = { songName: 'x', newStatus: 'Like' };

  const result = await helpers.sendLikeDislike(payload);

  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.endsWith('/updateRecordStatus'));
  assert.equal(fetchCalls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), payload);
  assert.deepEqual(result, { ok: true, echoed: payload });
});

test('sendSongStats POSTs JSON to the updateSongStats endpoint', async () => {
  fetchCalls.length = 0;
  const result = await helpers.sendSongStats({ songName: 'y' });

  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.endsWith('/updateSongStats'));
  assert.equal(result, 'stats-received');
});

test('senders swallow network errors instead of crashing the player', async () => {
  const original = fetchImpl;
  fetchImpl = async () => {
    throw new Error('wifi died');
  };

  const likeResult = await helpers.sendLikeDislike({ songName: 'z' });
  const statsResult = await helpers.sendSongStats({ songName: 'z' });

  fetchImpl = original;
  assert.equal(likeResult, undefined);
  assert.equal(statsResult, undefined);
});
