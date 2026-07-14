'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerMock } = require('./support/moduleMock');
registerMock('_playerConfig', { playlists: [], recentGuard: 5 });
registerMock('node-fetch', async () => ({ json: async () => ({}), text: async () => '' }));

const { RecentTracksService } = require('../_recentTracksService');

function makeTracks(n) {
  return Array.from({ length: n }, (_, k) => `/music/track-${k}.mp3`);
}

test('remember caps the history at the guard size', () => {
  const service = new RecentTracksService(3);
  for (const t of makeTracks(10)) service.remember(t);
  assert.equal(service.recentTracks.length, 3);
  assert.deepEqual(service.recentTracks, [
    '/music/track-7.mp3',
    '/music/track-8.mp3',
    '/music/track-9.mp3',
  ]);
});

test('shuffleWithRecentGuard pushes recently played tracks to the tail', () => {
  const service = new RecentTracksService(5);
  const playlist = makeTracks(30);
  const recentlyPlayed = playlist.slice(0, 5);
  recentlyPlayed.forEach((t) => service.remember(t));

  service.shuffleWithRecentGuard(playlist);

  // guardN = min(5, 30/3=10) = 5 → the LAST 5 slots hold exactly those tracks
  const tail = playlist.slice(-5);
  assert.deepEqual([...tail].sort(), [...recentlyPlayed].sort());
  // and none of them appear earlier in the list
  const head = playlist.slice(0, -5);
  for (const t of recentlyPlayed) {
    assert.ok(!head.includes(t), `${t} leaked into the head of the shuffle`);
  }
});

test('guard window shrinks to a third of small playlists', () => {
  const service = new RecentTracksService(30);
  const playlist = makeTracks(6); // guardN = min(30, 2) = 2
  service.remember(playlist[0]);
  service.remember(playlist[1]);
  service.remember(playlist[2]); // only last 2 of history count
  const expectedTail = [playlist[1], playlist[2]]; // capture BEFORE in-place shuffle

  service.shuffleWithRecentGuard(playlist);

  const tail = playlist.slice(-2);
  assert.deepEqual([...tail].sort(), [...expectedTail].sort());
});

test('shuffleWithRecentGuard mutates the array IN PLACE (same reference)', () => {
  // loadNextTrack compares playlists by reference (newPlaylist !== currentPlaylist),
  // so the shuffle must never replace the array object.
  const service = new RecentTracksService(5);
  const playlist = makeTracks(12);
  const sameRef = service.shuffleWithRecentGuard(playlist);
  assert.equal(sameRef, playlist);
});

test('history entries not present in the list are ignored', () => {
  const service = new RecentTracksService(5);
  service.remember('/music/from-other-playlist.mp3');
  service.remember('/music/deleted-by-dislike.mp3');

  const playlist = makeTracks(9);
  const before = [...playlist].sort();
  service.shuffleWithRecentGuard(playlist);

  assert.deepEqual([...playlist].sort(), before, 'no tracks lost or added');
});

test('empty history means a plain shuffle (no crash, permutation intact)', () => {
  const service = new RecentTracksService(5);
  const playlist = makeTracks(10);
  const before = [...playlist].sort();
  service.shuffleWithRecentGuard(playlist);
  assert.deepEqual([...playlist].sort(), before);
});
