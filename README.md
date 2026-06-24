# mcp-cirujanos

MCP de agendamiento para consultorios de cirugía plástica. **Fork de `valeria-mcp-server`** (repo `zobra-auto/valeria-mcp-server`), adaptado a multi-tenant por archivos/env. Es el Componente B del `INFRA_PLAN.md`.

## Qué cambió respecto a valeria-mcp-server
1. **`catalog.js` parcheado**: la tienda/servicios ya NO están hardcodeados (eran de la barbería). Ahora se leen de `CATALOG_JSON` (`./data/catalog.json`) → servicios de la **valoración** del cirujano.
2. **Tool nueva `casos`** (alias `buscar_casos`): biblioteca antes/después por procedimiento, leída de `CASOS_JSON`. La usa el sub-agente VENTAS en M1 del guion.
3. **Defaults a cirujanos**: `BARBERS_JSON` → `./data/doctors.json` (cada "barbero" = un médico con su Google Calendar). Duración por defecto 45 min.

Lo demás (`calendar` check/create/cancel, `booking` search, `barbers` resolve, auth, rate-limit, caché) es **idéntico** a valeria y 100% configurable por env — por eso no se toca el `mcp-valeria` de la barbería.

## Endpoint
`POST /mcp` (alias `/tools`) con header `x-api-key: <API_KEY>` y cuerpo `{ "tool", "action", "params" }`.

| tool | action | params | Uso |
|---|---|---|---|
| `calendar` | `check` | `date` (YYYY-MM-DD) ó `from`+`to` ISO, `barber?`, `duration?` | Slots reales del calendar |
| `calendar` | `create` | `date`,`time` (ó `when` ISO), `who`, `phone`, `barber`, `duration?` | Agendar valoración |
| `calendar` | `cancel` | `eventId`, `barber?` | Cancelar |
| `booking` | `search` | `phone` | Citas del paciente |
| `catalog` | `search` | `query?` | Servicios/precios del consultorio |
| `casos` | `search` | `procedimiento`, `n?` (def 2, máx 5) | Casos antes/después (M1) |
| `health` | `ping` | — | Healthcheck |

Alias para n8n: `ver_disponibilidad`/`agendar_turno`/`cancelar_turno` → `calendar`; `buscar_turnos` → `booking`; `buscar_casos` → `casos`.

## Configuración
Copia `.env.example` → `.env` y rellena `API_KEY` + `GOOGLE_APPLICATION_CREDENTIALS_JSON`. Los datos del consultorio viven en `data/` (`doctors.json`, `business_hours.json`, `catalog.json`, `casos.json`).

**Migrar a otro doctor:** cambiar los 4 JSON de `data/` (o apuntar las envs `*_JSON` a otros archivos) + el calendarId compartido con la SA. Cero cambios de código.

## Correr local
```bash
npm install
cp .env.example .env   # rellenar API_KEY y la SA
npm run dev            # node --watch
# smoke:
curl -s localhost:3000/mcp -H 'x-api-key: <API_KEY>' -H 'content-type: application/json' \
  -d '{"tool":"catalog","action":"search","params":{}}' | jq
curl -s localhost:3000/mcp -H 'x-api-key: <API_KEY>' -H 'content-type: application/json' \
  -d '{"tool":"casos","action":"search","params":{"procedimiento":"rinoplastia","n":2}}' | jq
```

## Despliegue (EasyPanel — con tu luz verde)
Nuevo servicio `mcp-cirujanos` en el proyecto `barber_auto`. Env según `.env.example`; copiar `GOOGLE_APPLICATION_CREDENTIALS_JSON` desde `mcp-valeria` (misma SA `mcp-valeria@zobra-pruebas`). Dominio `barber-auto-mcp-cirujanos.wytay4.easypanel.host`. NO reconfigurar `mcp-valeria` (aislamiento).
