// src/tools/booking.js
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { logger, createRequestLogger, logWithDuration } from '../utils/logger.js';
import * as barbersTool from './barbers.js';

const TZ = process.env.TIMEZONE || 'America/Bogota';
const BARBERS_JSON_PATH =
  process.env.BARBERS_JSON || path.join(process.cwd(), 'data', 'barbers.json');

// ---------- Helpers compartidos con calendar ----------

function getAuthClient() {
  const keyfile = process.env.GOOGLE_SA_KEYFILE;
  const jsonInline = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const b64 = process.env.GOOGLE_SA_JSON_BASE64; // opcional

  let credentials;

  try {
    if (keyfile && fs.existsSync(keyfile)) {
      credentials = JSON.parse(fs.readFileSync(keyfile, 'utf8'));
    } else if (jsonInline) {
      credentials = JSON.parse(jsonInline);
    } else if (b64) {
      credentials = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } else {
      const err = new Error(
        'MISSING_GOOGLE_SA: Define GOOGLE_APPLICATION_CREDENTIALS_JSON o GOOGLE_SA_KEYFILE'
      );
      err.code = 'MISSING_GOOGLE_SA';
      throw err;
    }
  } catch (err) {
    logger.error?.('BOOKING_GOOGLE_SA_PARSE_ERROR', { message: err.message });
    throw err;
  }

  if (!credentials || !credentials.client_email || !credentials.private_key) {
    const err = new Error(
      'INVALID_GOOGLE_SA: missing client_email or private_key in credentials'
    );
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

let barbersConfigCache = null;

function loadBarbersConfig() {
  if (barbersConfigCache) return barbersConfigCache;
  try {
    if (!fs.existsSync(BARBERS_JSON_PATH)) {
      barbersConfigCache = {};
      return barbersConfigCache;
    }
    const raw = fs.readFileSync(BARBERS_JSON_PATH, 'utf8').trim();
    if (!raw) {
      barbersConfigCache = {};
      return barbersConfigCache;
    }
    const parsed = JSON.parse(raw);
    barbersConfigCache =
      parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    logger.error?.('BOOKING_BARBERS_JSON_READ_ERROR', { message: e.message });
    barbersConfigCache = {};
  }
  return barbersConfigCache;
}

function normalizePhone(str) {
  // dejamos solo dígitos y '+'
  return String(str || '').replace(/[^\d+]/g, '');
}

// ---------- Core booking.search ----------

async function searchBookings(params = {}) {
  const log = createRequestLogger({ tool: 'booking', action: 'search' });
  const start = Date.now();

  const {
    phone,
    clientId,
    from,
    to,
    barber,
    calendarId: explicitCalId,
  } = params;

  if (!phone && !clientId) {
    const err = new Error('Debe enviar al menos phone o clientId');
    err.code = 'IDENTIFIER_REQUIRED';
    log.error(
      { err: { message: err.message, code: err.code } },
      'booking.search → identificador faltante'
    );
    throw err;
  }

  // Rango de fechas: por defecto -30d a +30d
  const now = DateTime.now().setZone(TZ);
  let fromDT = from
    ? DateTime.fromISO(from, { zone: TZ })
    : now.minus({ days: 30 });
  let toDT = to
    ? DateTime.fromISO(to, { zone: TZ })
    : now.plus({ days: 30 });

  if (!fromDT.isValid || !toDT.isValid || toDT <= fromDT) {
    const err = new Error('INVALID_RANGE: rango de fechas inválido');
    err.code = 'INVALID_RANGE';
    log.error(
      {
        err: { message: err.message, code: err.code },
        from,
        to,
      },
      'booking.search → rango inválido'
    );
    throw err;
  }

  // --------- Determinar calendarios a consultar ---------
  const barbersCfg = loadBarbersConfig();
  const calendars = [];

  if (explicitCalId) {
    calendars.push({
      calendarId: explicitCalId,
      barberLabel: barber || explicitCalId,
    });
  } else if (barber) {
    // Resolver nombre de barbero → barber_id
    const resolved = await barbersTool.actions.resolve({
      params: { name: barber },
    });

    if (!resolved.ok) {
      const err = new Error(
        resolved.error?.message || 'BARBER_NOT_FOUND'
      );
      err.code = resolved.error?.code || 'BARBER_NOT_FOUND';
      log.error(
        { err: { message: err.message, code: err.code }, barber },
        'booking.search → error resolviendo barbero'
      );
      throw err;
    }

    const barberId = resolved.data.barber_id;
    const cfg = barbersCfg[barberId];

    if (!cfg || !cfg.calendarId) {
      const err = new Error(`MISSING_CALENDAR para barbero ${barberId}`);
      err.code = 'MISSING_CALENDAR';
      log.error(
        { err: { message: err.message, code: err.code }, barberId },
        'booking.search → barbero sin calendarId'
      );
      throw err;
    }

    calendars.push({
      calendarId: cfg.calendarId,
      barberLabel: cfg.displayName || barber,
      barberId,
    });
  } else {
    // Sin barber → todos los barberos configurados
    for (const [barberId, cfg] of Object.entries(barbersCfg)) {
      if (!cfg || !cfg.calendarId) continue;
      calendars.push({
        calendarId: cfg.calendarId,
        barberLabel: cfg.displayName || barberId,
        barberId,
      });
    }
  }

  if (!calendars.length) {
    const err = new Error('MISSING_CALENDAR');
    err.code = 'MISSING_CALENDAR';
    log.error(
      { err: { message: err.message, code: err.code } },
      'booking.search → sin calendarios'
    );
    throw err;
  }

  const auth = getAuthClient();
  const calendarApi = google.calendar({ version: 'v3', auth });

  const phoneNorm = phone ? normalizePhone(phone) : null;
  const clientNorm = clientId
    ? String(clientId).trim().toLowerCase()
    : null;

  const eventsOut = [];

  for (const cal of calendars) {
    const res = await calendarApi.events.list({
      calendarId: cal.calendarId,
      timeMin: fromDT.toISO(),
      timeMax: toDT.toISO(),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: TZ,
    });

    const items = res.data.items || [];

    for (const ev of items) {
      const startStr = ev.start?.dateTime || ev.start?.date;
      const endStr = ev.end?.dateTime || ev.end?.date;
      if (!startStr || !endStr) continue;

      const location = ev.location || '';
      const description = ev.description || '';
      const summary = ev.summary || '';

      const locNorm = normalizePhone(location);
      const descNorm = description.toLowerCase();

      let matches = false;

      if (phoneNorm) {
        if (locNorm && locNorm.includes(phoneNorm)) {
          matches = true;
        } else if (descNorm.includes(phoneNorm.toLowerCase())) {
          matches = true;
        }
      }

      if (!matches && clientNorm) {
        if (locNorm && locNorm.includes(clientNorm)) {
          matches = true;
        } else if (descNorm.includes(clientNorm)) {
          matches = true;
        }
      }

      if (!matches) continue;

      eventsOut.push({
        id: ev.id,
        start: DateTime.fromISO(startStr, { zone: TZ }).toISO(),
        end: DateTime.fromISO(endStr, { zone: TZ }).toISO(),
        barber: cal.barberLabel,
        who: summary || description || '',
        notes: description || '',
      });
    }
  }

  eventsOut.sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : 0
  );

  logWithDuration(
    log,
    'booking.search → completado',
    { events: eventsOut.length },
    start
  );

  return { events: eventsOut };
}

// -------------------- EXPORTS MCP --------------------

export const name = 'booking';

export const actions = {
  async search({ params }) {
    const data = await searchBookings(params);
    return { ok: true, data };
  },
};
