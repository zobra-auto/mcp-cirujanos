// src/utils/logger.js
import pino from 'pino';
import { randomUUID } from 'crypto';

const isProd = process.env.NODE_ENV === 'production';

// Nivel de log por entorno
const level =
  process.env.LOG_LEVEL ||
  (isProd ? 'info' : 'debug');

// Metadata base global
const base = {
  service: 'valeria-mcp',
  env: process.env.NODE_ENV || 'development',
};

// Logger raíz
export const logger = pino({
  level,
  base,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
    bindings(bindings) {
      return {
        pid: bindings.pid,
        hostname: bindings.hostname,
        service: base.service,
      };
    },
  },
});

/**
 * Crea loggers hijos relacionados a una operación
 */
export function createRequestLogger(meta = {}) {
  const reqId = meta.reqId || randomUUID().slice(0, 8);

  const { tool, action, barber, ...rest } = meta;

  return logger.child({
    req_id: reqId,
    ...(tool && { tool }),
    ...(action && { action }),
    ...(barber && { barber }),
    ...rest,
  });
}

/**
 * Log sencillo con duración
 */
export function logWithDuration(log, message, extra = {}, startTimeMs) {
  const now = Date.now();
  const duration_ms = startTimeMs ? now - startTimeMs : 0;

  if (extra && typeof extra === 'object') {
    log.info({ ...extra, duration_ms }, message);
  } else {
    log.info({ duration_ms }, message);
  }
}

/**
 * Wrapper async con duración + handling de errores
 */
export async function timeAsync(log, message, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    log.info({ duration_ms: Date.now() - start }, message);
    return result;
  } catch (err) {
    log.error(
      {
        err: {
          message: err.message,
          code: err.code,
          stack: err.stack,
        },
        duration_ms: Date.now() - start,
      },
      message,
    );
    throw err;
  }
}
