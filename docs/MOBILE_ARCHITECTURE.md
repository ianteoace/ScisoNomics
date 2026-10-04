# ScisoNomics Mobile: interfaz local (milestone 3)

La versión de producto sigue siendo 3.3.1. Este milestone implementa únicamente
categorías y movimientos locales. Android usa SQLite nativo; Windows continúa
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

## Migración v1

Fuente de verdad: `modern_app/frontend/src-tauri/migrations/0001_mobile_finance.sql`.
Rust registra version 1, descripción `mobile_finance_core`, kind `Up`.
`Database.load()` aplica las migraciones mediante SQLx; su tabla técnica
`_sqlx_migrations` guarda versiones/checksums y evita repetir una migración aplicada.
El SQL inicial también usa `IF NOT EXISTS`; no incluye DROP ni copia datos desktop.
Una migración publicada debe conservarse y las ampliaciones usar otra versión.

SQLx configura `foreign_keys=ON` por conexión, también en el pool. La migración
declara el PRAGMA y el startup comprueba su valor y que version 1 figure exitosa
en `_sqlx_migrations`. Un PRAGMA ejecutado una sola vez desde JS no garantizaría
las restricciones en todas las conexiones del pool.

Sólo hay dos tablas de dominio (además de metadatos técnicos SQLx/SQLite):

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

Pendientes: `meta_id` y FK a metas; tags/tabla puente; metadatos
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
Monta una sola vista según `/dashboard`, `/movimientos` o `/categorias`.
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
No se modifica la migración v1 ni se agregan migraciones en este milestone.

Después de cada escritura hay una recarga compartida de categorías, movimientos
y resumen. Se bloquean submits duplicados, se descartan lecturas tardías de otro
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
