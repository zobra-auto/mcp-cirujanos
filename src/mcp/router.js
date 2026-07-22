import express from 'express';
import Ajv from 'ajv';
import crypto from 'crypto';
import { logger } from '../utils/logger.js'; // Ajusta la ruta si tus utils están en src/utils

// --- IMPORTAMOS SOLO LOS MÓDULOS REALES ---
import * as calendar from '../tools/calendar.js';
import * as barbers from '../tools/barbers.js';
import * as catalog from '../tools/catalog.js';
import * as booking from '../tools/booking.js';
import * as casos from '../tools/casos.js';
import cache from '../utils/cache.js';

const ajv = new Ajv({ removeAdditional: true, allErrors: true });
const schema = {
  type: 'object',
  required: ['tool', 'action'],
  properties: {
    tool: { type: 'string' },
    action: { type: 'string' },
    params: { type: 'object', additionalProperties: true }
  }
};
const validate = ajv.compile(schema);

// --- REGISTRO DE HERRAMIENTAS ---
const registry = {
  // Módulos Core
  calendar,
  barbers,
  catalog,
  booking,
  casos,

  // --- ALIAS (Puentes para N8N) ---
  // Esto permite que si el Agente llama a "ver_disponibilidad",
  // el MCP use el código de "calendar" automáticamente.
  ver_disponibilidad: calendar,
  agendar_turno: calendar,
  cancelar_turno: calendar,
  buscar_turnos: booking,
  buscar_casos: casos,

  // docs y notificador se han eliminado
};

export const mcpRouter = express.Router();

// Configuración básica
const API_KEY = process.env.API_KEY || '';
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 120);
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 60);

// Rate limiter en memoria simple
const rateWindows = new Map();

function timingSafeCompare(a, b) {
  try {
    const aBuf = Buffer.from(String(a));
    const bBuf = Buffer.from(String(b));
    if (aBuf.length !== bBuf.length) {
      const pad = Buffer.alloc(Math.abs(aBuf.length - bBuf.length));
      if (aBuf.length < bBuf.length) return crypto.timingSafeEqual(Buffer.concat([aBuf, pad]), bBuf) && false;
      return crypto.timingSafeEqual(aBuf, Buffer.concat([bBuf, pad])) && false;
    }
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch (e) {
    return false;
  }
}

function normalizeError(e) {
  if (!e) return { code: 'ERROR', message: 'Unknown error', status: 500, raw: e };
  if (e instanceof Error) {
    return {
      code: e.code || (e.name ? e.name.toUpperCase() : 'ERROR'),
      message: e.message || String(e),
      status: e.status || e.statusCode || (e.response && e.response.status),
      raw: e,
    };
  }
  return { code: 'ERROR', message: String(e), status: 500, raw: e };
}

function rateAllow(apiKey) {
  if (!RATE_LIMIT_PER_MINUTE || RATE_LIMIT_PER_MINUTE <= 0) return true;
  const nowSec = Math.floor(Date.now() / 1000);
  const windowSec = 60;
  const w = rateWindows.get(apiKey) || { windowStart: nowSec, count: 0 };
  if (nowSec - w.windowStart >= windowSec) {
    w.windowStart = nowSec;
    w.count = 1;
    rateWindows.set(apiKey, w);
    return true;
  }
  if (w.count >= RATE_LIMIT_PER_MINUTE) return false;
  w.count += 1;
  rateWindows.set(apiKey, w);
  return true;
}

mcpRouter.post('/', async (req, res) => {
  const requestId = req.headers['x-request-id'] || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const incomingApiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '';

  const authorized = API_KEY ? timingSafeCompare(API_KEY, incomingApiKey) : true;
  if (!authorized) return res.status(401).json({ status: 'error', error: 'UNAUTHORIZED', message: 'Invalid API key' });

  if (!rateAllow(incomingApiKey || 'anon')) return res.status(429).json({ status: 'error', error: 'RATE_LIMIT', message: 'Rate limit exceeded' });

  const body = req.body || {};
  if (!validate(body)) return res.status(400).json({ status: 'error', message: 'JSON inválido', errors: validate.errors });
  
  const { tool, action, params = {} } = body;
  logger.info({ requestId, tool, action }, 'mcp.request');

  // Health check rápido dentro del endpoint
  if (tool === 'health' && action === 'ping') {
    return res.json({ status: 'ok', data: { pong: true } });
  }

  // --- RESOLUCIÓN DE LA TOOL ---
  const mod = registry[tool];
  if (!mod) {
    return res.status(404).json({ status: 'error', message: `Tool desconocida: ${tool}` });
  }

  // Buscamos la acción dentro de actions{} o exportada directamente
  const handler = (mod.actions && typeof mod.actions[action] === 'function')
    ? (p) => mod.actions[action]({ params: p })
    : (typeof mod[action] === 'function' ? mod[action] : null);

  if (!handler) {
    return res.status(404).json({ status: 'error', message: `Acción desconocida: ${action}` });
  }

  // Clave de caché determinista
  const deterministicKey = `mcp:${tool}:${action}:${crypto.createHash('sha256').update(JSON.stringify(params)).digest('hex')}`;

  try {
    // 1. Intentar leer de caché (Solo para lecturas seguras)
    if (CACHE_TTL_SECONDS > 0 && (action === 'check' || action === 'resolve' || action === 'search' || action === 'get')) { 
       const cached = await cache.get(deterministicKey);
       if (cached) {
         logger.info({ requestId, tool, action }, 'mcp.cache_hit');
         return res.json({ status: 'ok', data: cached, fromCache: true });
       }
    }

    // 2. Ejecutar la lógica real
    // Pasamos meta información por si la tool la necesita (requestId)
    const result = await handler({ ...params, _meta: { requestId } });
    
    // Normalizar respuesta: Si viene { ok:true, data:... } extraemos data
    const payload = (result && result.ok === true && result.data !== undefined) ? result.data : result;

    // 3. Guardar en caché si aplica
    if (CACHE_TTL_SECONDS > 0 && (action === 'check' || action === 'resolve' || action === 'search' || action === 'get')) {
       // Solo cacheamos si no hubo error implícito
       if (!payload.error) {
         await cache.set(deterministicKey, payload, CACHE_TTL_SECONDS);
       }
    }

    return res.json({ status: 'ok', message: 'OK', data: payload });

  } catch (rawErr) {
    const err = normalizeError(rawErr);
    
    // Mapeo de errores de negocio a HTTP Status
    const mappedStatus =
      err.code === 'GOOGLE_403_FORBIDDEN' ? 403 :
      err.code === 'EVENT_NOT_FOUND' || err.code === 'BARBER_NOT_FOUND' || err.code === 'CATALOG_NOT_FOUND' ? 404 :
      err.code === 'SLOT_OCCUPIED' ? 409 :
      err.code === 'INVALID_RANGE' || err.code === 'IN_PAST' || err.code === 'INVALID_WHEN' || err.code === 'MISSING_CALENDAR' ||
        err.code === 'PROCEDIMIENTO_REQUIRED' || err.code === 'CATALOG_ID_REQUIRED' || err.code === 'INVALID_INTENT' ? 400 :
      500;

    logger.error({ requestId, tool, action, err }, 'mcp.error');
    
    // Respuesta de error limpia
    return res.status(mappedStatus).json({ 
      status: 'error', 
      error: err.code || 'INTERNAL_ERROR', 
      message: err.message 
    });
  }
});
