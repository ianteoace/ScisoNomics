# ScisoNomics Mobile: SQLite local (milestone 1)

La versión de producto sigue siendo 3.3.1. Este milestone implementa únicamente
categorías y movimientos locales. Android usa SQLite nativo; Windows continúa
usando FastAPI y su SQLite existente. No se cambia el modelo ni los datos desktop.

## Runtime y almacenamiento

- `getRuntimePlatformSync()` identifica el runtime antes de montar providers.
- Mobile monta `MobileStartupGate`, sin auth, updater, sync, sidebar ni páginas desktop.
- El gate espera `getMobileDatabase()`. Ante un fallo ofrece **Reintentar** sin
  borrar datos. Sólo muestra la demo cuando SQLite y la migración están listos.
- URL lógica: `sqlite:scisonomics-mobile.db`, sin colisión con los nombres desktop.
- El plugin resuelve el archivo dentro de `app_config_dir()` de la aplicación,
  en el almacenamiento privado Android. La ruta absoluta depende del runtime;
  no se fija una ruta Windows ni del emulador.
- En el APK debug validado, la ruta resuelta es
  `/data/user/0/com.scisonomics.desktop.debug/scisonomics-mobile.db`.
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
| deleted_at | TEXT nullable; tombstone reservado |
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
tablas/historial de sync y resolución de conflictos; edición y borrado.
Los campos sync reservados no implementan ni autorizan sincronización cloud.
No hay users/auth mobile ni traducción de IDs Windows/Android.

## FinanceRepository

Contrato en `services/data/financeRepositoryTypes.ts`: `listCategorias`,
`createCategoria`, `listMovimientos({month, year})`, `createMovimiento`.
Devuelve los tipos existentes `Categoria` y `Movimiento`; las creaciones devuelven
void como las operaciones desktop. El nombre evita la colisión Windows entre
`FinanceRepository.ts` y `financeRepository.ts`.

`getFinanceRepository()` importa sólo la rama seleccionada:

- Android/iOS Tauri → `mobileFinanceRepository`, mediante plugin SQL.
- Desktop Tauri/browser → `desktopFinanceRepository`, que delega a `api.ts`
  conservando HTTP, owner activo y notificaciones existentes de sync.

La demo tiene selector de mes y crea/lista registros; no porta el dashboard.
Al guardar en otro mes muestra ese período. Resumen **operativo del mes**:
ingresos menos gastos; ahorro/inversión son tipos separados, como el resumen
desktop. Se suma en centavos para evitar ruido de decimales en la demo.
`saldo_acumulado` de cada movimiento usa todo el historial local previo en orden
fecha/id, deduciendo los otros tipos, como la lista de movimientos desktop.
No confundir ese campo con el resumen operativo del mes.

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

Prueba manual, en una base demo nueva:

1. Abrir ScisoNomics Android y esperar la demo (sin pantalla desktop).
2. Crear categoría **Prueba Mobile**, tipo **Ingreso**.
3. Crear ingreso **10000**, descripción **Ingreso demo**, fecha de hoy, categoría anterior.
4. Crear gasto **2500**, descripción **Gasto demo**, misma fecha y categoría.
5. Confirmar Ingresos **$10.000**, Gastos **$2.500**, Balance **$7.500** en ese mes.
6. Forzar cierre completo desde Ajustes Android o `adb shell am force-stop com.scisonomics.desktop.debug`.
7. Volver a abrir ScisoNomics sin reinstalar, desinstalar ni borrar almacenamiento.
8. Confirmar categoría, ambos movimientos y balance **$7.500**.

Si ya hay datos demo, comparar el incremento de balance **$7.500** respecto de
la base anterior; no borrar datos para obtener un resultado esperado.

Validado el 4 de octubre de 2026 en Pixel_8 / x86_64 mediante
`npx tauri android run --no-watch Pixel_8`: APK compilado e instalado; categoría
y movimientos creados desde los formularios del WebView; cierre con force-stop,
ausencia de PID confirmada y reapertura COLD en un PID distinto. Se conservaron
Prueba Mobile, ingreso 10000, gasto 2500 y balance 7500. No se reinstaló ni se
borró almacenamiento entre el cierre y la reapertura. El WebView reabierto no
registró errores de página ni requests al API desktop durante la comprobación.

## Próximo milestone

Ampliar el repositorio y la UX local Android de forma incremental, primero
edición/borrado y navegación de movimientos. Auth, sync cloud, migración desde
Windows, Premium, backups y demás módulos requieren milestones independientes.
