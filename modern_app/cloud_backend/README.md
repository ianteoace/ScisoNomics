# ScisoNomics Cloud Backend

Backend FastAPI independiente para cuentas opcionales de ScisoNomics.

Esta API usa SQLite en desarrollo local y PostgreSQL en produccion Railway.

Desde v3.1.0 el frontend intenta sincronizar al abrir y cerrar la app cuando hay una cuenta cloud activa. El backend conserva los mismos contratos JWT y de sync.

## Desarrollo

```powershell
cd C:\dev\scisonomics
$env:SCISONOMICS_JWT_SECRET="dev-secret-change-me"
$env:SCISONOMICS_ENV="development"
$env:SCISONOMICS_CLOUD_DATABASE_URL="sqlite:///./modern_app/cloud_backend/scisonomics_cloud_dev.db"
python -m uvicorn modern_app.cloud_backend.app.main:app --reload --host 127.0.0.1 --port 9000
```

## Railway

Start command:

```bash
python -m uvicorn modern_app.cloud_backend.app.main:app --host 0.0.0.0 --port $PORT
```

Variables de entorno:

```bash
SCISONOMICS_ENV=production
SCISONOMICS_JWT_SECRET=GENERAR_SECRET_SEGURO
DATABASE_URL=postgresql://...
SCISONOMICS_ALLOWED_ORIGINS=http://tauri.localhost,https://tauri.localhost,tauri://localhost
SCISONOMICS_ACCESS_TOKEN_EXPIRE_MINUTES=240
SCISONOMICS_DEVICE_VERIFICATION_MODE=off
SCISONOMICS_GOOGLE_CLIENT_ID=...
SCISONOMICS_GOOGLE_CLIENT_SECRET=...
SCISONOMICS_GOOGLE_REDIRECT_URI=https://TU_BACKEND/auth/google/callback
```

`SCISONOMICS_CLOUD_DATABASE_URL` tiene prioridad sobre `DATABASE_URL`. En Railway puede usarse `DATABASE_URL` directamente desde PostgreSQL.

En produccion `SCISONOMICS_ALLOWED_ORIGINS` es obligatorio y no acepta `*`. En desarrollo, si se omite, se habilitan solamente los origins locales de Tauri y Next.

La expiracion JWT por defecto es de 240 minutos. El frontend mantiene acceso centralizado al token para compatibilidad multicuentas; migrar sesiones persistentes a secure storage nativo requiere una version dedicada con plugin del sistema operativo y migracion controlada.

## Endpoints

- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `POST /auth/google/start`
- `GET /auth/google/callback`
- `GET /auth/google/status/{login_request_id}`
- `GET /health`
- `GET /sync/health`
- `POST /sync/push`
- `GET /sync/pull`
- `GET /sync/devices`

`GET /sync/debug-counts` queda deshabilitado por defecto. Para habilitarlo temporalmente en un entorno controlado, definir `SCISONOMICS_ENABLE_DEBUG_ENDPOINTS=true`.

## Variables

- `SCISONOMICS_CLOUD_DATABASE_URL`
- `DATABASE_URL`
- `SCISONOMICS_ENV`
- `SCISONOMICS_JWT_SECRET`
- `SCISONOMICS_ACCESS_TOKEN_EXPIRE_MINUTES`
- `SCISONOMICS_DEVICE_VERIFICATION_MODE`: ausente, vacio u `off` inicia Fase 1. Solo acepta los literales exactos en minusculas `off`, `observe` y `enforce`; valores como `OFF`, `Observe` o con espacios son invalidos. `observe` y `enforce` abortan el startup con `device_mode_not_implemented`; cualquier otro valor aborta con `invalid_device_verification_mode`. Nunca se degradan silenciosamente a `off`.

Device Proof V1 es una especificacion criptografica congelada. La Fase 1 implementada prepara schema e identidad local con modo predeterminado `off`; la Fase 2, que incorporara `observe`, `enforce`, endpoints V1 e integracion frontend, sigue pendiente.
- `SCISONOMICS_DB_MIGRATION_LOCK_TIMEOUT_MS` (PostgreSQL, predeterminado `15000`, rango `1000..600000`).
- `SCISONOMICS_DB_MIGRATION_STATEMENT_TIMEOUT_MS` (PostgreSQL, predeterminado `120000`, rango `1000..600000`).
- `SCISONOMICS_ALLOWED_ORIGINS`
- `SCISONOMICS_GOOGLE_CLIENT_ID`
- `SCISONOMICS_GOOGLE_CLIENT_SECRET`
- `SCISONOMICS_GOOGLE_REDIRECT_URI`
- `SCISONOMICS_ENABLE_DEBUG_ENDPOINTS` (opcional; usar solo temporalmente en soporte controlado)

La sincronizacion manual y automatica opcional acepta categorias, tags, relaciones movimiento-tag, movimientos, metas de ahorro, gastos programados, gastos fijos y presupuestos del usuario autenticado. No recibe archivos `.db`, reportes, copias de seguridad ni datos fuera de ese alcance.

Desde v2.4.0 el backend cloud tambien registra dispositivos por usuario (`device_id`, `device_name`, `last_seen_at`) para preparar uso multi-dispositivo.

Desde v2.5.0 los registros cloud guardan metadata del ultimo dispositivo que los modifico (`last_modified_device_id`, `last_modified_device_name`, `last_modified_at`). La resolucion avanzada de conflictos no esta implementada; la app mantiene last-write-wins.

Desde v2.6.0 el cliente desktop consulta cambios remotos automaticamente aunque no tenga pendientes locales. El backend cloud no usa WebSockets; sigue exponiendo endpoints HTTP de push/pull.

Desde v2.7.0 el cliente desktop aísla datos locales por cuenta con `owner_user_id`. El backend cloud sigue filtrando por el usuario autenticado desde el JWT e ignora cualquier intento del cliente de indicar otro usuario.

Desde v2.8.0 el cliente desktop puede guardar varias cuentas cloud en el mismo dispositivo, pero la sincronizacion cloud corre solo para la cuenta activa. El backend cloud no sincroniza cuentas en segundo plano ni acepta que el cliente indique otro `user_id`.

Desde v2.9.0 Google Login esta disponible como metodo opcional. El backend cloud genera `login_request_id`, redirige a Google con `state`, recibe el callback, vincula por `google_sub` o email existente y emite el mismo JWT propio de ScisoNomics. Si faltan variables `SCISONOMICS_GOOGLE_CLIENT_ID`, `SCISONOMICS_GOOGLE_CLIENT_SECRET` o `SCISONOMICS_GOOGLE_REDIRECT_URI`, `/auth/google/start` devuelve error controlado. No guardar secretos de Google en frontend/Tauri.

Desde v3.0.1 se mantiene Google Login, email/password y sync por JWT, con hardening de polling Google one-time-use, CORS mas explicito y logs con menos PII.

Antes de v3.1.0 el pull incorpora cursor incremental por revision de servidor. El primer pull o un cliente viejo conserva fallback completo. Los cambios cloud usan `remote_updated_at` generado en servidor y baseline optimista para evitar que el reloj incorrecto de una notebook pise silenciosamente cambios de otro dispositivo.
