import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
dotenv.config();

function loadJSON(p) {
  const full = path.resolve(p);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  apiKey: process.env.API_KEY || '',
  tz: process.env.TIMEZONE || 'America/Bogota',
  cacheTtlSec: Number(process.env.CACHE_TTL_SECONDS || 120),
  ratePerMin: Number(process.env.RATE_LIMIT_PER_MINUTE || 60),
  // NOTA: por compat con el código heredado el env sigue llamándose BARBERS_JSON,
  // pero apunta a doctors.json (cada "barbero" = un médico con su Google Calendar).
  barbersPath: process.env.BARBERS_JSON || './data/doctors.json',
  hoursPath: process.env.BUSINESS_HOURS_JSON || './data/business_hours.json',
  catalogPath: process.env.CATALOG_JSON || './data/catalog.json',
  casosPath: process.env.CASOS_JSON || './data/casos.json',
  defaultSlotMin: Number(process.env.DEFAULT_SLOT_MINUTES || 45),
  defaultBufferMin: Number(process.env.DEFAULT_BUFFER_MINUTES || 0),
  // si usas SA inline
  saJson: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || null,
};

export const barbers = loadJSON(config.barbersPath);
export const businessHours = loadJSON(config.hoursPath);
