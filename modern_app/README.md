# Modernizacion Web (FastAPI + Next.js + Tauri)

Esta carpeta contiene una nueva version web/desktop de la app, separada de Tkinter.

## Garantia de datos

- La app web/desktop usa siempre SQLite en AppData del usuario:
  - `C:\Users\<usuario>\AppData\Local\RegistroFinanzas\data\finanzas.db`
- No se crea una base vacia en carpetas del proyecto.
- Si falta la DB de AppData, el backend intenta copiar una vez desde `App registro/data/finanzas.db`.
- Si no existe ninguna, la API responde error claro: `No se encontro la base de datos.`
- Desde v2.8.0 el cliente soporta varias cuentas cloud guardadas en el mismo dispositivo. El modo sin cuenta usa el owner `local`; cada cuenta cloud usa su `user_id`, y solo una cuenta queda activa a la vez.
- Desde v2.9.0 se puede agregar una cuenta cloud con Google Login. El OAuth lo maneja el backend cloud; el frontend solo abre el navegador externo y nunca guarda secretos de Google.
- Desde v3.0.1 la app suma hardening de sync, auth cloud y API local del sidecar.
- Desde v3.1.0 una cuenta cloud activa intenta sync al abrir y cerrar la app. El toggle de auto-sync controla solamente cambios, foco e intervalo configurable durante el uso.

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
- `GET /ready`
- `GET /app/paths`
- `GET /app/diagnostics`
- `GET /meta`

`GET /debug/db-path` queda deshabilitado por defecto. Para habilitarlo temporalmente en un entorno controlado, definir `SCISONOMICS_ENABLE_DEBUG_ENDPOINTS=true`.

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

Validar y copiar el sidecar de Tauri:

```powershell
cd ..\frontend
npm run prepare:sidecar
```

`prepare:sidecar` falla si el EXE no existe, si alguna fuente Python es mas nueva que el binario, si las versiones frontend/Tauri/backend no coinciden o si el hash copiado difiere. Regenera primero el EXE con PyInstaller cuando cambie el backend.

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

Tauri inicia automaticamente el sidecar `scisonomics-backend`, espera respuesta de `/health`, y al cerrar la app termina el proceso backend.

En v3.1.0 el instalador NSIS intenta cerrar procesos anteriores de ScisoNomics antes de copiar archivos:
- `ScisoNomics.exe`
- `scisonomics-backend.exe`
- `scisonomics-backend-x86_64-pc-windows-msvc.exe`

No debe usarse "Omitir" si Windows avisa que un archivo esta en uso; hay que cancelar, cerrar esos procesos y volver a instalar. La actualizacion no borra la DB local, backups ni logs. El instalador esperado es `ScisoNomics_3.2.0_x64-setup.exe`.

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

`tauri:build` ejecuta automaticamente `prepare:sidecar` antes del bundle para evitar publicar frontend nuevo con backend viejo.

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

### Checklist manual de sync v3.1.0

- Abrir con cuenta cloud activa: registra una corrida `app_start`.
- Cerrar con cuenta cloud activa: intenta `app_close` antes de apagar el sidecar.
- Desactivar sync durante el uso: apertura y cierre siguen intentando sincronizar.
- Crear o editar datos con sync durante el uso desactivada: deja pendientes sin disparar corrida inmediata.
- Activar sync durante el uso y crear datos: dispara `data_change` con debounce.
- Cambiar intervalo: actualiza el timer de background para la cuenta activa.
- Cambiar A/B/local durante una corrida: conserva snapshot fijo y no mezcla estados.
- Abrir y cerrar varias veces: no deja ocupado `127.0.0.1:8000`.

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
- En v2.6 la sincronizacion automatica tambien consulta cambios remotos aunque no haya pendientes locales. Se ejecuta al iniciar, por intervalo, al recuperar foco y despues de cambios locales. Tambien se mejora visualmente el dashboard.
- En v3.0.0 se fija el modo oscuro, se elimina el selector claro/oscuro, se expone diagnostico seguro desde Configuracion > Acerca de ScisoNomics y las actualizaciones se realizan manualmente desde GitHub Releases.
- En v3.0.1 se agrega estabilizacion de sync/auth: snapshot de owner por corrida, token local para el sidecar en app instalada y Google Login one-time-use.
- En v3.1.0 una cuenta cloud activa intenta sincronizar al abrir y cerrar la app. El toggle controla solo el background durante el uso y el intervalo configurable por owner.
- El CSP desktop restringe conexiones al sidecar local, localhost de desarrollo y Railway. `script-src 'unsafe-inline'` se conserva porque el export estatico de Next lo necesita para hidratacion.
- `shell:allow-spawn` se mantiene como permiso minimo necesario para iniciar `app.shell().sidecar("scisonomics-backend")`; no se amplio `plugins.shell.scope`.
- Los JWT siguen centralizados en el servicio de auth. La expiracion cloud por defecto baja a 240 minutos. Migrar a secure storage nativo requiere incorporar un plugin del sistema operativo y se deja como tarea separada para no romper sesiones multicuentas existentes.

## Rutas locales principales

- DB local: `%LOCALAPPDATA%\RegistroFinanzas\data\finanzas.db`
- Backups: `%LOCALAPPDATA%\RegistroFinanzas\backups`
- Logs: `%LOCALAPPDATA%\ScisoNomics\logs`

El diagnostico de la app no incluye tokens, secretos, contrasenas, connection strings completas ni datos financieros.
