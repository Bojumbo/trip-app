'use strict';

/** Структуроване JSON-логування (один рядок = одна подія). */

function write(level, msg, extra) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

const logger = {
  info: (msg, extra) => write('info', msg, extra),
  warn: (msg, extra) => write('warn', msg, extra),
  error: (msg, extra) => write('error', msg, extra),
  debug: (msg, extra) => {
    if (process.env.LOG_LEVEL === 'debug') write('debug', msg, extra);
  }
};

module.exports = logger;
