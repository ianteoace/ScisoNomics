# ScisoNomics Mobile: interfaz local (milestone 4)

La versión de producto sigue siendo 3.3.1. Este milestone implementa únicamente
categorías, movimientos, gastos fijos, presupuestos y metas locales. Android usa SQLite nativo; Windows continúa
usando FastAPI y su SQLite existente. No se cambia el modelo ni los datos desktop.

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

## Migración v1

Fuente de verdad: `modern_app/frontend/src-tauri/migrations/0001_mobile_finance.sql`.
Rust registra version 1, descripción `mobile_finance_core`, kind `Up`.
`Database.load()` aplica las migraciones mediante SQLx; su tabla técnica
`_sqlx_migrations` guarda versiones/checksums y evita repetir una migración aplicada.
El SQL inicial también usa `IF NOT EXISTS`; no incluye DROP ni copia datos desktop.
Una migración publicada debe conservarse y las ampliaciones usar otra versión.

SQLx configura `foreign_keys=ON` por conexión, también en el pool. La migración
declara el PRAGMA y el startup comprueba su valor y que las versiones 1 y 2 figuren exitosas
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
para categorías y movimientos, más `getSummary({month, year})`.
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
`/gastos-fijos`, `/presupuestos` o `/metas`.
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
- Presupuestos: mes/año, límites por categoría, consumo real, restante y porcentaje; CRUD.
- Metas: objetivo/inicial/fecha/estado, avance por ahorros asignados y CRUD.
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
y resumen, gastos fijos, presupuestos y metas. Las seis lecturas se hacen en paralelo
una vez por carga/escritura/período, no por navegación. Se bloquean submits duplicados, se descartan lecturas tardías de otro
período y no se actualiza un componente desmontado. No hay polling.

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
v1 y v2 antes de abrir el shell; un fallo permite Reintentar sin borrar almacenamiento.

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
Siguen pendientes Planificación, Calendario, Estadísticas, Reporte y Configuración.

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
