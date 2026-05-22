# Modernizacion Web (FastAPI + Next.js + Tauri)

Esta carpeta contiene una nueva version web/desktop de la app, separada de Tkinter.

## Garantia de datos

- La app web/desktop usa siempre SQLite en AppData del usuario:
  - `C:\Users\<usuario>\AppData\Local\RegistroFinanzas\data\finanzas.db`
- No se crea una base vacia en carpetas del proyecto.
- Si falta la DB de AppData, el backend intenta copiar una vez desde `App registro/data/finanzas.db`.
- Si no existe ninguna, la API responde error claro: `No se encontro la base de datos.`

## Estructura

- `backend/`: API FastAPI sobre SQLite
- `frontend/`: UI Next.js + Tauri
- `cloud_backend/`: API FastAPI independiente para cuenta opcional, sincronizacion cloud opcional y preparacion multi-dispositivo

## 1) Backend (FastAPI)

```powershell
cd modern_app/backend
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
$env:PYTHONPATH="../.."
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Endpoints utilitarios:
- `GET /health`
- `GET /debug/db-path`
- `GET /meta`

Docs Swagger:
- `http://127.0.0.1:8000/docs`

## 2) Generar EXE del backend (PyInstaller)

Desde `modern_app/backend`:

```powershell
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
pip install pyinstaller
pyinstaller --noconfirm --onefile --name scisonomics-backend --collect-all uvicorn run_backend.py
```

Salida:
- `modern_app/backend/dist/scisonomics-backend.exe`

Copiar a sidecar de Tauri:

```powershell
Copy-Item .\dist\scisonomics-backend.exe ..\frontend\src-tauri\binaries\scisonomics-backend-x86_64-pc-windows-msvc.exe -Force
```

## 3) Frontend

```powershell
cd modern_app/frontend
npm install
$env:NEXT_PUBLIC_API_URL="http://127.0.0.1:8000"
npm run dev
```

Abrir:
- `http://127.0.0.1:3000`

Nota: el frontend ya tiene fallback a `http://127.0.0.1:8000` en `services/http.ts`.

Para probar la cuenta opcional en desarrollo:

```powershell
$env:NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL="http://127.0.0.1:9000"
```

## 4) Desktop (Tauri, Windows)

Tauri inicia automaticamente el sidecar `scisonomics-backend`, espera respuesta de `/health` o `/debug/db-path`, y al cerrar la app termina el proceso backend.

### Desarrollo

```powershell
cd modern_app/frontend
npm install
npm run tauri:dev
```

Si no existe sidecar en dev, Tauri no corta la sesion; deja warning en logs para poder seguir con backend manual.

### Build / instalador

```powershell
cd modern_app/frontend
npm run tauri:build
```

Salida esperada (Windows):
- `modern_app/frontend/src-tauri/target/release/bundle/`
- instalador `.msi` y/o `.exe` segun toolchain disponible.

## 5) Validaciones solicitadas

```powershell
python -m compileall modern_app/backend/app
cd modern_app/frontend
npm run build
npm run tauri:dev
npm run tauri:build
```

## Notas tecnicas

- Se reutiliza la logica existente de `finance_app/services.py` para mantener:
  - saldo inicial
  - balance final
  - saldo acumulado
- SQLite sigue siendo la base de datos.
- Exportacion Excel reutiliza `finance_app/exporter.py`.
- La cuenta opcional de v2.0 no sincroniza datos financieros. El backend cloud esta separado del backend local.
- En v2.3 la sincronizacion automatica es opcional. Si esta desactivada, la sincronizacion sigue siendo manual y siempre iniciada por el usuario.
- En v2.4 se agrega Centro de sincronizacion, historial local de sync, cambios pendientes por tabla e identificador local de dispositivo. No hay resolucion avanzada de conflictos y no se sube la base `.db` completa.
- En v2.5 se agrega metadata de origen por dispositivo, deteccion basica de conflictos, registro local `sync_conflicts` y vista de dispositivos vinculados. La resolucion sigue siendo last-write-wins.
