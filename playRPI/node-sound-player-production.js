///////////modules for player
var fs = require('fs');
var soundplayer = require('sound-player');
const loudness = require('mwl-loudness');
const playerConfig = require('./_playerConfig')
var volume = playerConfig.volume ?? 80; // стартовая громкость из конфига
const likeDislikeService = require('./_likeDislikeService')
const recentTracksService = require('./_recentTracksService')
const { log, warn, timestamp } = require('./_logger')
const {
  parseTracksList,
  getCurrentPlaylistConfig,
  getCurrentPlaylistName,
  collectStats,
  deletingTrackFromTXT,
  sendLikeDislike,
  sendSongStats,
  toMinutes,
  formatTime,
  getPlaylistWindow,
  getActiveSession,
  computeSessionStopDate,
  computeNextReinitDate,
} = require('./_helpers')
///////////modules for server
const express = require('express')
const path = require('path');

////////////variables for player
var i = 0;
var currentPlaylist, allPlaylists = {}, currentTrackName, player, activePlaylistConfig;
var sessionStopDate;   // locked in at boot - exact Date when today's session ends
var nextReinitDate;    // 24/7 only - exact Date of next reinit (= end of last playlist)

// ─────────────────────────────────────────────
//  GRACEFUL RESTART ДЛЯ АВТООБНОВЛЕНИЯ
//  Скрипт deploy/update.sh, подготовив новый код, шлёт SIGUSR2.
//  Мы НЕ выходим сразу: ставим флаг, доигрываем текущий трек,
//  ДОЖИДАЕМСЯ отправки статистики и только потом process.exit(0).
//  systemd (Restart=always) поднимет процесс уже на новом коде.
// ─────────────────────────────────────────────
var restartPending = false;
process.on('SIGUSR2', () => {
  restartPending = true;
  log('📦 Получен SIGUSR2: обновление готово — перезапущусь после текущего трека.');
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Страховка для финальных отправок перед выходом: у node-fetch нет
// таймаута по умолчанию, а висеть на мёртвом вайфае перед перезапуском
// нельзя. По таймауту просто продолжаем (сами send-функции ошибки глотают).
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    sleep(ms).then(() => { throw new Error(`timeout after ${ms}ms`); }),
  ]);
}

// ─────────────────────────────────────────────
//  РЕЖИМ РАБОТЫ (настраивается в _playerConfig.js: mode24h)
//  false → по расписанию daySchedule: процесс выходит
//          в стоп-время, crontab поднимает на следующий старт.
//  true  → круглосуточно: daySchedule игнорируется, процесс не выходит.
//          Плейлисты перечитываются и перемешиваются заново (повторный
//          вызов playerInitialization) в момент, когда наступает КОНЕЦ
//          ВРЕМЕНИ (end) последнего плейлиста в playerConfig — или в
//          reshuffleAt ('HH:MM'), если он задан в конфиге.
// ─────────────────────────────────────────────
const MODE_24H = playerConfig.mode24h === true;

var options = {
  gain: 0,
  debug: false,
  player: 'mpg123',
}

////////////variables and settings for server
const app = express();
const port = process.env.PORT || playerConfig.port || 3333;
const static_path = path.join(__dirname, 'public');
app.use(express.static(static_path));
app.use(express.urlencoded({ extended: true }));

////////////////////////////////////////////////////server
app.post('/request', (req, res) => {
  if (req.body.value === 'like') {
    likeDislikeService.scheduleLikeDislike({newStatus: 'Like'})
    log(`👍 Лайк запланирован: "${currentTrackName}"`);
    return res.json({currentTrackName, message: 'like scheduled'})
  } else if (req.body.value === 'dislike') {
    likeDislikeService.scheduleLikeDislike({newStatus: 'Dislike'})
    log(`👎 Дизлайк запланирован: "${currentTrackName}"`);
    return res.json({currentTrackName, message: 'dislike scheduled'})
  } else if (req.body.value == 'volumeDown') {
    if (volume == 0) {
      res.send('min');
      return;
    }
    else {
      volume = volume - 2;
      loudness.setVolume(volume);
      log(`Громкость → ${volume}`);
      res.send(''+volume);
      return;
    }
  }
  else if (req.body.value == 'volumeUp') {
    if (volume == 100) {
      res.send('max');
      return;
    }
    else {
      volume = volume + 2;
      loudness.setVolume(volume);
      log(`Громкость → ${volume}`);
      res.send(''+volume);
      return;
    }
  }

  // Find current playlist name for response
  const currentPlaylistName = getCurrentPlaylistName();
  var arrayResponse = [currentTrackName, currentPlaylistName + ' list'];
  res.send(arrayResponse);
})

app.get('/volumeData', (req, res) => {
  res.send(''+volume);
})

const server = app.listen(port, () => {
  log(`Веб-пульт запущен на порту ${port}`);
});

// Понятная ошибка вместо stack trace, если порт уже занят
// (обычно это значит, что старый экземпляр плеера ещё работает)
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    warn(`Порт ${port} занят — похоже, другой экземпляр плеера уже запущен.`);
    warn(`Найди его:  ps aux | grep node`);
    warn(`Останови:   pkill -f node-sound-player`);
    process.exit(1);
  } else {
    warn(`Ошибка веб-сервера: ${err.message}`);
    process.exit(1);
  }
});


/////////////////////////////////////////////////player
function checkingOnReboot() {
  const now = new Date();

  log('═══════════ SPHERE PLAYER — ЗАПУСК ═══════════');

  // ── Режим 24/7: расписание дней не проверяем, играем всегда ──
  if (MODE_24H) {
    log('Режим 24/7 — круглосуточно, расписание дней игнорируется.');
    sessionStopDate = null; // в 24/7 выключаться некуда
    activePlaylistConfig = getCurrentPlaylistConfig();
    playerInitialization();
    return;
  }

  // ── Режим расписания (daySchedule в _playerConfig.js) ──
  if (playerConfig.daySchedule) {
    const session = getActiveSession(now);
    const todaySched = playerConfig.daySchedule[now.getDay()];
    log(`Расписание дня: ${formatTime(toMinutes(todaySched.start))} → ${formatTime(toMinutes(todaySched.stop))}`);

    if (session) {
      sessionStopDate = computeSessionStopDate(session); // lock in for the session
      activePlaylistConfig = getCurrentPlaylistConfig();
      log(`Музыкальное время ✓ — играем до ${timestamp(sessionStopDate)}`);
      playerInitialization();
    } else {
      log('Сейчас не музыкальное время — выключаюсь.');
      server.close();
      return;
    }
    return;
  }

  // ── Fallback (нет daySchedule в конфиге): рубильник — окна плейлистов ──
  activePlaylistConfig = getCurrentPlaylistConfig();

  if (activePlaylistConfig) {
    log(`Музыкальное время ✓ — активен плейлист "${activePlaylistConfig.name}"`);
    playerInitialization();
  } else {
    log('Сейчас не музыкальное время — выключаюсь.');
    server.close();
    return;
  }
}

checkingOnReboot();

function playerInitialization() {
  loudness.setVolume(volume);
  log(`Громкость установлена: ${volume}`);

  // Load all configured playlists
  playerConfig.playlists.forEach(playlistConf => {
    allPlaylists[playlistConf.name] = parseTracksList(playlistConf.file);
    // Защищённая перемешка: при старте история пуста (= обычный shuffle),
    // при переинициализации недавние треки уходят в хвост.
    recentTracksService.shuffleWithRecentGuard(allPlaylists[playlistConf.name]);

    const count = allPlaylists[playlistConf.name].length;
    if (count === 0) {
      warn(`Плейлист "${playlistConf.name}" ПУСТ или файл не найден: ${playlistConf.file}`);
    } else {
      const { startMin, endMin } = getPlaylistWindow(playlistConf);
      log(`Плейлист "${playlistConf.name}" (${formatTime(startMin)}–${formatTime(endMin)}): ${count} треков`);
    }
  });

  // Set current playlist
  activePlaylistConfig = getCurrentPlaylistConfig();
  if (activePlaylistConfig) {
    currentPlaylist = allPlaylists[activePlaylistConfig.name];
    log(`Активный плейлист: "${activePlaylistConfig.name}"`);
  }

  // В режиме 24/7 запоминаем момент следующей переинициализации
  // (= ближайший будущий end последнего плейлиста, либо reshuffleAt).
  // Обновляется здесь же при каждом повторном вызове playerInitialization,
  // поэтому loadNextTrack только сравнивает с ним, а не пересчитывает.
  if (MODE_24H) {
    nextReinitDate = computeNextReinitDate(new Date());
    log(`Следующая переинициализация (24/7): ${timestamp(nextReinitDate)}`);
  }

  playSong();
}

function playSong () {
  if (!currentPlaylist || currentPlaylist.length === 0) {
    warn('В активном плейлисте нет треков — повторная попытка через 60 секунд');
    setTimeout(loadNextTrack, 60 * 1000);
    return;
  }

  options.filename = currentPlaylist[i];
  currentTrackName = currentPlaylist[i].split('music/')[1];

  // История для защиты от недавних повторов
  recentTracksService.remember(currentPlaylist[i]);

  if (!fs.existsSync(options.filename)) {
    warn(`Файл трека не найден на диске: ${options.filename}`);
  }

  log(`▶ [${activePlaylistConfig ? activePlaylistConfig.name : 'unknown'}] ${currentTrackName}  (${i + 1}/${currentPlaylist.length})`);

  player = new soundplayer(options);

  player.play();
  player.once('complete', async function(){
    const currentSongFullName = currentTrackName;
    const songNameWithoutExtension = currentSongFullName.replace('.mp3', '');
    const stats = collectStats(songNameWithoutExtension, likeDislikeService, i);
    const currentPlaylistFileName = activePlaylistConfig.file // stores an entire path
    // clean up so next track could be liked or disliked
    likeDislikeService.resetLikeDislikeScheduledValues()

    // Обычный путь: следующий трек стартует СРАЗУ, до сетевых отправок —
    // музыка не ждёт сеть. При ожидающем обновлении следующий трек не
    // запускаем: доотправим статистику ниже и выйдем.
    if (!restartPending) {
      loadNextTrack();
    } else {
      log('⏸ Обновление ожидает — следующий трек не запускаю, доотправляю статистику…');
    }

    // send those stats ang handle results
    if (stats.newStatus) {
      log(`${currentSongFullName} song will be ${stats.newStatus.toLowerCase()}d`) // liked or disliked
      if (stats.newStatus === 'Dislike') {
        deletingTrackFromTXT(currentSongFullName, currentPlaylistFileName);
        log(`👎 Дизлайк: "${currentSongFullName}" удалён из плейлиста`);
      }

      // use here the same object, although it may be not the best name for it
      try {
        const result = await withTimeout(sendLikeDislike(stats), 15 * 1000)
        console.log(result)
        log(`${stats.newStatus} is sent`)
      } catch(error) {
        console.error(error)
      }
    }

    // to hopefully bypass airtable's 5 requests per second limit
    if (!restartPending) {
      setTimeout(async () => {
        try {
          const result = await sendSongStats(stats);
          console.log(result)
        } catch(error) {
          console.error(error)
        }
      }, 2000)
    } else {
      // Перед выходом ту же паузу ДОЖИДАЕМСЯ (иначе process.exit её отменит),
      // затем отправляем статистику один раз — как обычно, без дублей.
      await sleep(2000);
      try {
        const result = await withTimeout(sendSongStats(stats), 15 * 1000);
        console.log(result)
      } catch(error) {
        console.error(error)
      }
      log('■ Статистика отправлена — выхожу для обновления. systemd поднимет новый код.');
      process.exit(0);
    }
  });

  player.once('error', function(err) {
    warn(`Ошибка воспроизведения "${currentTrackName}": ${err}. Пропускаю трек.`);
    loadNextTrack(); // Skip to next track on error
  });
}

function loadNextTrack() {
  // ── Ожидающее обновление: путь БЕЗ висящих отправок ──
  // Сюда при restartPending попадаем только из error-обработчика или
  // таймера пустого плейлиста (обычный complete-путь при обновлении
  // не вызывает loadNextTrack — он сам доотправляет статистику и выходит).
  if (restartPending) {
    log('■ Обновление ожидает — выхожу (отправок нет). systemd поднимет новый код.');
    process.exit(0);
    return;
  }

  // ── Режим расписания: проверка окончания сессии ──
  // Сравниваем текущее время с моментом остановки, зафиксированным на
  // старте (sessionStopDate). Корректно и для стопа после полуночи.
  // В режиме 24/7 sessionStopDate == null, поэтому сюда не заходим.
  if (!MODE_24H && sessionStopDate && new Date().getTime() >= sessionStopDate.getTime()) {
    log(`■ Сессия завершена (план был: ${timestamp(sessionStopDate)}). Выключаюсь. До завтра!`);
    process.exit(0);
    return;
  }

  // ── Режим 24/7: проверка конца цикла (end последнего плейлиста) ──
  // Достигли запомненного момента → перечитываем файлы и перемешиваем
  // заново через ПОВТОРНЫЙ вызов playerInitialization. Она же пересчитает
  // следующий nextReinitDate и сама запустит playSong, поэтому здесь
  // сразу return (иначе задвоим воспроизведение).
  if (MODE_24H && nextReinitDate && new Date().getTime() >= nextReinitDate.getTime()) {
    log(`🔄 Конец цикла 24/7 (${timestamp(nextReinitDate)}). Переинициализация: перечитываю .txt и перемешиваю.`);
    playerInitialization();
    return;
  }

  // Check if playlist should change (time-based switching between playlists)
  activePlaylistConfig = getCurrentPlaylistConfig();

  if (!activePlaylistConfig) {
    if (MODE_24H) {
      // В 24/7 дырок между окнами быть не должно, но на всякий случай
      // не выходим, а продолжаем текущим списком.
      warn('Нет окна плейлиста на текущее время, но режим 24/7 — продолжаю текущим плейлистом. Проверь окна start/end!');
      if (i >= currentPlaylist.length - 1) { recentTracksService.shuffleWithRecentGuard(currentPlaylist); i = 0; } else { i += 1; }
      playSong();
      return;
    }
    warn('Нет активного плейлиста на текущее время (проверь окна в playerConfig!). Выключаюсь.');
    process.exit(0);
    return;
  }

  const newPlaylist = allPlaylists[activePlaylistConfig.name];

  // If playlist changed, switch and reset index
  if (newPlaylist !== currentPlaylist) {
    log(`Переключение плейлиста → "${activePlaylistConfig.name}"`);
    currentPlaylist = newPlaylist;
    i = 0;
  } else {
    // Continue with current playlist
    if (i >= currentPlaylist.length - 1) {
      // Круг доигран → перемешиваем заново (на месте), недавние
      // треки уезжают в хвост — трек не заиграет вскоре после
      // прошлого раза, включая шов «конец круга → начало нового».
      recentTracksService.shuffleWithRecentGuard(currentPlaylist);
      i = 0;
      log('Плейлист доигран до конца — перемешал и начинаю сначала');
    } else {
      i += 1;
    }
  }

  playSong();
}
