/**
 * Источник плейлистов и расписания для плеера.
 *
 * Завхоз каждую ночь пишет рядом playlist.json: что играть и когда.
 * Этот файл — единственное место, где плеер его читает.
 *
 * Что отдаёт:
 *   getDaySchedule() — расписание на все семь дней, числами дней, как у плеера
 *   getPlaylists()   — плейлисты на сегодня: окно времени плюс список треков
 *
 * Если playlist.json нет, он битый или пустой — обе функции возвращают null.
 * Это сигнал плееру работать по-старому: окна из _playerConfig.js, треки
 * из txt-файлов. Так пирожок, где Завхоз ещё не запускался или сломался,
 * продолжает играть вчерашнюю музыку, а не замолкает.
 *
 * Что сюда НЕ переезжает: громкость, порт, baseId — это настройки самого
 * устройства, они остаются в _playerConfig.js и ставятся руками при установке.
 */

const fs = require('fs');
const path = require('path');

const PLAYLIST_FILE = path.join(__dirname, 'playlist.json');
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
function activeDays(data) {
  if (!data) return null;

  if (Array.isArray(data.playlists)) {
    if (!data.playlists.length) return null;
    const playing = data.playlists.find(p => p.name === data.activePlaylist) || data.playlists[0];
    return playing.days || null;
  }

  return data.days || null;
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

/**
 * Плейлисты на сегодня. Форма совпадает с записями playerConfig.playlists
 * (name, start, end), поэтому getPlaylistWindow и getCurrentPlaylistConfig
 * работают с ними без изменений. Вместо поля file — готовый список путей.
 *
 * recordIds отдаём отдельно: они нужны, когда лайк с пирожка поедет
 * в Airtable, а в путь к файлу их не положить.
 */
function getPlaylists(now = new Date()) {
  const data = read();
  const days = activeDays(data);
  if (!days) return null;

  const day = days[DAY_NAMES[now.getDay()]];
  if (!day || !day.intervals || !day.intervals.length) return null;

  const recordIds = {};

  const playlists = day.intervals.map(interval => {
    const tracks = interval.tracks.map(track => {
      const fullPath = path.join(MUSIC_DIR, track.fileName);
      recordIds[fullPath] = track.recordId;
      return fullPath;
    });

    return {
      // Имя попадает в лог и в статистику, поэтому делаем его читаемым.
      name: `${interval.start}-${interval.end}`,
      start: interval.start,
      end: interval.end,
      tracks,
    };
  });

  return {
    playlists,
    recordIds,
    generatedAt: data.generatedAt,
    place: data.place,
    // Имя играющего плейлиста — для лога и для статистики.
    activePlaylist: data.activePlaylist || null,
  };
}

module.exports = { getDaySchedule, getPlaylists, PLAYLIST_FILE };
