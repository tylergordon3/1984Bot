import { config } from '../config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function stamp() {
  return new Date().toISOString();
}

function log(level, ...args) {
  if (LEVELS[level] > threshold) return;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${stamp()}] ${level.toUpperCase().padEnd(5)}`, ...args);
}

export const logger = {
  error: (...a) => log('error', ...a),
  warn: (...a) => log('warn', ...a),
  info: (...a) => log('info', ...a),
  debug: (...a) => log('debug', ...a),
};
