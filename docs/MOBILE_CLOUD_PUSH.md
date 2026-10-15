# M9C: Android → cloud → PC

## Contexto explícito de cuenta

Configuración → Cuenta conserva el pull manual y agrega **Subir cambios**,
**Crear categoría cloud** y **Crear movimiento cloud**. Los formularios reutilizan
los componentes mobile existentes. Las escrituras usan el mismo repositorio de
entidades, parametrizado con `users.id` interno. Sin contexto explícito, el
repositorio conserva su owner predeterminado `local`. Ninguna fila se reasigna.
Los módulos financieros generales siguen trabajando sobre `local`.

La edición/eliminación en esta vista afecta únicamente la cuenta mostrada. Las
eliminaciones piden confirmación y quedan como tombstones. Notas y metas no se
ofrecen en el formulario cloud porque el contrato actual de movimientos cloud
no las transporta; el repositorio rechaza esos campos en contexto cloud.

## Contrato existente y selección de pendientes

`mobileCloudPush.ts` consume `/sync/push` sin cambiar backend ni protocolo.
Obtiene el grant con el mismo resolver de sesión que M9B, y el dispositivo actual
trusted mediante el servicio de dispositivos existente. El backend revalida
autorización/familia. No se decodifican tokens ni se guardan credenciales en SQL.

Solo se seleccionan categorías/movimientos del owner solicitado y activo con
estado `pending`, `sync_error`, NULL o vacío, incluidos tombstones. Se ordenan
por ID local para obtener una selección determinista. `sync_error_code` contiene
solo códigos conocidos/sanitizados; no bodies ni mensajes del proveedor.
Las otras seis entidades del contrato se envían como arrays vacíos.

Se envían campos de entidad, `sync_id`, timestamps, `deleted_at`, `sync_status`
y `last_remote_updated_at`. Las relaciones usan `categoria_sync_id`, nunca IDs
numéricos de otro dispositivo. `device_id` es el dispositivo trusted actual;
la telemetría no reemplaza la autorización del grant. Colores/iconos existentes
se conservan desde el preflight, aunque mobile no los edite.

Primero se envía la fase de categorías y se valida su ACK; después se envían
los movimientos cuyas categorías no fueron rechazadas. Esto evita referencias
huérfanas incluso si cloud admite ACKs parciales. Ambas fases usan exactamente
el endpoint y response existentes: accepted/rejected/ignored/conflicts/counts.

## Revisión, ACK y retries

La migración SQLx 5 agrega `last_remote_revision` (texto cloud exacto),
`local_change_version` y `sync_error_code`. No altera filas/IDs/owners y no cambia
el cursor de M9B. Cloud compara baselines como strings exactos, mientras M9B
normalizaba revisiones para ordenarlas. Desde esta etapa el pull conserva ambos
formatos. Para filas v4, el preflight completo de solo lectura recupera el texto
exacto solo si coincide la revisión normalizada conocida.

Si cloud tiene otra revisión no conocida, se conserva el pendiente y se informa
`conflict_remote_newer`. Una respuesta perdida se reconoce por identidad estable,
dispositivo y contenido del cambio; nunca se inventa un nuevo sync ID. Cloud
hace upsert por `(user_id,sync_id)`. No se hace merge automático ni force upload.
El servidor sigue verificando la baseline ante carreras entre preflight y POST.

Se validan IDs únicos, pertenencia al batch, cobertura completa y conteos
received/saved/ignored del ACK. Un HTTP/timeout o ACK inválido no marca synced.
La revisión del ACK proviene del `device.last_seen_at` generado por el endpoint
para esa fase. Los ACKs de ambas fases se aplican en una transacción SQLite.

`accepted` cambia a synced y guarda revisión/dispositivo/last_synced_at solo si
`local_change_version` sigue siendo la enviada. Cada edición incrementa esa
versión, incluso si ocurre en el mismo segundo: un ACK tardío no limpia una
edición nueva. Rejected/conflict permanecen pendientes y observables.
Aunque haya una edición posterior, se guarda la baseline del cambio confirmado
sin marcar esa edición synced. Así se puede subir la nueva versión después sin
confundir el ACK perdido con una modificación de otro dispositivo. Un ACK viejo
no retrocede una revisión cloud más nueva ya conocida.
Si falla la transacción de ACK se revierte toda la metadata; repetir conserva
los mismos sync IDs y recupera las respuestas perdidas. Las llamadas push
simultáneas por cuenta comparten una ejecución. No hay scheduling ni fire-and-forget.

## Pull y cambios locales

El pull sigue creando filas synced: pull → push sin edición produce cero uploads.
Un lote remoto que coincide con filas pendientes revierte sin avanzar el cursor,
para no sobrescribir un cambio rechazado o no confirmado. Los upserts también
excluyen esas filas. Usar primero Subir cambios; después descargar. Un conflicto
real requiere revisión/resolución futura, nunca descartar automáticamente su
contenido para hacer pasar un pull.

## Validación real

Desde frontend, con SDK/NDK/Java y variables públicas staging configuradas:

```powershell
npm.cmd run tauri:android:dev -- --no-watch Pixel_8
```

Crear un movimiento con nombre único en la sección cloud. Subir cambios,
comprobar estado synced y existencia única por sync ID con el pull autenticado.
Repetir upload, descargar, reiniciar Android y comprobar persistencia. En Windows,
con la misma cuenta staging, usar el sync desktop habitual dos veces y comprobar
que el movimiento aparece una sola vez. No declarar la prueba completa antes de
confirmar Android → cloud → PC. Comparar hashes de todas las filas `local` sin
imprimir su contenido. Para probar borrado real usar un segundo registro de
prueba, conservando el principal como evidencia; no borrar registros ajenos.

## Limitaciones

- Esta vista de cuenta todavía no reemplaza los módulos financieros `local`.
- El preflight obtiene el pull completo; paginación/lotes grandes quedan para
  una etapa posterior. Los límites del servidor se respetan mediante rechazo
  explícito; no se confirman filas de un lote rechazado por tamaño.
- Tags, asociaciones, planificación, notas y metas no se suben en esta etapa.
- Sin merges de nombre/tipo de categoría ni resolución automática de conflictos.
- Android solo; iOS y sync de fondo no están habilitados.
- El fallback UUID usa `getRandomValues` si el WebView HTTP dev no ofrece
  `randomUUID`; nunca usa tiempo/contadores como identidad de sync.

## Evidencia real, 2026-10-06

- APK debug compilado e instalado sobre el sandbox existente de Pixel_8,
  conservando SQLite/Keystore. La sesión trusted restauró sin pedir OTP.
- Categoría creada desde el formulario: `M9C Android 20261006-193127`.
- Movimiento principal creado desde el formulario: `prueba m9c android 20261006-193127`,
  monto 4321, fecha 2026-10-06, owner de la cuenta cloud activa.
- Push por fases: categoría confirmada primero; movimiento quedó synced.
- API staging autenticada confirmó exactamente una fila del movimiento, mismo
  sync ID y categoría que SQLite, categoría existente y users.id interno correcto.
- Repetir upload sin ediciones produjo cero pendientes. Pull posterior mantuvo
  el movimiento sin duplicados. Force-stop/reapertura conservó la fila synced y
  restauró la sesión. `prueba m8` sigue disponible.
- Segundo registro: `prueba m9c tombstone 20261006-193127`, monto 1. Creado,
  confirmado en cloud, eliminado mediante confirmación UI y tombstone subido:
  HTTP 200, accepted movimiento 1, rejected 0. La API cloud conservó exactamente
  una fila con deleted_at y SQLite conservó el tombstone synced. El principal
  permaneció visible; no se borraron registros ajenos ni filas físicamente.
- Los hashes de todos los campos locales originales de las seis tablas
  coincidieron antes/después de la migración 5, pull/push y reinicio. Conteos:
  categorías 5, movimientos 6, fijos 1, presupuestos 1, metas 1, programados 2.
- Tests: mobile 159/159; auth 92/92; push específico 17 casos aprobados; smoke desktop de
  sync en SQLite temporal 41/41; build estático y cargo check Windows aprobados.
  Cargo test Windows: primer intento concurrente 11/12 (roundtrip ficticio de
  WinCred); repetición serial 12/12. No se cambió auth para ocultar ese fallo.
- **Desktop real validado** en `http://localhost:3001`, simultáneo con Next
  Android en 3000. El usuario volvió a iniciar sesión por el origen nuevo; la
  API confirmó dispositivo actual trusted y dos dispositivos autorizados.
- El sync inicial posterior al login descargó principal y tombstone. Cursor
  previo `2026-10-06T00:59:37Z`; posterior `2026-10-07T00:31:53Z`.
- Dos syncs manuales mediante el botón existente terminaron con HTTP 200. Sus
  pulls incrementales devolvieron cero cambios. Cursores persistidos:
  `2026-10-07T00:33:57Z` y `2026-10-07T00:35:10Z`.
- Principal: exactamente una fila tras ambas ejecuciones, mismo sync ID
  `0a692255-c652-4210-a12a-cd5dd02220c2`, gasto 4321, fecha 2026-10-06,
  categoría `M9C Android 20261006-193127`, synced y deleted_at NULL. En
  Movimientos se muestra una sola vez.
- Tombstone: exactamente una fila, sync ID `e632a480-2fef-4fce-a69d-e896bce33ead`,
  synced, deleted_at `2026-10-06T19:44:12Z`; oculto en UI, sin resurrección ni
  duplicación tras los dos syncs. Se conservaron hashes de todos los campos de
  los demás owners desktop. No se borraron/resetearon cursores ni datos.
- Bloqueos de la prueba: CORS local no incluía 3001 (habilitado por opt-in dev)
  y CORS cloud staging tampoco (el usuario agregó el origen exacto al entorno
  staging). No se encontró incompatibilidad del motor/payload de sync. Ver
  [desktop concurrente](DESKTOP_CONCURRENT_DEV.md).
- **M9C Android → cloud → PC VALIDADO.** Los cursores anteriores se expresan
  en UTC; la comprobación final ocurrió la noche del 6 de octubre de 2026
  en America/Argentina/Buenos_Aires.
