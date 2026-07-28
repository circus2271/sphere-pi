#!/usr/bin/env zx
// ─────────────────────────────────────────────────────────────
//  АВТООБНОВЛЕНИЕ SPHERE-PI (запускается кроном), версия на zx
//
//  Требует: npm i -g zx   (или локально + вызов через `npx zx update.js`)
//  Делает: chmod +x update.js — и можно запускать напрямую (шебанг above).
//
//  Порядок ночи в режиме 24/7 (пример):
//    04:30 — плеер сам делает reshuffle (reshuffleAt в _playerConfig.js)
//    04:45 — этот скрипт (кроном): fetch → npm ci → SIGUSR2 → плеер
//            доигрывает трек, отправляет статистику и выходит →
//            супервизор (systemd ИЛИ bash wrapper-loop — неважно какой)
//            поднимает новый код.
//
//  Строка для crontab (crontab -e):
//    45 4 * * * /home/pi/sphere-pi/playRPI/deploy/update.js >> /home/pi/sphere-pi/playRPI/deploy/update.log 2>&1
//
//  Гарантии:
//    - сеть умерла        → пропускаем цикл, музыка не тронута
//    - npm ci упал        → откат на прежний коммит, сигнал не шлём
//    - плеер завис        → через EXIT_DEADLINE секунд шлём SIGKILL
//    - кода нового нет    → вообще ничего не трогаем
//
//  ВАЖНО: поиск процесса через pgrep, а не systemctl — скрипт не
//  привязан к тому, ЧТО именно поднимет плеера после выхода
//  (systemd с Restart=always, или свой bash wrapper-loop). Это
//  забота супервизора, а не этого скрипта.
// ─────────────────────────────────────────────────────────────

$.verbose = false; // не засорять update.log сырыми командами — свои log() ниже

const REPO_DIR = '/home/pi/sphere-pi';
const APP_DIR = `${REPO_DIR}/playRPI`;
const BRANCH = 'master';
const FETCH_TIMEOUT = 60;     // сек на git fetch
const EXIT_DEADLINE = 600;    // сек ожидания мягкого выхода (SIGUSR2)
const POLL_INTERVAL = 5;      // сек между проверками, жив ли ещё старый PID

const log = (msg) => console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

cd(REPO_DIR);

// ── 1. Проверяем, есть ли что обновлять ─────────────────────
try {
  await $`timeout ${FETCH_TIMEOUT} git fetch origin ${BRANCH} --quiet`;
} catch (e) {
  log('git fetch не удался (нет сети?) — пропускаю до следующего запуска.');
  process.exit(0); // музыка важнее: ничего не трогаем
}

const local = (await $`git rev-parse HEAD`).stdout.trim();
const remote = (await $`git rev-parse origin/${BRANCH}`).stdout.trim();

if (local === remote) {
  log(`Код актуален (${local.slice(0, 8)}) — ничего не делаю.`);
  process.exit(0);
}

log(`Обновление: ${local.slice(0, 8)} → ${remote.slice(0, 8)}`);

// ── 2. Применяем новый код (плеер в памяти — ему всё равно) ──
const lockDiff = (
  await $`git diff --name-only ${local} ${remote} -- playRPI/package-lock.json`
).stdout.trim();
const lockChanged = lockDiff.length > 0;

await $`git reset --hard origin/${BRANCH} --quiet`;

if (lockChanged) {
  log('package-lock.json изменился — npm ci…');
  try {
    await $`cd ${APP_DIR} && npm ci --omit=dev --no-audit --no-fund`;
  } catch (e) {
    log(`npm ci ПРОВАЛИЛСЯ — откатываюсь на ${local.slice(0, 8)}, сигнал плееру НЕ шлём.`);
    await $`git reset --hard ${local} --quiet`;
    try {
      await $`cd ${APP_DIR} && npm ci --omit=dev --no-audit --no-fund`;
    } catch (e2) {
      log('⚠ Откат npm ci тоже провалился — нужно вмешательство!');
    }
    process.exit(1);
  }
}

// ── 3. Находим PID плеера (не важно, кто его супервизирует) ──
// pgrep -f ищет по полной командной строке — совпадает с ExecStart
// в sphere-player.service, если менять команду запуска — поправь и тут.
let pid;
try {
  pid = (await $`pgrep -f "node .*node-sound-player-production.js"`).stdout.trim().split('\n')[0];
} catch (e) {
  pid = '';
}

if (!pid) {
  log('Плеер сейчас не запущен — новый код подхватится при следующем старте.');
  process.exit(0);
}

log(`SIGUSR2 → PID ${pid} (плеер выйдет после текущего трека и отправки статистики)`);
await $`kill -USR2 ${pid}`;

// ── 4. Ждём мягкого выхода, страхуемся принудительным SIGKILL ─
let waited = 0;
while (waited < EXIT_DEADLINE) {
  await sleep(POLL_INTERVAL * 1000);
  waited += POLL_INTERVAL;

  const stillAlive = await $`kill -0 ${pid}`.nothrow();
  if (stillAlive.exitCode !== 0) {
    log(`Готово ✓ Плеер (PID ${pid}) вышел мягко за ${waited}с — супервизор поднимет новый код.`);
    process.exit(0);
  }
}

log(`⚠ Мягкий выход не случился за ${EXIT_DEADLINE}с (плеер завис?) — SIGKILL.`);
await $`kill -9 ${pid}`.nothrow();
log('Принудительно остановлен — супервизор (systemd/wrapper-loop) должен поднять новый код сам.');
