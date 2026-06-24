import fs from 'fs';
import path from 'path';
import { createRequestLogger } from '../utils/logger.js';
const log = createRequestLogger({ tool: 'barbers', action: 'resolve' });


const BARBERS_JSON_PATH =
  process.env.BARBERS_JSON || path.join(process.cwd(), 'data', 'barbers.json');

/**
 * Carga y cachea el archivo barbers.json
 */
let barbersCache = null;

function loadBarbers() {
  if (barbersCache) return barbersCache;

  try {
    if (!fs.existsSync(BARBERS_JSON_PATH)) {
      log.error({ path: BARBERS_JSON_PATH }, 'BARBERS_JSON_NOT_FOUND');
      barbersCache = {};
      return barbersCache;
    }

    const raw = fs.readFileSync(BARBERS_JSON_PATH, 'utf8').trim();
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object') {
      log.error({}, 'BARBERS_JSON_INVALID');
      barbersCache = {};
      return barbersCache;
    }

    barbersCache = parsed;
  } catch (err) {
    log.error(
      {
        message: err.message,
        stack: err.stack,
      },
      'BARBERS_JSON_LOAD_ERROR'
    );
    barbersCache = {};
  }

  return barbersCache;
}

/**
 * Normaliza texto para comparación
 * (NO tocamos esta lógica)
 */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    // quita caracteres de reemplazo '�' que aparecen por problemas de encoding
    .replace(/\uFFFD/g, '')
    .normalize('NFD')          // separa letra + tilde
    .replace(/[\u0300-\u036f]/g, '') // quita tildes
    .replace(/\s+/g, ' ')      // colapsa espacios múltiples
    .trim();
}

/**
 * Distancia de Levenshtein simple para permitir 1 error
 * (NO tocamos esta lógica)
 */
function levenshtein(a, b) {
  const s = a || '';
  const t = b || '';
  const m = s.length;
  const n = t.length;

  if (m === 0) return n;
  if (n === 0) return m;

  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      if (s[i - 1] === t[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = Math.min(
          prev + 1,      // sustitución
          dp[j] + 1,     // borrado
          dp[j - 1] + 1  // inserción
        );
      }
      prev = temp;
    }
  }

  return dp[n];
}

/**
 * Comparación "suave": exacto, substring o distancia <= 1
 * (NO tocamos esta lógica)
 */
function looseMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  const dist = levenshtein(a, b);
  return dist <= 1;
}

/**
 * Resolver barbero:
 * - Si el nombre coincide con displayName → OK
 * - Si coincide con alias → OK
 * - Si coincide con llave técnica → ERROR BARBER_INTERNAL_ID_USED
 * - Si coincide con varios → ERROR BARBER_AMBIGUOUS
 * - Si no coincide con nada → ERROR BARBER_NOT_FOUND
 */
async function resolveBarber(params) {
  const name = params?.name;

  if (!name) {
    const resp = {
      ok: false,
      error: {
        code: 'BARBER_PARAM_MISSING',
        message: 'Debe proporcionar un nombre.',
      },
    };
    log.warn({ params }, 'BARBER_PARAM_MISSING');
    return resp;
  }

  const inputN = normalize(name);
  const barbers = loadBarbers();

  const matches = [];
  let internalIdMatch = null;

  for (const barberId of Object.keys(barbers)) {
    const cfg = barbers[barberId];

    const display = normalize(cfg.displayName);
    const aliases = Array.isArray(cfg.aliases)
      ? cfg.aliases.map((a) => normalize(a))
      : [];

    // 1) displayName coincide (exacto o casi igual)
    if (looseMatch(inputN, display)) {
      matches.push({ barber_id: barberId, displayName: cfg.displayName });
      continue;
    }

    // 2) alias coincide (exacto o casi igual)
    if (aliases.some((a) => looseMatch(inputN, a))) {
      matches.push({ barber_id: barberId, displayName: cfg.displayName });
      continue;
    }

    // 3) coincide con ID interno → error especial
    if (inputN === normalize(barberId)) {
      internalIdMatch = barberId;
    }
  }

  // ⚠ Si coincide con ID interno pero NO con nombre visible → error
  if (internalIdMatch && matches.length === 0) {
    const resp = {
      ok: false,
      error: {
        code: 'BARBER_INTERNAL_ID_USED',
        message: `El nombre "${name}" coincide con un identificador interno, no con un nombre visible.`,
        internal_id: internalIdMatch,
      },
    };
    log.warn({ name, internalIdMatch }, 'BARBER_INTERNAL_ID_USED');
    return resp;
  }

  // 0 coincidencias
  if (matches.length === 0) {
    const resp = {
      ok: false,
      error: {
        code: 'BARBER_NOT_FOUND',
        message: `No se encontró ningún barbero llamado "${name}".`,
      },
    };
    log.warn({ name }, 'BARBER_NOT_FOUND');
    return resp;
  }

  // Más de una coincidencia → ambiguo
  if (matches.length > 1) {
    const resp = {
      ok: false,
      error: {
        code: 'BARBER_AMBIGUOUS',
        message: `El nombre "${name}" coincide con varios barberos.`,
        options: matches,
      },
    };
    log.warn({ name, options: matches }, 'BARBER_AMBIGUOUS');
    return resp;
  }

  // Coincidencia única → OK
  const resp = {
    ok: true,
    data: matches[0],
  };

  log.info({ name, resolved: matches[0] }, 'BARBER_RESOLVED_OK');
  return resp;
}

export const name = 'barbers';

export const actions = {
  async resolve({ params }) {
    return await resolveBarber(params);
  },
};
