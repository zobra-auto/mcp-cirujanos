import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  ...config.pg,
  ssl: false,
  max: 6,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000,
  statement_timeout: 30000,
});

pool.on('error', (err) => console.error('[mcp-db] pool error:', err.message));
export const query = (text, params) => pool.query(text, params);
