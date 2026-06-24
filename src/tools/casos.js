// src/tools/casos.js
// Tool NUEVA (no existe en valeria-mcp-server).
// Biblioteca de casos antes/después por procedimiento.
// El sub-agente VENTAS la llama en M1 del guion: buscar_casos(procedimiento, n).
// Lee CASOS_JSON (fallback ./data/casos.json). En producción puede migrar a la tabla `casos`.
import fs from 'fs';
import path from 'path';
import { createRequestLogger, logWithDuration } from '../utils/logger.js';

const CASOS_JSON_PATH =
  process.env.CASOS_JSON || path.join(process.cwd(), 'data', 'casos.json');

let casosCache = null;

function normalize(str = '') {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadCasos() {
  if (casosCache) return casosCache;

  const log = createRequestLogger({ tool: 'casos', action: 'load' });

  try {
    if (!fs.existsSync(CASOS_JSON_PATH)) {
      log.warn({ path: CASOS_JSON_PATH }, 'CASOS_JSON_NOT_FOUND');
      casosCache = [];
      return casosCache;
    }

    const raw = fs.readFileSync(CASOS_JSON_PATH, 'utf8').trim();
    if (!raw) {
      casosCache = [];
      return casosCache;
    }

    const parsed = JSON.parse(raw);
    // Acepta { casos: [...] } o directamente [...]
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed.casos) ? parsed.casos : [];

    // Normaliza el esquema: tolera image_antes/media_antes (DDL usa media_*).
    casosCache = arr.map((c) => ({
      id: c.id,
      procedimiento: c.procedimiento,
      titulo: c.titulo || '',
      descripcion: c.descripcion || '',
      media_antes: c.media_antes || c.image_antes || '',
      media_despues: c.media_despues || c.image_despues || '',
      real: c.real === true,
      activo: c.activo !== false, // default true
    }));
  } catch (err) {
    log.error(
      { err: { message: err.message, stack: err.stack }, path: CASOS_JSON_PATH },
      'CASOS_JSON_LOAD_ERROR'
    );
    casosCache = [];
  }

  return casosCache;
}

/**
 * buscar_casos: devuelve hasta n casos ACTIVOS del procedimiento pedido.
 * params: { procedimiento (string, requerido), n (int, default 2, max 5) }
 */
async function searchCasos(params = {}) {
  const log = createRequestLogger({ tool: 'casos', action: 'search' });
  const started = Date.now();

  const proc = normalize(params.procedimiento || params.query || '');
  if (!proc) {
    const err = new Error('PROCEDIMIENTO_REQUIRED: se requiere params.procedimiento');
    err.code = 'PROCEDIMIENTO_REQUIRED';
    throw err;
  }

  let n = Number(params.n);
  if (!Number.isFinite(n) || n <= 0) n = 2;
  if (n > 5) n = 5;

  const all = loadCasos().filter((c) => c.activo);

  // 1) match exacto por key de procedimiento; 2) substring en ambos sentidos
  const exact = all.filter((c) => normalize(c.procedimiento) === proc);
  let matches = exact;
  if (matches.length === 0) {
    matches = all.filter((c) => {
      const cp = normalize(c.procedimiento);
      return cp.includes(proc) || proc.includes(cp);
    });
  }

  const casos = matches.slice(0, n).map((c) => ({
    id: c.id,
    procedimiento: c.procedimiento,
    titulo: c.titulo,
    descripcion: c.descripcion,
    media_antes: c.media_antes,
    media_despues: c.media_despues,
    real: c.real,
  }));

  logWithDuration(
    log,
    'casos.search → completado',
    { procedimiento: proc, encontrados: casos.length, total_proc: matches.length },
    started
  );

  return { procedimiento: params.procedimiento, total: matches.length, casos };
}

// -------------------- EXPORTS MCP --------------------

export const name = 'casos';

export const actions = {
  async search({ params }) {
    const data = await searchCasos(params);
    return { ok: true, data };
  },
};
