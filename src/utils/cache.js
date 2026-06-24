// Simple TTL in-memory cache compatible with the rest of the code.
// Export the class TTLCache (named) and also export default = singleton that exposes get/set/del/clear
// The singleton interprets the third argument of set as TTL in seconds (converted to ms internally).

export class TTLCache {
  constructor(defaultTtlMs = 120 * 1000) {
    this.defaultTtlMs = defaultTtlMs;
    this.store = new Map();
  }
  // ttlMs: milliseconds
  set(key, value, ttlMs) {
    const exp = Date.now() + (ttlMs ?? this.defaultTtlMs);
    this.store.set(key, { value, exp });
  }
  get(key) {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.exp) { this.store.delete(key); return undefined; }
    return e.value;
  }
  del(key) { this.store.delete(key); }
  clear() { this.store.clear(); }
}

// Singleton adapter: interface expected by router/calendar:
//   await cache.get(key)
//   await cache.set(key, value, ttlSeconds)
// Internal TTL of the instance default is read from CACHE_TTL_SECONDS env (seconds) or 120s.
const envTtlSec = Number(process.env.CACHE_TTL_SECONDS || 120);
const defaultTtlMs = Number.isFinite(envTtlSec) ? envTtlSec * 1000 : 120 * 1000;
const inner = new TTLCache(defaultTtlMs);

const defaultCache = {
  // get may be used with await; keep it synchronous but return value directly
  get(key) {
    return inner.get(key);
  },
  // set accepts ttl in seconds (or undefined to use default)
  set(key, value, ttlSeconds) {
    const ttlMs = (typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds)) ? Math.floor(ttlSeconds * 1000) : undefined;
    inner.set(key, value, ttlMs);
  },
  del(key) {
    inner.del(key);
  },
  clear() {
    inner.clear();
  },
  // expose underlying class/instance for tests or advanced usage
  _inner: inner,
  TTLCache,
};

export default defaultCache;