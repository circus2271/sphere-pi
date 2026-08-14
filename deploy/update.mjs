#!/usr/bin/env zx
// ─────────────────────────────────────────────────────────────
//  АВТООБНОВЛЕНИЕ SPHERE-PI (запускается кроном), версия на zx (ESM)
//
//  Требует: zx в dependencies package.json (в КОРНЕ репо) — ставится npm ci.
//  Запуск (из корня репо):  ./node_modules/.bin/zx deploy/update.mjs
//
//  Порядок ночи в режиме 24/7 (пример):
//    04:30 — плеер сам делает reshuffle (reshuffleAt в _playerConfig.js)
//    04:45 — этот скрипт (кроном): fetch → npm ci → [daemon-reload] →
//            SIGUSR2 → плеер доигрывает трек, отправляет статистику
//            и выходит → systemd (Restart=always) поднимает новый код.
//
//  Строка для crontab (crontab -e), от пользователя spherepi-peremena:
//    45 4 * * * cd /home/spherepi-peremena/sphere/sphere-pi && ./node_modules/.bin/zx deploy/update.mjs >> deploy/update.log 2>&1
//
//  Требуется ОДНОРАЗОВЫЙ bootstrap на каждом Pi:
//    1) sudo ln -s /home/spherepi-peremena/sphere/sphere-pi/deploy/sphere-player.service /etc/systemd/system/
//       sudo systemctl daemon-reload && sudo systemctl enable --now sphere-player
//    2) passwordless sudo для двух команд:
//       sudo visudo -f /etc/sudoers.d/sphere-player, содержимое:
//         spherepi-peremena ALL=(root) NOPASSWD: /bin/systemctl daemon-reload, /bin/systemctl restart sphere-player
//    3) SSH deploy key БЕЗ passphrase для git (иначе fetch зависнет в cron
//       на запросе пароля): ssh-keygen -t ed25519 -f ~/.ssh/sphere_deploy_key -N ""
//       + добавить публичный ключ как Deploy Key в настройках репозитория на GitHub
//
//  Гарантии:
//    - сеть умерла              → пропускаем цикл, музыка не тронута
//    - npm ci упал              → откат на прежний коммит, сигнал не шлём
//    - npm ci И откат упали     → восстанавливаем node_modules из бэкапа
//    - .service файл изменился  → daemon-reload (sudo, без пароля)
//    - плеер завис              → через EXIT_DEADLINE секунд принудительный restart
//    - кода нового нет          → вообще ничего не трогаем
// ─────────────────────────────────────────────────────────────

// Импорт работает только потому, что node_modules лежит в КОРНЕ репозитория:
// Node ищет пакет, поднимаясь вверх от самого файла (deploy/node_modules →
// sphere-pi/node_modules). Если зависимости когда-нибудь вернут внутрь playRPI,
// эта строка сломается с ERR_MODULE_NOT_FOUND ещё до первой команды — то есть
// cron будет молча отрабатывать вхолостую.
import { $, cd, fs, path } from 'zx';

$.verbose = false; // не засорять update.log сырыми командами — свои log() ниже

// Все пути и тайминги настраиваются через env — по умолчанию боевые
// значения для Pi, но тестам (test/deploy/update.test.js) нужны
// временные директории и ускоренные таймауты вместо реальных.
const REPO_DIR = process.env.UPDATE_REPO_DIR || '/home/spherepi-peremena/sphere/sphere-pi';
// package.json/package-lock.json/node_modules лежат в корне репозитория,
// поэтому npm ci выполняется там же, а не в playRPI.
const APP_DIR = process.env.UPDATE_APP_DIR || REPO_DIR;
const SERVICE_UNIT_PATH = process.env.UPDATE_SERVICE_UNIT_PATH || `${REPO_DIR}/deploy/sphere-player.service`;
const SERVICE_NAME = process.env.UPDATE_SERVICE_NAME || 'sphere-player';
const BRANCH = process.env.UPDATE_BRANCH || 'master';
const FETCH_TIMEOUT = Number(process.env.UPDATE_FETCH_TIMEOUT || 60);
const EXIT_DEADLINE = Number(process.env.UPDATE_EXIT_DEADLINE || 600);
const POLL_INTERVAL = Number(process.env.UPDATE_POLL_INTERVAL || 5);
const PLAYER_MATCH_PATTERN = process.env.UPDATE_PLAYER_PATTERN || 'node .*node-sound-player-production.js';
// путь к package-lock.json ОТНОСИТЕЛЬНО корня репозитория (для git diff)
const LOCK_PATH_REL = path.relative(REPO_DIR, path.join(APP_DIR, 'package-lock.json'));

const log = (msg) => console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fileHash(filePath) {
  if (!(await fs.pathExists(filePath))) return null;
  return (await $`sha256sum ${filePath}`).stdout.split(' ')[0];
}

cd(REPO_DIR);

// ── 1. Проверяем, есть ли что обновлять ─────────────────────
// GIT_SSH_COMMAND с BatchMode=yes: если ssh вдруг всё же попросит
// интерактивный ввод (сбитый ключ/passphrase) — упадёт сразу, а не
// зависнет молча на минуту до timeout.
process.env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';

try {
  await $`timeout ${FETCH_TIMEOUT} git fetch origin ${BRANCH} --quiet`;
} catch (e) {
  log('git fetch не удался (нет сети или проблема с SSH-ключом?) — пропускаю до следующего запуска.');
  process.exit(0);
}

const local = (await $`git rev-parse HEAD`).stdout.trim();
const remote = (await $`git rev-parse origin/${BRANCH}`).stdout.trim();

if (local === remote) {
  log(`Код актуален (${local.slice(0, 8)}) — ничего не делаю.`);
  process.exit(0);
}

log(`Обновление: ${local.slice(0, 8)} → ${remote.slice(0, 8)}`);

const serviceHashBefore = await fileHash(SERVICE_UNIT_PATH);

// ── 2. Применяем новый код (плеер в памяти — ему всё равно) ──
const lockDiff = (
  await $`git diff --name-only ${local} ${remote} -- ${LOCK_PATH_REL}`
).stdout.trim();
const lockChanged = lockDiff.length > 0;

await $`git reset --hard origin/${BRANCH} --quiet`;

if (lockChanged) {
  log('package-lock.json изменился — npm ci…');

  const backupDir = `${APP_DIR}/node_modules.backup`;
  const hadNodeModules = await fs.pathExists(`${APP_DIR}/node_modules`);

  if (hadNodeModules) {
    await $`rm -rf ${backupDir}`;
    await $`cp -r ${APP_DIR}/node_modules ${backupDir}`;
  }

  try {
    await $`cd ${APP_DIR} && npm ci --omit=dev --no-audit --no-fund`;
    if (hadNodeModules) await $`rm -rf ${backupDir}`;
  } catch (e) {
    log(`npm ci ПРОВАЛИЛСЯ — откатываюсь на ${local.slice(0, 8)}, сигнал плееру НЕ шлём.`);
    await $`git reset --hard ${local} --quiet`;

    try {
      await $`cd ${APP_DIR} && npm ci --omit=dev --no-audit --no-fund`;
      log('Откат npm ci прошёл успешно — node_modules соответствует старому коду.');
      if (hadNodeModules) await $`rm -rf ${backupDir}`;
    } catch (e2) {
      log('⚠ Откат npm ci тоже провалился — восстанавливаю node_modules из бэкапа.');
      if (hadNodeModules) {
        await $`rm -rf ${APP_DIR}/node_modules`;
        await $`mv ${backupDir} ${APP_DIR}/node_modules`;
        log('node_modules восстановлен из бэкапа — старый код должен снова работать при следующем запуске.');
      } else {
        log('⚠ Бэкапа node_modules не было (его и до этого не существовало) — нужно вмешательство!');
      }
    }
    process.exit(1);
  }
}

// ── 3. Если .service файл изменился — daemon-reload (sudo, без пароля) ──
const serviceHashAfter = await fileHash(SERVICE_UNIT_PATH);

if (serviceHashBefore !== serviceHashAfter) {
  log('sphere-player.service изменился — systemctl daemon-reload…');
  try {
    await $`sudo /bin/systemctl daemon-reload`;
    log('daemon-reload выполнен успешно.');
  } catch (e) {
    log('⚠ daemon-reload ПРОВАЛИЛСЯ — проверь passwordless sudo (см. шапку файла).');
  }
}

// ── 4. Находим PID плеера (не важно, кто его супервизирует) ──
let pid;
try {
  pid = (await $`pgrep -f ${PLAYER_MATCH_PATTERN}`).stdout.trim().split('\n')[0];
} catch (e) {
  pid = '';
}

if (!pid) {
  log('Плеер сейчас не запущен — новый код подхватится при следующем старте.');
  process.exit(0);
}

log(`SIGUSR2 → PID ${pid} (плеер выйдет после текущего трека и отправки статистики)`);
await $`kill -USR2 ${pid}`;

// ── 5. Ждём мягкого выхода, страхуемся принудительным перезапуском ──
let waited = 0;
while (waited < EXIT_DEADLINE) {
  await sleep(POLL_INTERVAL * 1000);
  waited += POLL_INTERVAL;

  const stillAlive = await $`kill -0 ${pid}`.nothrow();
  if (stillAlive.exitCode !== 0) {
    log(`Готово ✓ Плеер (PID ${pid}) вышел мягко за ${waited}с — systemd поднимет новый код.`);
    process.exit(0);
  }
}

log(`⚠ Мягкий выход не случился за ${EXIT_DEADLINE}с (плеер завис?) — принудительный restart через systemd.`);
try {
  await $`sudo /bin/systemctl restart ${SERVICE_NAME}`;
  log('Принудительный restart выполнен через systemctl.');
} catch (e) {
  log('⚠ systemctl restart тоже провалился (нет passwordless sudo?) — SIGKILL как последний резерв.');
  await $`kill -9 ${pid}`.nothrow();
}
