# ScisoNomics Cloud Backend

Backend FastAPI independiente para cuentas opcionales de ScisoNomics.

Esta API prepara autenticacion para futuras funciones cloud, pero no sincroniza datos financieros.

## Desarrollo

```powershell
cd C:\dev\scisonomics
$env:SCISONOMICS_JWT_SECRET="dev-secret-change-me"
$env:SCISONOMICS_CLOUD_DATABASE_URL="sqlite:///./modern_app/cloud_backend/scisonomics_cloud_dev.db"
python -m uvicorn modern_app.cloud_backend.app.main:app --reload --host 127.0.0.1 --port 9000
```

## Endpoints

- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `GET /health`

## Variables

- `SCISONOMICS_CLOUD_DATABASE_URL`
- `SCISONOMICS_JWT_SECRET`
- `SCISONOMICS_ACCESS_TOKEN_EXPIRE_MINUTES`
- `SCISONOMICS_GOOGLE_CLIENT_ID`
- `SCISONOMICS_GOOGLE_CLIENT_SECRET`
- `SCISONOMICS_GOOGLE_REDIRECT_URI`

La sincronizacion de movimientos, categorias o datos financieros no esta implementada en esta API.

El endpoint `GET /auth/google/start` queda preparado para OAuth. Sin credenciales de Google devuelve un estado no configurado y no inicia redirecciones invalidas.
