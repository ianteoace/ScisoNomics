# ScisoNomics

ScisoNomics es una aplicación de escritorio para gestión de finanzas personales.

Permite registrar ingresos, gastos, ahorros e inversiones, organizar categorías, controlar presupuestos mensuales, crear metas de ahorro, administrar gastos fijos, visualizar estadísticas, consultar reportes, filtrar movimientos, exportar información a Excel y crear copias de seguridad locales.

La aplicación funciona con enfoque **local-first**: los datos principales se guardan en una base SQLite dentro del equipo del usuario y la app puede utilizarse sin conexión a internet.

A partir de la versión `v2.1.1`, ScisoNomics incorpora backend cloud real desplegado en Railway con PostgreSQL, cuenta opcional y sincronización manual inicial para categorías y movimientos.

---

## Descargar

La versión estable para Windows está disponible en la sección de Releases:

[Descargar ScisoNomics v2.1.1](../../releases/tag/v2.1.1)

---

## Versión actual

**Versión estable actual:** `v2.1.1`

---

## Novedades de v2.1.1

- Backend cloud/auth desplegado en Railway.
- Compatibilidad del backend cloud con PostgreSQL.
- Compatibilidad mantenida con SQLite local para desarrollo.
- Conexión de la app desktop a backend cloud público mediante `NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL`.
- Registro, inicio de sesión, sesión actual y healthchecks validados contra Railway.
- Sincronización manual inicial para categorías y movimientos.
- Validación reforzada para evitar marcar datos locales como sincronizados si el cloud no confirma recepción.
- Documentación agregada para deploy cloud.

### Notas de esta versión

- La cuenta sigue siendo opcional.
- La app sigue funcionando offline.
- La sincronización automática todavía no está activa.
- No se sube la base `.db` completa.
- Todavía no se sincronizan presupuestos, metas, gastos fijos, gastos programados ni tags.
- Los datos financieros siguen guardándose localmente en SQLite.
- El backend cloud productivo usa PostgreSQL en Railway.

---

## Características principales

- Registro de ingresos, gastos, ahorros e inversiones.
- Categorías personalizadas.
- Dashboard de inicio con resumen financiero mensual.
- Cards de ingresos, gastos, balance, ahorros e inversiones.
- Últimos movimientos desde la pantalla de inicio.
- Accesos rápidos a funciones principales.
- Presupuestos mensuales con progreso, disponible y estados visuales.
- Metas de ahorro con progreso, monto faltante y porcentaje alcanzado.
- Gastos fijos con resumen mensual, próximos vencimientos y estados visuales.
- Calendario de movimientos.
- Filtros de movimientos por fechas exactas, tipo, categoría, monto y orden.
- Estadísticas por períodos: mes actual, últimos 3 meses, últimos 6 meses y año actual.
- Sección Reporte con vista mensual y anual.
- Reporte mensual con resumen de ingresos, gastos, balance y movimientos del período.
- Reporte anual con resumen del año, totales, promedios y detalle por mes.
- Exportación de reportes a Excel por rango de fechas.
- Reporte Excel mejorado visualmente.
- Exportación Excel con opción de elegir ubicación.
- Creación de copias de seguridad locales.
- Restauración segura de copias de seguridad.
- Validación de copias antes de restaurar.
- Creación automática de una copia previa antes de restaurar datos.
- Advertencias para conservar correctamente los archivos de copia de seguridad.
- Guías contextuales por sección para nuevos usuarios.
- Opción para volver a ver las guías desde Configuración.
- Pantalla de inicio mientras se preparan los servicios locales.
- Base de datos SQLite local.
- Creación automática de base de datos en primera instalación.
- Backend local embebido como sidecar.
- Cuenta de usuario opcional.
- Login con email y contraseña.
- Opción “Recordarme” para mantener la sesión iniciada.
- Base preparada para inicio de sesión con Google.
- Backend cloud/auth real desplegable en Railway.
- Soporte cloud con PostgreSQL.
- Sincronización manual inicial de categorías y movimientos.
- Modo claro y modo oscuro.
- Aplicación instalable para Windows.

---

## Stack técnico

- Frontend: Next.js, React, Tailwind CSS
- Desktop: Tauri
- Backend local: FastAPI
- Backend cloud/auth: FastAPI
- Base de datos local: SQLite
- Base cloud de desarrollo: SQLite
- Base cloud productiva: PostgreSQL
- Deploy backend cloud: Railway
- Empaquetado backend local: PyInstaller
- Exportación Excel: OpenPyXL
- Autenticación: JWT

---

## Arquitectura

ScisoNomics está construida como una aplicación desktop con frontend web embebido y backend local.

Tauri ejecuta la interfaz hecha con Next.js y levanta un backend FastAPI local como sidecar. El frontend se comunica con ese backend mediante una API local, y los datos se guardan en una base SQLite dentro del equipo del usuario.

Al iniciar la aplicación, ScisoNomics verifica que el backend local y la base de datos estén listos antes de cargar las pantallas principales. Esto evita errores de carga durante el arranque.

Base de datos local:

```text
%LOCALAPPDATA%\RegistroFinanzas\data\finanzas.db
```

Logs técnicos:

```text
%LOCALAPPDATA%\ScisoNomics\logs
```

La versión `v2.1.1` incorpora backend cloud productivo desplegado en Railway con PostgreSQL. La aplicación sigue siendo local-first: los datos financieros continúan guardándose localmente y la cuenta no es obligatoria.

La sincronización no es automática. Solo se ejecuta cuando el usuario toca **“Sincronizar ahora”**.

---

## Cuenta de usuario

ScisoNomics permite crear o iniciar sesión con una cuenta opcional.

Actualmente la cuenta permite:

- Registrarse con email y contraseña.
- Iniciar sesión.
- Cerrar sesión.
- Usar la opción “Recordarme”.
- Preparar la base para futuro inicio de sesión con Google.
- Habilitar sincronización manual inicial de categorías y movimientos.

Importante:

- La cuenta no es obligatoria.
- La app puede usarse sin internet.
- Los datos financieros siguen guardándose localmente.
- Cerrar sesión no borra los datos locales.
- La sincronización manual inicial solo incluye categorías y movimientos.
- No se sube la base `.db` completa.
- No hay sincronización automática en esta versión.

---

## Sincronización manual

La sincronización manual inicial requiere una cuenta iniciada y backend cloud configurado.

Al tocar **“Sincronizar ahora”**, ScisoNomics:

- Lee los registros locales pendientes de categorías y movimientos.
- Sube cambios pendientes al backend cloud.
- Valida que el cloud confirme los registros recibidos y guardados.
- Marca como sincronizados solo los registros aceptados por el cloud.
- Descarga categorías y movimientos del usuario autenticado.
- Aplica cambios remotos en SQLite local.
- Resuelve conflictos simples usando `updated_at` con estrategia `last write wins`.

No sincroniza todavía:

- Presupuestos.
- Metas de ahorro.
- Gastos fijos.
- Gastos programados.
- Tags.
- Reportes.
- Copias de seguridad.
- Archivos `.db`.

---

## Capturas

### Inicio

![Inicio](./docs/screenshots/inicio.png)

### Movimientos

![Movimientos](./docs/screenshots/movimientos.png)

### Estadísticas

![Estadísticas](./docs/screenshots/estadisticas.png)

### Exportación a Excel

![Exportación Excel](./docs/screenshots/excel.png)

---

## Instalación

1. Ir a la sección de Releases.
2. Descargar `ScisoNomics_2.1.1_x64-setup.exe`.
3. Ejecutar el instalador.
4. Abrir ScisoNomics desde el acceso directo o desde el menú de inicio.

En la primera apertura, la aplicación crea automáticamente la base de datos local.

---

## Estado del proyecto

Versión estable actual: `v2.1.1`

Funcionalidades validadas:

- Instalación en Windows.
- Creación automática de base de datos.
- Arranque controlado con verificación del backend local.
- Registro de movimientos.
- Gestión de categorías.
- Dashboard financiero.
- Presupuestos con progreso y estados visuales.
- Metas de ahorro con progreso y estados visuales.
- Gastos fijos con próximos vencimientos y estados visuales.
- Calendario de movimientos.
- Filtros de movimientos.
- Estadísticas por períodos.
- Reporte mensual.
- Reporte anual.
- Exportación a Excel por rango de fechas.
- Creación de copias de seguridad.
- Restauración segura de copias de seguridad.
- Guías contextuales por sección.
- Diagnóstico local de estado de sincronización mediante `/sync/status`.
- Cuenta de usuario opcional.
- Registro e inicio de sesión con email y contraseña.
- Backend cloud/auth desplegado en Railway.
- Backend cloud compatible con PostgreSQL.
- Sincronización manual inicial de categorías y movimientos.
- Cierre de sesión sin borrar datos locales.
- Funcionamiento offline.

---

## Reportes

ScisoNomics incluye una sección de Reporte con dos vistas principales:

- Reporte mensual: permite analizar ingresos, gastos, balance y movimientos de un período mensual.
- Reporte anual: permite revisar el comportamiento financiero del año, con totales, promedios y resumen por mes.

Esta sección está pensada para consultar información más detallada y complementar las estadísticas visuales de la aplicación.

---

## Guías de uso

ScisoNomics incluye guías contextuales que aparecen la primera vez que se ingresa a cada sección principal.

Estas guías explican brevemente para qué sirve cada pantalla y ayudan al usuario a comenzar a usar la aplicación sin necesidad de configuración previa.

Desde Configuración se pueden volver a mostrar las guías cuando sea necesario.

---

## Copias de seguridad

ScisoNomics permite crear y restaurar copias de seguridad locales.

Al restaurar una copia, la aplicación valida que el archivo sea una base de datos compatible y crea automáticamente una copia previa de los datos actuales antes de reemplazarlos.

Se recomienda conservar el nombre y la extensión `.db` del archivo de copia de seguridad.

---

## Desarrollo local

Backend cloud/auth en desarrollo:

```powershell
cd C:\dev\scisonomics

$env:SCISONOMICS_ENV="development"
$env:SCISONOMICS_JWT_SECRET="dev-secret-change-me"
$env:SCISONOMICS_CLOUD_DATABASE_URL="sqlite:///./modern_app/cloud_backend/scisonomics_cloud_dev.db"

python -m uvicorn modern_app.cloud_backend.app.main:app --reload --host 127.0.0.1 --port 9000
```

Frontend/Tauri en desarrollo con cuenta:

```powershell
cd C:\dev\scisonomics\modern_app\frontend

$env:NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL="http://127.0.0.1:9000"

npm run tauri:dev
```

Frontend/Tauri apuntando al backend cloud productivo:

```powershell
cd C:\dev\scisonomics\modern_app\frontend

$env:NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL="https://TU_BACKEND_RAILWAY"

npm run tauri:dev
```

---

## Backend cloud

El backend cloud/auth se encuentra en:

```text
modern_app/cloud_backend
```

En desarrollo puede funcionar con SQLite local.

En producción está preparado para Railway + PostgreSQL.

Variables principales:

```env
SCISONOMICS_ENV=production
SCISONOMICS_JWT_SECRET=GENERAR_SECRET_SEGURO
DATABASE_URL=postgresql://...
SCISONOMICS_ALLOWED_ORIGINS=*
SCISONOMICS_ACCESS_TOKEN_EXPIRE_MINUTES=1440
```

La prioridad para elegir base cloud es:

1. `SCISONOMICS_CLOUD_DATABASE_URL`
2. `DATABASE_URL`
3. SQLite local de desarrollo

---

## Deploy backend cloud

El backend cloud/auth puede desplegarse en Railway con FastAPI y PostgreSQL.

Archivo de configuración:

```text
railway.json
```

Start command:

```bash
python -m uvicorn modern_app.cloud_backend.app.main:app --host 0.0.0.0 --port $PORT
```

Variables necesarias en Railway:

```env
SCISONOMICS_ENV=production
SCISONOMICS_JWT_SECRET=GENERAR_SECRET_SEGURO
DATABASE_URL=${{Postgres.DATABASE_URL}}
SCISONOMICS_ALLOWED_ORIGINS=*
SCISONOMICS_ACCESS_TOKEN_EXPIRE_MINUTES=1440
```

Healthcheck:

```text
GET /health
```

Respuesta esperada:

```json
{
  "ok": true,
  "service": "scisonomics-cloud-auth",
  "database": "postgresql",
  "version": "2.1.1"
}
```

La app desktop debe configurarse antes del build con:

```powershell
$env:NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL="https://TU_BACKEND_RAILWAY"
```

No hay sincronización automática en esta versión. La sincronización sigue siendo manual y limitada a categorías y movimientos.

---

## Build desktop

Antes de generar una build productiva, configurar la URL del backend cloud:

```powershell
cd C:\dev\scisonomics\modern_app\frontend

$env:NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL="https://TU_BACKEND_RAILWAY"

npm run build
npm run tauri:build
```

Los instaladores se generan en:

```text
modern_app/frontend/src-tauri/target/release/bundle/nsis
```

y opcionalmente:

```text
modern_app/frontend/src-tauri/target/release/bundle/msi
```

---

## Posibles mejoras futuras

- Sincronización automática entre dispositivos.
- Sincronización de presupuestos, metas y gastos fijos.
- Sincronización de gastos programados y tags.
- Google OAuth completamente configurado.
- Exportación específica del reporte anual.
- Importación desde plantilla oficial de Excel o CSV.
- Backups automáticos configurables.
- Restauración guiada con historial de copias.
- Sistema de actualización automática.
- Versión mobile.

---

## Autor

Desarrollado por Ian Acevedo.