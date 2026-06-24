// src/tools/catalog.js
// PARCHE mcp-cirujanos: el catálogo YA NO está hardcodeado.
// Se externaliza a un archivo JSON vía env CATALOG_JSON (fallback ./data/catalog.json).
// Así cada doctor/consultorio define su tienda+servicios sin tocar código (multi-tenant).
import fs from 'fs';
import path from 'path';
import { createRequestLogger, logWithDuration } from '../utils/logger.js';

const BARBERS_JSON_PATH =
  process.env.BARBERS_JSON || path.join(process.cwd(), 'data', 'barbers.json');

const CATALOG_JSON_PATH =
  process.env.CATALOG_JSON || path.join(process.cwd(), 'data', 'catalog.json');

// Cache en memoria
let barbersCache = null;
let catalogCache = null;

function loadBarbersForCatalog() {
  if (barbersCache) return barbersCache;

  const log = createRequestLogger({ tool: 'catalog', action: 'loadBarbers' });

  try {
    if (!fs.existsSync(BARBERS_JSON_PATH)) {
      log.warn({ path: BARBERS_JSON_PATH }, 'BARBERS_JSON_NOT_FOUND_FOR_CATALOG');
      barbersCache = {};
      return barbersCache;
    }

    const raw = fs.readFileSync(BARBERS_JSON_PATH, 'utf8').trim();
    if (!raw) {
      log.warn({ path: BARBERS_JSON_PATH }, 'BARBERS_JSON_EMPTY_FOR_CATALOG');
      barbersCache = {};
      return barbersCache;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      log.error({ path: BARBERS_JSON_PATH }, 'BARBERS_JSON_INVALID_FOR_CATALOG');
      barbersCache = {};
      return barbersCache;
    }

    barbersCache = parsed;
  } catch (err) {
    log.error(
      { err: { message: err.message, stack: err.stack }, path: BARBERS_JSON_PATH },
      'BARBERS_JSON_LOAD_ERROR_FOR_CATALOG'
    );
    barbersCache = {};
  }

  return barbersCache;
}

/**
 * Carga la "tienda" (consultorio) desde CATALOG_JSON.
 * Estructura esperada (ver config/mcp/catalog.json):
 *   { id, nombre, ciudad, descripcion_corta, ubicacion, politica_citas,
 *     medios_pago, descuento, servicios:[{id,nombre,duracion_min,precio,moneda,descripcion}],
 *     procedimientos:[ ... ] }
 */
function loadCatalog() {
  if (catalogCache) return catalogCache;

  const log = createRequestLogger({ tool: 'catalog', action: 'loadCatalog' });

  try {
    if (!fs.existsSync(CATALOG_JSON_PATH)) {
      log.error({ path: CATALOG_JSON_PATH }, 'CATALOG_JSON_NOT_FOUND');
      const err = new Error(`CATALOG_JSON_NOT_FOUND: ${CATALOG_JSON_PATH}`);
      err.code = 'CATALOG_NOT_FOUND';
      throw err;
    }

    const raw = fs.readFileSync(CATALOG_JSON_PATH, 'utf8').trim();
    if (!raw) {
      const err = new Error(`CATALOG_JSON_EMPTY: ${CATALOG_JSON_PATH}`);
      err.code = 'CATALOG_NOT_FOUND';
      throw err;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      const err = new Error(`CATALOG_JSON_INVALID: ${CATALOG_JSON_PATH}`);
      err.code = 'CATALOG_NOT_FOUND';
      throw err;
    }

    // Defaults defensivos para no romper la respuesta si falta algo
    catalogCache = {
      id: parsed.id || 'clinic-001',
      nombre: parsed.nombre || 'Consultorio',
      ciudad: parsed.ciudad || '',
      descripcion_corta: parsed.descripcion_corta || '',
      ubicacion: parsed.ubicacion || {},
      politica_citas: parsed.politica_citas || '',
      medios_pago: Array.isArray(parsed.medios_pago) ? parsed.medios_pago : [],
      descuento: parsed.descuento || '',
      servicios: Array.isArray(parsed.servicios) ? parsed.servicios : [],
      procedimientos: Array.isArray(parsed.procedimientos) ? parsed.procedimientos : [],
    };
  } catch (err) {
    log.error(
      { err: { message: err.message, code: err.code }, path: CATALOG_JSON_PATH },
      'CATALOG_JSON_LOAD_ERROR'
    );
    throw err;
  }

  return catalogCache;
}

function normalize(str = '') {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Construye el consultorio con la lista de médicos reales del barbers.json (doctors.json)
 */
function buildFullShop() {
  const base = loadCatalog();
  const barbersCfg = loadBarbersForCatalog();
  const barberos = [];

  let idx = 1;
  for (const [barberId, cfg] of Object.entries(barbersCfg)) {
    // Ignora claves de documentación (_doc, _nota, …) y entradas inválidas.
    if (barberId.startsWith('_') || !cfg || typeof cfg !== 'object' || !cfg.displayName) continue;
    barberos.push({
      id: idx,
      barber_id: barberId, // dr_fredy, etc.
      nombre: cfg.displayName,
      aliases: cfg.aliases || [],
      especialidades: cfg.especialidades || [],
      bio: cfg.bio || '',
    });
    idx++;
  }

  return { ...base, barberos };
}

// -------------------- ACTIONS --------------------

async function catalogSearch(params = {}) {
  const log = createRequestLogger({ tool: 'catalog', action: 'search' });
  const started = Date.now();

  const query = normalize(params.query || '');
  const shop = buildFullShop();

  const nombresServicios = shop.servicios.map((s) => s.nombre);
  const nombresBarberos = shop.barberos.map((b) => b.nombre);

  // match: si no hay query, devuelve todo; si hay, busca en nombre/ciudad/servicios/médicos/procedimientos
  let match = true;
  if (query) {
    const nombre = normalize(shop.nombre);
    const ciudad = normalize(shop.ciudad);
    const serviciosStr = normalize(nombresServicios.join(' '));
    const barberosStr = normalize(nombresBarberos.join(' '));
    const procsStr = normalize((shop.procedimientos || []).join(' '));

    match =
      nombre.includes(query) ||
      ciudad.includes(query) ||
      serviciosStr.includes(query) ||
      barberosStr.includes(query) ||
      procsStr.includes(query);
  }

  const servicios_detalle = shop.servicios.map((s) => ({
    id: s.id,
    nombre: s.nombre,
    precio: s.precio,
    moneda: s.moneda || 'COP',
    duracion_min: s.duracion_min,
    descripcion: s.descripcion || '',
  }));

  const barberos_detalle = shop.barberos.map((b) => ({
    barber_id: b.barber_id,
    nombre: b.nombre,
    aliases: b.aliases || [],
    especialidades: b.especialidades || [],
    bio: b.bio || '',
  }));

  const results = match
    ? [
        {
          id: shop.id,
          nombre: shop.nombre,
          ciudad: shop.ciudad,
          descripcion_corta: shop.descripcion_corta,
          ubicacion: shop.ubicacion,
          politica_citas: shop.politica_citas,
          medios_pago: shop.medios_pago,
          descuento: shop.descuento,

          // compat (lista de nombres)
          servicios: nombresServicios,
          barberos: nombresBarberos,
          procedimientos: shop.procedimientos,

          // detalle
          servicios_detalle,
          barberos_detalle,
        },
      ]
    : [];

  logWithDuration(log, 'catalog.search → completado', { query, results: results.length }, started);
  return { results };
}

async function catalogGet(params = {}) {
  const log = createRequestLogger({ tool: 'catalog', action: 'get' });
  const started = Date.now();

  const id = String(params.id || '').trim();
  if (!id) {
    const err = new Error('CATALOG_ID_REQUIRED');
    err.code = 'CATALOG_ID_REQUIRED';
    log.error({ err: { message: err.message, code: err.code } }, 'catalog.get → id faltante');
    throw err;
  }

  const shop = buildFullShop();

  if (id !== shop.id) {
    const err = new Error(`CATALOG_NOT_FOUND: ${id}`);
    err.code = 'CATALOG_NOT_FOUND';
    log.error({ err: { message: err.message, code: err.code }, id }, 'catalog.get → no encontrado');
    throw err;
  }

  logWithDuration(log, 'catalog.get → completado', { id }, started);
  return { item: shop };
}

// -------------------- EXPORTS MCP --------------------

export const name = 'catalog';

export const actions = {
  async search({ params }) {
    const data = await catalogSearch(params);
    return { ok: true, data };
  },
  async get({ params }) {
    const data = await catalogGet(params);
    return { ok: true, data };
  },
};
