'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * The player with playlist.json from Завхоз: the REAL player runs on a fast
 * fake clock (see support/clockPreload.js) in a throwaway copy of the code,
 * so the live playlist.json and music folder are never touched.
 *
 * Every test starts on Friday 30 Oct 2026 or later, Moscow time.
 * Requires node_modules (express); skipped on a bare checkout.
 */

const APP_DIR = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'support', 'clockPreload.js');
const APP_FILES = ['node-sound-player-production.js', '_helpers.js', '_logger.js',
  '_likeDislikeService.js', '_recentTracksService.js', '_playlistSource.js', 'package.json'];

let expressAvailable = true;
try {
  require.resolve('express', { paths: [APP_DIR] });
} catch {
  expressAvailable = false;
}

const DAY =['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function makeApp({ config = {}, playlist, state, txt, missing = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-playlist-test-'));
  for (const file of APP_FILES) fs.copyFileSync(path.join(APP_DIR, file), path.join(dir, file));
  fs.symlinkSync(path.join(APP_DIR, 'node_modules'), path.join(dir, 'node_modules'));
  fs.mkdirSync(path.join(dir, 'music'));

  const port = 20000 + Math.floor(Math.random() * 20000);
  const fullConfig = {
    playlists: [{ name: 'old', file: path.join(dir, 'tracks.txt'), start: '00:00', end: '24:00' }],
    daySchedule: {
      0: { start: '00:00', stop: '24:00' }, 1: { start: '00:00', stop: '24:00' },
      2: { start: '00:00', stop: '24:00' }, 3: { start: '00:00', stop: '24:00' },
      4: { start: '00:00', stop: '24:00' }, 5: { start: '00:00', stop: '24:00' },
      6: { start: '00:00', stop: '24:00' },
    },
    mode24h: true, reshuffleAt: null, recentGuard: 30, port, volume: 50,
    baseId: 'appBASE', tableId: 'tblCONFIG',
    ...config,
  };
  fs.writeFileSync(path.join(dir, '_playerConfig.js'), `module.exports = ${JSON.stringify(fullConfig)}`);

  const addMusic = (name) => {
    if (!missing.includes(name)) fs.writeFileSync(path.join(dir, 'music', name), 'x');
  };
  (txt || ['old-1.mp3', 'old-2.mp3']).forEach(addMusic);
  fs.writeFileSync(path.join(dir, 'tracks.txt'), (txt || ['old-1.mp3', 'old-2.mp3']).join('\n'));

  if (playlist) writePlaylist(dir, playlist, addMusic);
  if (state) fs.writeFileSync(path.join(dir, 'zavhoz-state.json'), JSON.stringify(state));
  return { dir, port, addMusic };
}

// days: { friday: [['20:00', '26:00', ['a.mp3']]], ... } → the file Завхоз writes
function writePlaylist(dir, days, addMusic = () => {}) {
  const asDays = {};
  for (const name of DAY) {
    const intervals = (days[name] || []).map(([start, end, names]) => {
      names.forEach(addMusic);
      return { start, end, tracks: names.map((fileName) => ({ recordId: `rec-${fileName}`, fileName })) };
    });
    asDays[name] = {
      daySchedule: intervals.length
        ? {
            start: intervals[0].start,
            stop: intervals.map((i) => i.end).sort((a, b) => parseInt(b) - parseInt(a))[0],
          }
        : null,
      intervals,
    };
  }
  fs.writeFileSync(path.join(dir, 'playlist.json'), JSON.stringify({
    generatedAt: '2026-10-30T12:00:00.000Z',
    activePlaylist: 'P',
    playlists: [{ name: 'P', tableId: 'tblFILE', days: asDays }],
  }));
}

// Runs the player until `until` (real ms) or its exit. Returns what it did.
function run(app, { start, speed, trackSeconds = 240, realMs, onLine }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--require', PRELOAD, path.join(app.dir, 'node-sound-player-production.js')], {
      cwd: app.dir,
      env: { ...process.env, TZ: 'Europe/Moscow', TEST_START: start, TEST_SPEED: String(speed),
             TEST_TRACK_SECONDS: String(trackSeconds), PORT: String(app.port) },
    });
    let out = '';
    let seen = 0;
    child.stdout.on('data', (d) => {
      out += d;
      if (onLine) {
        const lines = out.split('\n');
        lines.slice(seen, -1).forEach((line) => onLine(line, child));
        seen = lines.length - 1;
      }
    });
    child.stderr.on('data', (d) => { out += d; });
    let exited = null;
    child.on('exit', (code) => { exited = code; });
    const timer = setTimeout(() => child.kill(), realMs);
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ out, exited, plays: parsePlays(out), fetches: parseFetches(out) });
    });
  });
}

function parsePlays(out) {
  return [...out.matchAll(/\[(\d{4}-\d\d-\d\d) (\d\d):(\d\d):\d\d\] ▶ \[(.*?)\] (.+?)  \(\d+\/\d+\)/g)]
    .map((m) => ({ date: m[1], hour: Number(m[2]), minute: Number(m[3]), window: m[4], track: m[5] }));
}

function parseFetches(out) {
  return [...out.matchAll(/^FETCH (\S+) (.*)$/gm)].map((m) => ({ endpoint: m[1], body: JSON.parse(m[2]) }));
}

const crashed = (r) => /TypeError|Unhandled|Cannot read/.test(r.out);
const cleanUp = (app) => fs.rmSync(app.dir, { recursive: true, force: true });

const sameEveryDay = (intervals) => Object.fromEntries(DAY.map((d) => [d, intervals]));

test('playlist.json: tracks and windows come from the file', { skip: !expressAvailable }, async () => {
  const app = makeApp({
    playlist: sameEveryDay([
      ['00:00', '09:50', ['night.mp3']],
      ['09:50', '20:00', ['day.mp3']],
      ['20:00', '24:00', ['eve.mp3']],
    ]),
  });
  const r = await run(app, { start: '2026-10-30T09:00:00+03:00', speed: 7200, realMs: 15000 });
  cleanUp(app);

  assert.ok(!crashed(r), r.out);
  assert.ok(r.plays.length > 50);
  for (const p of r.plays) {
    const min = p.hour * 60 + p.minute;
    const want = min < 590 ? 'night.mp3' : min < 1200 ? 'day.mp3' : 'eve.mp3';
    assert.equal(p.track, want, `${p.hour}:${p.minute}`);
  }
  assert.ok(r.plays.every((p) => !p.track.startsWith('old')), 'старые треки из txt не играют');
  assert.match(r.plays[0].window, /^P 00:00-09:50$/);
  assert.doesNotMatch(r.out, /playlist\.json изменился/, 'файл не менялся — не перечитывал');
});

test('at midnight the player takes the new day, even if its list is shorter', { skip: !expressAvailable }, async () => {
  const many = Array.from({ length: 40 }, (_, k) => `fri-${k}.mp3`);
  const app = makeApp({
    playlist: {
      friday: [['00:00', '24:00', many]],
      saturday: [['00:00', '24:00', ['sat.mp3']]],
      sunday: [['00:00', '24:00', ['sun.mp3']]],
    },
  });
  // the clock starts late on Friday and the list is long, so the index is far along
  const r = await run(app, { start: '2026-10-30T22:00:00+03:00', speed: 3600, realMs: 8000 });
  cleanUp(app);

  assert.ok(!crashed(r), r.out);
  const fri = r.plays.filter((p) => p.date === '2026-10-30');
  const sat = r.plays.filter((p) => p.date === '2026-10-31');
  assert.ok(fri.length > 5 && sat.length > 5, r.out.slice(0, 2000));
  assert.ok(fri.every((p) => p.track.startsWith('fri-')));
  assert.ok(sat.every((p) => p.track === 'sat.mp3'), JSON.stringify(sat.slice(0, 4)));
});

test('the schedule rules even with mode24h: true; the player waits and comes back', { skip: !expressAvailable }, async () => {
  const app = makeApp({ playlist: sameEveryDay([['10:00', '22:00', ['a.mp3']]]) });
  const r = await run(app, { start: '2026-10-30T08:00:00+03:00', speed: 7200, realMs: 15000 });
  cleanUp(app);

  assert.equal(r.exited, null, 'процесс не выходит');
  assert.ok(!crashed(r), r.out);
  assert.ok(r.plays.some((p) => p.date === '2026-10-30'));
  assert.ok(r.plays.some((p) => p.date === '2026-10-31'), 'вернулся на следующий день');
  for (const p of r.plays) {
    assert.ok(p.hour >= 10 && p.hour < 22 || (p.hour === 22 && p.minute < 5), `${p.date} ${p.hour}:${p.minute}`);
  }
});

test('while silent, the player reads the file every minute: an earlier start written at night is kept', { skip: !expressAvailable }, async () => {
  const app = makeApp({ playlist: sameEveryDay([['10:00', '22:00', ['bar.mp3']]]) });
  let wrote = false;
  const r = await run(app, {
    // a fake minute is 0.1 real second; 08:00 → 09:30 takes 9 seconds
    start: '2026-10-30T08:00:00+03:00', speed: 600, trackSeconds: 240, realMs: 9000,
    onLine(line) {
      if (!wrote && line.includes('музыки нет')) {
        wrote = true; // Завхоз ночью переписал файл: бар открывается на час раньше
        writePlaylist(app.dir, sameEveryDay([['09:00', '22:00', ['bar.mp3']]]), app.addMusic);
      }
    },
  });
  cleanUp(app);

  assert.ok(!crashed(r), r.out);
  assert.ok(wrote && r.plays.length > 0, r.out.slice(0, 2000));
  assert.equal(r.plays[0].hour, 9, 'заиграл по новому расписанию, а не в 10:00');
  assert.ok(r.plays[0].minute <= 1, `в течение минуты после 09:00, а не в ${r.plays[0].hour}:${r.plays[0].minute}`);
});

test('started after midnight inside a night interval: yesterday\'s tracks, until its end', { skip: !expressAvailable }, async () => {
  const app = makeApp({
    playlist: {
      friday: [['20:00', '26:00', ['fri-night.mp3']]],
      saturday: [['12:00', '22:00', ['sat-day.mp3']]],
    },
  });
  const r = await run(app, { start: '2026-10-31T01:00:00+03:00', speed: 3600, realMs: 15000 });
  cleanUp(app);

  assert.ok(!crashed(r), r.out);
  const night = r.plays.filter((p) => p.hour < 3);
  assert.ok(night.length > 3);
  assert.ok(night.every((p) => p.track === 'fri-night.mp3'), JSON.stringify(night[0]));
  assert.ok(r.plays.every((p) => p.hour < 3 || p.hour >= 12), 'до 12:00 тишина');
  assert.ok(r.plays.some((p) => p.track === 'sat-day.mp3'), 'в субботу днём заиграла суббота');
});

test('overlapping intervals play together; a gap between intervals is silent', { skip: !expressAvailable }, async () => {
  const app = makeApp({
    playlist: sameEveryDay([
      ['08:00', '12:00', ['always.mp3']],
      ['09:00', '11:00', ['extra.mp3']],
      ['14:00', '16:00', ['late.mp3']],
    ]),
  });
  const r = await run(app, { start: '2026-10-30T07:00:00+03:00', speed: 3600, realMs: 12000 });
  cleanUp(app);

  assert.equal(r.exited, null);
  const today = r.plays.filter((p) => p.date === '2026-10-30');
  const inside = today.filter((p) => p.hour === 9 || p.hour === 10);
  assert.ok(inside.some((p) => p.track === 'always.mp3') && inside.some((p) => p.track === 'extra.mp3'));
  assert.ok(today.filter((p) => p.hour === 8).every((p) => p.track === 'always.mp3'));
  assert.ok(today.filter((p) => p.hour >= 14).every((p) => p.track === 'late.mp3'));
  assert.ok(today.every((p) => !(p.hour >= 12 && p.hour < 14) || (p.hour === 12 && p.minute < 5)), 'тишина в дырке');
});

test('a day without music in the file stays silent and does not fall back to txt', { skip: !expressAvailable }, async () => {
  const app = makeApp({ playlist: { saturday: [['10:00', '12:00', ['sat.mp3']]] } });
  const r = await run(app, { start: '2026-10-30T10:00:00+03:00', speed: 7200, realMs: 8000 });
  cleanUp(app);

  assert.equal(r.exited, null);
  assert.ok(r.plays.every((p) => p.track === 'sat.mp3'));
  assert.ok(r.plays.every((p) => p.date !== '2026-10-30'), 'в пятницу тихо');
});

for (const [name, setup] of [
  ['no file', () => {}],
  ['broken file', (app) => fs.writeFileSync(path.join(app.dir, 'playlist.json'), '{"playlists":[{"na')],
  ['empty file', (app) => fs.writeFileSync(path.join(app.dir, 'playlist.json'), '{"playlists":[]}')],
]) {
  test(`${name}: the player goes the old way, from txt`, { skip: !expressAvailable }, async () => {
    const app = makeApp();
    setup(app);
    const r = await run(app, { start: '2026-10-30T10:00:00+03:00', speed: 3600, realMs: 3000 });
    cleanUp(app);

    assert.ok(!crashed(r), r.out);
    assert.ok(r.plays.length > 3);
    assert.ok(r.plays.every((p) => p.track.startsWith('old-') && p.window === 'old'));
  });
}

test('mp3 files gone from the disk are skipped; if all are gone, the old way', { skip: !expressAvailable }, async () => {
  const some = makeApp({
    playlist: sameEveryDay([['00:00', '24:00', ['here.mp3', 'gone.mp3']]]),
    missing: ['gone.mp3'],
  });
  const a = await run(some, { start: '2026-10-30T10:00:00+03:00', speed: 3600, realMs: 3000 });
  cleanUp(some);
  assert.ok(a.plays.length > 3 && a.plays.every((p) => p.track === 'here.mp3'));

  const none = makeApp({
    playlist: sameEveryDay([['00:00', '24:00', ['gone.mp3']]]),
    missing: ['gone.mp3'],
  });
  const b = await run(none, { start: '2026-10-30T10:00:00+03:00', speed: 3600, realMs: 3000 });
  cleanUp(none);
  assert.ok(b.plays.length > 3 && b.plays.every((p) => p.track.startsWith('old-')));
});

test('the file appears while playing from txt: picked up after the track; gone: back to txt at the next session', { skip: !expressAvailable }, async () => {
  const app = makeApp();
  let wrote = false;
  let removed = false;
  const r = await run(app, {
    // a track lasts 2 real seconds, midnight comes after 15
    start: '2026-10-30T23:30:00+03:00', speed: 120, trackSeconds: 240, realMs: 40000,
    onLine(line, child) {
      if (!wrote && line.includes('▶')) {
        wrote = true;
        writePlaylist(app.dir, sameEveryDay([['00:00', '24:00', ['new.mp3']]]), app.addMusic);
      }
      if (wrote && !removed && line.includes('new.mp3')) {
        removed = true;
        fs.rmSync(path.join(app.dir, 'playlist.json'));
      }
      if (removed && line.includes('возвращаюсь')) setTimeout(() => child.kill(), 1000);
    },
  });
  cleanUp(app);

  assert.ok(!crashed(r), r.out);
  assert.ok(r.plays[0].track.startsWith('old-'));
  const firstNew = r.plays.findIndex((p) => p.track === 'new.mp3');
  assert.ok(firstNew >= 1 && firstNew <= 2, `новый файл с ${firstNew}-го трека:\n${r.out.slice(0, 3000)}`);
  assert.equal(r.plays[firstNew].date, '2026-10-30', 'подхвачен в тот же вечер, не в полночь');
  assert.ok(r.plays.filter((p) => p.date === '2026-10-30').slice(firstNew).every((p) => p.track === 'new.mp3'),
    'пропавший файл до конца сессии не трогает музыку');
  assert.ok(r.plays[r.plays.length - 1].track.startsWith('old-'), 'вернулся к txt');
  assert.equal(r.plays[r.plays.length - 1].date, '2026-10-31');
  assert.match(r.out, /возвращаюсь к _playerConfig/);
});

test('a new playlist.json mid-session plays from the next track, and the days still rule', { skip: !expressAvailable }, async () => {
  const app = makeApp({
    playlist: { friday: [['00:00', '24:00', ['a.mp3']]], saturday: [['00:00', '24:00', ['a.mp3']]] },
  });
  let wrote = false;
  const r = await run(app, {
    start: '2026-10-30T23:40:00+03:00', speed: 120, trackSeconds: 240, realMs: 20000,
    onLine(line) {
      if (!wrote && line.includes('▶')) {
        wrote = true;
        writePlaylist(app.dir, {
          friday: [['00:00', '24:00', ['b.mp3']]],
          saturday: [['00:00', '24:00', ['s.mp3']]],
        }, app.addMusic);
      }
    },
  });
  cleanUp(app);

  assert.ok(!crashed(r), r.out);
  assert.equal(r.plays[0].track, 'a.mp3');
  const firstNew = r.plays.findIndex((p) => p.track !== 'a.mp3');
  assert.ok(firstNew >= 1 && firstNew <= 2, `новый файл с ${firstNew}-го трека:\n${r.out.slice(0, 3000)}`);
  const fri = r.plays.filter((p) => p.date === '2026-10-30').slice(firstNew);
  const sat = r.plays.filter((p) => p.date === '2026-10-31');
  assert.ok(fri.length > 0 && fri.every((p) => p.track === 'b.mp3'), 'пятница из нового файла');
  assert.ok(sat.length > 3 && sat.every((p) => p.track === 's.mp3'), 'в полночь суббота из нового файла');
  assert.equal((r.out.match(/playlist\.json изменился/g) || []).length, 1, 'перечитал один раз, без повторов');
});

test('a broken playlist.json mid-session: the player keeps its list, warns once, no txt', { skip: !expressAvailable }, async () => {
  const app = makeApp({ playlist: sameEveryDay([['00:00', '24:00', ['a.mp3']]]) });
  let broke = false;
  const r = await run(app, {
    start: '2026-10-30T10:00:00+03:00', speed: 120, trackSeconds: 240, realMs: 10000,
    onLine(line) {
      if (!broke && line.includes('▶')) {
        broke = true;
        fs.writeFileSync(path.join(app.dir, 'playlist.json'), '{"playlists":[{"na');
      }
    },
  });
  cleanUp(app);

  assert.ok(!crashed(r), r.out);
  assert.ok(r.plays.length > 3);
  assert.ok(r.plays.every((p) => p.track === 'a.mp3'), 'играет прочитанный список, не txt');
  assert.equal((r.out.match(/нет рабочего расписания/g) || []).length, 1, 'предупредил один раз');
});

test('stats carry the record id, the file\'s table and the Завхоз status; likes do not carry the status', { skip: !expressAvailable }, async () => {
  const app = makeApp({
    playlist: sameEveryDay([['00:00', '24:00', ['a.mp3', 'b.mp3', 'c.mp3']]]),
    state: { status: 'проверка 30.10 23:18 ок; работа —' },
  });
  let disliked = false;
  const r = await run(app, {
    start: '2026-10-30T10:00:00+03:00', speed: 600, realMs: 8000,
    onLine(line) {
      if (!disliked && line.includes('▶')) {
        disliked = true;
        fetch(`http://127.0.0.1:${app.port}/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'value=dislike',
        }).catch(() => {});
      }
    },
  });
  cleanUp(app);

  assert.ok(!crashed(r), r.out);
  const stats = r.fetches.filter((f) => f.endpoint === 'updateSongStats');
  assert.ok(stats.length > 0, r.out.slice(0, 1500));
  for (const { body } of stats) {
    assert.equal(body.tableId, 'tblFILE');
    assert.equal(body.recordId, `rec-${body.songName}.mp3`);
    assert.equal(body.zavhozStatus, 'проверка 30.10 23:18 ок; работа —');
    assert.equal(body.playlistName, 'P 00:00-24:00');
  }

  const likes = r.fetches.filter((f) => f.endpoint === 'updateRecordStatus');
  assert.equal(likes.length, 1);
  assert.equal(likes[0].body.newStatus, 'Dislike');
  assert.equal(likes[0].body.recordId, `rec-${likes[0].body.songName}.mp3`);
  assert.equal(likes[0].body.zavhozStatus, undefined);
});

test('a disliked track does not come back at the next reload, the old txt is left alone', { skip: !expressAvailable }, async () => {
  const app = makeApp({ playlist: sameEveryDay([['00:00', '24:00', ['a.mp3', 'b.mp3', 'c.mp3']]]) });
  const txtBefore = fs.readFileSync(path.join(app.dir, 'tracks.txt'), 'utf8');
  let disliked = null;
  const r = await run(app, {
    start: '2026-10-30T23:50:00+03:00', speed: 60, trackSeconds: 120, realMs: 25000,
    onLine(line, child) {
      if (!disliked && line.includes('▶')) {
        disliked = line.match(/\] (\S+\.mp3)/)[1];
        fetch(`http://127.0.0.1:${app.port}/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'value=dislike',
        }).catch(() => {});
      }
      if (line.includes('▶') && line.includes('(1/2)')) setTimeout(() => child.kill(), 1500);
    },
  });
  const txtAfter = fs.readFileSync(path.join(app.dir, 'tracks.txt'), 'utf8');
  cleanUp(app);

  assert.ok(!crashed(r), r.out);
  assert.equal(txtAfter, txtBefore);
  const afterReload = r.plays.filter((p) => p.date === '2026-10-31');
  assert.ok(afterReload.length > 0, r.out.slice(-1500));
  assert.ok(afterReload.every((p) => p.track !== disliked));
});

test('the old way keeps its exit: without the file a scheduled player stops at the stop time', { skip: !expressAvailable }, async () => {
  const stopAt10 = Object.fromEntries(Array.from({ length: 7 }, (_, d) => [d, { start: '08:00', stop: '10:00' }]));
  const app = makeApp({ config: { mode24h: false, daySchedule: stopAt10 } });
  const r = await run(app, { start: '2026-10-30T09:00:00+03:00', speed: 3600, realMs: 8000 });
  cleanUp(app);

  assert.equal(r.exited, 0);
  assert.match(r.out, /До завтра/);
  assert.ok(r.plays.length > 3);
});

test('a second player on a busy port never starts playing', { skip: !expressAvailable }, async () => {
  const first = makeApp({ playlist: sameEveryDay([['00:00', '24:00', ['a.mp3']]]) });
  const second = makeApp({ playlist: sameEveryDay([['00:00', '24:00', ['a.mp3']]]) });
  second.port = first.port;

  let secondResult;
  await run(first, {
    start: '2026-10-30T10:00:00+03:00', speed: 60, realMs: 4000,
    onLine(line) {
      if (!secondResult && line.includes('▶')) {
        secondResult = run(second, { start: '2026-10-30T10:00:00+03:00', speed: 60, realMs: 3000 });
      }
    },
  });
  const r = await secondResult;
  cleanUp(first);
  cleanUp(second);

  assert.equal(r.exited, 1);
  assert.equal(r.plays.length, 0);
});
