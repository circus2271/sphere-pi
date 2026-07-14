'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { freshRequire } = require('./support/moduleMock');

// _likeDislikeService exports a singleton with mutable state, so each test
// gets a fresh instance to stay independent of test order.
const SERVICE_PATH = path.join(__dirname, '..', '_likeDislikeService');

test('starts with nothing scheduled', () => {
  const service = freshRequire(SERVICE_PATH);
  assert.equal(service.scheduled, false);
  assert.equal(service.newStatus, null);
});

test('scheduleLikeDislike marks a Like as scheduled', () => {
  const service = freshRequire(SERVICE_PATH);
  service.scheduleLikeDislike({ newStatus: 'Like' });
  assert.equal(service.scheduled, true);
  assert.equal(service.newStatus, 'Like');
});

test('normalizes casing: "dislike" -> "Dislike", "LIKE" -> "Like"', () => {
  const service = freshRequire(SERVICE_PATH);

  service.scheduleLikeDislike({ newStatus: 'dislike' });
  assert.equal(service.newStatus, 'Dislike');

  service.scheduleLikeDislike({ newStatus: 'LIKE' });
  assert.equal(service.newStatus, 'Like');
});

test('a later vote overwrites an earlier one for the same track', () => {
  const service = freshRequire(SERVICE_PATH);
  service.scheduleLikeDislike({ newStatus: 'Like' });
  service.scheduleLikeDislike({ newStatus: 'Dislike' });
  assert.equal(service.newStatus, 'Dislike');
});

test('resetLikeDislikeScheduledValues clears state for the next track', () => {
  const service = freshRequire(SERVICE_PATH);
  service.scheduleLikeDislike({ newStatus: 'Like' });
  service.resetLikeDislikeScheduledValues();
  assert.equal(service.scheduled, false);
  assert.equal(service.newStatus, null);
});
