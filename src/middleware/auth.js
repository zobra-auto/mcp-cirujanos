import { config } from '../config.js';

export function auth(req, res, next) {
  // Acepta tanto `Authorization: Bearer <key>` como `x-api-key: <key>`
  // (n8n httpRequestTool usa x-api-key; alineado con el router MCP).
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const apiKeyHeader = req.headers['x-api-key'] || null;
  const token = bearer || apiKeyHeader;
  if (!config.apiKey) return res.status(500).json({ status: 'error', message: 'API_KEY no configurada' });
  if (token !== config.apiKey) return res.status(401).json({ status: 'error', message: 'No autorizado' });
  next();
}
