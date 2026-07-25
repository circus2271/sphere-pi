const fs = require('fs');
const path = require('path');
const os = require('os');
const fetch = require('node-fetch')
const { version } = require('./package.json');
const playerConfig = require('./_playerConfig');
const { log, warn, pad } = require('./_logger');

// helper functions
// (functions that don't modify app's state)

// ─────────────────────────────────────────────
//  TIME HELPERS (минутная точность)
//  Формат времени: "HH:MM".
//  end > "24:00" означает, что окно заканчивается ПОСЛЕ полуночи,
//  уже на следующих сутках. Например "26:00" = 02:00 следующего дня.
// ─────────────────────────────────────────────

// "HH:MM" -> минуты с начала суток. "26:00" -> 1560 (следующие сутки).
function toMinutes(timeStr) {
    const parts = timeStr.split(':');
    return Number(parts[0]) * 60 + Number(parts[1]);
}

// минуты -> "HH:MM" для логов. 1560 -> "02:00(след.день)"
function formatTime(min) {
    const nextDay = min >= 1440;
    const m = min % 1440;
    return `${pad(Math.floor(m / 60))}:${pad(m % 60)}` + (nextDay ? '(след.день)' : '');
}

// Текущая минута суток
function getNowMinutes(now) {
    return now.getHours() * 60 + now.getMinutes();
}

// Проверка: попадает ли текущая минута в диапазон [startMin, endMin).
// endMin > 1440 означает, что диапазон пересекает полночь
// (например 1080 → 1620 это 18:00 → 03:00 следующих суток).
// endMin === 1440 означает "ровно до полуночи".
function isTimeInRange(nowMin, startMin, endMin) {
    if (endMin > 1440) {
        // Пересекает полночь: активно от startMin до 23:59 ИЛИ от 00:00 до (endMin - 1440)
        return nowMin >= startMin || nowMin < (endMin - 1440);
    } else if (endMin === 1440) {
        // "До полуночи" — активно от startMin до конца суток
        return nowMin >= startMin;
    } else {
        // Обычный диапазон в пределах суток
        return nowMin >= startMin && nowMin < endMin;
    }
}

// Окно плейлиста в минутах. Понимает оба формата конфига:
//   новый:  { start: '11:30', end: '26:00' }   — минутная точность
//   старый: { startHour: 11, endHour: 2 }      — целые часы
// Для старого формата endHour < startHour означает переход через
// полночь — переводим его в "end следующего дня" (+1440), чтобы обе
// записи работали через один isTimeInRange.
function getPlaylistWindow(playlist) {
    if (playlist.start !== undefined && playlist.end !== undefined) {
        return { startMin: toMinutes(playlist.start), endMin: toMinutes(playlist.end) };
    }
    // legacy format (whole hours)
    const startMin = playlist.startHour * 60;
    let endMin = playlist.endHour * 60;
    if (endMin <= startMin) {
        endMin += 1440; // crosses midnight (e.g. 20 → 2 becomes 1200 → 1560)
    }
    return { startMin, endMin };
}

// ─────────────────────────────────────────────
//  SESSION LOGIC (расписание дней недели, минутная точность)
//  daySchedule живёт в _playerConfig.js:
//    { 0: { start: '08:55', stop: '23:55' }, 1: {...}, ... }
//  Day numbers: 0=Sun, 1=Mon, ..., 6=Sat
//  stop > "24:00" — сессия заканчивается после полуночи.
// ─────────────────────────────────────────────

// Определяет, активна ли сессия ПРЯМО СЕЙЧАС, и если да — возвращает её
// параметры. Учитывает, что сессия вчерашнего дня может продолжаться
// после полуночи (стоп > "24:00").
// Возвращает { startMin, stopMin, baseDate } или null.
// baseDate — полночь тех суток, к которым сессия ПРИНАДЛЕЖИТ
// (для сессии Пт, играющей в 01:15 Сб, baseDate = полночь пятницы).
function getActiveSession(now, schedule) {
    schedule = schedule || playerConfig.daySchedule;
    if (!schedule) return null;

    const nowMin = getNowMinutes(now);

    // 1) Сессия сегодняшнего дня
    const todaySched = schedule[now.getDay()];
    const tStart = toMinutes(todaySched.start);
    const tStop = toMinutes(todaySched.stop);
    // Сегодняшняя сессия активна в пределах СЕГОДНЯШНИХ суток:
    // от старта до стопа (но не дальше полуночи — хвост после полуночи
    // проверяется уже как "вчерашняя сессия" на следующий день).
    if (nowMin >= tStart && nowMin < Math.min(tStop, 1440)) {
        const base = new Date(now);
        base.setHours(0, 0, 0, 0);
        return { startMin: tStart, stopMin: tStop, baseDate: base };
    }

    // 2) Хвост вчерашней сессии, пересёкшей полночь (стоп > "24:00")
    const yDay = (now.getDay() + 6) % 7;
    const ySched = schedule[yDay];
    const yStop = toMinutes(ySched.stop);
    if (yStop > 1440 && nowMin < (yStop - 1440)) {
        const base = new Date(now);
        base.setDate(base.getDate() - 1);
        base.setHours(0, 0, 0, 0);
        return { startMin: toMinutes(ySched.start), stopMin: yStop, baseDate: base };
    }

    return null;
}

// Точный момент окончания сессии как объект Date.
// baseDate (полночь дня сессии) + stopMin минут.
// stopMin > 1440 корректно переносится JS-датой на следующие сутки.
function computeSessionStopDate(session) {
    const stop = new Date(session.baseDate);
    stop.setHours(0, session.stopMin, 0, 0);
    return stop;
}

// Вычисляет ТОЧНУЮ дату следующей переинициализации в режиме 24/7.
// Источник времени (правило приоритета):
//   1) reshuffleAt задан в конфиге → берём его ('05:00' → каждый день в 5 утра)
//   2) reshuffleAt null → end последнего плейлиста в массиве
// Затем строим ближайший БУДУЩИЙ момент: дата на сегодня; если это
// время уже прошло (или совпадает с текущим) — переносим на следующие
// сутки. Так корректно при ребуте в любой момент дня.
function computeNextReinitDate(now, config) {
    config = config || playerConfig;
    const list = config.playlists;
    const reinitMin = config.reshuffleAt
        ? toMinutes(config.reshuffleAt)                          // явное время побеждает
        : getPlaylistWindow(list[list.length - 1]).endMin;       // иначе end последнего

    // База — полночь сегодняшних суток, плюс reinitMin минут.
    // Для 1440 (24:00) JS сам перенесёт на полночь следующего дня.
    const candidate = new Date(now);
    candidate.setHours(0, 0, 0, 0);
    candidate.setMinutes(reinitMin);

    // Если получившийся момент уже наступил/прошёл — значит ближайший
    // будущий момент будет завтра.
    if (candidate.getTime() <= now.getTime()) {
        candidate.setDate(candidate.getDate() + 1);
    }

    return candidate;
}

// ─────────────────────────────────────────────
//  PLAYLIST SELECTION
// ─────────────────────────────────────────────

// Helper function to get current playlist configuration (which playlist is active right now)
function getCurrentPlaylistConfig() {
    const nowMin = getNowMinutes(new Date());

    for (const playlist of playerConfig.playlists) {
        const { startMin, endMin } = getPlaylistWindow(playlist);
        if (isTimeInRange(nowMin, startMin, endMin)) {
            return playlist;
        }
    }
    return null;
}

// Helper function to get current playlist name
function getCurrentPlaylistName() {
    const config = getCurrentPlaylistConfig();
    return config ? config.name : 'unknown';
}

function getCurrentPlaylistTableId() {
    const config = getCurrentPlaylistConfig();
    // per-playlist tableId (if set) overrides the global playerConfig.tableId
    return (config && config.tableId) || playerConfig.tableId || 'unknown';
}

// ─────────────────────────────────────────────
//  STATS / AIRTABLE
// ─────────────────────────────────────────────

function collectStats(currentTrackName, likeDislikeService, currentTrackIndex) {
    const timestamp = new Date().toLocaleString('ru-RU')

    const data = {
        'baseId': playerConfig.baseId,
        'tableId': getCurrentPlaylistTableId(),
        'songName': currentTrackName,
        timestamp,
        currentIndex: currentTrackIndex,
        playlistName: getCurrentPlaylistName(),
        deviceUniqueId: os.hostname(),
    }

    if (likeDislikeService.scheduled) {
        data['newStatus'] = likeDislikeService.newStatus
    }

    console.log('data', data)

    return data
}

const basePath = 'https://europe-central2-sphere-385104.cloudfunctions.net'
const updateRecordApiEndpoint = `${basePath}/updateRecordStatus`
const updateSongStatsApiEndpoint = `${basePath}/updateSongStats`

const sendLikeDislike = async data => {

    try {

        const response = await send(updateRecordApiEndpoint, data)

        return await response.json()

    } catch (error) {
        console.log(error)
    }
}

const sendSongStats = async data => {

    try {

        const response = await send(updateSongStatsApiEndpoint, data)

        return await response.text()

    } catch (error) {
        console.log(error)
    }
}

function send(url, data) {
    return fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            // без этого node-fetch представляется как "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)"
            // версия берётся из package.json — обновляется через `npm version`
            'User-Agent': `sphere-pi-player/${version} (${os.hostname()})`,
        },
        body: JSON.stringify(data)
    })
}

// ─────────────────────────────────────────────
//  PLAYLIST FILES
// ─────────────────────────────────────────────

function parseTracksList (data) {
    if (!fs.existsSync(data)) {
        warn(`Файл плейлиста не найден: ${data}`);
        return [];
    }

    var arrayList = fs.readFileSync(data, 'utf8').split(/\r\n|\r|\n/g);

    for (var j = 0; j < arrayList.length; j++) {
        if (arrayList[j].trim() !== '') {
            arrayList[j] = path.resolve(__dirname, 'music',  arrayList[j]);
        }
    }

    // Filter out empty lines
    return arrayList.filter(track => track.includes('/music/'));
}

function shuffle(array) {
    var currentIndex = array.length, temporaryValue, randomIndex;

    while (0 !== currentIndex) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex -= 1;
        temporaryValue = array[currentIndex];
        array[currentIndex] = array[randomIndex];
        array[randomIndex] = temporaryValue;
    }

    return array;
}

//////////////////////////////////////////////////fs function deleting from dislikes
function deletingTrackFromTXT(trackName, currentPlaylistFileName) {

    // it's the same (as currentPlaylistFileName stores an entire path)
    // let's keep it like that to lower a complexity
    const pathToFile = currentPlaylistFileName;

    let lines = fs.readFileSync(pathToFile, 'utf8')
        .split(/\r?\n/)
        .filter(line => line.trim() !== '' && line.trim() !== trackName.trim());

    fs.writeFileSync(pathToFile, lines.join('\n'), 'utf8');
}

module.exports = {
    parseTracksList,
    shuffle,
    deletingTrackFromTXT,
    getCurrentPlaylistConfig,
    getCurrentPlaylistName,
    collectStats,
    sendLikeDislike,
    sendSongStats,
    // time helpers (минутная точность)
    toMinutes,
    formatTime,
    getNowMinutes,
    isTimeInRange,
    getPlaylistWindow,
    // session logic (daySchedule)
    getActiveSession,
    computeSessionStopDate,
    computeNextReinitDate,
}
