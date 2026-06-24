import { config } from '../config.js';

const buckets = new Map(); // key -> {count, resetAt}

export function rateLimit(req, res, next) {
  const perMinute = config.ratePerMin;
  const windowMs = 60_000;
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/,'').trim();
  const key = `${token}:${ip||'local'}`;
  const now = Date.now();

  let b = buckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }

  b.count += 1;
  const remaining = Math.max(0, perMinute - b.count);
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(b.resetAt - now));

  if (b.count > perMinute) {
    return res.status(429).json({ status: 'error', message: 'rate_limit_exceeded' });
  }
  next();
}
