const trackMs = Number(process.env.FAKE_PLAYER_TRACK_MS || 200);
const hang = process.env.FAKE_PLAYER_HANG === '1';

console.log(`[fake-player] стартовал, PID ${process.pid}, hang=${hang}`);

if (!hang) {
  process.on('SIGUSR2', () => {
    console.log('[fake-player] получен SIGUSR2 — "доигрываю трек"...');
    setTimeout(() => {
      console.log('[fake-player] трек доигран — выхожу');
      process.exit(0);
    }, trackMs);
  });
}

setInterval(() => {}, 1000 * 60 * 60);
