#!/usr/bin/env node
/**
 * ЗАВХОЗ v1 — ночная синхронизация музыки на пирожке.
 *
 * Что делает: получает манифест (список треков от сервера), сверяет его с папкой
 * music, докачивает недостающее, генерирует playlist.json для плеера.
 *
 * С плеером НЕ общается напрямую — только через файл playlist.json на диске.
 * В Airtable ничего не пишет (read-only). Лайки и статистику шлёт плеер.
 *
 * Запуск:
 *   node zavhoz.js                          — боевой режим (манифест с сервера)
 *   node zavhoz.js --manifest=./stub.json   — тест на локальном манифесте
 *   node zavhoz.js --now                    — без случайной задержки (для тестов)
 *   node zavhoz.js --dry-run                — ничего не качать и не писать, только показать план
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

// ─────────────────────────────────────────────────────────────────────────────
// Пути. Относительные, а не /home/pi/... — чтобы скрипт одинаково работал
// на Маке при отладке и на пирожке в бою.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = __dirname;
// Настройки устройства — в том же файле, что читает плеер. Отдельного
// device.json больше нет: два файла с одними и теми же baseId — верный способ
// однажды поправить только один из них.
const CONFIG_FILE   = path.join(ROOT, '_playerConfig.js');
const MUSIC_DIR     = path.join(ROOT, 'music');
const PLAYLIST_FILE = path.join(ROOT, 'playlist.json');
const STATE_FILE    = path.join(ROOT, 'zavhoz-state.json');
const LOG_FILE      = path.join(ROOT, 'zavhoz.log');
const LOCK_FILE     = path.join(ROOT, 'zavhoz.lock');

// Зеркало на случай, если основной хостинг не отвечает.
const FALLBACK_BASE = 'https://storage.yandexcloud.net/sphere-bucket/musicLibrary/';

// Адрес облачных функций. Можно переопределить в _playerConfig.js полем
// functionsBasePath — тот же приём, что в _helpers.js у плеера.
const DEFAULT_FUNCTIONS_BASE = 'https://europe-central2-sphere-385104.cloudfunctions.net';

// Сетевые настройки. MAIN_RESPONSE_TIMEOUT_MS — сколько ждём ПЕРВЫЙ байт от
// основного хостинга, прежде чем уйти на зеркало. Ждать долго нет смысла:
// если R2 не ответил за пару секунд, он и дальше будет тормозить.
const MAIN_RESPONSE_TIMEOUT_MS = 2500;
const STALL_TIMEOUT_MS = 30000;      // молчание в середине скачивания

// Сколько ждём первый байт, когда торопиться некуда: зеркало, повторная попытка,
// вход в функцию. На медленной сети 2,5 секунды не хватит даже на подключение.
const PATIENT_RESPONSE_TIMEOUT_MS = 15000;

// Отдача по капле. Поток не молчит, но файл идёт сутками, а таймаут молчания
// такое не ловит. Меньше этой скорости за окно считаем сбоем.
const MIN_SPEED_BYTES_PER_SEC = 10 * 1024;
const SPEED_WINDOW_MS = 60000;
const MIN_FILE_SIZE_BYTES = 100 * 1024; // меньше 100 КБ — это не трек, а ошибка

// Запас свободного места, ниже которого не начинаем новое скачивание.
// Забить карту под ноль — значит оборвать файл на середине и получить утром
// битый mp3. Плееру и системе тоже нужно куда-то писать логи.
const MIN_FREE_BYTES = 500 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DOWNLOAD_RETRIES = 2;

// Джиттер: разброс старта, чтобы весь парк не пришёл на функцию одновременно.
// Число случайное каждую ночь — вести учёт «какое устройство в какую минуту»
// не нужно, устройства остаются одинаковыми.
// Разброс рассчитан на то, что на одной базе Airtable сидит несколько устройств
// (бывает пять-семь), а проход делается раз в пару часов. Десяти минут на такой
// парк мало: два устройства нет-нет да сойдутся в одну секунду и получат отказ.
const JITTER_MAX_SECONDS = 1800;

// Верхний предел одного прохода. Что бы ни случилось, Завхоз завершится сам и не
// будет держать блокировку вечно. Скачанное остаётся, следующий проход продолжит.
const MAX_PASS_MS = 12 * 60 * 60 * 1000;

// Недокачанное пробуем ещё раз в этом же проходе: через минуту и через пять.
// Следующий запуск из крона будет только через три часа.
const LATER_ROUND_WAITS_MS = [60000, 300000];

// Сколько треков играющего плейлиста может не хватать, чтобы всё же заменить
// рабочий playlist.json. Больше — оставляем прежний: он точно играет.
const MAX_MISSING_SHARE = 0.1;

// Сколько раз подряд хостинг должен не ответить по сети, чтобы до конца прохода
// перейти в конец очереди. Из России R2 часто отдаёт первые байты и замирает, и на
// каждом треке терялось бы по полминуты. То же правило работает и для зеркал.
const FAILS_BEFORE_MOVED_BACK = 2;

// Повторы запроса к функции. 429 означает «слишком много запросов к этой базе»
// и снимается примерно через полминуты — отсюда и первая пауза.
// Повторяем только то, что имеет смысл: 429, ошибки сервера и обрывы связи.
// На 400 (например, неверный baseId) повтор ничего не изменит.
const REQUEST_ATTEMPTS = 5;
const RETRY_WAIT_MS = 30000;
const REQUEST_DEADLINE_MS = 120000;  // весь ответ функции, от подключения до конца

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const IN_DAY = { sunday: 'в воскресенье', monday: 'в понедельник', tuesday: 'во вторник',
  wednesday: 'в среду', thursday: 'в четверг', friday: 'в пятницу', saturday: 'в субботу' };

// Как часто крон запускает Завхоз: строка `0 */3 * * *` в crontab, плюс случайная
// задержка до JITTER_MAX_SECONDS. Нужно, чтобы написать в статусе, когда следующая
// проверка. Поменяли расписание в crontab — поменять и здесь.
const CRON_EVERY_HOURS = 3;

const args = process.argv.slice(2);
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const has  = name => args.includes(`--${name}`);

const MANIFEST_FILE = flag('manifest');
const SKIP_JITTER   = has('now') || !!MANIFEST_FILE;
const DRY_RUN       = has('dry-run');

// ─────────────────────────────────────────────────────────────────────────────
// Лог
// ─────────────────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (!DRY_RUN) {
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mb = bytes => Math.round(bytes / (1024 * 1024));

// Сколько места осталось на диске с музыкой.
// fs.statfsSync появился в Node 18.15; на старых пирожках его может не быть,
// поэтому запасной путь — системный df, он есть и на Пи, и на Маке.
// Если не удалось узнать ни так, ни так, возвращаем null: это значит
// «не знаю», и тогда мы не мешаем скачиванию, а просто пишем в лог.
function freeSpaceBytes(dir) {
  // Папки может ещё не быть: первый запуск на чистом устройстве или dry-run,
  // который ничего не создаёт. Свободное место — свойство диска, а не папки,
  // поэтому спрашиваем ближайшую существующую папку выше.
  let target = dir;
  while (!fs.existsSync(target)) {
    const parent = path.dirname(target);
    if (parent === target) return null; // дошли до корня и ничего не нашли
    target = parent;
  }

  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(target);
      return s.bsize * s.bavail;
    }
  } catch {}

  try {
    const out = require('child_process')
      .execSync(`df -Pk ${JSON.stringify(target)}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const kb = Number(out.trim().split('\n').pop().split(/\s+/)[3]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Блокировка. Защищает от случая: ребут в 3:00 → Завхоз ждёт сеть → в 4:00
// просыпается второй по расписанию. Два экземпляра качали бы в один и тот же
// временный файл и наперегонки писали конфиг.
// Делаем средствами Node, а не утилитой flock — чтобы работало и на macOS.
//
// Решаем по тому, жив ли хозяин, а не по возрасту файла. Первый проход на большой
// базе идёт часами, и срок годности отдал бы блокировку следующему запуску из
// крона, пока первый ещё качает.
// ─────────────────────────────────────────────────────────────────────────────
function lockOwnerAlive(pid) {
  if (!Number.isInteger(pid)) return false;

  try {
    process.kill(pid, 0); // сигнал 0 ничего не шлёт, только проверяет процесс
  } catch (e) {
    if (e.code !== 'EPERM') return false; // EPERM: процесс есть, но чужой
  }

  // После перезагрузки номер мог достаться другой программе. На Linux проверяем,
  // что это всё ещё Завхоз. На Маке /proc нет, там хватает проверки выше.
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('zavhoz');
  } catch {
    return true;
  }
}

function acquireLock() {
  try {
    // 'wx' = создать и упасть, если файл уже есть. Атомарно на уровне ОС,
    // поэтому два процесса не могут создать его одновременно.
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;

    let lock = null;
    try {
      lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    } catch { /* битый lock считаем брошенным */ }

    if (!lock || !lockOwnerAlive(lock.pid)) {
      log(`Найдена брошенная блокировка (процесс ${lock?.pid ?? 'неизвестен'} — уже не Завхоз) — перехватываю.`);
      fs.unlinkSync(LOCK_FILE);
      return acquireLock();
    }

    return false;
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

// Ключ для сверки имён. Одну и ту же букву Unicode позволяет записать двумя
// способами: 'ô' бывает одним символом, а бывает 'o' плюс отдельный значок.
// Строки при этом не равны, а файл — один и тот же.
//
// Из Airtable такие имена приходят (Antônio, João, Gábor — боссанова). На диске
// тот же трек мог оказаться в другой форме: его туда копировали руками, с Мака
// или из Windows. Без общего ключа Завхоз считал бы такой файл отсутствующим и
// качал заново каждую ночь, оставляя рядом второй экземпляр под неотличимым
// именем.
const diskKey = name => name.normalize('NFC');

// Имя файла на пирожке. Обычно это имя из Airtable без изменений: так уже
// скачанные файлы остаются на месте и не качаются заново.
//
// Длиннее 255 байт имя файла на карте быть не может, а пока трек качается,
// к имени добавляется ".part". Отсюда 250. Такие имена бывают: Airtable отдаёт
// имя в кодах вида %D0%9E (русская буква — 6 знаков, тайская — 9) и обрезает
// его на 255 байтах, уже без ".mp3". Раскодировать обрезанное нельзя,
// поэтому просто укорачиваем и дописываем номер записи: два трека с одинаковым
// началом имени не попадут в один файл. Статистика ищет трек по номеру записи,
// так что имя файла ни на что, кроме вида в логе, не влияет.
const MAX_NAME_BYTES = 250;

function localFileName(track) {
  const name = track.fileName;
  if (Buffer.byteLength(name) <= MAX_NAME_BYTES) return name;
  if (!/^[A-Za-z0-9]+$/.test(track.recordId || '')) return null;

  const tail = ` ${track.recordId}.mp3`;
  const room = MAX_NAME_BYTES - Buffer.byteLength(tail);
  let head = '';
  // По символам, а не по байтам: букву пополам не режем.
  for (const ch of name.replace(/\.mp3$/i, '')) {
    if (Buffer.byteLength(head + ch) > room) break;
    head += ch;
  }
  return head.trimEnd() + tail;
}

// ─────────────────────────────────────────────────────────────────────────────
// Работа со временем.
// Сервер присылает 'HH:MM'. Плеер на пирожке использует соглашение, где конец
// после полуночи выражается числом больше 24 ('26:00' = 2 ночи следующего дня).
// Перевод в этот «местный диалект» — работа Завхоза.
// ─────────────────────────────────────────────────────────────────────────────
function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function fromMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function normalizeInterval(startStr, endStr) {
  const start = toMinutes(startStr);
  let end = toMinutes(endStr);
  if (start === null || end === null) return null;

  // Начало = конец означает «играет всегда» (соглашение из Airtable, случай 5-5).
  if (start === end) return { start: 0, end: 24 * 60 };

  // Конец раньше начала = переход через полночь.
  if (end < start) end += 24 * 60;

  return { start, end };
}

// ─────────────────────────────────────────────────────────────────────────────
// Манифест
// ─────────────────────────────────────────────────────────────────────────────
function httpGetJsonOnce(url) {
  return new Promise((resolve, reject) => {
    // Временный обход: getRecordsFromCdn читает заголовок origin без проверки
    // на существование и падает, если его нет. Браузер шлёт origin всегда,
    // а мы — обычная программа, поэтому подставляем вручную.
    // Убрать, когда Паша поправит функцию (одна строка на её стороне).
    const options = {
      timeout: 30000,
      headers: { origin: 'http://192.168.0.1' },
    };

    const req = https.get(url, options, res => {
      if (res.statusCode !== 200) {
        res.resume();
        const err = new Error(`HTTP ${res.statusCode}`);
        err.statusCode = res.statusCode;
        // Если сервер сам сказал, сколько ждать, слушаем его, а не свой таймер.
        const after = Number(res.headers['retry-after']);
        if (Number.isFinite(after) && after >= 0) err.retryAfterMs = after * 1000;
        return reject(err);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('error', reject);
      res.on('close', () => {
        if (!res.complete) reject(new Error('Соединение оборвалось'));
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Ответ сервера — не JSON: ' + e.message)); }
      });
    });
    // Общий предел: таймаут выше следит только за молчанием и не срабатывает,
    // если ответ идёт по капле или подключение не устанавливается.
    const deadline = setTimeout(() => req.destroy(new Error('Функция не ответила вовремя')), REQUEST_DEADLINE_MS);
    req.on('close', () => clearTimeout(deadline));

    req.on('timeout', () => req.destroy(new Error('Таймаут запроса манифеста')));
    req.on('error', reject);
  });
}

// Один отказ не должен стоить целого прохода: на одной базе сидит несколько
// устройств, и совпадение по времени неизбежно, как ни разводи старты.
async function httpGetJson(url) {
  let lastError;

  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt++) {
    try {
      return await httpGetJsonOnce(url);
    } catch (e) {
      lastError = e;

      // Нет статуса — значит обрыв связи или таймаут, это стоит повторить.
      const status = e.statusCode;
      const worthRetrying = !status || status === 429 || status >= 500;
      if (!worthRetrying || attempt === REQUEST_ATTEMPTS) break;

      const wait = e.retryAfterMs ?? RETRY_WAIT_MS * attempt;
      log(`  ${e.message} — попытка ${attempt} из ${REQUEST_ATTEMPTS} не удалась, жду ${Math.round(wait / 1000)} c…`);
      await sleep(wait);
    }
  }

  throw lastError;
}

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    // В тестовом режиме устройства нет — работаем с тем, что дали в файле.
    if (MANIFEST_FILE) return { placeName: 'локальный тест' };
    throw new Error(`Нет ${CONFIG_FILE}. Его заполняют руками при установке устройства.`);
  }

  // require, а не чтение JSON: это JavaScript, и тот же файл читает плеер.
  const config = require(CONFIG_FILE);
  if (!config || !config.baseId) throw new Error('В _playerConfig.js не заполнен baseId');
  return config;
}

function recordsEndpoint(config) {
  return `${config.functionsBasePath || DEFAULT_FUNCTIONS_BASE}/getRecordsFromCdn`;
}

// Какие плейлисты сейчас активны — решает таблица Info, ровно как у веб-плеера.
// Порядок строк в ней значащий: первый активный плейлист и есть тот, что играет.
// Так куратор включает «особый» плейлист — поднимает его строку наверх.
async function getActivePlaylists(config) {
  const url = `${recordsEndpoint(config)}?baseId=${encodeURIComponent(config.baseId)}&tableId=Info`;
  log('Спрашиваю таблицу Info, какие плейлисты активны…');

  const records = await httpGetJson(url);
  if (!Array.isArray(records)) throw new Error('Ожидался список плейлистов из таблицы Info');

  const playlists = [];
  const warnings = [];

  for (const rec of records) {
    const name = rec.fields?.Name;
    // tableId приклеивает функция, сопоставляя имя плейлиста с именем таблицы.
    // Нет его — значит таблицы с таким именем в базе не существует.
    if (!rec.tableId) {
      warnings.push(`Плейлист «${name || rec.id}» активен, но таблицы с таким именем в базе нет`);
      continue;
    }
    playlists.push({ name: name || rec.tableId, tableId: rec.tableId });
  }

  return { playlists, warnings };
}

async function getManifest(config, tableId) {
  if (MANIFEST_FILE) {
    log(`Манифест из локального файла: ${MANIFEST_FILE}`);
    return JSON.parse(fs.readFileSync(path.resolve(MANIFEST_FILE), 'utf8'));
  }

  const url = `${recordsEndpoint(config)}?baseId=${encodeURIComponent(config.baseId)}`
            + `&tableId=${encodeURIComponent(tableId)}&format=2`;
  return httpGetJson(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// Скачивание. Подход взят из рабочего download_with_yandex.js: если основной
// хостинг долго молчит — уходим на зеркало; качаем во временный .part и только
// после проверки размера переименовываем. Переименование внутри диска неделимо,
// поэтому плеер физически не может увидеть полфайла.
// ─────────────────────────────────────────────────────────────────────────────
function downloadToFile(url, destPath, firstByteMs, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const tmpPath = destPath + '.part';
    let settled = false;
    let file;
    let firstByteTimer;
    let speedTimer;

    const stopTimers = () => {
      clearTimeout(firstByteTimer);
      clearInterval(speedTimer);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      stopTimers();
      // Закрываем и само соединение: зависший поток иначе держал бы процесс живым.
      try { req.destroy(); } catch {}
      try { file?.destroy(); } catch {}
      try { fs.existsSync(tmpPath) && fs.unlinkSync(tmpPath); } catch {}
      reject(err);
    };

    const req = https.get(url, res => {
      clearTimeout(firstByteTimer);

      // Редиректы
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirectsLeft <= 0) return fail(new Error('Слишком много редиректов'));
        let next;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch {
          return fail(new Error('Редирект без адреса'));
        }
        settled = true;
        stopTimers();
        return downloadToFile(next, destPath, firstByteMs, redirectsLeft - 1).then(resolve, reject);
      }

      if (res.statusCode !== 200) {
        res.resume();
        const err = new Error(`HTTP ${res.statusCode}`);
        err.statusCode = res.statusCode;
        return fail(err);
      }

      // Провайдер может вместо файла отдать свою страницу с кодом 200.
      if (/text\/html/i.test(res.headers['content-type'] || '')) {
        return fail(new Error('Хостинг вернул страницу вместо файла'));
      }

      res.setTimeout(STALL_TIMEOUT_MS, () => fail(new Error('Поток завис')));

      // Если сервер оборвёт соединение на середине, конца файла не будет никогда:
      // без этих двух строк Завхоз ждал бы его вечно.
      res.on('error', fail);
      res.on('close', () => {
        if (!res.complete) fail(new Error('Соединение оборвалось'));
      });

      let received = 0;
      let receivedAtLastCheck = 0;
      res.on('data', chunk => { received += chunk.length; });
      speedTimer = setInterval(() => {
        const minBytes = MIN_SPEED_BYTES_PER_SEC * (SPEED_WINDOW_MS / 1000);
        if (received - receivedAtLastCheck < minBytes) return fail(new Error('Слишком медленно'));
        receivedAtLastCheck = received;
      }, SPEED_WINDOW_MS);

      const expected = Number(res.headers['content-length']);

      file = fs.createWriteStream(tmpPath);
      res.pipe(file);

      file.on('error', fail);
      file.on('finish', () => {
        if (settled) return;
        file.close(() => {
          if (settled) return;
          try {
            // Дожидаемся записи на карту до переименования. Иначе при обрыве
            // питания файл с готовым именем мог бы остаться пустым, и Завхоз
            // считал бы его скачанным.
            const fd = fs.openSync(tmpPath, 'r+');
            const firstByte = Buffer.alloc(1);
            try {
              fs.fsyncSync(fd);
              fs.readSync(fd, firstByte, 0, 1, 0);
            } finally {
              fs.closeSync(fd);
            }

            const size = fs.statSync(tmpPath).size;
            if (size < MIN_FILE_SIZE_BYTES) {
              return fail(new Error(`Файл подозрительно мал (${size} байт)`));
            }
            if (Number.isFinite(expected) && expected > 0 && size !== expected) {
              return fail(new Error(`Файл обрезан: ${size} из ${expected} байт`));
            }
            if (firstByte[0] === 0x3c) { // '<' — это разметка, а не mp3
              return fail(new Error('Хостинг вернул страницу вместо файла'));
            }

            // Атомарная подмена: до этого момента файла с финальным именем нет.
            fs.renameSync(tmpPath, destPath);
            settled = true;
            stopTimers();
            resolve(size);
          } catch (e) {
            fail(e);
          }
        });
      });
    });

    // Ждём ПЕРВЫЙ байт ограниченное время — иначе смысла в зеркале нет. Свой
    // таймер, а не req.setTimeout: тот не считает время до установки соединения,
    // а заблокированный адрес может молчать на этом шаге минутами.
    firstByteTimer = setTimeout(() => fail(new Error('Хостинг не ответил вовремя')), firstByteMs);
    req.on('error', fail);
  });
}

// Память на один проход: следующий запуск снова начнёт в обычном порядке,
// вдруг хостинг уже ожил. Правило одно для всех источников.
const failsInARow = new Map();
const movedBack = new Set();

// Ошибка на самом пирожке (карта, права, длина имени), а не у хостинга.
// У ошибок работы с файлом Node указывает путь к нему, у сетевых пути нет.
// Коды — для ошибок без пути, например при записи на карту в конце скачивания.
const LOCAL_ERROR_CODES = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'EIO', 'ENAMETOOLONG', 'EMFILE', 'ENFILE', 'EISDIR', 'ENOTDIR', 'EBADF']);
const isLocalError = e => typeof e?.path === 'string' || LOCAL_ERROR_CODES.has(e?.code);

function noteResult(source, error) {
  // Ответ сервера вроде 404 говорит о файле, а не о связи с хостингом.
  if (error?.statusCode) return;
  // Ошибка карты говорит о пирожке, а не о хостинге.
  if (isLocalError(error)) return;

  if (!error) {
    failsInARow.set(source.key, 0);
    return;
  }

  const fails = (failsInARow.get(source.key) || 0) + 1;
  failsInARow.set(source.key, fails);

  if (fails >= FAILS_BEFORE_MOVED_BACK && !movedBack.has(source.key)) {
    movedBack.add(source.key);
    log(`  ${source.label} не ответил ${fails} раза подряд — до конца прохода он в конце очереди.`);
  }
}

// Зеркала из манифеста идут раньше зеркала в коде: функция может поменять
// порядок сразу на всех устройствах, без захода на каждое.
let mirrorBases = [FALLBACK_BASE];

function setMirrors(fromManifests) {
  const fromServer = fromManifests
    .filter(m => typeof m === 'string' && m.startsWith('https://'))
    .map(m => (m.endsWith('/') ? m : m + '/'));
  mirrorBases = [...new Set([...fromServer, FALLBACK_BASE])];
}

// Адреса файла на зеркале. Имя берём из самой ссылки, а не из fileName: оно приходит
// из вложения Airtable и теоретически может отличаться от файла в хранилище.
// Второй адрес — то же имя в другой форме Unicode: на Яндексе такой файл уже нашёлся.
function mirrorUrlsFor(track, base) {
  let name = track.fileName;
  try {
    name = decodeURIComponent(new URL(track.url).pathname.split('/').pop()) || name;
  } catch {}
  return [...new Set([name, name.normalize('NFC'), name.normalize('NFD')])]
    .map(n => base + encodeURIComponent(n));
}

function sourcesFor(track) {
  const all = [
    { key: 'main', urls: [track.url], label: 'Основной хостинг', isMain: true },
    ...mirrorBases.map(base => ({
      key: base,
      urls: mirrorUrlsFor(track, base),
      label: `Зеркало ${new URL(base).host}`,
      isMain: false,
    })),
  ];

  // Сломавшиеся не выбрасываем совсем: на остальных файла может не оказаться.
  return [...all.filter(x => !movedBack.has(x.key)), ...all.filter(x => movedBack.has(x.key))];
}

// Качает из одного источника. Другую форму имени пробуем, только если сервер
// сказал, что такого файла нет.
async function downloadFromSource(source, dest, firstByteMs) {
  let lastError;
  for (const url of source.urls) {
    try {
      return await downloadToFile(url, dest, firstByteMs);
    } catch (e) {
      lastError = e;
      if (![403, 404].includes(e.statusCode)) break;
    }
  }
  throw lastError;
}

async function downloadTrack(track) {
  const dest = path.join(MUSIC_DIR, track.fileName);

  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
    let notFoundAnywhere = true;

    for (const source of sourcesFor(track)) {
      const firstByteMs = source.isMain && attempt === 1 ? MAIN_RESPONSE_TIMEOUT_MS : PATIENT_RESPONSE_TIMEOUT_MS;
      try {
        const size = await downloadFromSource(source, dest, firstByteMs);
        noteResult(source, null);
        return { ok: true, viaFallback: !source.isMain, size };
      } catch (e) {
        // Файл не записать на пирожке — другой источник тут не поможет.
        // Пробуем снова в следующих попытках прохода.
        if (isLocalError(e)) {
          log(`  ✗ Ошибка на пирожке, не у хостинга: ${e.message}`);
          return { ok: false };
        }
        log(`  ✗ ${source.label}: ${e.message}`);
        noteResult(source, e);
        // Хранилище без открытого списка на отсутствующий файл отвечает 403, а не 404.
        if (![403, 404].includes(e.statusCode)) notFoundAnywhere = false;
      }
    }

    // Ни в одном хранилище такого файла нет. Это не сбой связи, повторять
    // незачем, и задерживать из-за него обновление плейлиста нельзя.
    if (notFoundAnywhere) return { ok: false, gone: true };

    if (attempt < DOWNLOAD_RETRIES) await sleep(1000 * attempt);
  }
  return { ok: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Сборка playlist.json.
//
// Важно: кладём ВСЕ СЕМЬ ДНЕЙ, а не только завтрашний. Если Завхоз не отработает
// (нет сети, устройство было выключено), плеер прочитает вчерашний файл — и всё
// равно возьмёт правильное расписание на сегодня. Устареет только содержимое,
// а не логика дня недели. Для офлайн-устройства это принципиально.
// ─────────────────────────────────────────────────────────────────────────────
// Свой устойчивый порядок треков внутри интервала.
//
// Зачем: функция просит у Airtable записи в порядке «реже игравшие сначала»
// (Times repeated asc), а счётчик растёт после каждого проигрывания. Порядок
// записей поэтому меняется каждую ночь. Без своей сортировки playlist.json
// каждый раз отличался бы от вчерашнего одной лишь перестановкой строк —
// и переписывался бы вхолостую, изнашивая SD-карту.
//
// На музыку не влияет: и пирожок (shuffleWithRecentGuard), и веб-плеер
// (randomize) перемешивают список перед игрой.
//
// Сравниваем коды символов напрямую, а не через localeCompare: правила
// сравнения строк зависят от сборки Node (на Пи она может идти с урезанной
// ICU), и один и тот же плейлист получил бы разный порядок на Маке и на
// устройстве. recordId — на случай двух одинаковых имён файлов.
function byFileName(a, b) {
  if (a.fileName !== b.fileName) return a.fileName < b.fileName ? -1 : 1;
  if (a.recordId === b.recordId) return 0;
  return a.recordId < b.recordId ? -1 : 1;
}

function buildDays(manifest, availableFiles) {
  const days = {};
  const warnings = [...(manifest.warnings || [])];

  for (const dayName of DAYS) {
    // Группируем треки по одинаковому интервалу: треки с 8:00–11:00 — одна
    // пачка, с 18:00–02:00 — другая. Тот же алгоритм, что в веб-плеере.
    const groups = new Map();

    for (const track of manifest.tracks) {
      const raw = track.schedule?.[dayName];
      // Пустая ячейка дня = трек в этот день не играет (так делятся будни и выходные).
      if (!raw) continue;

      // Пропускаем то, что физически не скачалось — плеер не должен получить
      // ссылку на отсутствующий файл. Берём имя, под которым файл РЕАЛЬНО
      // лежит на диске: плееру открывать именно его, а наше представление об
      // имени может отличаться формой записи (см. diskKey).
      const onDiskName = availableFiles.get(diskKey(track.fileName));
      if (!onDiskName) continue;

      const interval = normalizeInterval(raw[0], raw[1]);
      if (!interval) {
        warnings.push(`Не разобрал интервал "${raw}" (${dayName}) у трека ${track.fileName}`);
        continue;
      }

      const key = `${interval.start}-${interval.end}`;
      if (!groups.has(key)) groups.set(key, { ...interval, tracks: [] });
      groups.get(key).tracks.push({ fileName: onDiskName, recordId: track.recordId });
    }

    const intervals = [...groups.values()]
      .sort((a, b) => a.start - b.start)
      .map(g => ({
        start: fromMinutes(g.start),
        end: fromMinutes(g.end),   // может быть '26:00' — соглашение плеера
        tracks: g.tracks.sort(byFileName),
      }));

    // daySchedule вычисляется, а не задаётся руками: самое раннее начало и
    // самый поздний конец. Поэтому он не может разъехаться с Airtable.
    // Именно max, а не «конец последнего»: интервалы могут пересекаться
    // (трек «играет всегда» 00:00–24:00 рядом с треком 05:00–20:00),
    // и тогда последний по началу заканчивается раньше другого.
    const daySchedule = intervals.length
      ? {
          start: intervals[0].start,
          stop: fromMinutes(Math.max(...[...groups.values()].map(g => g.end))),
        }
      : null;

    days[dayName] = { daySchedule, intervals };
  }

  return { days, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Атомарная запись: пишем рядом, потом переименовываем.
// ─────────────────────────────────────────────────────────────────────────────
function writeJsonAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  const text = JSON.stringify(data, null, 2);

  // Пишем в соседний временный файл и дожидаемся, пока карта правда его
  // запишет. Без fsync данные могут остаться в кеше системы: если в этот
  // момент выдернут питание, имя файла уже появится, а содержимого ещё не
  // будет — и плеер утром получит пустой или обрезанный файл. На SD-картах
  // это не теория.
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  // Переименование внутри одного диска неделимо: плеер видит либо старый
  // целый файл, либо новый целый — никогда половину. Если питание пропадёт
  // до переименования, останется прежний файл, а .tmp просто перезапишется
  // в следующий раз.
  fs.renameSync(tmp, filePath);
}

const dayHasMusic = day => day.intervals.some(i => i.tracks.length > 0);

// Причина не заменять playlist.json или null, если заменять можно.
// Смотрим только на играющий плейлист: остальные лежат про запас.
function whyKeepOldPlaylist(manifest, built, available, gone) {
  const hasMusic = DAYS.some(d => dayHasMusic(built.days[d]));

  // Прежнего рабочего файла нет — беречь нечего, частичный лучше никакого.
  let oldIsUsable = false;
  try {
    const old = JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));
    oldIsUsable = Array.isArray(old.playlists)
      ? old.playlists.some(p => p.days && DAYS.some(d => p.days[d] && dayHasMusic(p.days[d])))
      : !!old.days;
  } catch {}

  if (!hasMusic) return oldIsUsable ? 'в нём нет ни одного скачанного трека с расписанием' : 'нет музыки для записи';
  if (!oldIsUsable) return null;

  const expected = manifest.tracks.filter(t => !gone.has(diskKey(t.fileName)));
  const notHere = expected.filter(t => !available.has(diskKey(t.fileName))).length;
  if (notHere / expected.length > MAX_MISSING_SHARE) {
    return `не скачано ${notHere} из ${expected.length}`;
  }

  // Интервал мог опустеть целиком, даже если треков не хватает немного.
  const everything = new Map(expected.map(t => [diskKey(t.fileName), t.fileName]));
  const complete = buildDays({ tracks: expected }, everything);
  for (const d of DAYS) {
    if (complete.days[d].intervals.length !== built.days[d].intervals.length) {
      return `${IN_DAY[d]} опустел целый интервал`;
    }
  }

  return null;
}

// Сравниваем без времени генерации — иначе файл считался бы изменившимся каждую
// ночь. Лишняя перезапись × 365 × 20 устройств бессмысленно изнашивает SD-карты.
function playlistChanged(next) {
  if (!fs.existsSync(PLAYLIST_FILE)) return true;
  try {
    const prev = JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));
    const strip = p => JSON.stringify({ active: p.activePlaylist, playlists: p.playlists, place: p.place });
    return strip(prev) !== strip(next);
  } catch {
    return true; // битый файл — перезаписываем
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Статус для куратора. Плеер отправляет его с каждым сыгранным треком в колонку
// «Zavhoz status» таблицы Timestamps, поэтому из Airtable видно, что на пирожке,
// без входа на устройство. Строку собирает шаблон, слова в нём всегда одни и те же:
//
//   [⚠ предупреждения.] {плейлист} ({скачано} из {в базе}).
//   Альтернативные: {плейлист} ({скачано} из {в базе}), …
//   Плейлист обновлён {дата}. Завхоз проверил базу {дата}, следующая проверка {дата}.
// ─────────────────────────────────────────────────────────────────────────────
const pad2 = n => String(n).padStart(2, '0');
const dayOf = d => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
const timeOf = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const dayTime = iso => { const d = new Date(iso); return `${dayOf(d)} в ${timeOf(d)}`; };

// Ближайшая отметка крона после `from` и она же плюс наибольшая задержка.
function nextCheckWindow(from) {
  const start = new Date(from);
  start.setMinutes(0, 0, 0);
  do start.setHours(start.getHours() + 1); while (start.getHours() % CRON_EVERY_HOURS !== 0);
  const end = new Date(start.getTime() + JITTER_MAX_SECONDS * 1000);
  return `${dayOf(start)} в ${timeOf(start)}–${timeOf(end)}`;
}

// 1 трек, 2 трека, 5 треков.
function plural(n, [one, few, many]) {
  const t = n % 100, u = n % 10;
  if (t >= 11 && t <= 14) return many;
  return u === 1 ? one : u >= 2 && u <= 4 ? few : many;
}
const tracksWord = n => `${n} ${plural(n, ['трек', 'трека', 'треков'])}`;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Записи плейлиста из playlist.json.
function recordIdsOf(p) {
  return new Set(DAYS.flatMap(d => (p.days?.[d]?.intervals || []).flatMap(i => i.tracks.map(t => t.recordId))));
}

// Плейлисты и дата обновления, без предупреждений и строки о проверке.
//   counts    — [{ name, onPlayer, inBase }], первым тот, что стоит первым в Info
//   updatedAt — когда записан playlist.json, null — файла нет
// Что играет прямо сейчас, видно в колонке Playlist name, здесь это не повторяем.
function playlistSummary(counts, updatedAt) {
  const [first, ...others] = counts;
  const of = p => `${p.name} (${p.onPlayer} из ${p.inBase})`;
  let s = `${of(first)}.`;
  if (others.length) s += ` ${others.length > 1 ? 'Альтернативные' : 'Альтернативный'}: ${others.map(of).join(', ')}.`;
  if (updatedAt) s += ` Плейлист обновлён ${dayTime(updatedAt)}.`;
  return s;
}

// Предупреждения идут в начало строки: узкая колонка в Airtable показывает только его.
const withNotes = (notes, rest) => [...notes.map(n => `⚠ ${n}.`), rest].join(' ');

// Ошибка в самой базе, а не сбой связи или программы: куратору она показывается
// своими словами, без «Завхоз не смог проверить базу».
class BaseProblem extends Error {}

// ─────────────────────────────────────────────────────────────────────────────
// Главный сценарий
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  if (!SKIP_JITTER) {
    const delay = Math.floor(Math.random() * JITTER_MAX_SECONDS);
    log(`Проснулся, жду ${delay} c (разброс по парку)…`);
    await sleep(delay * 1000);
  }

  log(`── Завхоз стартовал (${os.hostname()}) ──`);

  const config = readConfig();
  const place = config.placeName || os.hostname();
  log(`Место: ${place}`);

  // В dry-run папку не создаём: показ плана не должен оставлять следов.
  if (!DRY_RUN) fs.mkdirSync(MUSIC_DIR, { recursive: true });

  const warnings = [];

  // Какие плейлисты активны. В тестовом режиме Info не спрашиваем — работаем
  // с тем единственным манифестом, который дали файлом.
  const active = MANIFEST_FILE
    ? { playlists: [{ name: 'Локальный манифест', tableId: null }], warnings: [] }
    : await getActivePlaylists(config);

  if (!active.playlists.length) {
    throw new BaseProblem('В таблице Info нет ни одного активного плейлиста (или их названия не совпадают с названиями таблиц), плеер играет прежний список');
  }
  active.warnings.forEach(w => warnings.push(w));

  log(`Активных плейлистов: ${active.playlists.length} — ${active.playlists.map(p => p.name).join(', ')}`);
  log(`Играет первый: «${active.playlists[0].name}»`);

  // Манифест на каждый плейлист. Качаем музыку всех активных, чтобы
  // переключение было мгновенным, но играть будет только первый.
  const loaded = [];
  for (const p of active.playlists) {
    const manifest = await getManifest(config, p.tableId);
    if (!Array.isArray(manifest.tracks)) throw new Error(`В манифесте «${p.name}» нет списка треков`);
    log(`  «${p.name}»: треков ${manifest.tracks.length}`);
    (manifest.warnings || []).forEach(w => warnings.push(`сервер, «${p.name}»: ${w}`));

    // Сколько записей отдала база, до отсева: это «из N» в статусе.
    const inBase = manifest.tracks.length;

    // Имя станет путём на диске, поэтому проверяем его.
    manifest.tracks = manifest.tracks.filter(t => {
      const ok = typeof t.fileName === 'string' && t.fileName && t.url
        && path.basename(t.fileName) === t.fileName;
      const local = ok && localFileName(t);
      if (!local) {
        warnings.push(`«${p.name}»: пропущена запись ${t.recordId} с неправильным именем файла`);
        return false;
      }
      if (local !== t.fileName) {
        log(`  Имя у записи ${t.recordId} длиннее ${MAX_NAME_BYTES} байт, на диске будет: ${local}`);
        t.fileName = local;
      }
      return true;
    });
    loaded.push({ name: p.name, tableId: p.tableId, manifest, inBase });
  }

  setMirrors(loaded.flatMap(l => Array.isArray(l.manifest.mirrors) ? l.manifest.mirrors : []));

  // Один и тот же трек может стоять в нескольких плейлистах — качаем его один раз.
  const wanted = new Map();
  for (const { manifest } of loaded) {
    for (const t of manifest.tracks) {
      if (!wanted.has(diskKey(t.fileName))) wanted.set(diskKey(t.fileName), t);
    }
  }
  if (loaded.length > 1) log(`Всего разных треков во всех плейлистах: ${wanted.size}`);

  // Сверка с папкой. Манифест говорит, что ДОЛЖНО лежать; папка — что ЛЕЖИТ.
  // Одно другое не заменяет: трек мог не докачаться прошлой ночью.
  // Ключ сверки → как файл РЕАЛЬНО называется на диске. Второе нужно, чтобы в
  // playlist.json уехало имя, которое плеер сможет открыть, а не наше.
  // existsSync — ради dry-run на чистой машине, где папку ещё не создавали.
  const onDisk = new Map();
  if (fs.existsSync(MUSIC_DIR)) {
    for (const f of fs.readdirSync(MUSIC_DIR)) {
      if (f.endsWith('.part')) continue;
      // Пустой или крошечный файл — след сбоя, а не трек. Считаем его
      // отсутствующим, и он перекачается поверх.
      try {
        if (fs.statSync(path.join(MUSIC_DIR, f)).size < MIN_FILE_SIZE_BYTES) continue;
      } catch {
        continue;
      }
      onDisk.set(diskKey(f), f);
    }
  }

  const missing = [...wanted.values()].filter(t => !onDisk.has(diskKey(t.fileName)));
  log(`На диске: ${onDisk.size}. Не хватает: ${missing.length}.`);

  const stats = { downloaded: 0, failed: 0, notDownloaded: 0, gone: 0, viaFallback: 0, stoppedForSpace: false };

  const freeAtStart = freeSpaceBytes(MUSIC_DIR);
  log(freeAtStart === null
    ? 'Свободное место определить не удалось — качаю без проверки.'
    : `Свободно на диске: ${mb(freeAtStart)} МБ (запас ${mb(MIN_FREE_BYTES)} МБ).`);

  // Трек, которого нет ни в одном хранилище: не сбой связи, его ждать незачем.
  const gone = new Set();

  if (DRY_RUN) {
    missing.forEach(t => log(`  [dry-run] скачал бы: ${t.fileName}`));
  } else {
    let queue = missing;

    for (let round = 0; queue.length && !stats.stoppedForSpace; round++) {
      if (round > 0) {
        if (round > LATER_ROUND_WAITS_MS.length) break;
        const wait = LATER_ROUND_WAITS_MS[round - 1];
        log(`Не скачалось ${queue.length}. Ещё раз через ${Math.round(wait / 1000)} c…`);
        await sleep(wait);
      }

      const failedThisRound = [];

      for (const [i, track] of queue.entries()) {
        // Проверяем перед каждым файлом, а не один раз: за длинную ночь места
        // могло не хватить уже на середине списка.
        const free = freeSpaceBytes(MUSIC_DIR);
        if (free !== null && free < MIN_FREE_BYTES) {
          log(`✗ Осталось ${mb(free)} МБ, это меньше запаса ${mb(MIN_FREE_BYTES)} МБ. Дальше не качаю.`);
          log(`  Не скачано треков: ${queue.length - i}. Нужно освободить место на устройстве.`);
          stats.stoppedForSpace = true;
          failedThisRound.push(...queue.slice(i));
          break;
        }

        log(`(${i + 1}/${queue.length}) ${track.fileName}`);
        const res = await downloadTrack(track);
        if (res.ok) {
          stats.downloaded++;
          if (res.viaFallback) stats.viaFallback++;
          onDisk.set(diskKey(track.fileName), track.fileName);
        } else if (res.gone) {
          gone.add(diskKey(track.fileName));
          log('  ✗ файла нет ни в одном хранилище — трек не попадёт в плейлист');
        } else {
          failedThisRound.push(track);
          log('  ✗ не удалось скачать');
        }
      }

      queue = failedThisRound;
    }

    stats.failed = queue.length + gone.size;
    stats.notDownloaded = queue.length;
    stats.gone = gone.size;
  }

  // В dry-run считаем недостающие треки скачанными: показываем план, каким он
  // станет после синхронизации. Иначе на чистом устройстве сводка по дням
  // всегда говорила бы «не играем» — и проверить расписание было бы нечем.
  const available = DRY_RUN
    ? new Map([...onDisk, ...missing.map(t => [diskKey(t.fileName), t.fileName])])
    : onDisk;

  const playlists = loaded.map(({ name, tableId, manifest }) => {
    const built = buildDays(manifest, available);
    built.warnings.forEach(w => warnings.push(`«${name}»: ${w}`));
    return { name, tableId, days: built.days };
  });

  const playlist = {
    generatedAt: new Date().toISOString(),
    generatedBy: 'zavhoz',
    place,
    // Первый активный в Info — тот, что играет. Имя, а не номер: по номеру
    // потом не понять, что именно имелось в виду.
    activePlaylist: playlists[0].name,
    playlists,
    warnings,
  };

  warnings.forEach(w => log(`  ⚠ ${w}`));

  if (DRY_RUN) {
    log('[dry-run] playlist.json не записан. Сводка:');
    for (const p of playlist.playlists) {
      log(`  «${p.name}»${p.name === playlist.activePlaylist ? ' — играет' : ' — лежит готовым'}:`);
      for (const d of DAYS) {
        const day = p.days[d];
        const n = day.intervals.reduce((s, i) => s + i.tracks.length, 0);
        log(`     ${d}: интервалов ${day.intervals.length}, треков ${n}` +
            (day.daySchedule ? `, день ${day.daySchedule.start}–${day.daySchedule.stop}` : ', не играем'));
      }
    }
    return stats;
  }

  // Рабочий файл заменяем только таким, который точно не хуже: сбой сети в этом
  // проходе не должен оставить плеер без музыки.
  let playlistWritten = false;
  const heldBack = whyKeepOldPlaylist(loaded[0].manifest, playlists[0], available, gone);
  const prevState = readJson(STATE_FILE) || {};
  const prevFile = readJson(PLAYLIST_FILE);

  if (heldBack) {
    log(`⚠ playlist.json не заменён: ${heldBack}. Повторю в следующий проход.`);
  } else if (playlistChanged(playlist)) {
    writeJsonAtomic(PLAYLIST_FILE, playlist);
    playlistWritten = true;
    log('playlist.json обновлён.');
  } else {
    log('Изменений нет — playlist.json не трогаю.');
  }

  const lastCheckAt = new Date().toISOString();
  const lastWorkAt = stats.downloaded > 0 || playlistWritten ? lastCheckAt : prevState.lastWorkAt || null;
  const onPlayerFile = playlistWritten ? playlist : prevFile;

  // Скачано из записей каждого плейлиста. Записи без расписания тоже на плеере,
  // но не играют: о них отдельное предупреждение.
  const counts = loaded.map(({ name, manifest, inBase }) => ({
    name,
    inBase,
    onPlayer: manifest.tracks.filter(t => available.has(diskKey(t.fileName))).length,
  }));
  const scheduled = recordIdsOf(playlists[0]);
  const unscheduled = loaded[0].manifest.tracks
    .filter(t => available.has(diskKey(t.fileName)) && !scheduled.has(t.recordId)).length;
  const skipped = loaded.reduce((s, l) => s + l.inBase - l.manifest.tracks.length, 0);

  const notes = [];
  if (stats.stoppedForSpace) notes.push('Кончилось место на пирожке, часть треков не скачана');
  if (heldBack) {
    // Пустой список в базе — почти всегда снятый Playing, называем это прямо.
    // «Плейлист обновлён» в строке ниже — дата прежнего списка, который играет.
    notes.push(`Новый список не поставлен: ${counts[0].inBase === 0
      ? `в базе у ${counts[0].name} нет ни одного трека со статусом Playing`
      : heldBack}, ${onPlayerFile ? 'играет прежний' : 'плеер играет старый список из txt'}`);
  }
  if (stats.notDownloaded) {
    notes.push(`Не ${plural(stats.notDownloaded, ['скачан', 'скачано', 'скачано'])} ${tracksWord(stats.notDownloaded)}, Завхоз попробует снова при следующей проверке`);
  }
  if (stats.gone) notes.push(`Нет ни на одном хостинге: ${tracksWord(stats.gone)}, проверьте Full link`);
  if (skipped) notes.push(`${plural(skipped, ['Пропущена', 'Пропущены', 'Пропущено'])} ${skipped} ${plural(skipped, ['запись', 'записи', 'записей'])}: неправильное имя файла`);
  if (unscheduled) notes.push(`Без расписания: ${tracksWord(unscheduled)}, на плеере есть, но не играют ни в один день`);

  const summary = playlistSummary(counts, onPlayerFile?.generatedAt || null);
  const status = withNotes(notes, `${summary} Завхоз проверил базу ${dayTime(lastCheckAt)}, следующая проверка ${nextCheckWindow(lastCheckAt)}.`);
  log(`Статус: ${status}`);

  writeJsonAtomic(STATE_FILE, {
    status,
    summary,
    lastCheckAt,
    lastGoodCheckAt: lastCheckAt,
    // Проход удался, если всё скачано и плейлист поставлен. Записи без расписания
    // или с плохим именем — вопрос к базе, а не сбой Завхоза.
    lastCheckOk: !(stats.stoppedForSpace || stats.failed > 0 || heldBack),
    lastWorkAt,
    activePlaylist: playlist.activePlaylist,
    playlistsActive: playlists.length,
    tracksWanted: wanted.size,
    tracksOnDisk: onDisk.size,
    downloaded: stats.downloaded,
    failed: stats.failed,
    viaFallback: stats.viaFallback,
    warnings: warnings.length,
    freeSpaceMb: freeAtStart === null ? null : mb(freeAtStart),
    stoppedForSpace: stats.stoppedForSpace,
    playlistHeldBack: heldBack,
  });

  return stats;
}

// Блокировка нужна только боевому запуску: он качает файлы и переписывает
// конфиг. Dry-run ничего не пишет, а вот брошенный им lock-файл (Ctrl+C
// в середине показа плана) заблокировал бы ночную синхронизацию на два часа.
if (!DRY_RUN) {
  if (!acquireLock()) {
    log('Другой Завхоз уже работает — выхожу.');
    process.exit(0);
  }
  process.on('exit', releaseLock);
}
function reportCrash(message, baseProblem = false) {
  log(baseProblem ? `⚠ ${message}. Ничего не меняю.` : `✗ Завхоз упал: ${message}`);
  if (DRY_RUN) return;
  try {
    // Что на плеере, мы в этом проходе не узнали: берём из прошлой проверки.
    const prev = readJson(STATE_FILE) || {};
    const lastCheckAt = new Date().toISOString();
    const next = nextCheckWindow(lastCheckAt);
    const rest = [
      prev.summary ? `Данные прошлой проверки: ${prev.summary}` : '',
      prev.lastGoodCheckAt
        ? `Прошлая проверка ${dayTime(prev.lastGoodCheckAt)}, следующая проверка ${next}.`
        : `Следующая проверка ${next}.`,
    ].filter(Boolean).join(' ');
    const text = String(message).replace(/\.+$/, '');
    writeJsonAtomic(STATE_FILE, {
      ...prev,
      status: withNotes([baseProblem ? text : `Завхоз не смог проверить базу: ${text}`], rest),
      lastCheckAt,
      lastCheckOk: false,
      error: message,
    });
  } catch {}
}

process.on('uncaughtException', err => {
  reportCrash(err.message);
  process.exit(1);
});

setTimeout(() => {
  reportCrash('проход не уложился в отведённое время');
  process.exit(1);
}, MAX_PASS_MS).unref();

process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

main()
  .then(s => log(`── Готово. Скачано ${s.downloaded}, ошибок ${s.failed}, через зеркало ${s.viaFallback}. ──`))
  .catch(err => {
    reportCrash(err.message, err instanceof BaseProblem);
    process.exit(1);
  });
