# ScisoNomics

ScisoNomics es una aplicación de escritorio para gestión de finanzas personales.

Permite registrar ingresos, gastos, ahorros e inversiones, organizar categorías, controlar presupuestos mensuales, crear metas de ahorro, visualizar estadísticas y exportar reportes a Excel.

La aplicación funciona de forma local, sin necesidad de conexión a internet, y almacena los datos en una base SQLite dentro del equipo del usuario.

---

## Descargar

La versión estable para Windows está disponible en la sección de Releases:

[Descargar ScisoNomics v1.4.0](../../releases/tag/v1.4.0)

---

## Características principales

- Registro de ingresos, gastos, ahorros e inversiones.
- Categorías personalizadas.
- Presupuestos mensuales.
- Metas de ahorro.
- Calendario de movimientos.
- Estadísticas por períodos: mes actual, últimos 3 meses, últimos 6 meses y año actual.
- Reporte mensual.
- Base de datos SQLite local.
- Creación automática de base de datos en primera instalación.
- Backend local embebido como sidecar.
- Modo claro y modo oscuro.
- Aplicación instalable para Windows.
- Exportación Excel con opción de elegir ubicación.
- Creación de copia de seguridad local.
- Exportación de reportes por rango de fechas.
- Filtros de movimientos por fechas exactas.
- Reporte Excel mejorado visualmente.
- Restauración segura de copias de seguridad.
- Validación de copias antes de restaurar.
- Creación automática de una copia previa antes de restaurar datos.

---

## Stack técnico

- Frontend: Next.js, React, Tailwind CSS
- Desktop: Tauri
- Backend: FastAPI
- Base de datos: SQLite
- Empaquetado backend: PyInstaller
- Exportación Excel: OpenPyXL

---

## Arquitectura

ScisoNomics está construida como una aplicación desktop con frontend web embebido y backend local.

Tauri ejecuta la interfaz hecha con Next.js y levanta un backend FastAPI local como sidecar. El frontend se comunica con ese backend mediante una API local, y los datos se guardan en una base SQLite dentro del equipo del usuario.

Base de datos local:

`%LOCALAPPDATA%\RegistroFinanzas\data\finanzas.db`

Logs técnicos:

`%LOCALAPPDATA%\ScisoNomics\logs`

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
2. Descargar `ScisoNomics_1.0.0_x64-setup.exe`.
3. Ejecutar el instalador.
4. Abrir ScisoNomics desde el acceso directo o desde el menú de inicio.

En la primera apertura, la aplicación crea automáticamente la base de datos local.

---

## Estado del proyecto

Versión estable actual: `v1.4.0`

Funcionalidades validadas:

- Instalación en Windows.
- Creación automática de base de datos.
- Registro de movimientos.
- Gestión de categorías.
- Presupuestos.
- Metas.
- Calendario.
- Estadísticas.
- Exportación a Excel.
- Funcionamiento offline.

---

## Posibles mejoras futuras

- Importación desde Excel o CSV.
- Backups automáticos configurables.
- Mejora visual de reportes exportados.
- Sistema de actualización automática.
- Sincronización cloud opcional.
- Versión mobile.

---

## Autor

Desarrollado por Ian Acevedo.