# ScisoNomics

ScisoNomics es una aplicación de escritorio para gestión de finanzas personales.

Permite registrar ingresos, gastos, ahorros e inversiones, organizar categorías, controlar presupuestos mensuales, crear metas de ahorro, administrar gastos fijos, visualizar estadísticas, consultar reportes, filtrar movimientos y exportar información a Excel.

La aplicación funciona de forma local, sin necesidad de conexión a internet, y almacena los datos en una base SQLite dentro del equipo del usuario.

---

## Descargar

La versión estable para Windows está disponible en la sección de Releases:

[Descargar ScisoNomics v2.1.0](../../releases/tag/v2.1.0)

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
- Preparación interna para futura sincronización cloud opcional.
- Identificadores internos de sincronización para datos locales.
- Cuenta de usuario opcional.
- Login con email y contraseña.
- Opción “Recordarme” para mantener la sesión iniciada.
- Base preparada para inicio de sesión con Google.
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
- Empaquetado backend: PyInstaller
- Exportación Excel: OpenPyXL
- Autenticación: JWT

---

## Arquitectura

ScisoNomics está construida como una aplicación desktop con frontend web embebido y backend local.

Tauri ejecuta la interfaz hecha con Next.js y levanta un backend FastAPI local como sidecar. El frontend se comunica con ese backend mediante una API local, y los datos se guardan en una base SQLite dentro del equipo del usuario.

Al iniciar la aplicación, ScisoNomics verifica que el backend local y la base de datos estén listos antes de cargar las pantallas principales. Esto evita errores de carga durante el arranque.

Base de datos local:

`%LOCALAPPDATA%\RegistroFinanzas\data\finanzas.db`

Logs técnicos:

`%LOCALAPPDATA%\ScisoNomics\logs`

La versión 2.1.0 incorpora sincronización manual inicial para categorías y movimientos. La aplicación sigue siendo local-first: los datos financieros continúan guardándose localmente y la cuenta no es obligatoria.

La sincronización no es automática. Solo se ejecuta cuando el usuario toca “Sincronizar ahora”.

---

## Cuenta de usuario

ScisoNomics permite crear o iniciar sesión con una cuenta opcional.

Actualmente la cuenta permite:

- Registrarse con email y contraseña.
- Iniciar sesión.
- Cerrar sesión.
- Usar la opción “Recordarme”.
- Preparar la base para futuro inicio de sesión con Google.

Importante:

- La cuenta no es obligatoria.
- La app puede usarse sin internet.
- Los datos financieros siguen guardándose localmente.
- Cerrar sesión no borra los datos locales.
- La sincronización manual inicial solo incluye categorías y movimientos.
- No se sube la base `.db` completa.

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
2. Descargar `ScisoNomics_2.1.0_x64-setup.exe`.
3. Ejecutar el instalador.
4. Abrir ScisoNomics desde el acceso directo o desde el menú de inicio.

En la primera apertura, la aplicación crea automáticamente la base de datos local.

---

## Estado del proyecto

Versión estable actual: `v2.1.0`

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
- Preparación local-first para sincronización futura.
- Diagnóstico local de estado de sincronización mediante `/sync/status`.
- Cuenta de usuario opcional.
- Registro e inicio de sesión con email y contraseña.
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

---

## Sincronización manual

La sincronización manual inicial requiere una cuenta iniciada y backend cloud configurado.

Al tocar “Sincronizar ahora”, ScisoNomics:

- Sube cambios pendientes de categorías y movimientos.
- Descarga categorías y movimientos del usuario autenticado.
- Resuelve conflictos simples usando `updated_at` con estrategia last write wins.
- Mantiene los datos en SQLite local.

No sincroniza todavía presupuestos, metas, gastos fijos, reportes, copias de seguridad ni archivos `.db`.

---

## Posibles mejoras futuras

- Sincronización automática entre dispositivos.
- Sincronización de presupuestos, metas y gastos fijos.
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
