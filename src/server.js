// src/server.js
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

import { config, barbers, businessHours } from './config.js';
import { auth } from './middleware/auth.js';
import { rateLimit } from './middleware/rate.js';
import { mcpRouter } from './mcp/router.js';

// Logger PRO
import { createRequestLogger } from './utils/logger.js';

const log = createRequestLogger({
  tool: 'server',
  action: 'start',
});

// Inicializa Express
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// Health simple
app.get('/health', (_, res) =>
  res.json({ status: 'ok', env: config.env })
);

// Aplica auth + rate limit al contrato MCP
app.use('/mcp', auth, rateLimit, mcpRouter);
app.use('/tools', auth, rateLimit, mcpRouter);

// Endpoint opcional para debug
app.get('/_debug/config', auth, (req, res) => {
  res.json({
    status: 'ok',
    tz: config.tz,
    cacheTtlSec: config.cacheTtlSec,
    ratePerMin: config.ratePerMin,
    barbersCount: barbers.length,
    hoursKeys: Object.keys(businessHours),
  });
});

// 404
app.use((req, res) =>
  res.status(404).json({
    status: 'error',
    message: 'Ruta no encontrada',
  })
);

// Start server con logger PRO 💥
app.listen(config.port, () => {
  log.info(
    {
      port: config.port,
      tz: config.tz,
      env: config.env,
    },
    'server.started'
  );
});
