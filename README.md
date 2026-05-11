# ScisoNomics

ScisoNomics es una aplicación de escritorio para gestión de finanzas personales. Permite registrar ingresos, gastos, ahorros e inversiones, organizar categorías, controlar presupuestos mensuales, crear metas de ahorro, visualizar estadísticas y exportar reportes a Excel.

La aplicación funciona de forma local, sin necesidad de conexión a internet, y almacena los datos en una base SQLite dentro del equipo del usuario.

---

## Descargar

La versión estable para Windows está disponible en la sección de Releases:

[Descargar ScisoNomics v1.0.0](../../releases/tag/v1.0.0)

---

## Características principales

- Registro de ingresos, gastos, ahorros e inversiones.
- Categorías personalizadas.
- Presupuestos mensuales.
- Metas de ahorro.
- Calendario de movimientos.
- Estadísticas mensuales.
- Reporte mensual.
- Exportación a Excel.
- Base de datos SQLite local.
- Creación automática de base de datos en primera instalación.
- Backend local embebido como sidecar.
- Modo claro y modo oscuro.
- Aplicación instalable para Windows.

---

## Stack técnico

- **Frontend:** Next.js, React, Tailwind CSS
- **Desktop:** Tauri
- **Backend:** FastAPI
- **Base de datos:** SQLite
- **Empaquetado backend:** PyInstaller
- **Exportación Excel:** OpenPyXL

---

## Arquitectura

ScisoNomics está construida como una aplicación desktop con frontend web embebido y backend local.

```txt
Tauri Desktop App
│
├── Frontend
│   └── Next.js + React + Tailwind CSS
│
├── Backend local
│   └── FastAPI ejecutado como sidecar
│
└── Base de datos local
    └── SQLite
El backend se ejecuta localmente junto con la aplicación y expone una API interna para que el frontend pueda registrar, consultar y exportar la información financiera.

Los datos se almacenan en:

%LOCALAPPDATA%\RegistroFinanzas\data\finanzas.db

Los logs técnicos del backend se guardan en:

%LOCALAPPDATA%\ScisoNomics\logs
## Capturas

### Inicio

<img src="docs/screenshots/inicio.png" alt="Inicio" width="900" />

### Movimientos

<img src="docs/screenshots/movimientos.png" alt="Movimientos" width="900" />

### Estadísticas

<img src="docs/screenshots/estadisticas.png" alt="Estadísticas" width="900" />
### Excel

<img src="docs/screenshots/excel.png" alt="Excel" width="900" />

Instalación
Ir a la sección Releases
.
Descargar el instalador:
ScisoNomics_1.0.0_x64-setup.exe
Ejecutar el instalador.
Abrir ScisoNomics desde el acceso directo o desde el menú de inicio.

En la primera apertura, la aplicación crea automáticamente la base de datos local.

Estado del proyecto

Versión estable actual:

v1.0.0

Funcionalidades validadas:

Instalación en Windows.
Creación automática de base de datos.
Registro de movimientos.
Gestión de categorías.
Presupuestos.
Metas.
Calendario.
Estadísticas.
Exportación a Excel.
Funcionamiento offline.
Posibles mejoras futuras
Importación desde Excel o CSV.
Backups automáticos configurables.
Mejora visual de reportes exportados.
Sistema de actualización automática.
Sincronización cloud opcional.
Versión mobile.
Autor

Desarrollado por Ian Acevedo.