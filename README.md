# ScisoNomics

ScisoNomics es una aplicación de escritorio para gestión de finanzas personales, desarrollada con enfoque **local-first**.

Permite registrar ingresos, gastos, inversiones, presupuestos, metas de ahorro, gastos fijos, gastos programados, reportes, estadísticas y copias de seguridad. Los datos principales se guardan localmente en SQLite, y la sincronización cloud es opcional.

---

## Descarga

Versión estable actual: **v2.6.0**

[Descargar ScisoNomics v2.6.0](../../releases/tag/v2.6.0)

---

## Novedades de v2.6.0

- La sincronización automática ahora también consulta cambios hechos desde otros dispositivos.
- El pull remoto se ejecuta aunque no haya cambios locales pendientes.
- La sync automática consulta remoto al iniciar, por intervalo y al recuperar foco.
- Se mantiene sync después de cambios locales con debounce.
- Se mejoró el historial de sincronización con razones como `startup`, `interval`, `focus` y `auto_local_change`.
- Se mejoró el Centro de sincronización para mostrar cambios remotos y conflictos con más claridad.
- Se renovó visualmente el dashboard principal con mejor jerarquía, saldo destacado y alertas financieras.
- La app sigue siendo local-first, la cuenta sigue siendo opcional y no se sube la base `.db` completa.
- No hay WebSockets ni merge manual complejo todavía.

---

## Novedades de v2.5.0

- Se agregó preparación multi-dispositivo real.
- Los registros sincronizados guardan metadata del dispositivo que los modificó.
- Se agregó detección básica de conflictos.
- Se registra un historial local de conflictos en `sync_conflicts`.
- El Centro de sincronización muestra dispositivos vinculados.
- El Centro de sincronización muestra conflictos y cambios remotos recientes.
- Se mantiene la estrategia last-write-wins por `updated_at`.
- No hay merge manual todavía.
- No se sube la base `.db` completa.
- La app sigue siendo local-first.

---

## Novedades de v2.4.0

- Se agregó un Centro de sincronización dentro de Configuración → Cuenta.
- Se incorporó historial local de sincronizaciones manuales y automáticas.
- Se muestra un resumen de cambios pendientes por tabla.
- Se agregó identificador local de dispositivo para preparar uso multi-dispositivo.
- El backend cloud registra dispositivos vistos por cuenta.
- Se mejoró el diagnóstico de errores de sincronización con mensajes amigables.
- La sincronización automática sigue siendo opcional y desactivada por defecto.
- No hay resolución avanzada de conflictos todavía.
- No se sube la base `.db` completa.

---

## Novedades de v2.3.0

- Se agregó sincronización automática opcional.
- La sincronización automática se puede activar o desactivar desde Configuración → Cuenta.
- Por defecto, la sincronización automática está desactivada.
- La sincronización manual sigue disponible con el botón “Sincronizar ahora”.
- Si la sincronización automática está activada, la app puede sincronizar:
  - al iniciar la aplicación;
  - después de crear, editar o borrar datos sincronizables;
  - cada 15 minutos mientras la app permanece abierta.
- Se agregó debounce para evitar sincronizaciones repetidas después de cambios seguidos.
- Se agregó control de simultaneidad para evitar múltiples sincronizaciones al mismo tiempo.
- Se mejoró el estado visual de sincronización en el panel de Cuenta.
- Se muestra información de última sincronización y último error.
- Se mejoró el manejo de errores de conexión con el servicio cloud.
- Si la sincronización falla, los cambios quedan guardados localmente y pendientes de sincronización.
- Se mantiene el enfoque local-first.

---

## Novedades de v2.2.0

- Se amplió la sincronización manual.
- La sincronización incluye:
  - categorías;
  - movimientos;
  - metas de ahorro;
  - gastos programados;
  - gastos fijos;
  - presupuestos.
- Se implementó soft delete para datos sincronizables.
- Los borrados ahora se propagan al backend cloud.
- Se evita que movimientos u otros registros borrados reaparezcan al hacer pull desde cloud.
- Los registros eliminados lógicamente quedan excluidos de listados, reportes, estadísticas y exportaciones.
- El backend cloud fue actualizado para soportar más tablas sincronizadas.

---

## Características principales

- Registro de ingresos, gastos e inversiones.
- Categorías personalizadas.
- Dashboard mensual.
- Estadísticas visuales.
- Reportes mensuales y anuales.
- Exportación a Excel.
- Copias de seguridad.
- Restauración de backups.
- Presupuestos.
- Metas de ahorro.
- Gastos fijos.
- Gastos programados.
- Cuenta opcional.
- Sincronización manual.
- Sincronización automática opcional.
- Funcionamiento offline.
- Almacenamiento local con SQLite.

---

## Enfoque local-first

ScisoNomics está pensada para funcionar aunque no haya conexión a internet.

Los datos financieros se guardan primero en el dispositivo del usuario, usando SQLite local. La sincronización cloud es opcional y no reemplaza el almacenamiento local.

Esto permite:

- usar la app sin internet;
- conservar los datos localmente;
- evitar depender completamente del servidor;
- sincronizar solo cuando el usuario lo desea o cuando activa la sincronización automática.

---

## Sincronización cloud

La sincronización cloud es opcional.

Actualmente permite sincronizar:

- categorías;
- movimientos;
- metas de ahorro;
- gastos programados;
- gastos fijos;
- presupuestos.

La app permite dos modos:

### Sincronización manual

El usuario puede iniciar la sincronización desde:

```txt
Configuración → Cuenta → Sincronizar ahora
