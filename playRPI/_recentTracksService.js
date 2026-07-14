const { shuffle } = require('./_helpers');
const playlistConfig = require('./_playlistConfig');

// ─────────────────────────────────────────────
//  ЗАЩИТА ОТ НЕДАВНИХ ПОВТОРОВ
//  При КАЖДОЙ перемешке последние сыгранные треки уходят в конец
//  списка, чтобы трек не заиграл снова вскоре после прошлого раза.
//  Эффективное окно = min(recentGuard, треть списка) — на маленьких
//  плейлистах защита автоматически сжимается, чтобы перемешка
//  не вырождалась. 30 треков ≈ 1.5–2 часа фоновой музыки.
//
//  recentGuard настраивается в _playlistConfig.js (default: 30).
//  История живёт только в памяти процесса: после ребута пустая — это ок,
//  первая перемешка после старта пройдёт без выноса недавних в хвост.
// ─────────────────────────────────────────────

class RecentTracksService {
    constructor(guardSize) {
        this.guardSize = guardSize;
        this.recentTracks = []; // пути файлов; самые свежие — в конце
    }

    // Запоминаем сыгранный трек, держим не больше guardSize последних.
    remember(trackPath) {
        this.recentTracks.push(trackPath);
        if (this.recentTracks.length > this.guardSize) {
            this.recentTracks = this.recentTracks.slice(-this.guardSize);
        }
    }

    // Перемешка с защитой от недавних повторов. Используется ВЕЗДЕ, где
    // перемешиваются плейлисты (инициализация и каждый оборот круга).
    // Шаги:
    //   1) обычный shuffle
    //   2) окно защиты: guardN = min(guardSize, треть списка)
    //   3) последние guardN сыгранных треков (из recentTracks), которые
    //      ЕСТЬ в этом списке, вытаскиваем и отправляем в конец
    //      (между собой они уже перемешаны шагом 1).
    // Треки из истории, которых в списке нет (например, из другого
    // плейлиста или удалённые дизлайком), просто игнорируются.
    // Массив мутируется НА МЕСТЕ — это важно: loadNextTrack сравнивает
    // плейлисты по ссылке (newPlaylist !== currentPlaylist).
    shuffleWithRecentGuard(array) {
        shuffle(array);

        const guardN = Math.min(this.guardSize, Math.floor(array.length / 3));
        if (guardN <= 0 || this.recentTracks.length === 0) return array;

        // последние guardN сыгранных (самые свежие — в конце recentTracks)
        const recentSet = new Set(this.recentTracks.slice(-guardN));

        const fresh = [];   // треки, которых не было в недавних
        const recent = [];  // недавние — уедут в хвост
        for (const track of array) {
            (recentSet.has(track) ? recent : fresh).push(track);
        }

        // переписываем массив на месте: сначала свежие, потом недавние
        for (let k = 0; k < array.length; k++) {
            array[k] = (k < fresh.length) ? fresh[k] : recent[k - fresh.length];
        }

        return array;
    }
}

module.exports = new RecentTracksService(playlistConfig.recentGuard ?? 30);
module.exports.RecentTracksService = RecentTracksService; // for tests
