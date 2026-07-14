// ─────────────────────────────────────────────
//  LOGGING (человекочитаемые логи с таймстампом)
//  Каждая строка: [2026-06-11 21:43:07] сообщение
//  Пишется в stdout — в консоль при ручном запуске,
//  в лог-файл через ">> file.log 2>&1" в crontab.
// ─────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function timestamp(d) {
  d = d || new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(msg)  { console.log(`[${timestamp()}] ${msg}`); }
function warn(msg) { console.log(`[${timestamp()}] ⚠ ${msg}`); }

module.exports = { log, warn, timestamp, pad };
