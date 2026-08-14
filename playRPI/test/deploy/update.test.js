'use strict';

/**
 * Интеграционные тесты для deploy/update.mjs.
 * Требуют установленный zx (npm ci в playRPI/ ставит его как dependency).
 * Не прогонялись в песочнице Claude — нет сети, чтобы поставить zx.
 * Прогоняй на своей машине: npm ci && npm run test:deploy
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const UPDATE_JS = path.join(REPO_ROOT, '..', 'deploy', 'update.mjs');
// node_modules переехал в корень репозитория (на уровень выше playRPI) —
// туда же, где теперь package.json.
const ZX_BIN = path.join(REPO_ROOT, '..', 'node_modules', '.bin', 'zx');
const FAKE_BIN_DIR = path.join(__dirname, 'fixtures', 'fake-bin');
const FAKE_PLAYER_SRC = path.join(__dirname, 'fixtures', 'fake-node-sound-player-production.js');

let zxAvailable = fs.existsSync(ZX_BIN);

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${res.stdout}\n${res.stderr}`);
  }
  return res.stdout.trim();
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-update-test-'));
  const originDir = path.join(root, 'origin.git');
  const deviceDir = path.join(root, 'device');
  const appDir = path.join(deviceDir, 'playRPI');

  sh('git', ['init', '--bare', '--initial-branch=master', originDir]);

  const seedDir = path.join(root, 'seed');
  fs.mkdirSync(path.join(seedDir, 'playRPI', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(seedDir, 'playRPI', 'package.json'), JSON.stringify({ name: 'seed', version: '1.0.0' }, null, 2));
  fs.writeFileSync(path.join(seedDir, 'playRPI', 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }, null, 2));
  fs.writeFileSync(path.join(seedDir, 'playRPI', 'deploy', 'sphere-player.service'), '[Service]\nExecStart=fake\n');
  sh('git', ['init', '--initial-branch=master', seedDir]);
  sh('git', ['-C', seedDir, 'config', 'user.email', 'test@test'], {});
  sh('git', ['-C', seedDir, 'config', 'user.name', 'test'], {});
  sh('git', ['-C', seedDir, 'add', '.'], {});
  sh('git', ['-C', seedDir, 'commit', '-m', 'initial'], {});
  sh('git', ['-C', seedDir, 'remote', 'add', 'origin', originDir], {});
  sh('git', ['-C', seedDir, 'push', 'origin', 'master'], {});

  sh('git', ['clone', originDir, deviceDir]);
  sh('git', ['-C', deviceDir, 'config', 'user.email', 'test@test'], {});
  sh('git', ['-C', deviceDir, 'config', 'user.name', 'test'], {});

  const playerFileName = `fake-player-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.js`;
  const playerPath = path.join(root, playerFileName);
  fs.copyFileSync(FAKE_PLAYER_SRC, playerPath);

  const npmControlFile = path.join(root, 'npm-control');
  const sudoLog = path.join(root, 'sudo.log');
  const systemctlLog = path.join(root, 'systemctl.log');
  const updateLog = path.join(root, 'update.log');

  const env = {
    ...process.env,
    PATH: `${FAKE_BIN_DIR}:${process.env.PATH}`,
    UPDATE_REPO_DIR: deviceDir,
    UPDATE_APP_DIR: appDir,
    UPDATE_SERVICE_UNIT_PATH: path.join(deviceDir, 'playRPI', 'deploy', 'sphere-player.service'),
    UPDATE_SERVICE_NAME: 'sphere-player-test',
    UPDATE_BRANCH: 'master',
    UPDATE_FETCH_TIMEOUT: '10',
    UPDATE_EXIT_DEADLINE: '5',
    UPDATE_POLL_INTERVAL: '1',
    UPDATE_PLAYER_PATTERN: `node .*${playerFileName}`,
    FAKE_NPM_CONTROL_FILE: npmControlFile,
    FAKE_SUDO_LOG: sudoLog,
    FAKE_SYSTEMCTL_LOG: systemctlLog,
  };

  let playerProc = null;
  function startPlayer(extraEnv = {}) {
    const { spawn } = require('child_process');
    playerProc = spawn('node', [playerPath], {
      env: { ...process.env, ...extraEnv },
      stdio: 'ignore',
    });
    return playerProc;
  }

  function runUpdate() {
    const res = spawnSync(ZX_BIN, [UPDATE_JS], { env, encoding: 'utf8' });
    fs.writeFileSync(updateLog, (res.stdout || '') + (res.stderr || ''));
    return res;
  }

  function commitToOrigin(mutate) {
    mutate(seedDir);
    sh('git', ['-C', seedDir, 'add', '.'], {});
    sh('git', ['-C', seedDir, 'commit', '-m', 'update'], {});
    sh('git', ['-C', seedDir, 'push', 'origin', 'master'], {});
  }

  t.after(() => {
    if (playerProc && !playerProc.killed) {
      try { process.kill(playerProc.pid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { root, deviceDir, appDir, seedDir, npmControlFile, sudoLog, systemctlLog, updateLog, startPlayer, runUpdate, commitToOrigin, getPlayerProc: () => playerProc };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('update.mjs: нет нового кода — ничего не трогает', { skip: !zxAvailable && 'zx не установлен — прогони npm ci' }, (t) => {
  const f = makeFixture(t);
  f.startPlayer();
  const res = f.runUpdate();
  assert.equal(res.status, 0);
  assert.match(fs.readFileSync(f.updateLog, 'utf8'), /Код актуален/);
  assert.ok(isAlive(f.getPlayerProc().pid));
});

test('update.mjs: новый код без изменения lock — npm ci пропускается, плеер выходит', { skip: !zxAvailable && 'zx не установлен' }, async (t) => {
  const f = makeFixture(t);
  f.startPlayer();
  const oldPid = f.getPlayerProc().pid;

  f.commitToOrigin((seedDir) => {
    fs.writeFileSync(path.join(seedDir, 'playRPI', 'README.md'), 'просто изменение кода');
  });

  const res = f.runUpdate();
  const log = fs.readFileSync(f.updateLog, 'utf8');

  assert.equal(res.status, 0);
  assert.doesNotMatch(log, /npm ci/);
  assert.match(log, /SIGUSR2/);
  assert.match(log, /вышел мягко/);
  assert.ok(!isAlive(oldPid));
});

test('update.mjs: изменился lock-файл — вызывается npm ci (успех)', { skip: !zxAvailable && 'zx не установлен' }, async (t) => {
  const f = makeFixture(t);
  f.startPlayer();
  fs.writeFileSync(f.npmControlFile, 'success');

  f.commitToOrigin((seedDir) => {
    fs.writeFileSync(path.join(seedDir, 'playRPI', 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, extra: true }));
  });

  const res = f.runUpdate();
  const log = fs.readFileSync(f.updateLog, 'utf8');

  assert.equal(res.status, 0);
  assert.match(log, /npm ci/);
  assert.ok(fs.existsSync(path.join(f.appDir, 'node_modules', '.marker')));
});

test('update.mjs: npm ci проваливается — откат, сигнал НЕ отправляется', { skip: !zxAvailable && 'zx не установлен' }, async (t) => {
  const f = makeFixture(t);
  f.startPlayer();
  const pid = f.getPlayerProc().pid;
  const beforeHead = sh('git', ['-C', f.deviceDir, 'rev-parse', 'HEAD']);

  fs.writeFileSync(f.npmControlFile, 'fail');

  f.commitToOrigin((seedDir) => {
    fs.writeFileSync(path.join(seedDir, 'playRPI', 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, broken: true }));
  });

  const res = f.runUpdate();
  const log = fs.readFileSync(f.updateLog, 'utf8');

  assert.equal(res.status, 1);
  assert.match(log, /ПРОВАЛИЛСЯ/);
  assert.doesNotMatch(log, /SIGUSR2/);

  const afterHead = sh('git', ['-C', f.deviceDir, 'rev-parse', 'HEAD']);
  assert.equal(afterHead, beforeHead);
  assert.ok(isAlive(pid));
});

test('update.mjs: изменился .service-файл — вызывается systemctl daemon-reload', { skip: !zxAvailable && 'zx не установлен' }, async (t) => {
  const f = makeFixture(t);
  f.startPlayer();

  f.commitToOrigin((seedDir) => {
    fs.writeFileSync(path.join(seedDir, 'playRPI', 'deploy', 'sphere-player.service'), '[Service]\nExecStart=fake\nRestartSec=10\n');
  });

  f.runUpdate();

  assert.ok(fs.existsSync(f.systemctlLog));
  assert.match(fs.readFileSync(f.systemctlLog, 'utf8'), /daemon-reload/);
});

test('update.mjs: плеер завис — принудительный systemctl restart', { skip: !zxAvailable && 'zx не установлен' }, async (t) => {
  const f = makeFixture(t);
  f.startPlayer({ FAKE_PLAYER_HANG: '1' });

  f.commitToOrigin((seedDir) => {
    fs.writeFileSync(path.join(seedDir, 'playRPI', 'README.md'), 'триггерим обновление');
  });

  f.runUpdate();
  const log = fs.readFileSync(f.updateLog, 'utf8');

  assert.match(log, /Мягкий выход не случился/);
  assert.match(fs.readFileSync(f.systemctlLog, 'utf8'), /restart sphere-player-test/);
});
