/**
 * Источник плейлистов и расписания для плеера.
 *
 * Завхоз каждую ночь пишет рядом playlist.json: что играть и когда.
 * Этот файл — единственное место, где плеер его читает.
 *
 * Что отдаёт:
 *   getDaySchedule() — расписание на все семь дней, числами дней, как у плеера
 *   getPlaylists()   — плейлисты на нужный день: окно времени плюс список треков
 *   getZavhozStatus() — строка статуса Завхоза для статистики
 *
 * Если playlist.json нет, он битый, в нём нет музыки ни на один день или
 * пропали все mp3 на сегодня — функции возвращают null. Это сигнал плееру
 * работать по-старому: окна из _playerConfig.js, треки из txt-файлов. Так
 * пирожок, где Завхоз ещё не запускался или сломался, продолжает играть
 * вчерашнюю музыку, а не замолкает.
 *
 * Что сюда НЕ переезжает: громкость, порт, baseId — это настройки самого
 * устройства, они остаются в _playerConfig.js и ставятся руками при установке.
 */

const fs = require('fs');
const path = require('path');

const PLAYLIST_FILE = path.join(__dirname, 'playlist.json');
const STATE_FILE = path.join(__dirname, 'zavhoz-state.json');
const MUSIC_DIR = path.join(__dirname, 'music');

// В playlist.json дни названы словами, плеер считает их числами
// (0 — воскресенье, как в JS). Порядок здесь именно такой.
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));
    return (data && (data.playlists || data.days)) ? data : null;
  } catch {
    return null; // файла нет или он битый — пусть плеер идёт старым путём
  }
}

/**
 * Дни того плейлиста, который сейчас должен играть.
 *
 * Завхоз кладёт в файл все активные плейлисты и отдельно пишет имя играющего:
 * его выбирает куратор порядком строк в таблице Info. Остальные лежат
 * скачанными, чтобы переключение было мгновенным.
 *
 * Старый вид файла (один плейлист, дни в корне) тоже понимаем — чтобы
 * устройство, где Завхоз ещё не обновился, не осталось без музыки.
 */
function activePlaylist(data) {
  if (!data) return null;

  if (Array.isArray(data.playlists)) {
    if (!data.playlists.length) return null;
    return data.playlists.find(p => p.name === data.activePlaylist) || data.playlists[0];
  }

  return data;
}

function activeDays(data) {
  const playing = activePlaylist(data);
  return (playing && playing.days) || null;
}

// День без музыки. Заведения у нас работают каждый день, так что это не про
// выходные — но пустой день в файле всё равно возможен:
//   — плейлист ещё готовят: треки залиты, ячейки дней не заполнены;
//   — куратор очистил или испортил колонку одного дня;
//   — все треки этого дня не докачались, а отсутствующих в плейлисте не бывает;
//   — плейлист собран только из выходных треков (так их и делят на будни
//     и выходные — пустой ячейкой).
// Плеер читает расписание как schedule[номер дня].start, без проверки на
// пустоту, поэтому пропускать день нельзя — он упадёт при запуске. Нулевое
// окно его собственная логика понимает правильно: «сейчас не музыкальное
// время», ведь текущая минута не может быть меньше нуля.
const NO_MUSIC = { start: '00:00', stop: '00:00' };

/**
 * Расписание на неделю в том виде, в каком его ждёт getActiveSession:
 *   { 0: { start: '08:00', stop: '23:00' }, 1: {...}, ... }
 *
 * Отдаём все семь дней всегда — см. NO_MUSIC выше о том, почему день может
 * оказаться пустым и почему его нельзя пропустить.
 */
function getDaySchedule() {
  const days = activeDays(read());
  if (!days) return null;

  const schedule = {};
  let anyMusic = false;

  DAY_NAMES.forEach((name, dayNumber) => {
    const day = days[name];
    if (day && day.daySchedule) {
      schedule[dayNumber] = day.daySchedule;
      anyMusic = true;
    } else {
      schedule[dayNumber] = NO_MUSIC;
    }
  });

  // Если музыки нет ни в один день, файл бесполезен — пусть плеер идёт
  // старым путём, чем стоит молча в тишине всю неделю.
  return anyMusic ? schedule : null;
}

function minutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function timeOf(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// Какому дню принадлежит этот момент. Обычно сегодняшнему, но в 01:00 субботы
// ещё идёт пятничный интервал 20:00-26:00, и играть надо пятничные треки.
function dayOfMoment(days, now) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const today = days[DAY_NAMES[now.getDay()]];
  const yesterday = days[DAY_NAMES[(now.getDay() + 6) % 7]];

  const todayHours = today && today.daySchedule;
  if (todayHours && nowMin >= minutes(todayHours.start) && nowMin < minutes(todayHours.stop)) return today;

  const lastNight = yesterday && yesterday.daySchedule;
  if (lastNight && minutes(lastNight.stop) > 1440 && nowMin < minutes(lastNight.stop) - 1440) return yesterday;

  return today;
}

// Куратор может задать треку 00:00-24:00, а соседнему 05:00-20:00. Плеер берёт
// первое подходящее окно, и второй интервал не заиграл бы никогда. Поэтому режем
// день по всем границам: в каждом куске играют все треки, чьё время его покрывает.
function splitOverlaps(intervals) {
  const ranges = intervals.map(interval => ({
    start: minutes(interval.start),
    end: minutes(interval.end),
    tracks: interval.tracks,
  }));
  const edges = [...new Set(ranges.flatMap(r => [r.start, r.end]))].sort((a, b) => a - b);

  const pieces = [];
  for (let k = 0; k < edges.length - 1; k++) {
    const covering = ranges.filter(r => r.start <= edges[k] && r.end >= edges[k + 1]);
    if (!covering.length) continue; // дырка в расписании: в это время музыка не играет

    const tracks = new Map();
    covering.forEach(r => r.tracks.forEach(t => tracks.set(t.recordId, t)));
    pieces.push({ start: timeOf(edges[k]), end: timeOf(edges[k + 1]), tracks: [...tracks.values()] });
  }
  return pieces;
}

/**
 * Плейлисты на день, которому принадлежит этот момент. Форма совпадает с записями
 * playerConfig.playlists (name, start, end), поэтому getPlaylistWindow
 * и getCurrentPlaylistConfig работают с ними без изменений. Вместо поля file —
 * готовый список путей.
 *
 * recordIds отдаём отдельно: по ним статистика и лайки находят трек в Airtable.
 * Имя файла для этого не годится, оно не всегда совпадает с полем Name.
 *
 * День без музыки — это пустой список, а не null: файл исправен, просто сейчас
 * по расписанию тихо. Иначе в такой день заиграли бы старые треки из txt.
 */
function getPlaylists(now = new Date()) {
  const data = read();
  const days = activeDays(data);
  if (!days) return null;

  const day = dayOfMoment(days, now);
  const intervals = (day && day.intervals) || [];
  const playing = activePlaylist(data);
  const recordIds = {};

  // Завхоз пишет в файл только то, что есть на диске, но файл могли удалить
  // позже или повредить карту. Без этой проверки плеер споткнётся о каждый такой трек.
  const playlists = splitOverlaps(intervals).map(interval => {
    const tracks = interval.tracks
      .map(track => {
        const fullPath = path.join(MUSIC_DIR, track.fileName);
        recordIds[fullPath] = track.recordId;
        return fullPath;
      })
      .filter(fullPath => fs.existsSync(fullPath));

    return {
      // Имя попадает в лог и в статистику, поэтому делаем его читаемым.
      name: `${data.activePlaylist || 'playlist'} ${interval.start}-${interval.end}`,
      start: interval.start,
      end: interval.end,
      tracks,
      tableId: playing.tableId,
    };
  });

  // В расписании на день музыка есть, а на диске ни одного файла.
  if (intervals.length && !playlists.some(p => p.tracks.length)) return null;

  return {
    playlists,
    recordIds,
    generatedAt: data.generatedAt,
    place: data.place,
    // Имя играющего плейлиста — для лога и для статистики.
    activePlaylist: data.activePlaylist || null,
  };
}

// Строка вроде «проверка 30.10 23:18 ок; работа 30.10 21:26»: так из Airtable
// видно, что Завхоз на этом устройстве жив. Нет файла — нет и поля.
function getZavhozStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).status || null;
  } catch {
    return null;
  }
}

module.exports = { getDaySchedule, getPlaylists, getZavhozStatus, PLAYLIST_FILE };
