# ScisoNomics Cloud Backend

Backend FastAPI independiente para cuentas opcionales de ScisoNomics.

Esta API usa SQLite en desarrollo local y PostgreSQL en produccion Railway.

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
SCISONOMICS_ALLOWED_ORIGINS=*
SCISONOMICS_ACCESS_TOKEN_EXPIRE_MINUTES=1440
```

`SCISONOMICS_CLOUD_DATABASE_URL` tiene prioridad sobre `DATABASE_URL`. En Railway puede usarse `DATABASE_URL` directamente desde PostgreSQL.

## Endpoints

- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `GET /health`
- `GET /sync/health`
- `POST /sync/push`
- `GET /sync/pull`

## Variables

- `SCISONOMICS_CLOUD_DATABASE_URL`
- `DATABASE_URL`
- `SCISONOMICS_ENV`
- `SCISONOMICS_JWT_SECRET`
- `SCISONOMICS_ACCESS_TOKEN_EXPIRE_MINUTES`
- `SCISONOMICS_ALLOWED_ORIGINS`
- `SCISONOMICS_GOOGLE_CLIENT_ID`
- `SCISONOMICS_GOOGLE_CLIENT_SECRET`
- `SCISONOMICS_GOOGLE_REDIRECT_URI`

La sincronizacion manual acepta categorias, movimientos, metas de ahorro, gastos programados, gastos fijos y presupuestos del usuario autenticado. No recibe archivos `.db`, reportes, copias de seguridad ni datos fuera de ese alcance.

El endpoint `GET /auth/google/start` queda preparado para OAuth. Sin credenciales de Google devuelve un estado no configurado y no inicia redirecciones invalidas.
