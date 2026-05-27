'use strict';
/**
 * utils/logger.js
 * Structured logger built on winston.
 * Usage:  const log = require('./logger')('agent1-crawler');
 */

const winston = require('winston');

const { combine, timestamp, printf, colorize, errors } = winston.format;

const level = process.env.LOG_LEVEL || 'info';

const lineFormat = printf(({ level, message, label, timestamp, stack }) => {
  const prefix = label ? `[${label}] ` : '';
  return stack
    ? `${timestamp} ${level}: ${prefix}${message}\n${stack}`
    : `${timestamp} ${level}: ${prefix}${message}`;
});

const baseLogger = winston.createLogger({
  level,
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    colorize(),
    lineFormat,
  ),
  transports: [new winston.transports.Console()],
});

/**
 * Returns a child logger tagged with the given label.
 * @param {string} label
 * @returns {winston.Logger}
 */
function createLogger(label) {
  return baseLogger.child({ label });
}

module.exports = createLogger;
