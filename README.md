# ScisoNomics

ScisoNomics es una aplicación de escritorio para gestión de finanzas personales, desarrollada con enfoque **local-first**.

Permite registrar ingresos, gastos, inversiones, presupuestos, metas de ahorro, gastos fijos, gastos programados, reportes, estadísticas y copias de seguridad. Los datos principales se guardan localmente en SQLite, y la sincronización cloud es opcional.

---

## Descarga

Versión estable actual: **v3.0.1**

[Descargar ScisoNomics v3.0.1](../../releases/tag/v3.0.1)

### Actualizar manualmente

- Cerra ScisoNomics antes de instalar una version nueva.
- El instalador de v3.0.1 mantiene el cierre del sidecar y suma hardening de seguridad local/sync.
- Si Windows informa que hay archivos en uso, cancela la instalacion y cerra los procesos desde el Administrador de tareas.
- No uses "Omitir" en archivos de ScisoNomics durante el instalador; podria quedar una app nueva con backend viejo.
- Actualizar la app no borra la base local, backups ni logs.
- Instalador esperado en Windows: `ScisoNomics_3.0.1_x64-setup.exe`.
- Procesos esperados a cerrar si hace falta:
  - `ScisoNomics.exe`
  - `scisonomics-backend.exe`
  - `scisonomics-backend-x86_64-pc-windows-msvc.exe`

---

## Novedades de v3.0.1

- Hardening de sync para evitar mezcla de cuentas si cambia el owner durante una sincronizacion.
- Token local por sesion para proteger la API del sidecar en app instalada.
- Google Login consume el resultado de polling una sola vez.
- Mejor clasificacion de errores de red/cloud.
- Migracion legacy de movimientos mas segura y preservando metadata.
- Tags y relaciones movimiento-tag participan del contrato de sync.
- Pull incremental por cursor de servidor con fallback completo para primera sync y clientes anteriores.
- `schema_version` local formal para detectar instalaciones incompatibles antes de sincronizar.
- El bundle valida que el sidecar generado sea reciente y coincida con las versiones frontend/Tauri/backend.

## Novedades de v3.0.0

- Enfoque en experiencia final de usuario, diagnostico e instalacion.
- ScisoNomics queda siempre en modo oscuro; se elimino el selector claro/oscuro.
- Nueva seccion **Acerca de ScisoNomics** con version, estado local, rutas importantes y estado de sync.
- Acceso rapido a carpeta de datos, backups y logs.
- Boton **Copiar diagnostico** con informacion segura para soporte, sin tokens, secretos ni datos financieros.
- Boton **Buscar actualizaciones** que abre GitHub Releases para descarga manual.
- Mejor onboarding para instalaciones sin datos.
- Mensajes de arranque, base de datos y errores locales mas claros.
- La app sigue siendo local-first, la cuenta sigue siendo opcional y no se sube la base `.db` completa.

---

## Novedades de v2.9.0

- Se agrego Login con Google como metodo alternativo para agregar cuentas cloud.
- El flujo Google se maneja en el backend cloud con `start`, `callback` y `status` por polling.
- El frontend solo abre el navegador externo y guarda el token propio de ScisoNomics cuando el backend confirma el login.
- Email/password sigue funcionando y las cuentas Google conviven con multicuentas locales.
- Si un email ya existe con password, Google se vincula a ese mismo usuario y mantiene el mismo `user_id`.
- Google Login es opcional, requiere variables de entorno en el backend cloud y no guarda secretos en frontend/Tauri.
- La sync sigue corriendo solo para la cuenta activa; modo local sigue separado.

---

## Novedades de v2.8.0

- Se agregó soporte de multicuentas locales en el mismo dispositivo.
- El modo local funciona como un owner separado y no se sincroniza con cloud.
- Se puede cambiar la cuenta activa desde Configuración > Cuenta sin mezclar datos.
- La sincronización manual y automática corren solo para la cuenta cloud activa.
- Quitar una cuenta del dispositivo elimina el acceso guardado, pero no borra datos financieros locales ni datos cloud.
- Se migra automáticamente la sesión única de v2.7.0 a la nueva lista de cuentas guardadas.
- No se sincronizan todas las cuentas en segundo plano y la app sigue siendo local-first.

---

## Novedades de v2.7.0

- Se agregó aislamiento local de cuentas con `owner_user_id` para evitar mezcla de datos entre usuarios.
- Al cerrar sesión, los datos de la cuenta dejan de mostrarse y la sincronización automática se desactiva.
- La sincronización local solo toma datos del usuario activo y no puede subir datos de otra cuenta.
- Los datos locales sin cuenta quedan separados bajo el modo local y pueden asociarse manualmente a una cuenta.
- Se corrigió el cierre accidental de modales al seleccionar texto y arrastrar fuera del contenido.
- Se mejoró el contraste del modo claro en cards, inputs y botones.
- Se prepara la experiencia final con versión visible y actualizaciones manuales desde GitHub Releases.
- La app sigue siendo local-first, la cuenta sigue siendo opcional y no se sube la base `.db` completa.

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
