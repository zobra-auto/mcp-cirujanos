import { config } from '../config.js';

// ISO con offset -05:00 fijo (Bogotá)
export function nowISO() {
  const offsetMin = -5 * 60; // -05:00
  const t = Date.now() + offsetMin * 60000;
  const d = new Date(t);
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth()+1).padStart(2,'0');
  const D = String(d.getUTCDate()).padStart(2,'0');
  const h = String(d.getUTCHours()).padStart(2,'0');
  const m = String(d.getUTCMinutes()).padStart(2,'0');
  const s = String(d.getUTCSeconds()).padStart(2,'0');
  return `${Y}-${M}-${D}T${h}:${m}:${s}-05:00`;
}

export const TZ = config.tz;
