import { google } from 'googleapis';
import { DateTime } from 'luxon';
import path from 'path';
import fs from 'fs';
import crypto from 'node:crypto';

import cache from '../utils/cache.js';
import { pool } from '../db.js';
import { config } from '../config.js';
// Logger PRO
import { logger, createRequestLogger, timeAsync, logWithDuration } from '../utils/logger.js';


// -------------------- ENV --------------------
const TZ = process.env.TIMEZONE || 'America/Bogota';
const DEFAULT_DURATION_MIN = Number(process.env.DEFAULT_SLOT_MINUTES || 30);
const BARBERS_JSON_PATH = process.env.BARBERS_JSON || path.join(process.cwd(), 'data', 'barbers.json');
const BUSINESS_HOURS_JSON_PATH =
  process.env.BUSINESS_HOURS_JSON || path.join(process.cwd(), 'data', 'business_hours.json');

const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 120);


// -------------------- AUTH (Service Account) --------------------
function getAuthClient() {
  const keyfile = process.env.GOOGLE_SA_KEYFILE;
  const jsonInline = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const b64 = process.env.GOOGLE_SA_JSON_BASE64; // optional

  let credentials;

  try {
    if (keyfile && fs.existsSync(keyfile)) {
      credentials = JSON.parse(fs.readFileSync(keyfile, 'utf8'));
    } else if (jsonInline) {
      credentials = JSON.parse(jsonInline);
    } else if (b64) {
      credentials = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } else {
      const err = new Error('MISSING_GOOGLE_SA: Define GOOGLE_APPLICATION_CREDENTIALS_JSON or GOOGLE_SA_KEYFILE');
      err.code = 'MISSING_GOOGLE_SA';
      throw err;
    }
  } catch (err) {
    logger.error?.('GOOGLE_SA_PARSE_ERROR', { message: err.message });
    throw err;
  }

  if (!credentials || !credentials.client_email || !credentials.private_key) {
    const err = new Error('INVALID_GOOGLE_SA: missing client_email or private_key in credentials');
    err.code = 'INVALID_GOOGLE_SA';
    throw err;
  }

  const privateKey = credentials.private_key.replace(/\\n/g, '\n');

  return new google.auth.JWT({
    email: credentials.client_email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

// -------------------- HELPERS --------------------
function normalizeName(str) {
  if (!str) return '';
  return str
    .toString()
    .toLowerCase()
    .normalize('NFD')              // separa tildes
    .replace(/[\u0300-\u036f]/g, '') // quita tildes
    .replace(/\s+/g, ' ')         // colapsa espacios
    .trim();
}


function loadBarbersMap() {
  try {
    if (!fs.existsSync(BARBERS_JSON_PATH)) return {};
    const raw = fs.readFileSync(BARBERS_JSON_PATH, 'utf8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);

    const obj = {};

    // 1) Formato array [{ id/name, calendarId, aliases? }]
    if (Array.isArray(parsed)) {
      for (const it of parsed) {
        if (!it) continue;
        const calId = it.calendarId;
        if (!calId) continue;

        // id o name como clave técnica
        const idKey = normalizeName(it.id || it.name);
        if (idKey) obj[idKey] = calId;

        // aliases como claves adicionales
        if (Array.isArray(it.aliases)) {
          for (const alias of it.aliases) {
            const aKey = normalizeName(alias);
            if (aKey) obj[aKey] = calId;
          }
        }
      }
      return obj;
    }

    // 2) Formato objeto { barberId: { displayName, aliases, calendarId } }
    if (parsed && typeof parsed === 'object') {
      for (const key of Object.keys(parsed)) {
        const v = parsed[key];
        if (!v) continue;

        // Compat anterior: { "Carlos": "calId" }
        if (typeof v === 'string') {
          const idKey = normalizeName(key);
          if (idKey) obj[idKey] = v;
          continue;
        }

        if (typeof v === 'object') {
          const calId = v.calendarId;
          if (!calId) continue;

          // 2.1 ID interno (nova, atlas, etc.)
          const idKey = normalizeName(key);
          if (idKey) obj[idKey] = calId;

          // 2.2 displayName visible ("Carlos")
          if (v.displayName) {
            const dnKey = normalizeName(v.displayName);
            if (dnKey) obj[dnKey] = calId;
          }

          // 2.3 aliases ["carlos", "carlitos", "atlas"]
          if (Array.isArray(v.aliases)) {
            for (const alias of v.aliases) {
              const aKey = normalizeName(alias);
              if (aKey) obj[aKey] = calId;
            }
          }
        }
      }
      return obj;
    }

    return {};
  } catch (e) {
    logger.error?.('BARBERS_JSON_READ_ERROR', { message: e.message });
    return {};
  }
}



let businessHoursCache = null;

function loadBusinessHours() {
  if (businessHoursCache) return businessHoursCache;

  try {
    if (!fs.existsSync(BUSINESS_HOURS_JSON_PATH)) {
      businessHoursCache = {};
      return businessHoursCache;
    }

    const raw = fs.readFileSync(BUSINESS_HOURS_JSON_PATH, 'utf8').trim();
    if (!raw) {
      businessHoursCache = {};
      return businessHoursCache;
    }

    const parsed = JSON.parse(raw);
    businessHoursCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    logger.error?.('BUSINESS_HOURS_READ_ERROR', { message: e.message });
    businessHoursCache = {};
  }

  return businessHoursCache;
}

function normalizeBizConfig(cfg) {
  const dayMap = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };

  let days = [];

  if (Array.isArray(cfg.days)) {
    days = cfg.days
      .map((d) => dayMap[d] || Number(d) || null)
      .filter(Boolean);
  }

  if (!days.length) {
    days = (process.env.BUSINESS_DAYS || '1,2,3,4,5')
      .split(',')
      .map((d) => Number(d.trim()))
      .filter(Boolean);
  }

  return {
    days,
    start: cfg.start || process.env.BUSINESS_START || '08:00',
    end: cfg.end || process.env.BUSINESS_END || '20:00',
  };
}

function getBizFor(barber) {
  const map = loadBusinessHours();

  // 1) config específica por barbero
  if (barber && map && map[barber]) {
    return normalizeBizConfig(map[barber]);
  }

  // 2) config default del JSON
  if (map && map.default) {
    return normalizeBizConfig(map.default);
  }

  // 3) fallback por .env
  const days = (process.env.BUSINESS_DAYS || '1,2,3,4,5')
    .split(',')
    .map((d) => Number(d.trim()))
    .filter(Boolean);

  return {
    days,
    start: process.env.BUSINESS_START || '08:00',
    end: process.env.BUSINESS_END || '20:00',
  };
}


function parseHm(hm) {
  const [h, m] = String(hm || '').split(':').map(Number);
  return { h: h || 0, m: m || 0 };
}

function dayIsOpen(dt, daysArr) {
  // Luxon: Monday=1 ... Sunday=7
  return daysArr.includes(dt.weekday);
}

function buildDayWindow(dayDt, startHm, endHm) {
  const { h: sh, m: sm } = parseHm(startHm);
  const { h: eh, m: em } = parseHm(endHm);

  const start = dayDt.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  const end = dayDt.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  return { start, end };
}

function clipInterval(interval, L, R) {
  const s = interval.start < L ? L : interval.start;
  const e = interval.end > R ? R : interval.end;
  return s < e ? { start: s, end: e } : null;
}

function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = intervals.slice().sort((a, b) => a.start - b.start);
  const out = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      out.push(cur);
    }
  }
  return out;
}

function freeGaps(L, R, busy) {
  const merged = mergeIntervals(busy);
  const gaps = [];
  let cursor = L;

  for (const iv of merged) {
    if (iv.start > cursor) {
      gaps.push({ start: cursor, end: iv.start });
    }
    if (iv.end > cursor) {
      cursor = iv.end;
    }
  }
  if (cursor < R) {
    gaps.push({ start: cursor, end: R });
  }
  return gaps;
}

function ceilToStep(dt, stepMin) {
  const minute = dt.minute;
  const remainder = minute % stepMin;
  if (remainder === 0) {
    return dt.set({ second: 0, millisecond: 0 });
  }
  const delta = stepMin - remainder;
  return dt.plus({ minutes: delta }).set({ second: 0, millisecond: 0 });
}

function applyBuffer(busy, bufferMin) {
  if (!bufferMin) return busy;
  return busy.map((iv) => ({
    start: iv.start.minus({ minutes: bufferMin }),
    end: iv.end.plus({ minutes: bufferMin }),
  }));
}

function genSlotsBackToBack(gaps, durationMin, now) {
  const slots = [];
  const step = durationMin;

  for (const g of gaps) {
    let start = g.start;

    // Excluir pasado si el gap es del mismo día
    if (now.hasSame(g.start, 'day') && start < now) {
      start = now;
    }

    // Alinear a la rejilla
    start = ceilToStep(start, step);

    while (start.plus({ minutes: step }) <= g.end) {
      const end = start.plus({ minutes: step });
      slots.push({ start, end });
      start = end; // back-to-back
    }
  }

  return slots;
}


function resolveCalendarId(params) {
  const { calendarId, barber } = params || {};
  if (calendarId) return calendarId;

  if (barber) {
    const map = loadBarbersMap();
    const key = normalizeName(barber);

    if (!key || !map[key]) {
      const err = new Error(`BARBER_NOT_FOUND: ${barber}`);
      err.code = 'BARBER_NOT_FOUND';
      throw err;
    }

    return map[key];
  }

  const err = new Error('MISSING_CALENDAR: se requiere calendarId o barber');
  err.code = 'MISSING_CALENDAR';
  throw err;
}

function buildWhenISO({ when, date, time }) {
  // Si ya viene un ISO completo → lo usamos tal cual
  if (when) return when;

  // Si vienen date + time → construimos el ISO en zona Bogotá
  if (date && time) {
    const [hStr, mStr] = String(time).split(':');
    const hour = Number(hStr) || 0;
    const minute = Number(mStr) || 0;

    const base = DateTime.fromISO(date, { zone: TZ });
    if (!base.isValid) {
      const err = new Error(`INVALID_WHEN: fecha inválida ${date}`);
      err.code = 'INVALID_WHEN';
      throw err;
    }

    const dt = base.set({ hour, minute, second: 0, millisecond: 0 });
    if (!dt.isValid) {
      const err = new Error(`INVALID_WHEN: combinación inválida date+time (${date} ${time})`);
      err.code = 'INVALID_WHEN';
      throw err;
    }

    // Devolvemos ISO con offset correcto de la zona (America/Bogota)
    return dt.toISO({ suppressMilliseconds: true });
  }

  const err = new Error('INVALID_WHEN: se requiere when o (date + time)');
  err.code = 'INVALID_WHEN';
  throw err;
}


function ensureFuture(whenISO) {
  const now = DateTime.now().setZone(TZ);
  const dt = DateTime.fromISO(whenISO, { zone: TZ });
  if (!dt.isValid) {
    const err = new Error(`INVALID_WHEN: ${whenISO}`);
    err.code = 'INVALID_WHEN';
    throw err;
  }
  if (dt <= now) {
    const err = new Error('IN_PAST');
    err.code = 'IN_PAST';
    throw err;
  }
  return dt;
}

function toRFC3339(dt) {
  return dt.setZone(TZ).toISO({ suppressMilliseconds: true });
}

async function withIdempotency(key, fn) {
  const cached = await Promise.resolve(cache.get(key));
  if (cached) return cached;
  const result = await fn();
  // cache.set expects TTL in seconds in our adapter
  await Promise.resolve(cache.set(key, result, 24 * 60 * 60)); // 24h in seconds
  return result;
}

// -------------------- CORE OPS --------------------
export async function createEvent(params) {
  const log = createRequestLogger({
    tool: 'calendar',
    action: 'create',
    barber: params?.barber,
  });

  const startLog = Date.now();
  log.info({ params }, 'calendar.create → inicio');

  const {
    when,       // ISO completo (opcional)
    date,       // YYYY-MM-DD (opcional)
    time,       // HH:MM (opcional)
    who,
    notes = '',
    duration,
    barber,
    phone,      // NUEVO
    clientId,   // NUEVO
    calendarId: explicitCalId,
    client_request_id,
  } = params || {};


  if (!who) throw new Error('Missing param: who');

  // Construimos un ISO robusto a partir de when o (date+time)
  const whenISO = buildWhenISO({ when, date, time });

  const calId = resolveCalendarId({ calendarId: explicitCalId, barber });
  log.info({ calId, whenISO }, 'calendar.create → usando calendarId y whenISO');

  const durMin = Number.isFinite(Number(duration)) ? Number(duration) : DEFAULT_DURATION_MIN;

  // Validamos que esté en el futuro
  const startDT = ensureFuture(whenISO);

  const endDT = startDT.plus({ minutes: durMin });
  const summary = `Cita con ${who}`;

  // Descripción enriquecida para booking.search
  const descriptionParts = [];
  if (phone) descriptionParts.push(`Tel: ${phone}`);
  if (clientId) descriptionParts.push(`ID: ${clientId}`);
  if (notes) descriptionParts.push(`Notas: ${notes}`);

  const description = descriptionParts.join('\n');


  // --- INICIO DEL REEMPLAZO ---
  const exec = async () => {
    // 1. INSTANCIAR CLIENTE (Lo sacamos del timeAsync para usarlo en la verificación previa)
    const auth = getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

    // 2. VERIFICAR CONFLICTOS (Lógica NUEVA de seguridad)
    // Consultamos a Google si ya existen eventos en ese rango exacto de tiempo
    const conflictRes = await calendar.events.list({
      calendarId: calId,
      timeMin: toRFC3339(startDT),
      timeMax: toRFC3339(endDT),
      singleEvents: true,
      timeZone: TZ
    });

    // Filtramos los eventos que realmente chocan (superposición estricta)
    const conflicts = (conflictRes.data.items || []).filter(ev => {
      // Si el evento es "transparente" (marcado como disponible), no bloquea.
      if (ev.transparency === 'transparent') return false;
      
      const s = DateTime.fromISO(ev.start.dateTime || ev.start.date, { zone: TZ });
      const e = DateTime.fromISO(ev.end.dateTime || ev.end.date, { zone: TZ });
      
      // Fórmula matemática de superposición: (InicioNuevo < FinExistente) Y (FinNuevo > InicioExistente)
      return (startDT < e) && (endDT > s);
    });

    // Si encontramos al menos un conflicto, lanzamos ERROR y detenemos todo.
    if (conflicts.length > 0) {
      const err = new Error('SLOT_OCCUPIED: El horario seleccionado ya está ocupado.');
      err.code = 'SLOT_OCCUPIED';
      throw err;
    }

    // 3. INSERTAR EL EVENTO (Solo si pasamos la verificación anterior)
    return await timeAsync(log, 'Google Calendar → insert event', async () => {
      const res = await calendar.events.insert({
        calendarId: calId,
        requestBody: {
          summary,
          description,
          start: { dateTime: toRFC3339(startDT), timeZone: TZ },
          end: { dateTime: toRFC3339(endDT), timeZone: TZ },
        },
      });

      const ev = res.data || {};
      return {
        id: ev.id,
        when: toRFC3339(startDT),
        start: ev.start?.dateTime || toRFC3339(startDT),
        end: ev.end?.dateTime || toRFC3339(endDT),
        who,
        notes: description,
      };
    });
  };
  // --- FIN DEL REEMPLAZO ---

  try {
    const result = client_request_id
      ? await withIdempotency(`calendar:create:${client_request_id}`, exec)
      : await exec();

    logWithDuration(log, 'calendar.create → completado', { id: result.id }, startLog);
    return result;
  } catch (e) {
    log.error(
      {
        err: { message: e.message, code: e.code },
        calId,
        params,
      },
      'calendar.create → ERROR'
    );
    throw e;
  }
}


export async function cancelEvent(params) {
  const log = createRequestLogger({
    tool: 'calendar',
    action: 'cancel',
    barber: params?.barber,
  });

  const startLog = Date.now();
  log.info({ params }, 'calendar.cancel → inicio');

  const { eventId, calendarId: explicitCalId, barber } = params || {};
  if (!eventId) throw new Error('Missing param: eventId');

  const calId = resolveCalendarId({ calendarId: explicitCalId, barber });

  try {
    await timeAsync(log, 'Google Calendar → delete event', async () => {
      const auth = getAuthClient();
      const calendar = google.calendar({ version: 'v3', auth });

      await calendar.events.delete({ calendarId: calId, eventId });
    });

    logWithDuration(log, 'calendar.cancel → completado', { eventId }, startLog);
    return { id: eventId, cancelled: true };
  } catch (e) {
    const status = e?.response?.status || e?.statusCode || e?.code;

    log.error(
      {
        err: { message: e.message, code: e.code, status },
        calId,
        eventId,
      },
      'calendar.cancel → ERROR'
    );

    if (status === 404) throw Object.assign(new Error('EVENT_NOT_FOUND'), { code: 'EVENT_NOT_FOUND' });
    if (status === 403)
      throw Object.assign(
        new Error('GOOGLE_403_FORBIDDEN: la SA no tiene permiso.'),
        { code: 'GOOGLE_403_FORBIDDEN' }
      );

    throw e;
  }
}


// --- REEMPLAZA TU FUNCIÓN checkAvailability ACTUAL POR ESTA ---

export async function checkAvailability(params) {
  const log = createRequestLogger({
    tool: 'calendar',
    action: 'check',
    barber: params?.barber,
  });

  const startLog = Date.now();
  log.info({ params }, 'calendar.check → inicio');

  // ACEPTAMOS: from+to (ISO) O date (YYYY-MM-DD)
  let { from, to, date, duration, buffer = 0, barber, calendarId: explicitCalId } = params || {};

  // LÓGICA NUEVA: Si envían "date" simple, calculamos el rango del día completo
  if (date && !from && !to) {
     const dt = DateTime.fromISO(date, { zone: TZ });
     if (dt.isValid) {
       from = dt.startOf('day').toISO();
       to = dt.endOf('day').toISO();
     }
  }

  // Validación de rango
  if (!from || !to) {
    const err = new Error('INVALID_RANGE: Se requiere (from, to) O (date)');
    err.code = 'INVALID_RANGE';
    log.error({ err: { message: err.message, code: err.code } }, 'calendar.check → rango faltante');
    throw err;
  }

  const fromDT = DateTime.fromISO(from, { zone: TZ });
  const toDT = DateTime.fromISO(to, { zone: TZ });

  if (!fromDT.isValid || !toDT.isValid || toDT <= fromDT) {
    const err = new Error('INVALID_RANGE: rango inválido');
    err.code = 'INVALID_RANGE';
    throw err;
  }

  const durMin = Number.isFinite(Number(duration)) ? Number(duration) : DEFAULT_DURATION_MIN;
  const bufferMin = Number(buffer) || 0;
  const calId = resolveCalendarId({ calendarId: explicitCalId, barber });
  
  // Cache logic
  const cacheKey = ['calendar.check', calId, fromDT.toISO(), toDT.toISO(), durMin, bufferMin, barber || 'none'].join('|');
  const cached = await Promise.resolve(cache.get(cacheKey));
  if (cached) return cached;

  const auth = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const eventsRes = await calendar.events.list({
    calendarId: calId,
    timeMin: fromDT.toISO(),
    timeMax: toDT.toISO(),
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: TZ,
  });

  const items = eventsRes.data.items || [];
  const busy = items.map((ev) => {
      const s = ev.start?.dateTime || ev.start?.date;
      const e = ev.end?.dateTime || ev.end?.date;
      if (!s || !e) return null;
      return { start: DateTime.fromISO(s, { zone: TZ }), end: DateTime.fromISO(e, { zone: TZ }) };
    }).filter(Boolean);

  const bizCfg = getBizFor(barber);
  const daysArr = bizCfg.days || [1, 2, 3, 4, 5];
  const startHm = bizCfg.start || '08:00';
  const endHm = bizCfg.end || '20:00';
  const now = DateTime.now().setZone(TZ);
  const slots = [];

  let cursor = fromDT.startOf('day');
  const lastDay = toDT.startOf('day');

  while (cursor <= lastDay) {
    if (!dayIsOpen(cursor, daysArr)) { cursor = cursor.plus({ days: 1 }); continue; }
    const { start: dayStart, end: dayEnd } = buildDayWindow(cursor, startHm, endHm);
    // Recorte al rango solicitado
    const dayL = fromDT > dayStart ? fromDT : dayStart;
    const dayR = toDT < dayEnd ? toDT : dayEnd;

    if (dayL >= dayR) { cursor = cursor.plus({ days: 1 }); continue; }

    const dayBusyRaw = busy.map((iv) => clipInterval(iv, dayL, dayR)).filter(Boolean);
    const dayBusy = applyBuffer(dayBusyRaw, bufferMin);
    const gaps = freeGaps(dayL, dayR, dayBusy);
    const daySlots = genSlotsBackToBack(gaps, durMin, now);

    for (const s of daySlots) {
      slots.push({ start: toRFC3339(s.start), end: toRFC3339(s.end) });
    }
    cursor = cursor.plus({ days: 1 });
  }

  const result = {
    slots,
    generated_with: {
      duration: durMin, buffer: bufferMin, tz: TZ,
      business_hours: { days: bizCfg.days, start: startHm, end: endHm },
    },
  };

  await Promise.resolve(cache.set(cacheKey, result, CACHE_TTL_SECONDS));
  logWithDuration(log, 'calendar.check → completado', { slots: result.slots.length }, startLog);
  return result;
}

// -------------------- GUARDED ACTION INTENTS --------------------
// Las acciones externas se preparan en un turno y solo quedan listas cuando
// llega OTRO mensaje del paciente con confirmación explícita. El commit lo
// ejecuta n8n después de que el panel humano aprueba la acción.
function normalizedText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isExplicitConfirmation(value) {
  const text = normalizedText(value);
  if (!text || /\b(no|cambia|cambiar|otro|otra|mejor|espera|despues|cancelar esa)\b/.test(text)) return false;
  return /\b(si|confirmo|confirmado|de acuerdo|correcto|dale|listo|agendala|agenda|cancela|cancelala)\b/.test(text);
}

function canonicalPayload(kind, params) {
  if (kind === 'create') {
    const required = ['date', 'time', 'who', 'phone', 'barber'];
    for (const key of required) if (!params?.[key]) throw Object.assign(new Error(`Missing param: ${key}`), { code: 'INVALID_INTENT' });
    return {
      date: String(params.date), time: String(params.time), who: String(params.who),
      phone: String(params.phone), barber: String(params.barber),
      duration: Number(params.duration || 45),
    };
  }
  if (!params?.eventId || !params?.barber) throw Object.assign(new Error('Missing eventId/barber'), { code: 'INVALID_INTENT' });
  return { eventId: String(params.eventId), barber: String(params.barber), phone: String(params.phone || '') };
}

function samePayload(a, b) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
  };
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

async function prepareIntent(params) {
  const kind = params?.kind;
  if (!['create', 'cancel'].includes(kind)) throw Object.assign(new Error('kind must be create or cancel'), { code: 'INVALID_INTENT' });
  const conversationId = String(params.conversation_id || '');
  const sourceMessageId = String(params.source_message_id || '');
  if (!conversationId || !sourceMessageId) throw Object.assign(new Error('conversation_id and source_message_id are required'), { code: 'INVALID_INTENT' });
  const payload = canonicalPayload(kind, params);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE booking_action_intents SET status='expired', updated_at=now()
       WHERE conversation_id=$1 AND kind=$2 AND status IN ('awaiting_patient','ready_for_review') AND expires_at <= now()`,
      [conversationId, kind],
    );
    const currentResult = await client.query(
      `SELECT * FROM booking_action_intents
       WHERE conversation_id=$1 AND kind=$2 AND status IN ('awaiting_patient','ready_for_review','committing')
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [conversationId, kind],
    );
    const current = currentResult.rows[0];
    if (current && current.status === 'committing') {
      await client.query('COMMIT');
      return { state: 'committing', intent_id: current.id, kind, summary: current.payload };
    }
    if (current && samePayload(current.payload, payload)
        && current.source_message_id !== sourceMessageId
        && isExplicitConfirmation(params.user_text)) {
      const ready = await client.query(
        `UPDATE booking_action_intents
         SET status='ready_for_review', confirmed_message_id=$2, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [current.id, sourceMessageId],
      );
      await client.query('COMMIT');
      return { state: 'ready_for_review', intent_id: ready.rows[0].id, kind, summary: ready.rows[0].payload };
    }
    if (current) {
      await client.query(
        `UPDATE booking_action_intents SET status='cancelled', updated_at=now()
         WHERE id=$1`,
        [current.id],
      );
    }
    const id = crypto.randomUUID();
    const inserted = await client.query(
      `INSERT INTO booking_action_intents
       (id,conversation_id,kind,payload,source_message_id,status,expires_at)
       VALUES ($1,$2,$3,$4,$5,'awaiting_patient',now()+($6||' hours')::interval)
       RETURNING *`,
      [id, conversationId, kind, payload, sourceMessageId, String(config.actionIntentTtlHours)],
    );
    await client.query('COMMIT');
    return { state: 'confirmation_required', intent_id: id, kind, summary: inserted.rows[0].payload };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function updateIntent(id, fields) {
  const keys = Object.keys(fields);
  const values = keys.map((key) => fields[key]);
  const set = keys.map((key, index) => `${key}=$${index + 2}`).join(', ');
  await pool.query(`UPDATE booking_action_intents SET ${set}, updated_at=now() WHERE id=$1`, [id, ...values]);
}

async function commitIntent(params) {
  const id = String(params?.intent_id || '');
  if (!id || !params?.review_id || !params?.reviewer) throw Object.assign(new Error('intent_id, review_id and reviewer are required'), { code: 'INVALID_INTENT' });
  const client = await pool.connect();
  let intent;
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM booking_action_intents WHERE id=$1 FOR UPDATE', [id]);
    intent = result.rows[0];
    if (!intent) { await client.query('ROLLBACK'); return { state: 'intent_not_found', intent_id: id }; }
    if (intent.status === 'completed') { await client.query('COMMIT'); return { state: 'already_completed', intent_id: id, event_id: intent.event_id }; }
    if (intent.expires_at <= new Date()) {
      await client.query("UPDATE booking_action_intents SET status='expired',updated_at=now() WHERE id=$1", [id]);
      await client.query('COMMIT');
      return { state: 'intent_expired', intent_id: id };
    }
    if (intent.status !== 'ready_for_review') { await client.query('COMMIT'); return { state: intent.status, intent_id: id }; }
    await client.query(
      `UPDATE booking_action_intents SET status='committing',review_id=$2,reviewer=$3,updated_at=now() WHERE id=$1`,
      [id, String(params.review_id), String(params.reviewer)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  try {
    const result = intent.kind === 'create'
      ? await createEvent({ ...intent.payload, client_request_id: id })
      : await cancelEvent(intent.payload);
    const eventId = result?.id || intent.payload.eventId || null;
    await updateIntent(id, { status: 'completed', event_id: eventId, last_error: null });
    return { state: 'completed', intent_id: id, kind: intent.kind, event_id: eventId, data: result };
  } catch (error) {
    if (error?.code === 'SLOT_OCCUPIED') {
      await updateIntent(id, { status: 'failed', last_error: 'SLOT_OCCUPIED' });
      return { state: 'slot_occupied', intent_id: id, kind: intent.kind };
    }
    if (error?.code === 'EVENT_NOT_FOUND') {
      await updateIntent(id, { status: 'failed', last_error: 'EVENT_NOT_FOUND' });
      return { state: 'event_not_found', intent_id: id, kind: intent.kind };
    }
    await updateIntent(id, { status: 'failed', last_error: String(error?.code || error?.message || 'ERROR') });
    throw error;
  }
}



// -------------------- DISPATCHER --------------------
export const name = 'calendar';
export const actions = {
  async prepare({ params }) {
    const data = await prepareIntent(params);
    return { ok: true, data };
  },
  async commit({ params }) {
    const data = await commitIntent(params);
    return { ok: true, data };
  },
  async create({ params }) {
    const data = await createEvent(params);
    return { ok: true, data };
  },
  async cancel({ params }) {
    const data = await cancelEvent(params);
    return { ok: true, data };
  },
  async check({ params }) {
    const data = await checkAvailability(params);
    return { ok: true, data };
  },
};
