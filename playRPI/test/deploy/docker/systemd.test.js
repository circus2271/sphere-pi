'use strict';

/**
 * Тесты уровня "оркестрация под НАСТОЯЩИМ systemd".
 *
 * Зачем отдельный ярус: в test/deploy/update.test.js systemctl/sudo/npm
 * подменены заглушками через PATH. Там можно проверить, ЧТО скрипт позвал,
 * но нельзя проверить, что из этого реально вышло. Здесь systemd работает
 * как PID 1 в контейнере, поэтому проверяем именно последствия:
 *
 *   1. юнит поднимается сам при старте системы;
 *   2. Restart=always реально перезапускает убитый процесс (новый MainPID);
 *   3. update.mjs реально доводит обновление до конца: origin → git reset →
 *      SIGUSR2 → плеер вышел → systemd поднял его на новом коде;
 *   4. daemon-reload реально подхватывается живым демоном (RestartSec);
 *   5. правило в sudoers реально позволяет pi дёрнуть systemd по D-Bus.
 *
 * Всё делается через `docker exec` — то есть настоящими командами в живой
 * системе, а не разбором логов.
 *
 * Ярус медленный (сборка образа + сеть), поэтому он ВНЕ `npm test`:
 *   npm run test:docker
 *
 * Если Docker недоступен — тест пропускается, а не падает.
 *
 * Отладка: KEEP_CONTAINER=1 npm run test:docker — контейнер останется жив,
 * дальше можно смотреть `docker exec -it sphere-systemd-test-run bash`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const DOCKERFILE = path.join(__dirname, 'Dockerfile');
const IMAGE = 'sphere-systemd-test';
const CONTAINER = 'sphere-systemd-test-run';

// Пути внутри контейнера — те же, что на устройстве (заданы в Dockerfile).
const DEVICE_USER = 'spherepi-peremena';
const DEVICE_REPO = `/home/${DEVICE_USER}/sphere/sphere-pi`;
const APP_DIR = `${DEVICE_REPO}/playRPI`;
const ORIGIN = `/home/${DEVICE_USER}/origin.git`;
const UNIT_FILE = `${DEVICE_REPO}/deploy/sphere-player.service`;
const SERVICE = 'sphere-player';
const BRANCH = 'master'; // UPDATE_BRANCH по умолчанию в update.mjs

let dockerSkip = false;
try {
  execFileSync('docker', ['version'], { stdio: 'ignore' });
} catch {
  dockerSkip = 'Docker недоступен (не установлен или демон не запущен) — пропускаю ярус systemd';
}

// ── помощники ────────────────────────────────────────────────

function dexec(...cmd) {
  return spawnSync('docker', ['exec', CONTAINER, ...cmd], { encoding: 'utf8' });
}

function dexecOk(...cmd) {
  const res = dexec(...cmd);
  if (res.status !== 0) {
    throw new Error(
      `docker exec ${cmd.join(' ')} → код ${res.status}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`
    );
  }
  return res.stdout.trim();
}

/** Выполнить shell-строку от имени владельца проекта — как это делает крон. */
function asPi(script) {
  return dexec('su', DEVICE_USER, '-c', script);
}

function asPiOk(script) {
  const res = asPi(script);
  if (res.status !== 0) {
    throw new Error(
      `su ${DEVICE_USER} -c '${script}' → код ${res.status}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`
    );
  }
  return res.stdout.trim();
}

function mainPid() {
  return dexec('systemctl', 'show', '-p', 'MainPID', '--value', SERVICE).stdout.trim();
}

function isActive() {
  return dexec('systemctl', 'is-active', SERVICE).stdout.trim();
}

async function waitFor(fn, { timeoutMs = 60000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Дождаться нового MainPID (не старого, не нулевого). */
function waitForNewPid(oldPid, opts) {
  return waitFor(() => {
    const p = mainPid();
    return p && p !== '0' && p !== oldPid ? p : false;
  }, opts);
}

// ── сам тест ─────────────────────────────────────────────────

test('Docker + реальный systemd', { skip: dockerSkip, concurrency: 1 }, async (t) => {
  t.before(() => {
    // Сборка: контекст — корень репозитория, рядом с Dockerfile лежит
    // Dockerfile.dockerignore, он выкидывает node_modules и статику.
    execFileSync('docker', ['build', '-t', IMAGE, '-f', DOCKERFILE, REPO_ROOT], {
      stdio: 'inherit',
    });

    spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });

    // Настоящий systemd как PID 1 требует именно этих флагов.
    execFileSync('docker', [
      'run', '-d', '--name', CONTAINER,
      '--privileged',
      '--cgroupns=host',
      '-v', '/sys/fs/cgroup:/sys/fs/cgroup:rw',
      IMAGE,
    ]);
  });

  t.after(() => {
    if (process.env.KEEP_CONTAINER === '1') {
      console.log(`\nКонтейнер ${CONTAINER} оставлен для отладки (KEEP_CONTAINER=1).`);
      return;
    }
    spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  });

  await t.test('systemd догружается до multi-user.target', async () => {
    const booted = await waitFor(() => {
      const state = dexec('systemctl', 'is-system-running').stdout.trim();
      // degraded — это нормально: часть замаскированных юнитов не стартует
      return state === 'running' || state === 'degraded' ? state : false;
    }, { timeoutMs: 90000 });

    if (!booted) {
      const logs = spawnSync('docker', ['logs', '--tail', '60', CONTAINER], { encoding: 'utf8' });
      throw new Error(`systemd не догрузился\n--- docker logs ---\n${logs.stdout}\n${logs.stderr}`);
    }
    assert.ok(booted);
  });

  await t.test('юнит sphere-player поднимается сам при старте системы', async () => {
    const up = await waitFor(() => (isActive() === 'active' ? 'active' : false), { timeoutMs: 60000 });
    if (!up) {
      const status = dexec('systemctl', 'status', SERVICE, '--no-pager', '-l').stdout;
      const journal = dexec('journalctl', '-u', SERVICE, '--no-pager', '-n', '50').stdout;
      throw new Error(`сервис не стал active\n--- status ---\n${status}\n--- journal ---\n${journal}`);
    }

    assert.equal(isActive(), 'active');
    const pid = mainPid();
    assert.ok(pid && pid !== '0', `ожидался живой MainPID, получил "${pid}"`);

    // именно наш файл, а не что-то другое
    const cmdline = dexecOk('ps', '-o', 'args=', '-p', pid);
    assert.match(cmdline, /node-sound-player-production\.js/);
  });

  await t.test('Restart=always: SIGKILL процессу → systemd поднимает новый', async () => {
    const oldPid = mainPid();
    assert.ok(oldPid && oldPid !== '0');

    dexecOk('kill', '-9', oldPid);

    const newPid = await waitForNewPid(oldPid, { timeoutMs: 60000 });
    assert.ok(newPid, `после SIGKILL новый MainPID так и не появился (старый ${oldPid})`);
    assert.notEqual(newPid, oldPid);
    assert.equal(isActive(), 'active');
  });

  await t.test('update.mjs: реальный прогон обновления от origin до перезапуска', async () => {
    // 1. Выкладываем "релиз" в origin: клон → коммит → push.
    //    Всё внутри контейнера — никаких bind-mount'ов с Windows-хоста,
    //    иначе git спотыкается о права и владельца файлов.
    const seed = `/home/${DEVICE_USER}/seed`;
    asPiOk(`rm -rf ${seed} && git clone -q ${ORIGIN} ${seed}`);
    asPiOk(
      `cd ${seed} && echo "релиз для теста" > playRPI/RELEASE-MARKER.md && ` +
      `git add -A && git commit -q -m "test release" && git push -q origin ${BRANCH}`
    );
    const releaseHead = asPiOk(`git -C ${seed} rev-parse HEAD`);

    const beforeHead = asPiOk(`git -C ${DEVICE_REPO} rev-parse HEAD`);
    assert.notEqual(beforeHead, releaseHead, 'до обновления HEAD устройства должен отличаться');
    const oldPid = mainPid();

    // 2. Запускаем update.mjs ровно так, как это делает крон на устройстве.
    const res = asPi(`cd ${DEVICE_REPO} && ./node_modules/.bin/zx deploy/update.mjs`);
    const output = `${res.stdout}\n${res.stderr}`;
    assert.equal(res.status, 0, `update.mjs упал:\n${output}`);

    // 3. Код на устройстве реально переехал на origin.
    const afterHead = asPiOk(`git -C ${DEVICE_REPO} rev-parse HEAD`);
    assert.equal(afterHead, releaseHead, `HEAD не переехал на релиз:\n${output}`);
    assert.equal(
      asPi(`test -f ${APP_DIR}/RELEASE-MARKER.md`).status,
      0,
      'файла из релиза нет в рабочей копии'
    );

    // 4. Плеер получил SIGUSR2, вышел мягко, systemd поднял его заново.
    assert.match(output, /SIGUSR2/);
    const newPid = await waitForNewPid(oldPid, { timeoutMs: 60000 });
    assert.ok(newPid, `после update.mjs сервис не перезапустился (старый PID ${oldPid}):\n${output}`);
    assert.equal(isActive(), 'active');
  });

  await t.test('daemon-reload: правка юнита реально подхватывается живым демоном', async () => {
    // В юните RestartSec=5 → systemd показывает это как RestartUSec=5s.
    assert.equal(dexecOk('systemctl', 'show', '-p', 'RestartUSec', '--value', SERVICE), '5s');

    try {
      asPiOk(`sed -i 's/^RestartSec=5$/RestartSec=17/' ${UNIT_FILE}`);

      // Пока не перечитали конфигурацию — демон живёт со старым значением.
      assert.equal(
        dexecOk('systemctl', 'show', '-p', 'RestartUSec', '--value', SERVICE),
        '5s',
        'значение изменилось ДО daemon-reload — тест ничего не доказывает'
      );

      // Тот самый вызов, ради которого в sudoers лежит правило.
      asPiOk('sudo systemctl daemon-reload');

      assert.equal(
        dexecOk('systemctl', 'show', '-p', 'RestartUSec', '--value', SERVICE),
        '17s',
        'daemon-reload не подхватил новый RestartSec'
      );
    } finally {
      asPiOk(`sed -i 's/^RestartSec=17$/RestartSec=5/' ${UNIT_FILE}`);
      asPiOk('sudo systemctl daemon-reload');
    }

    assert.equal(dexecOk('systemctl', 'show', '-p', 'RestartUSec', '--value', SERVICE), '5s');
  });

  await t.test('sudoers: pi может дёрнуть systemd по D-Bus (restart), но не больше', async () => {
    const oldPid = mainPid();

    asPiOk(`sudo systemctl restart ${SERVICE}`);
    const newPid = await waitForNewPid(oldPid, { timeoutMs: 60000 });
    assert.ok(newPid, 'sudo systemctl restart не перезапустил сервис');
    assert.equal(isActive(), 'active');

    // Правило в sudoers узкое: всё остальное должно отлетать.
    const forbidden = asPi(`sudo systemctl stop ${SERVICE}`);
    assert.notEqual(forbidden.status, 0, 'sudo пропустил команду, которой нет в sudoers');
    assert.equal(isActive(), 'active', 'сервис не должен был остановиться');
  });
});
