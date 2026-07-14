const path = require("path");

// FLEXIBLE PLAYLIST CONFIGURATION
// Copy this file to `_playlistConfig.js` (it's gitignored) and edit.
//
// Time format: 'HH:MM' with minute precision ('11:30' works, not just '11').
// end/stop > '24:00' means "after midnight, next day": '26:00' = 02:00 next day.
//
// RULE: Окно плейлиста (start/end) должно быть ШИРЕ (или равно)
//       окна любого дня в daySchedule. daySchedule — главный рубильник.

const playlistConfig = {

    // ── PLAYLISTS ─────────────────────────────
    // 1 playlist, весь день:
    playlists: [
        // __dirname always points to the directory of the current file
        { name: 'AllDay', file: path.resolve(__dirname, './tracksAllDay.txt'), start: '07:00', end: '25:00', tableId: '' },
    ],

    // 2 playlists (day + night, ночь до 03:00 следующих суток):
    // playlists: [
    //     { name: 'day',   file: path.resolve(__dirname, './tracksDay.txt'),   start: '07:00', end: '18:00', tableId: '' },
    //     { name: 'night', file: path.resolve(__dirname, './tracksNight.txt'), start: '18:00', end: '27:00', tableId: '' },
    // ],

    // Старый формат (целые часы) тоже поддерживается:
    // playlists: [
    //     { name: 'all', file: path.resolve(__dirname, './tracksAllDay.txt'), startHour: 5, endHour: 2, tableId: '' }
    // ],

    // ── DAY-OF-WEEK SCHEDULE (минутная точность) ──
    // Главный рубильник: когда музыка вообще играет.
    // Day numbers: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
    // Если убрать daySchedule совсем — рубильником станут окна плейлистов.
    daySchedule: {
        0: { start: '08:55', stop: '23:55' },  // Воскресенье
        1: { start: '07:55', stop: '22:55' },  // Понедельник
        2: { start: '07:55', stop: '22:55' },  // Вторник
        3: { start: '07:55', stop: '22:55' },  // Среда
        4: { start: '07:55', stop: '22:55' },  // Четверг
        5: { start: '07:55', stop: '22:55' },  // Пятница
        6: { start: '08:55', stop: '23:55' },  // Суббота
    },

    // ── РЕЖИМ РАБОТЫ ──────────────────────────
    // false → по расписанию daySchedule: процесс выходит в стоп-время,
    //         crontab поднимает на следующий старт.
    // true  → круглосуточно: daySchedule игнорируется, процесс не выходит,
    //         плейлисты перечитываются/перемешиваются на стыке суток цикла.
    mode24h: false,

    // ── ВРЕМЯ ПЕРЕИНИЦИАЛИЗАЦИИ (только режим 24/7) ──
    // null     → переинициализация в момент end ПОСЛЕДНЕГО плейлиста
    // 'HH:MM'  → каждый день в это время; ПОБЕЖДАЕТ end последнего плейлиста
    reshuffleAt: null,

    // ── ЗАЩИТА ОТ НЕДАВНИХ ПОВТОРОВ ──────────
    // Сколько последних сыгранных треков уходит в конец при перемешке.
    // Эффективное окно = min(recentGuard, треть списка).
    recentGuard: 30,

    // ── AIRTABLE STATS ────────────────────────
    baseId: '',
};

module.exports = playlistConfig
