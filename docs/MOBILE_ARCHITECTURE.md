# ScisoNomics Mobile: interfaz local (milestone 7)

La versión de producto sigue siendo 3.3.1. Mobile incluye Inicio, categorías,
movimientos, gastos fijos, planificación, calendario, presupuestos, metas,
estadísticas, reportes y Configuración locales. Android usa SQLite nativo; Windows continúa
usando FastAPI y su SQLite existente. No se cambia el modelo ni los datos desktop.

## Auditoría de Configuración Desktop (milestone 7, previa a implementación)

Fuentes revisadas: `/configuracion/page.tsx`, `AccountPanel`, providers de
actualizaciones y Premium, `api.ts`, `backupDownload.ts`, `cloudSync.ts`,
`entitlements.ts`, `finance_app/services.py`, `finance_app/db.py`, el backend
local y `src-tauri/LICENSE.txt`. A = portable ahora; B = Mobile pendiente;
C = implementación exclusivamente Desktop.

| Función existente | Clase | Decisión Mobile |
| --- | --- | --- |
| Estado local y accesos rápidos | A | Datos locales, navegación existente |
| Saldo inicial mensual | A | Es un cálculo, no una configuración editable |
| Apariencia | A | Tema oscuro fijo; Providers elimina preferencias de tema antiguas, no existe selector |
| Guías de secciones | B | Onboarding Desktop en layout; handler de reapertura sin botón visible actual |
| Cuenta, multicuentas, Google, recuperación | B | Informativo; siguiente milestone con almacenamiento seguro |
| Sync manual, al abrir/cerrar, automático, intervalo y pendientes | B | Informativo, ninguna llamada cloud |
| Premium y suscripción | B | Información usando metadata del drawer; contratación y permisos pendientes |
| Backups sin cifrar/cifrados y restore con copia previa | B | No habilitar acciones hasta diseñar backup Mobile |
| Protección EFS Windows, carpetas de datos/backups/logs | C | No portar ni mostrar botones |
| Integridad, reparación y diagnóstico FastAPI | C | No ejecutar backend local; futura recuperación SQLite Mobile independiente |
| Exportación Excel / OpenPyXL | C | API disponible, sin acción en Configuración actual; exportación Mobile pendiente |
| Frecuencia de backup | B | API y app_config existentes, sin control visible en Configuración actual |
| Updater firmado, instaladores y Releases GitHub | C | Android informa futuras actualizaciones por tienda, sin botón |
| Acerca de / versión / novedades | A | Versión desde package.json; solo novedades aplicables a Mobile |
| Términos, privacidad y aceptación/licencia | A | Fuente única LICENSE.txt del instalador; no había rutas legales web |
| Soporte | A | Email seleccionable; mailto no está autorizado por capability actual, sin ampliar permisos |

### Semántica de saldo auditada

Desktop **no permite editar saldo inicial**: no hay input, endpoint de escritura
ni clave de configuración para ello. `get_saldo_inicial(month, year)` suma
movimientos activos del owner anteriores al primer día del mes, ingreso positivo
y todos los otros tipos negativos. `get_resumen_mensual_con_saldo` obtiene saldo
actual usando el mismo corte al mes siguiente (también diciembre/enero).
Mobile ya usa esta misma fórmula. `app_config(key,value,updated_at)` Desktop
guarda otras opciones, no un saldo base. No se debe introducir un offset financiero
como supuesto comportamiento Desktop. La edición solicitada requiere decidir
explícitamente si se incorpora una funcionalidad nueva.

## Runtime y almacenamiento


- `getRuntimePlatformSync()` identifica el runtime antes de montar providers.
- Mobile monta `MobileStartupGate`, sin auth, updater, sync ni páginas desktop.
- El gate espera `getMobileDatabase()`. Ante un fallo ofrece **Reintentar** sin
  borrar datos. Sólo monta `MobileApp` cuando SQLite y la migración están listos.
- URL lógica: `sqlite:scisonomics-mobile.db`, sin colisión con los nombres desktop.
- El plugin resuelve el archivo dentro de `app_config_dir()` de la aplicación,
  en el almacenamiento privado Android. La ruta absoluta depende del runtime;
  no se fija una ruta Windows ni del emulador.
- En el APK debug validado, la ruta resuelta es
  `/data/user/0/com.scisoftware.scisonomics.debug/scisonomics-mobile.db`.
  Release usa `com.scisoftware.scisonomics`; Windows conserva `com.scisonomics.desktop`.
- La conexión se carga de forma lazy, comparte una sola promesa entre llamadas
  concurrentes y se reutiliza. Un error limpia el estado de inicialización para
  permitir reintentar. Los componentes no reciben SQL ni handles de conexión.
- Cerrar o forzar el cierre de la app conserva el archivo. Desinstalar la app o
  borrar su almacenamiento Android elimina los datos: no hay backups en esta fase.
- No se usan localhost, Python ni localStorage para los datos financieros.

Se usa el [plugin SQL oficial de Tauri](https://v2.tauri.app/plugin/sql/), fijado
a 2.3.1 tanto en JavaScript como en Rust. Esta versión permite conservar el API
Tauri JavaScript 2.11.0 ya instalado. Rust sólo incluye la dependencia para
Android/iOS y registra el plugin bajo `#[cfg(mobile)]`, con feature `sqlite`.
iOS no se compila ni se valida en este milestone.

## Auditoría desktop y decisiones del milestone 4

Auditados antes de implementar: `finance_app/db.py`, `finance_app/services.py`,
schemas/endpoints del backend local, `services/api.ts`, `types/domain.ts`, las
tres páginas desktop, `GastosFijosView` y la asignación de metas de `MovimientosView`.

- **Gastos fijos**: categoría, descripción (1–500), monto positivo, día de
  vencimiento 1–31, activo 0/1. Son plantillas **mensuales**, sin campo frecuencia
  ni próxima fecha persistidos. Desktop tiene una operación separada de aplicación
  mensual que limita el día al último del mes y evita duplicados por fecha/tipo/
  categoría/descripción `[FIJO]`/monto/owner. Mobile implementa la definición CRUD;
  no aplica ni genera movimientos automáticamente. La UI muestra día mensual y
  activo/inactivo, sin inferir que esté pagado ni agregar otra periodicidad.
- **Presupuestos**: categoría, mes, año, monto positivo; UNIQUE por
  `(owner_user_id, categoria_id, mes, anio)`, incluyendo tombstones. Desktop hace
  upsert por esa clave, conservando identidad y restaurando el registro borrado.
  Consumo = suma de movimientos activos **tipo gasto** de la misma categoría,
  owner y mes/año. Restante = límite − consumo (puede ser negativo), porcentaje =
  consumo/límite × 100, excedido = consumo > límite. No se persisten derivados.
  Crear guarda con el mismo upsert. Editar en mobile cambia el límite del registro
  seleccionado, conservando categoría/período; para otro período se crea otro
  presupuesto. Desktop sólo expone POST upsert, no un PUT por id: el adaptador
  desktop delegará a ese API existente sin agregar endpoints.
  Etiquetas visuales desktop: >100 superado, =100 al límite, >=70 cerca, <70 en control.
- **Metas**: nombre (1–160), objetivo >0, inicial >=0, fecha objetivo opcional,
  descripción hasta 2000, estado `activa|pausada|completada`. Progreso = inicial +
  suma histórica de **ahorros asignados explícitamente por movimientos.meta_id**,
  activos del mismo owner; no suma ahorros sin asignar ni depende del mes elegido.
  Faltante = max(0, objetivo − progreso); porcentaje sin limitar a 100. Estado
  editable, nunca se completa automáticamente por llegar al objetivo. Al borrar,
  desktop desvincula movimientos, conserva sus montos y los marca pending; luego
  deja tombstone de la meta. Mobile conserva esas reglas y agrega el selector
  opcional de meta al formulario de ahorro (todas las metas no borradas, como desktop).
- Los tres modelos llevan owner/sync_id/timestamps/deleted_at/sync_status/
  last_synced_at. Updates conservan id/sync_id/created_at/owner y last_synced_at;
  modifican updated_at y pending. Deletes lógicos. Eliminar una categoría sin
  movimientos activos elimina lógicamente sus presupuestos/gastos fijos, como desktop.
- V2 será aditiva: tres tablas nuevas, índices, y **meta_id nullable en movimientos**
  con FK. La columna es necesaria para el progreso real; no se reconstruye ni
  reescribe ningún movimiento/categoría. Triggers validan owner de meta y hacen
  las desvinculaciones/cascadas de soft-delete atómicamente. V1 queda intacta.
- Owner actual = `local`. Sidebar identifica los tres módulos como `premium`
  con las feature keys desktop. Permanecen accesibles sólo para desarrollo:
  el gating comercial mobile es requisito antes de cualquier release pública.
  No se alteran entitlements ni gating desktop.

## Auditoría desktop y decisiones del milestone 5 (previa a implementación)

Revisados `finance_app/db.py`, `finance_app/services.py`, schemas y endpoints
locales, `services/api.ts`, `types/domain.ts`, las páginas Next de Planificación
y Calendario, `PlanificacionView`, la ventana Python de planificación y sus
relaciones con categorías/movimientos/gastos fijos/presupuestos/metas.

- Planificación persiste **gastos_programados**: descripción 1–500, categoría,
  monto_estimado >0, fecha_vencimiento YYYY-MM-DD, estado pendiente/pagado/cancelado,
  es_recurrente 0/1, frecuencia mensual/semanal/anual (NULL si no recurrente).
  Lista global del owner, ordenada por vencimiento/id; filtros de estado y ventana
  opcional desde hoy hasta hoy + N días, ambos extremos incluidos. Lleva toda la
  metadata de sync y borrado lógico del resto de entidades.
- Crear/editar un gasto programado, incluso con estado pagado, **no crea un
  movimiento**. Marcar pagado es una operación explícita diferente: en una misma
  transacción cambia estado, crea un gasto real con fecha local de hoy, descripción,
  categoría y monto estimado, y genera el siguiente pendiente si es recurrente.
  Repetir sobre pagado no modifica nada. Desktop también admite la operación sobre
  cancelado desde el servicio, aunque la UI sólo la ofrece para pendiente.
- La recurrencia usa el vencimiento anterior, no la fecha de pago: semanal +7 días;
  mensual +1 mes con día limitado al último del destino; anual +1 año con el mismo
  ajuste (29/2 → 28/2). Desktop evita duplicar el siguiente pendiente por owner,
  descripción/categoría/monto/fecha, sin requerir igual frecuencia. Editar o borrar
  planificación no elimina movimientos ya creados. Eliminar una categoría sin
  movimientos activos también borra lógicamente sus gastos programados.
- El resumen existente calcula vencidos (<hoy), pendientes próximos 30 días
  inclusivos, pagados según vencimiento del **mes actual**, y proyección del mes
  elegido = ingresos reales − gastos reales − pendientes que vencen ese mes.
  No incluye saldo anterior, ahorros, inversiones, presupuestos, metas ni plantillas
  de gastos fijos. Se conservarán estos detalles, sin escenarios nuevos ni modificar
  el saldo real del Dashboard. El resumen se mostrará identificado como proyección.
- Calendario es **derivado exclusivamente de movimientos reales activos** del
  owner y mes solicitado, agrupados por fecha y ordenados fecha/id ascendente.
  No muestra gastos fijos, vencimientos, planificación pendiente ni fechas de metas.
  Para sus totales desktop clasifica como inversión cualquier categoría cuyo nombre
  contenga `invers`, conservando el tipo original en el detalle del movimiento.
  Balance diario = ingreso − gasto − ahorro − inversión. No tiene filtros de eventos.
- Su grilla desktop empieza lunes, contiene 42 días y permite seleccionar días
  adyacentes; sólo el mes consultado lleva datos. Al tocar se muestra detalle o
  estado vacío. Mobile conservará esa semántica con celdas compactas y cantidades,
  y detalle separado, sin tablas HTML. No habrá tabla calendario ni expansión de
  gastos fijos día 31: éstos no son una fuente del calendario actual. La regla de
  ajustar meses cortos pertenece a la recurrencia programada/aplicación de fijos,
  no a eventos inventados del calendario.
- V3 será aditiva: una sola tabla gastos_programados, FK compuesta categoría/owner,
  checks de fecha/estado/frecuencia/montos, índices y trigger de cascade lógico de
  categoría. V1/v2 permanecerán byte a byte intactas. No se alteran filas existentes.
- Para el pago explícito se necesita una conexión transaccional única: ejecutar
  BEGIN/COMMIT mediante llamadas separadas al pool del plugin SQL sería inseguro.
  Se agregará un puente nativo mobile para ejecutar un batch con bindings en una
  transacción del pool existente. El SQL seguirá en el repository; no en React.
  SQLx 0.8.6 ya está en el lockfile; se declarará directamente sólo en target mobile,
  sin cambiar versiones ni el grafo Windows. No se agregará otro archivo SQLite.
- Las fechas son días locales sin hora; pago usa getLocalDateInputValue y el
  calendario Date local al mediodía. No convertir fechas de dominio a UTC.
  UI compartirá mes/estado y refrescará una vez tras mutar. Planificación lleva
  premium=true / planning; Calendario es free. Ambos accesibles en desarrollo;
  gating comercial mobile sigue pendiente antes de distribuir públicamente.

## Migración v1

Fuente de verdad: `modern_app/frontend/src-tauri/migrations/0001_mobile_finance.sql`.
Rust registra version 1, descripción `mobile_finance_core`, kind `Up`.
`Database.load()` aplica las migraciones mediante SQLx; su tabla técnica
`_sqlx_migrations` guarda versiones/checksums y evita repetir una migración aplicada.
El SQL inicial también usa `IF NOT EXISTS`; no incluye DROP ni copia datos desktop.
Una migración publicada debe conservarse y las ampliaciones usar otra versión.

SQLx configura `foreign_keys=ON` por conexión, también en el pool. La migración
declara el PRAGMA y el startup comprueba su valor y que las versiones 1, 2 y 3 figuren exitosas
en `_sqlx_migrations`. Un PRAGMA ejecutado una sola vez desde JS no garantizaría
las restricciones en todas las conexiones del pool.

V1 creó estas dos tablas de dominio (además de metadatos técnicos SQLx/SQLite):

### categorias

| Campo | SQLite / restricciones |
|---|---|
| id | INTEGER PRIMARY KEY AUTOINCREMENT |
| nombre | TEXT NOT NULL; nombre no vacío, hasta 120 caracteres |
| tipo | TEXT NOT NULL; ingreso, gasto, ahorro, inversion |
| owner_user_id | TEXT NOT NULL; default local, no vacío |
| sync_id | TEXT NOT NULL; UUID generado al crear; índice único |
| created_at, updated_at | TEXT NOT NULL; default CURRENT_TIMESTAMP |
| deleted_at | TEXT nullable; tombstone al eliminar |
| sync_status | TEXT NOT NULL; default pending |
| last_synced_at | TEXT nullable |

`UNIQUE(owner_user_id, nombre, tipo)` reproduce la unicidad desktop incluso
para tombstones. `UNIQUE(id, owner_user_id)` permite una FK compuesta segura.
Índice adicional por owner/tipo.

### movimientos

| Campo | SQLite / restricciones |
|---|---|
| id | INTEGER PRIMARY KEY AUTOINCREMENT |
| fecha | TEXT NOT NULL; fecha real YYYY-MM-DD |
| tipo | TEXT NOT NULL; los mismos cuatro tipos desktop |
| categoria_id | INTEGER NOT NULL |
| descripcion | TEXT NOT NULL; default vacío, hasta 500 caracteres |
| monto | REAL NOT NULL; mayor que cero |
| nota | TEXT NOT NULL; default vacío, hasta 4000 caracteres |
| owner_user_id | TEXT NOT NULL; default local, no vacío |
| sync_id | TEXT NOT NULL; UUID generado al crear; índice único |
| created_at, updated_at | TEXT NOT NULL; default CURRENT_TIMESTAMP |
| deleted_at | TEXT nullable |
| sync_status | TEXT NOT NULL; default pending |
| last_synced_at | TEXT nullable |

FK `(categoria_id, owner_user_id)` → `categorias(id, owner_user_id)`.
Índices por owner/fecha/id y categoría/owner. No hay cascada destructiva.

Las queries usan bindings `$1`, `$2`, etc., filtran owner `local` y omiten
tombstones. La creación valida categoría activa y existente del mismo owner.
Como desktop, no obliga a que el tipo de la categoría coincida con el movimiento.
Se validan montos finitos positivos con hasta dos decimales, fechas reales,
tipos e IDs permitidos y longitudes. La UI no muestra errores SQL ni rutas nativas.

## Compatibilidad auditada

Se revisaron `finance_app/db.py`, `finance_app/services.py`, schemas del backend
local, `types/domain.ts` y `services/api.ts`. No existe `finance_app/models.py`;
`MovimientoInput` es un dataclass de services.

Se conservan nombres y tipos de las columnas de núcleo, IDs numéricos, owner,
`sync_id`, timestamps y borrado lógico. Desktop permite monto >= 0 en SQLite,
pero su API exige > 0: mobile adopta > 0 y valida centavos. Se normalizan textos
opcionales a vacío, compatible con los tipos frontend.

V2 agrega `meta_id` y FK a metas. Pendientes: tags/tabla puente; metadatos
`last_remote_device_id`, `last_remote_device_name`, `last_remote_updated_at`;
tablas/historial de sync y resolución de conflictos.
Los campos sync reservados no implementan ni autorizan sincronización cloud.
No hay users/auth mobile ni traducción de IDs Windows/Android.

## FinanceRepository

Contrato en `services/data/financeRepositoryTypes.ts`: list/create/update/delete
para categorías, movimientos, gastos fijos, presupuestos, metas y gastos programados;
`getSummary`, `getSchedulingSummary`, `getCalendar`, `markGastoProgramadoPaid`,
`getStatistics`, `getMonthlyReport` y `getAnnualStatistics`.
Devuelve los tipos existentes `Categoria` y `Movimiento`; las creaciones devuelven
void como las operaciones desktop. El nombre evita la colisión Windows entre
`FinanceRepository.ts` y `financeRepository.ts`.

`getFinanceRepository()` importa sólo la rama seleccionada:

- Android/iOS Tauri → `mobileFinanceRepository`, mediante plugin SQL.
- Desktop Tauri/browser → `desktopFinanceRepository`, que delega a `api.ts`
  conservando HTTP, owner activo y notificaciones existentes de sync.

La lectura de movimientos añade `categoria_id` opcional al DTO existente para
editar la relación por ID en mobile. No cambia el DTO ni los endpoints desktop.
Al guardar en otro mes la UI muestra ese período.

## Navegación y pantallas

`MobileApp` es un shell: usa `usePathname()` y los enlaces Next existentes.
Monta una sola vista según `/dashboard`, `/movimientos`, `/categorias`,
`/gastos-fijos`, `/planificacion`, `/calendario`, `/presupuestos`, `/metas`,
`/estadisticas` o `/reporte`. El alias desktop `/reporte-mensual` también resuelve
a la misma vista mobile, conservando la redirección Next existente.
No crea otro router ni monta los layouts/providers financieros desktop.
Las rutas no implementadas en mobile vuelven a `/dashboard`.

`MobileHeader` muestra el título, branding y botón de menú. `MobileSidebar`
abre un drawer izquierdo con overlay, X, cierre exterior/Escape y al navegar.
El diálogo nativo mantiene el foco dentro y devuelve el foco al cerrar; el fondo
queda inerte y se bloquea su scroll. Incluye safe areas, targets de 44–48 px,
scroll propio y animación que respeta reduced motion. No hay bottom navigation.
La lista de secciones permite agregar módulos futuros cuando estén implementados.

- Inicio: saldo acumulado, saldo anterior, ingresos/gastos/ahorros/inversiones
  del período, últimos cinco movimientos y Agregar movimiento.
- Movimientos: cards, mes/año, filtro por tipo y crear/editar/eliminar con confirmación.
- Categorías: filtro por tipo, crear/editar/eliminar con confirmación.
- Gastos fijos: plantillas mensuales, categoría, monto, día y estado; CRUD.
- Planificación: gastos programados CRUD, filtros de estado, recurrencias, proyección
  y pago explícito con confirmación que registra un gasto real.
- Calendario: grilla lunes/domingo de 42 celdas, navegación mensual y detalle de
  movimientos reales al tocar un día. Sin fuentes planificadas ni tabla calendario.
- Presupuestos: mes/año, límites por categoría, consumo real, restante y porcentaje; CRUD.
- Metas: objetivo/inicial/fecha/estado, avance por ahorros asignados y CRUD.
- Estadísticas: totales del mes, tipos, gastos por categoría y detalle táctil,
  evolución anual y proyección identificada por separado.
- Reporte: lectura mensual y anual con los períodos y fórmulas desktop.
- Formularios: montos con teclado decimal/parser desktop, fecha local, categoría,
  descripción y nota opcional. No se crean defaults ni datos demo automáticamente.

La UI filtra categorías igual que el formulario desktop, incluyendo nombres
legacy de ahorro/inversión. El repositorio exige una categoría activa del mismo
owner, como el servicio desktop; no altera movimientos existentes al renombrar
una categoría o cambiar su tipo.

## CRUD y política de borrado

Updates conservan `id`, `sync_id`, `created_at` y `owner_user_id`, actualizan
`updated_at` y marcan `sync_status=pending`. Delete es soft-delete: establece
`deleted_at`, actualiza timestamp y estado pending; nunca ejecuta DELETE físico.
Se excluyen tombstones de listas y saldos.

No se elimina una categoría con movimientos activos asociados. La comprobación
está dentro del UPDATE con NOT EXISTS para no dejar una ventana entre comprobar
y borrar. INSERT/UPDATE de movimientos también exigen categoría activa dentro
de la escritura. Las FK siguen válidas para los movimientos borrados porque
las categorías permanecen físicamente. La unicidad v1 incluye tombstones:
un nombre/tipo eliminado sigue reservado, como desktop; no se resucita en silencio.
No se modifica la migración v1. V2 agrega los módulos descritos más abajo.

Después de cada escritura hay una recarga compartida de categorías, movimientos
y resumen, gastos fijos, presupuestos, metas, gastos programados y proyección.
Las ocho lecturas se hacen en paralelo; el calendario deriva de los movimientos
ya cargados sin otra consulta. Se ejecutan
una vez por carga/escritura/período, no por navegación. Se bloquean submits duplicados, se descartan lecturas tardías de otro
período y no se actualiza un componente desmontado. No hay polling.

En Estadísticas/Reporte se suspenden esas ocho lecturas generales. El hook
`useMobileAnalytics` carga sólo el análisis elegido y, para el detalle de
Estadísticas, los movimientos del mes. Descarta respuestas tardías al cambiar
mes/año/vista o desmontar, ofrece reintento explícito y no hace polling.

## Reglas de saldo

`getSummary` agrega desde SQLite todos los registros activos del owner local
hasta el fin del período, y separa el saldo inicial de los totales del mes.
La fórmula coincide con `get_resumen_mensual_con_saldo`/`get_saldo_inicial` desktop:

`saldo = saldoInicial + ingresos - gastos - ahorros - inversiones`.

`saldoInicial` incluye todo el historial anterior una sola vez; un mes vacío
hereda ese saldo, incluso si es negativo o cruza diciembre/enero.
El **balance operativo del mes** sigue siendo `ingresos - gastos`.
`financeSummary` suma en centavos para evitar ruido de decimales.
`saldo_acumulado` de cada movimiento usa todo el historial local previo en orden
fecha/id, deduciendo los otros tipos, como la lista de movimientos desktop.
No confundir ese campo con el balance operativo del mes. Fechas guardadas son
YYYY-MM-DD sin zona horaria: el mes inicial usa `getLocalDateInputValue`, y la
fecha visible usa calendario local/es-AR sin interpretar el string como UTC.

## Permisos

`capabilities/mobile-sql.json`, ventana `main`, plataformas android/iOS:
`sql:default` (load/select/close) y `sql:allow-execute` (escrituras).
No se añaden permisos SQL al capability compartido ni al updater desktop.

## Validación y prueba de persistencia

Desde `modern_app/frontend`:

```powershell
npm run test:mobile
node --test tests/platformStartup.test.cjs
npm run test:auth
npm run test:billing
npm run test:updater
npm run build
cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --locked
cargo test --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --locked
npx tauri android run --no-watch
```

`test:mobile` usa SQLite real mediante `node:sqlite` (Node >=22.13; entorno actual
Node 24). Sustituye sólo el puente IPC del plugin, verifica schema/queries,
bindings, owners, tombstones y persistencia en un archivo temporal; no toca DBs
de usuario. La validación nativa requiere ejecutar el APK en Android.

Registro histórico del milestone 2, antes del identifier definitivo y del CRUD:
validado el 4 de octubre de 2026 en Pixel_8 / x86_64 mediante
`npx tauri android run --no-watch Pixel_8`: APK compilado e instalado; categoría
y movimientos creados desde los formularios del WebView; cierre con force-stop,
ausencia de PID confirmada y reapertura COLD en un PID distinto. Se conservaron
Prueba Mobile, ingreso 10000, gasto 2500 y balance 7500. No se reinstaló ni se
borró almacenamiento entre el cierre y la reapertura. El WebView reabierto no
registró errores de página ni requests al API desktop durante la comprobación.

## Próximo milestone

Ampliar la UX local Android de forma incremental. Auth, sync cloud, migración desde
Windows, Premium, backups y demás módulos requieren milestones independientes.

## Migración v2 y módulos de planificación

`0002_mobile_planning.sql` se registra como versión 2 / `mobile_planning`, sólo
en el plugin mobile. SQLx aplica una vez y verifica el checksum. Startup comprueba
v1 y v2 (desde milestone 5 también v3) antes de abrir el shell; un fallo permite Reintentar sin borrar almacenamiento.

| Tabla | Campos propios y restricciones |
|---|---|
| gastos_fijos | categoria_id FK por id/owner, descripcion 1–500, monto >0, dia_vencimiento 1–31, activo 0/1 |
| presupuestos | categoria_id FK por id/owner, mes 1–12, anio 1–9999, monto >0; UNIQUE owner/categoría/mes/año |
| metas_ahorro | nombre 1–160, monto_objetivo >0, monto_inicial >=0, fecha_objetivo nullable YYYY-MM-DD real, descripcion hasta 2000, estado activa/pausada/completada |

Cada tabla agrega `id INTEGER PRIMARY KEY AUTOINCREMENT`, owner local no vacío,
sync_id único, created_at/updated_at CURRENT_TIMESTAMP, deleted_at nullable,
sync_status pending y last_synced_at nullable. Índices: owner/activo/día y categoría
para gastos fijos, owner/año/mes para presupuestos, owner/estado para metas.
`movimientos.meta_id` nullable referencia metas; un índice y triggers impiden
relaciones entre owners sin reconstruir movimientos. NULL no cambia filas v1.

Los triggers de soft-delete desvinculan movimientos de una meta eliminada y
borran lógicamente presupuestos/gastos fijos de una categoría eliminada, dentro
de la misma sentencia. No eliminan movimientos ni categorías físicamente.
`mobilePlanningRepository` concentra SQL, validaciones y derivados;
`mobileRepositorySupport` comparte montos/fechas/IDs y escrituras sanitizadas.
FinanceRepository agrega list/create/update/delete para los tres módulos;
el adaptador desktop usa gastosFijos/createGastoFijo/updateGastoFijo/deleteGastoFijo,
presupuestos/upsertPresupuesto/deletePresupuesto y metas/createMeta/updateMeta/deleteMeta
del API existente. No se agregan llamadas HTTP ni se modifica el API desktop.

Sidebar reserva metadata `premium=true`, feature keys `fixed_expenses`, `budgets`,
`saving_goals`. No representa una autorización comercial ni llama a billing.
El gating mobile deberá implementarse antes de distribuir una release pública.
Planificación y Calendario se incorporan en v3; siguen pendientes Estadísticas,
Reporte y Configuración.

## Migración v3, planificación y calendario

`0003_mobile_scheduling.sql`, versión 3 / `mobile_scheduling`, crea únicamente
`gastos_programados`: id, descripción, categoría, monto estimado, vencimiento,
estado, recurrencia y frecuencia, más owner/sync_id/created_at/updated_at/deleted_at/
sync_status/last_synced_at. CHECK exige texto no vacío hasta 500, monto positivo,
fecha real YYYY-MM-DD, estado válido y frecuencia coherente con recurrencia.
FK `(categoria_id, owner_user_id)` mantiene aislamiento; índices por owner/estado/
vencimiento y categoría/owner. Un trigger nuevo borra lógicamente planificación
cuando se elimina una categoría, sin alterar los triggers ni SQL de v1/v2.

Los nuevos métodos son listGastosProgramados(estado, días), createGastoProgramado,
updateGastoProgramado, deleteGastoProgramado, markGastoProgramadoPaid,
getSchedulingSummary(período) y getCalendar(período). Desktop delega a
gastosProgramados/create/update/delete/marcarPagado, stats.planificacion y
calendario del API existente; no se cambia ningún endpoint ni página desktop.

`mobileSchedulingRepository` conserva todo el SQL con bindings. El pago usa tres
sentencias que vuelven a comprobar registro/owner/estado/categoría dentro de la
misma transacción: insertar el gasto real de hoy, crear el siguiente pendiente
si no existe, y marcar pagado. Si una falla, rollback revierte las tres. Repetir
un pago no vuelve a generar movimientos. No usa valores financieros de una lectura
previa para escribir. El puente `mobile_sql_transaction` usa el pool del plugin
existente, sólo se compila/registra en mobile y devuelve cantidades de cambios;
los errores nativos no exponen SQL ni datos. SQLx se declara en Cargo sólo para
Android/iOS en la misma versión 0.8.6 previamente resuelta, sin nuevas versiones.

Calendar deriva de los movimientos compartidos, sin otra lectura ni tabla.
También existe getCalendar para consumidores del contrato: filtra por owner y
mes y excluye tombstones. Días sin datos siguen visibles; detalle distingue
Ingreso/Gasto/Ahorro/Inversión textualmente. La categoría legacy `invers` sólo
afecta sus totales, igual que desktop. Metadatos timestamp nunca son fechas de
evento: el modelo de dominio sólo admite fechas sin hora. `financeCalendar`
construye fechas locales al mediodía y reusa getLocalDateInputValue; evita parsear
YYYY-MM-DD como UTC. Navegar diciembre/enero conserva el año correctamente.

Drawer: Inicio, Movimientos, Categorías, Gastos fijos, Planificación, Calendario,
Presupuestos, Metas. Planificación lleva premium/planning; Calendario free.
No se implementan auth, billing, gating, sync ni notificaciones mobile.
Diferencias UX: cards en lugar de tablas y confirmación explícita antes de
registrar un pago. El Dashboard real conserva su fórmula; proyección se muestra
por separado en Planificación. El calendario no anticipa gastos fijos día 31 ni
vencimientos programados: sólo muestra movimientos reales, como desktop.

## Auditoría Desktop del milestone 6 (antes de implementar)

Fuentes revisadas: finance_app/db.py, services.py, exporter.py, endpoints
/estadisticas, /estadisticas/anual y /reporte-mensual del backend local,
services/api.ts, types/domain.ts, páginas estadisticas/reporte/reporte-mensual,
EstadisticasView.tsx, Sidebar.tsx y entitlements.ts. No existen entidades
persistentes de estadísticas/reporte: son lecturas de las tablas financieras.

Estadísticas Desktop selecciona mes y año; por defecto el actual, años actual
±3 y botón Mes actual. No hay rangos ni filtro por tipo. /estadisticas devuelve:
summary (saldo inicial, saldo actual y balance final), month_totals, categorías
de gasto, tendencia de los 12 meses del año y resumen de planificación.
Ingresos/gastos/ahorros/inversiones son SUM por tipo real. Balance operativo =
ingresos - gastos; disponible luego de ahorro = balance - ahorro. Saldo actual
es acumulado histórico descontando los cuatro tipos, mientras balance_final
legacy = saldo inicial + ingresos - gastos. No intercambiar estas métricas.

Categorías: sólo tipo gasto, agrupadas por id/nombre, owner coincidente, tanto
movimiento como categoría activos, total positivo, orden descendente por total.
Porcentaje = total categoría / suma de categorías * 100; base cero produce 0.
Tocar categoría abre sus movimientos del mes (Desktop muestra hasta 40), con
fecha, descripción, importe y nota. Las barras muestran cuatro tipos; la línea,
ingresos y gastos de todo el año, con meses vacíos en cero. No hay comparación
porcentual con mes anterior en esa UI. Mes vacío mantiene evolución anual si
existe; año sin datos tiene estado vacío. Se excluyen tombstones y otros owners.
Recharts 2.12.7 ya está instalado: Desktop usa LineChart fijo de 640 px y barras
CSS. Mobile adaptará el ancho disponible y tendrá detalle textual táctil, sin nueva librería.
Planificación sólo aparece identificada aparte: vencidos, próximos 30 días,
pagados por vencimiento del mes actual y proyección del mes seleccionado,
reutilizando las reglas del milestone 5; no altera estadísticas reales.

Reporte: /reporte es un alias que redirige a /reporte-mensual en Desktop. Esa
pantalla tiene pestañas Mensual y Anual. Mensual selecciona mes/año (yearOptions:
actual -5 hasta +2, incluyendo año seleccionado). API expone ingresos, gastos,
ahorro, inversiones, balance operativo, disponible luego de ahorro, top 5
categorías y top 5 gastos (importe DESC, fecha DESC), evolución de los últimos
6 meses inclusive, presupuestos estrictamente excedidos y metas activas.
La pantalla actual sólo muestra seis métricas y los dos tops; Mobile también
puede presentar las secciones ya existentes en esa misma respuesta. El servicio
calcula comparaciones/deltas/porcentajes respecto al mes anterior, pero el
endpoint los descarta: no inventar ni exponer ese contrato desde Mobile.
El reporte mensual NO expone saldo acumulado ni planificación/proyección;
balance operativo no hereda historial ni descuenta ahorros/inversiones.
Inversiones del reporte mensual usa la regla legacy categoría cuyo nombre
contiene `invers`, independientemente de tipo (y categoría activa); conservarla,
sin reemplazarla por la suma por tipo de Estadísticas/Anual. Metas activas usan
inicial + ahorros reales asignados históricos; presupuestos usan sólo gastos
reales del mes/categoría. No sumar iniciales de metas ni planes al balance.

Anual: 12 meses, cuatro tipos, cantidad de movimientos y balance = ingresos -
gastos - ahorros - inversiones. Promedios dividen por 12 incluso con meses
vacíos. Mes máximo usa el primer mes en caso de empate; categorías anuales
agrupan por nombre, sólo gastos y referencias activas. Año vacío muestra estado
vacío. No hay rango de fechas en estos módulos. Estadísticas y Reporte son free
en la Sidebar/API actuales; planificación/presupuestos/metas conservan su propia
metadata Premium, sin gating mobile durante desarrollo.

Exportación Desktop es XLSX/OpenPyXL (mensual/anual/rango y movimientos),
administrada desde Configuración/API, no un botón funcional en estos reportes.
Incluye resumen, movimientos/tipos, categorías, fijos, presupuestos, metas y
planificación pendiente. No hay PDF en estos módulos. No se portará exportación.

Decisión: tres lecturas getStatistics/getMonthlyReport/getAnnualStatistics;
Desktop delega a las tres APIs existentes y Mobile agrega por SQL, reutilizando
getSummary, listPresupuestos, listMetas y getSchedulingSummary. Helpers puros
para porcentajes/meses vacíos/anual; ninguna fórmula financiera en componentes.
Queries por rango YYYY-MM-DD usan idx_movimientos_owner_fecha y los índices de
categoría/owner existentes. No se justifica v4: cero tablas, columnas o índices
nuevos. Las lecturas mobile no escriben. Diferencia heredada del milestone 4:
get_month_summary Desktop aplica fijos antes de leer; Mobile no aplica plantillas
automáticamente. Si existe un movimiento real generado desde fijo/pago, se
incluye normalmente. Este milestone no cambia ese comportamiento de escritura.

## Implementación del milestone 6

Los tres métodos nuevos del contrato son lecturas:

| Método | Desktop | Mobile |
|---|---|---|
| getStatistics({ month, year }) | api.stats(month, year) | resumen compartido, categorías, 12 meses y planificación |
| getMonthlyReport({ month, year }) | api.reporteMensual(month, year) | seis métricas, tops, seis meses, presupuestos y metas |
| getAnnualStatistics(year) | api.statsAnual(year) | agregados anuales, 12 meses, promedios y máximos |

`mobileAnalyticsRepository.ts` concentra SQL con parámetros y filtros por owner
local/tombstones. `financeAnalytics.ts` concentra fórmulas, porcentajes, períodos
y relleno de meses vacíos; React sólo presenta resultados. Se reutilizan las
lecturas existentes de saldo, presupuestos, metas y planificación. Los agregados
anuales y de seis meses devuelven filas por mes, sin cargar todo el historial
de movimientos en JavaScript. El detalle de categorías carga sólo el mes elegido.
Las pruebas EXPLAIN comprueban el índice existente `idx_movimientos_owner_fecha`.

Fórmulas conservadas:

- Balance operativo mensual = ingresos - gastos.
- Disponible luego de ahorro = balance operativo - ahorro.
- Saldo real de Inicio = saldo inicial + ingresos - gastos - ahorros - inversiones.
- Balance anual y mensual dentro del reporte anual = ingresos - gastos - ahorros - inversiones.
- Participación por categoría = total / suma de categorías * 100; base cero = 0.
- Promedios anuales = total / 12. Se incluyen meses vacíos; máximos empatados
  conservan el primer mes, igual que Desktop.
- Reporte mensual conserva la clasificación legacy por nombre de categoría
  `invers`; Estadísticas y Anual suman por tipo real. No se unifican esas reglas.

Fechas de dominio YYYY-MM-DD y límites exclusivos del mes siguiente se construyen
sin conversión UTC. Las ventanas manejan diciembre/enero. La evolución mensual
incluye exactamente seis meses consecutivos hasta el seleccionado; la anual,
doce meses del año seleccionado. Cada módulo inicia en el período local actual,
igual que Desktop. No se agregó rango libre ni comparación descartada por el API.

`MobileStatistics` muestra cinco métricas, barras por tipo, participación y
detalle de hasta 40 gastos por categoría, evolución anual y las cuatro métricas
de planificación separadas. `MobileReport` ofrece Mensual/Anual: mensual muestra
las seis métricas y secciones que ya entrega el API; anual presenta totales,
promedios, máximos, cantidad de movimientos y doce resúmenes mensuales. No se
mezclan iniciales de metas, plantillas ni pendientes en estadísticas reales.
Los movimientos generados por el pago explícito de planificación sí se cuentan.

Recharts existente usa LineChart, líneas continua/punteada, leyenda textual y un
desplegable táctil con todos los valores. El ancho se mide con ResizeObserver y
se pasa explícitamente a LineChart, con altura 240 px y cleanup al desmontar.
La prueba real detectó que ResponsiveContainer de Recharts 2 usa react-is antiguo
que rechaza los elementos react.transitional.element del runtime Next actual:
el contenedor tenía ancho correcto pero descartaba sus hijos, sin gráfico. Se
usa el mismo API de dimensiones explícitas de Desktop, adaptado al contenedor,
sin parchear dependencias ni cambiar versiones. Los ejes también declaran sus
opciones explícitamente: categoría/abajo para meses, número/izquierda para importes,
IDs compartidos 0 y dominio [0, auto]. React actual no aplica los defaultProps de
esas funciones antiguas; omitirlos alteraba la escala y orientación del gráfico.
Se verifica que ambas curvas comparten escala. Los nombres de categoría largos
usan una columna minmax(0, 1fr) para envolver texto sin desborde. Mes vacío conserva la
evolución del año; año vacío informa el estado sin inventar datos. Cards y
selectores usan ancho flexible y targets de 48 px, sin tablas desktop.

Ambos módulos son `premium: false, feature: null`, según la Sidebar Desktop.
Se conserva la metadata Premium de otros módulos; no se agrega gating/billing
mobile. Configuración sigue preparada para un milestone posterior y no aparece
como enlace a una página desktop. Excel/PDF/CSV mobile siguen sin implementarse:
no se ofrecen botones de exportación ni se introduce Python en Android.

No hay tablas, columnas, índices ni migración v4; v1/v2/v3 permanecen intactas.
No se modifican APIs desktop, versión, identifiers, dependencias, auth, sync,
billing, updater, sidecar ni fuentes Rust.

## Validación del milestone 6

Ejecutada el 4 de octubre de 2026, sobre la DB real de prueba de milestones 1–5
en Pixel_8 / x86_64, package com.scisoftware.scisonomics.debug, versión 3.3.1.
`npx tauri android run --no-watch Pixel_8` compiló Rust y generó APK/AAB; el CLI
quedó esperando después de empaquetar. Se completó la instalación con adb
install -r y am start, sin desinstalar, wipe-data, reset de DB ni snapshot nuevo.
Un primer proceso de la última instalación no quedó disponible para CDP; reabrir
la app permitió la validación estable. No se cambió el runtime nativo para ello.

Antes de instalar se registraron mediante SELECT todos los campos de categorías,
movimientos, gastos fijos, presupuestos, metas_ahorro y gastos_programados,
incluidos tombstones/identidades/timestamps. Después de instalar, navegar todos
los módulos y forzar cierre/reabrir COLD (PID 17465 → 19242), las seis tablas
seguían idénticas. SQLx sólo tiene v1/v2/v3 exitosas; foreign_key_check vacío.

Resultados contrastados con la DB:

- Octubre 2026: ingresos 11234, gastos 3150, ahorro 500, inversión 0;
  balance operativo 8084, disponible luego de ahorro 7584, saldo real Inicio 7584.
- Servicios M4: total 3150, 100%, dos gastos; detalle muestra 3000 y el pago real
  Seguro M5 de 150. El movimiento borrado no aparece.
- Reporte mensual: los mismos seis totales, top de gastos correcto, seis meses,
  presupuesto límite 2500 / gasto 3150 / restante -650 / 126%; sin metas activas
  porque la meta existente tiene tombstone.
- Reporte anual 2026: cinco movimientos activos, balance 7584; promedios ingresos
  936.17 y gastos 262.50; máximos octubre, doce meses con ceros donde corresponde.
- Septiembre/diciembre vacíos, enero 2027 y año 2027 vacío correctos. Noviembre
  conserva balance operativo real 0 y muestra proyección -150 por separado.
- Estadísticas, Reporte Mensual y Reporte Anual conservaron estos resultados tras
  el cierre y reapertura. No se creó ni modificó ningún registro para esta prueba.

Las tres vistas y el detalle de categoría pasaron 16 combinaciones a
320/360/390/430 px, sin overflow horizontal; botones de al menos 44 px. Se
inspeccionó captura nativa del gráfico a 320 px, con ambos ejes y curvas en la
misma escala numérica (relación ingresos/gastos correcta). Nombres de categoría
de 120 caracteres sin espacios y descripciones de 500 se probaron temporalmente
en el DOM, sin guardarlos, y envolvieron correctamente. Un adb input tap real
abrió el detalle textual del gráfico tras la reapertura.

Navegación continua de los diez módulos desde drawer, cierre automático al
elegir, X/Escape/overlay y foco comprobados. A 320 × 400 el drawer tiene 398 px
visibles y 763 px de contenido con scroll para los diez enlaces. No hubo errores
JavaScript en la WebView final/reabierta.

Pruebas automáticas: test:mobile 97/97 (repository 48 + UI 49), test:auth 68/68,
test:billing 45/45, test:updater 32/32, platformStartup 24/24 y ejecución explícita
mobileUi 49/49. TypeScript/build correctos, cargo check Windows correcto y cargo
test Windows 9/9, también con assets finales. Sin fallo PKCE en este milestone.
Git diff --check correcto. Se agregaron 21 casos respecto al milestone 5.

Persisten avisos existentes de import Zeroize sin uso en Android, deprecaciones
Gradle y mensaje del linker Windows; no se cambiaron dependencias ni Rust para
silenciarlos. No se validó dispositivo físico, iOS ni instalador Windows completo.
Exportaciones, auth/sync/Premium real y Configuración mobile siguen pendientes.

## Prueba manual del milestone 5

Instalar sobre el mismo sandbox v2, sin desinstalar ni limpiar datos. Comparar
por SELECT todos los campos de las cinco tablas anteriores, incluidos tombstones;
comprobar SQLx v1/v2/v3 y foreign_key_check. Después crear/editar un gasto
programado recurrente, cerrar/reabrir y verificar identidad y proyección. Usar
Marcar pagado y su confirmación para probar la transacción nativa: exactamente
un gasto real con fecha local de hoy y el próximo vencimiento. Eliminar el
programado pagado no debe borrar el movimiento ni la próxima recurrencia.

Calendario: seleccionar un día con movimientos y otro vacío; navegar meses y
ambos cruces de año. Los vencimientos planificados/fijos no deben aparecer sin
movimiento real. Comprobar las ocho rutas desde drawer, su cierre/foco/scroll y
las vistas/formulario a 320, 360, 390 y 430 px, sin desborde horizontal.

Validación automática del milestone 5: test:mobile 76/76, mobileUi 38/38,
platformStartup 24/24, auth 68/68, billing 45/45 y updater 32/32. TypeScript y
build/export frontend correctos. Cargo check Windows correcto y cargo test
Windows 9/9 en ejecución normal, incluido PKCE, sin repetir en serial ni tocar
auth. Android x86_64 compiló e instaló mediante el comando indicado.

Upgrade real comprobado el 4 de octubre de 2026 sobre el mismo package debug:
SQLx v1/v2/v3 exitosas y foreign_key_check vacío. Las cinco categorías, cinco
movimientos (incluidos tombstones), gasto fijo eliminado, presupuesto activo y
meta eliminada conservaron exactamente todos sus campos. La tabla nueva estaba
vacía y el Dashboard mantuvo saldo 7734 y balance mensual 8234. No se modificaron
las migrations v1/v2, la versión, identifiers ni configuración desktop.

Prueba funcional desde la UI del WebView: Seguro M5, categoría Servicios M4,
mensual con vencimiento 2026-10-31, monto 100 → 150. La proyección pasó de 8134
a 8084 y el saldo real siguió en 7734. Se guardó la edición con teclado Android
abierto, desplazando el formulario y tocando Guardar. Un force-stop y arranque
COLD conservaron todos los campos editados, sync_id, owner y created_at.

Marcar pagado y Confirmar pago ejecutaron la transacción nativa: exactamente un
gasto de 150 con fecha local 2026-10-04, owner local y UUID propio; programado
original pagado y próxima recurrencia pendiente 2026-11-30. Calendario mostró
cinco movimientos ese día, ingreso 11234, gasto 3150, ahorro 500 y balance 7584.
Los días 31/10 y 30/11 siguieron vacíos. Se comprobó septiembre vacío, octubre,
noviembre, diciembre, enero 2027 y regreso a diciembre 2026/octubre.

Eliminar la planificación pagada y otro force-stop/arranque COLD conservaron su
tombstone, el gasto real y la próxima recurrencia. Todos los campos de las cinco
tablas anteriores siguieron idénticos; foreign_key_check vacío. El presupuesto
mostró consumo 3150, restante -650 y 126%, sólo después del pago real. No hubo
consumo por el vencimiento pendiente de noviembre.

Las ocho rutas se navegaron continuamente desde el drawer, sin home intermedia.
X/Escape/overlay cerraron y restauraron foco al menú. A 320 × 400 el drawer tuvo
398 px de alto y 651 px de contenido con ocho enlaces accesibles mediante scroll.
Planificación, su formulario y Calendario pasaron las 12 combinaciones a
320/360/390/430 px sin desborde horizontal, botones de al menos 44 px de alto y
42 celdas en Calendario. Se inspeccionaron capturas nativas, incluido Calendario
a 320 px, y el WebView final no registró errores de JavaScript.

Incidencia del entorno: Pixel_8 con imagen Android 17 beta perdió temporalmente
el servicio activity y registró abortos repetidos del HAL UWB. El reinicio normal
restauró ese estado bloqueado. El arranque sin snapshot, autorizado expresamente,
conservó el disco de datos; todos los campos anteriores se volvieron a comparar.
Durante el arranque lento hubo un aborto de Wry GetWebViewVersion/SendError; una
vez completado el boot, el siguiente inicio de la app y las pruebas anteriores
pasaron. No se parchearon Wry/Android ni se borró el sandbox. No se validó iOS,
un dispositivo físico ni un instalador Windows completo en este milestone.

## Prueba manual del milestone 4

1. Registrar por SELECT versiones SQLx, categorías/movimientos y saldo de la
   instalación v1 (incluidos sync_id/timestamps/tombstones).
2. Instalar el APK con `npx tauri android run --no-watch Pixel_8` sin desinstalar
   ni limpiar datos. Comprobar v1/v2 exitosas, FK y todos los campos anteriores;
   sólo `meta_id=NULL` debe agregarse a movimientos. Saldo previo idéntico.
3. Crear una categoría de gasto y un movimiento del mes para probar consumo.
4. Gastos fijos: crear, editar monto/estado, cerrar/reabrir y confirmar. Eliminar,
   cerrar/reabrir y comprobar tombstone y ausencia en listado. Saldo no cambia.
5. Presupuestos: crear en la categoría anterior; comprobar consumo, restante y
   porcentaje. Editar límite, cerrar/reabrir y comprobar persistencia. Probar
   cambio de mes, límite excedido y delete/upsert sin cambiar identidad.
6. Metas: crear con objetivo/inicial/fecha/estado. Crear ahorro asignado desde
   Movimientos, editar meta y comprobar inicial + ahorros asignados; cerrar/
   reabrir. Eliminar y comprobar que se desvinculan, pero conservan los movimientos.
7. Navegar las seis secciones desde drawer, sin volver a Inicio entre módulos.
   Comprobar X/overlay/Escape, foco y scroll; vistas y formularios a 320/360/390/430 px.

Validación del milestone 4 realizada el 4 de octubre de 2026 en Pixel_8 / x86_64,
package `com.scisoftware.scisonomics.debug`, mediante
`npx tauri android run --no-watch Pixel_8`. Se instaló sobre la app existente,
sin desinstalar ni borrar datos. Antes: SQLx v1, tres categorías y tres movimientos
(incluidos tombstones), saldo 11234. Después: v1/v2 exitosas; todos los campos
anteriores idénticos, movimientos con meta_id NULL y foreign_key_check sin errores.
La migration v1 y la versión 3.3.1 quedaron intactas.

Desde la UI nativa se creó Servicios M4 y un gasto de 3000. Gasto fijo Alquiler M4:
5000 → 6000, día 31, luego inactivo. Presupuesto octubre 2026: límite 5000,
consumo 3000, restante 2000, 60%; al editar límite a 2500, restante -500 y 120%
Superado. Meta M4: objetivo 10000, inicial 1000 → 1500, nombre editado y fecha
2027-01-01 elegida con el calendario Android. Un ahorro de 500 asignado explícitamente
produjo progreso 2000 / 20% y faltante 8000. No se generaron movimientos desde
gastos fijos, presupuestos ni iniciales de metas.

Un force-stop, ausencia de PID y arranque COLD conservaron los valores editados,
identidades y relaciones de los tres módulos. Luego se eliminaron gasto fijo y
meta desde sus confirmaciones. Otro arranque COLD conservó ambos tombstones y
sus listados vacíos; el ahorro conservó id/sync_id/created_at/monto y quedó sin
meta. El presupuesto mantuvo sus valores y el saldo siguió en 7734. La comparación
final confirmó nuevamente todos los campos de las categorías/movimientos previos.

Las tres vistas y sus tres formularios se comprobaron a 320, 360, 390 y 430 px:
24 combinaciones sin desborde horizontal, botones de al menos 44 px. En el
formulario de meta, con teclado Android abierto, se pudo desplazar la vista y
pulsar Guardar sin cerrar el teclado. Las seis rutas se navegaron desde el drawer;
X, Escape y overlay cerraron y restauraron foco al menú; a 320 × 400 el drawer
tuvo scroll interno para llegar a todas las secciones.

Validaciones automáticas: test:mobile 57/57, mobileUi 28/28, platformStartup 24/24,
auth 68/68, billing 45/45, updater 32/32, TypeScript y build frontend correctos.
Cargo check Windows correcto. La primera ejecución Rust tuvo un fallo en el test
existente native_pending_pkce_roundtrip_and_cleanup; repetir con
`-- --test-threads=1` pasó 9/9 sin modificar auth. La causa de ese fallo no se
resolvió en este milestone. No se validaron iOS ni un instalador Windows completo.

## Prueba manual del milestone 3

No borrar datos existentes. Registrar el saldo inicial B antes de la prueba.

1. Desde el menú lateral ir a Categorías; crear **Ingreso Mobile**, tipo Ingreso.
2. Ir a Movimientos; agregar ingreso **10000** con esa categoría y fecha de hoy.
3. Crear **Gasto Mobile**, tipo Gasto, y gasto **2500**.
4. Ir a Inicio: saldo esperado **B + 7500**.
5. Editar el gasto a **3000** y descripción **Gasto Mobile editado**.
6. Inicio muestra **B + 7000**.
7. Forzar cierre de `com.scisoftware.scisonomics.debug` y reabrir sin reinstalar.
8. Confirmar monto/descripción editados y el saldo.
9. Eliminar el gasto y confirmar: saldo **B + 10000**.
10. Cerrar/reabrir; el gasto sigue ausente y el saldo se conserva.
11. Intentar eliminar Ingreso Mobile mientras tenga un movimiento activo:
    debe informar que tiene movimientos asociados y conservar la categoría.

También comprobar drawer: hamburguesa, overlay/X/Escape, cierre al navegar,
aislamiento/restauración de foco; y layouts a 320, 360, 390 y 430 px.

Validación del milestone 3 realizada el 4 de octubre de 2026 en Pixel_8 / x86_64,
package `com.scisoftware.scisonomics.debug`, con APK compilado mediante
`npx tauri android run --no-watch Pixel_8`. Se conservaron los datos previos:
saldo base B = 1234 (Sandbox Android / Prueba Identificador). Se crearon las dos
categorías y movimientos indicados: saldo 8734; al editar el gasto a 3000,
descripción Gasto Mobile editado y nota Edición persistente, saldo 8234.
Un force-stop y arranque COLD en otro PID conservaron monto, descripción y nota.
Al eliminar el gasto, saldo 11234; un segundo cierre/arranque COLD conservó la
eliminación. La categoría con ingreso activo rechazó su eliminación; la categoría
de gasto, ya sin movimientos activos, permitió edición y eliminación.

Las tres rutas y ambos formularios se comprobaron en el WebView a 320, 360, 390
y 430 px: sin desborde horizontal, botones de al menos 44 px y formularios con
scroll vertical. Drawer verificado con navegación, X, overlay y Escape; foco
dentro del diálogo y restauración al botón de menú al cerrar. El APK final,
recompilado tras ajustar esa restauración, conservó los datos y las tres rutas.
No se validó un dispositivo iOS ni un instalador Windows completo en este milestone;
Windows se validó con cargo check, tests Rust y las suites/build frontend.


## Configuración Mobile: implementación del milestone 7

- `/configuracion` renderiza `MobileSettings` dentro del shell Mobile, con
  once enlaces en el drawer. No monta el componente Configuración Desktop.
- Cards: Finanzas, Apariencia, Cuenta, Sincronización, Premium, Backups y
  restauración, Actualizaciones, Acerca de, Legal y Soporte.
- Finanzas explica el saldo acumulado y ofrece acceso a Movimientos. No añade
  un saldo editable que Desktop no tiene. Saldo anterior y saldo actual siguen
  siendo los derivados del historial; las fórmulas y reportes no cambian.
- No hay preferencias persistentes nuevas: **no se necesita v4 ni una tabla de
  settings**. Tampoco se crea un repository vacío. Las migraciones v1/v2/v3
  permanecen byte por byte y el esquema continúa en v3. No hay upgrade v3→v4
  que probar; sí se verifica la actualización del APK preservando el archivo v3.
- Premium utiliza `mobileSections.filter(section => section.premium)` como
  fuente única. Coincide con las cuatro features Desktop de entitlements:
  fixed_expenses, planning, budgets y saving_goals. No concede permisos ni
  habilita contratación; las funciones locales continúan accesibles en desarrollo.
- Cuenta, sync, backup/restore, contratación y actualizaciones de tienda son
  exclusivamente informativos. No hay botones ficticios ni providers cloud.
- Acerca de obtiene la versión de package.json y reutiliza la novedad del saldo
  mensual. No anuncia backup cifrado, Mercado Pago, sync o updater como funciones
  Mobile disponibles. Tema oscuro conserva el comportamiento actual.
- Soporte ofrece el email seleccionable. El opener instalado no autoriza mailto;
  no se amplían capabilities ni se solicita acceso adicional al sistema.
- `/legal` es una ruta Next nueva fuera del layout financiero Desktop. Lee
  `src-tauri/LICENSE.txt` durante el build y exporta las secciones sin modificar
  su contenido. Términos, privacidad y aceptación son anclas del mismo documento.
  No existe una licencia separada que deba inventarse. El documento vigente
  todavía describe funcionalidades Desktop: se conserva íntegro por instrucción.
- Providers pasa el contenido estático de la ruta al gate Mobile; MobileApp
  solo lo monta en `/legal`. En las rutas financieras continúa seleccionando
  sus componentes Mobile, sin montar children Desktop. Configuración y Legal
  deshabilitan las ocho lecturas financieras base. No hay polling nuevo.
- Próximo milestone: cuenta/auth + almacenamiento seguro + sync. Sigue pendiente
  diseñar backups y recuperación Mobile, contratación/entitlements y distribución
  por tienda. No se implementa iOS en este milestone.


### Validación milestone 7

- Auditoría y decisiones documentadas antes de modificar la UI.
- test:mobile: 102 (48 repository + 54 UI), auth: 68, billing: 45,
  updater: 32, platformStartup: 24, UI explícito: 54; todos pasan.
- npm run build: TypeScript y static export pasan, incluyendo /legal.
- Windows cargo check --locked y cargo test --locked para
  x86_64-pc-windows-msvc: pasan; 9 tests Rust existentes.
- v1/v2/v3 comparadas byte por byte con HEAD: idénticas. Versión,
  identifiers, Rust y el documento legal original no cambiaron.
- Android: se ejecutó npx tauri android run --no-watch Pixel_8. Compilación
  Rust y empaquetado Gradle finalizaron; CLI quedó esperando sin instalar.
  Se registró el problema antes del fallback adb install -r del APK generado,
  sin wipe-data ni desinstalación. Persisten warnings anteriores de Zeroize
  y deprecaciones Gradle, sin modificaciones para silenciarlos.
- Las pruebas de editar saldo inicial y upgrade v3→v4 no corresponden a la
  implementación conservadora: Desktop no tiene saldo editable y no se
  introduce persistencia nueva. Una preferencia financiera de ese tipo deberá
  aprobarse como funcionalidad nueva, con contrato/calculadora definido.

- Android manual en WebView real: once módulos navegan, drawer cierra al elegir
  ruta, Configuración y Legal sin overflow en 320/360/390/430 px. Cards revisadas
  visualmente en capturas 320/430. Cuenta/Sync/Premium/Backups/Updates sin acciones
  falsas; versión real 3.3.1. Se comprobaron tres anclas legales y vuelta a Configuración.
- Texto legal completo del DOM coincide con LICENSE.txt, incluyendo aceptación.
- Antes y después de instalar el APK: categorías 5, movimientos 6, gastos fijos 1,
  presupuestos 1, metas 1, gastos programados 2; todos los campos y tombstones
  idénticos. Migraciones 1/2/3 exitosas y foreign_key_check vacío.
- Cierre real mediante am force-stop (PID 18732) y reapertura COLD (PID 20455):
  mismo saldo 7584, Configuración/versión disponibles, base íntegramente idéntica.
  No hubo solicitudes al API local Desktop. No se borró el almacenamiento.
- Se preservaron cambios sin commit del milestone 6. El diff acumulado del working
  tree incluye esa implementación previa; archivos nuevos no aparecen en diff --stat.
