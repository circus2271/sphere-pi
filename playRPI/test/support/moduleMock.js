'use strict';

/**
 * Lightweight CommonJS module interception.
 *
 * Why: the app depends on hardware/network modules (sound-player spawns
 * mpg123, mwl-loudness shells out to amixer, node-fetch hits the cloud,
 * _playerConfig.js is gitignored and machine-specific). None of those can
 * run in a test environment, so we intercept require() calls for them and
 * return controllable fakes instead.
 *
 * Usage (must be called BEFORE the module under test is required):
 *
 *   const { registerMock } = require('./support/moduleMock');
 *   registerMock('node-fetch', myFakeFetch);
 *   registerMock('_playerConfig', myFakeConfig); // matches by suffix too
 *   const helpers = require('../_helpers');
 */

const Module = require('module');

const mocks = new Map();
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  // Exact match (e.g. 'sound-player', 'node-fetch')
  if (mocks.has(request)) {
    return mocks.get(request);
  }
  // Suffix match for relative/local modules (e.g. './_playerConfig')
  const normalized = request.replace(/\.js$/, '');
  for (const [name, value] of mocks) {
    if (normalized === name || normalized.endsWith('/' + name)) {
      return value;
    }
  }
  return originalLoad.apply(this, arguments);
};

function registerMock(name, exportsValue) {
  mocks.set(name, exportsValue);
}

function clearMocks() {
  mocks.clear();
}

/**
 * Temporarily freeze the wall clock seen by `new Date()`.
 * The app schedules by hours AND minutes (and day-of-week for daySchedule),
 * so tests need deterministic control. Works on any Node >= 18.
 *
 * dateArgs: array passed to the Date constructor,
 * e.g. [2026, 0, 15, 11, 30] = Jan 15 2026, 11:30.
 */
function withDate(dateArgs, fn) {
  const RealDate = global.Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length) {
        super(...args);
      } else {
        super(...dateArgs);
      }
    }
    static now() {
      return new FakeDate().getTime();
    }
  }
  global.Date = FakeDate;
  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
}

/** Convenience: freeze only hour/minute on a fixed date (Thu Jan 15 2026). */
function withTime(hour, minute, fn) {
  return withDate([2026, 0, 15, hour, minute, 0], fn);
}

/**
 * Require a module bypassing the require cache (for stateful singletons).
 * Pass an ABSOLUTE path — relative paths would resolve against this file's
 * directory, not the calling test's.
 */
function freshRequire(absoluteModulePath) {
  delete require.cache[require.resolve(absoluteModulePath)];
  return require(absoluteModulePath);
}

module.exports = { registerMock, clearMocks, withDate, withTime, freshRequire };
