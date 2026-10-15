# M9D — contexto financiero mobile

## Namespaces y autorización

`MobileAccountProvider` publica un `financialContext` explícito: `ownerId` y una
función `isCurrent()` que valida la vigencia de esa instancia. El resolver utiliza
exclusivamente `account.user.id`, el `users.id` interno obtenido del backend.
No utiliza el email, el UUID de Supabase, tokens ni la identidad del dispositivo.

Sin cuenta autorizada, el namespace es `local`. Un login pendiente de autorización
de dispositivo no cambia los módulos financieros a cloud. Una cuenta ya autorizada
puede abrir su cache offline usando el historial de grant que ya almacena el flujo
de dispositivos, junto con su credencial en storage nativo seguro. No se añade otro
owner persistente ni se guarda ningún secreto en localStorage.

La metadata de grant es un indicio local de autorización previa: **no concede
acceso cloud**. Pull y push siguen requiriendo la sesión de dispositivo y la
validación existente del servidor. Una revocación desconocida mientras el equipo
está offline no puede comprobarse remotamente; la siguiente restauración online
aplica las reglas existentes de revocación. Un fallo de red no equivale a logout.
Si el storage seguro no puede leerse al arrancar, se ofrece reintento, sin escribir
accidentalmente en `local` ni borrar la cuenta.
También se ofrece continuar con datos locales como elección explícita usando el
cambio de modo existente. Un rechazo confirmado de credenciales requiere nuevo
login; no se trata como una caída de red ni elimina el cache financiero.

## Repositorios y UI

`createMobileFinanceRepository(ownerId, isCurrent)` captura el owner en una instancia.
Cada SELECT, agregado, referencia de categoría y UPDATE/DELETE de categorías y
movimientos usa un único owner en SQL. No hay consultas combinadas ni filtrado de
owners en JavaScript. Las modificaciones mantienen `sync_id` y las reglas existentes
de pending/version/tombstone. Una categoría utilizada continúa protegida.

Inicio, Movimientos, Categorías, Calendario, Estadísticas y Reporte usan ese contexto.
El formulario normal de movimientos es el mismo formulario existente. En cloud no
ofrece notas ni metas porque esas entidades todavía no están soportadas por el
protocolo mobile.

Gastos fijos, presupuestos, metas y planificación conservan **Datos locales**, con
su propio repositorio local explícito y sus referencias locales. Al entrar en esas
secciones se identifica el contexto en pantalla. Los reportes cloud no leen ni
agregan esas tablas locales: sus listas auxiliares están vacías y no tienen gastos
programados. No se crean entidades cloud adicionales ni sync en segundo plano.

## Cambios de cuenta, logout y offline

Un cambio de owner invalida la instancia previa antes de esperar al storage o la
red. React remonta el shell financiero por owner y la página al cambiar entre un
módulo de cuenta y uno local, descartando formularios, selecciones, mensajes y datos
anteriores. Los hooks descartan resultados de un contexto invalidado y esconden
datos cuyo owner ya no corresponde. Antes de enviar una escritura de categorías o
movimientos se vuelve a validar la instancia, después de abrir SQLite. Una operación
ya enviada a SQLite puede finalizar únicamente en el owner que capturó; nunca se
redirige al owner nuevo.

Logout cambia a `local` sin DELETE de filas financieras. El siguiente login vuelve
al namespace de la cuenta. La consulta financiera no restaura auth ni llama a red:
leer, crear, editar, borrar y calcular saldos funciona con SQLite offline. Los cambios
quedan pendientes para el siguiente push manual.

En Cuenta, “Cuenta sincronizada” y “Datos locales” indican el contexto sin mostrar
UUIDs internos. Los botones de descarga/subida reciben el mismo owner e instancia
que los módulos normales; los motores M9B/M9C permanecen sin cambios. Los registros
pulled aparecen en Movimientos normal y conservan `synced`.

## Datos locales e importación futura

No hay nueva migración SQLite, reasignación, copia ni upload de filas `local`.
El esquema multi-owner existente alcanza. Una eventual importación `local → cloud`
debe diseñarse como una acción explícita y consentida, con su propia política de
conflictos; no está implementada en este milestone.

## Validación

Las pruebas automatizadas cubren resolver, caché offline, cambio de cuenta y logout/
relogin, descarte de respuestas/formularios obsoletos, CRUD y agregados aislados en
SQLite real, protección de IDs/FK de otros owners, planificación local separada,
registros pulled visibles en el repositorio normal y el push del repositorio normal.

Resultados automatizados: `test:mobile` 171/171 y `test:auth` 93/93. El build/export
frontend pasó; el check Rust Windows pasó con código de salida 0 en un target
temporal aislado porque el sidecar del cliente concurrente mantiene bloqueado su
ejecutable en el target habitual. No se modificó Rust ni el sidecar.

Pixel_8 real, con el APK existente y frontend dev staging:

- Inicio y Movimientos normal mostraron M8 y M9C dentro de la cuenta.
- `prueba m9d normal android 20261006-225011`, gasto 2468, se creó en el owner
  interno correcto, con sync_id estable y `pending`; el push pasó a `synced`.
- `prueba m9d offline android 20261006-225715`, gasto 1357, se creó después de
  bloquear staging/Supabase y recargar el WebView. Conservó el contexto de cuenta
  con storage seguro, quedó `pending` y se confirmó después de restaurar la red.
- Respuestas reales de `/sync/pull` staging devolvieron una fila por cada registro
  principal, con los mismos sync_ids. La comprobación no leyó headers ni bodies
  de auth ni almacenó tokens.
- Una categoría secundaria se creó, editó y borró desde Categorías normal.
  `prueba m9d tombstone android 20261006-230217` se creó y editó desde Movimientos
  normal, mantuvo sync_id y luego se eliminó: tombstone `synced`, versión local 2.
- Logout mostró exclusivamente los cinco movimientos locales activos, ocultó los
  registros cloud y conservó sus filas SQLite. Hashes de todos los campos originales
  de categorías, movimientos y las cuatro tablas locales auxiliares: idénticos.
- El usuario completó el relogin Android. Movimientos normal recuperó los registros
  principal y offline en la cuenta; el tombstone continuó oculto.
- Dos ciclos adicionales Android de push/pull conservaron una fila por cada prueba,
  con los mismos sync_ids. La última subida confirmó cero cambios, pendientes y
  conflictos. La comparación de todos los campos locales siguió siendo idéntica.
- Windows quedó reconectado a la misma cuenta staging y su dispositivo se confirmó
  trusted. `/auth/me`, `/auth/devices` y `/sync/pull` validaron esa sesión sin exponer
  credenciales. Staging mantiene una fila por cada prueba, incluidos los tombstones.
- El cliente Windows recibió los tres registros M9D: una fila por descripción,
  mismo sync_id, monto, sync_status `synced` y estado de borrado que Android.
  Movimientos normal mostró las pruebas principal/offline y ocultó el tombstone.
- El sync Windows repetido no duplicó filas ni resucitó el borrado. Cursor anterior
  `2026-10-07T01:31:39Z`, recepción `2026-10-07T17:48:52Z`, repetición
  `2026-10-07T17:50:00Z` (timestamps del protocolo en UTC).
- La comparación de campos financieros de todos los otros owners Windows conservó
  sus hashes; los datos locales Android también quedaron idénticos tras el relogin
  y las repeticiones de sync.

Validación final: mobile 171/171, auth 93/93, build/export, check Windows Rust 1.88.0
con lockfile y `git diff --check`. Las pruebas de contexto invalidado también verifican
que no se inicien consultas SQL nuevas para el owner anterior.

**M9D VALIDADO end-to-end.** Se completaron creación/edición/borrado normal,
Android → staging → Windows, offline/online, logout/relogin, conservación del cache
y sync repetido sin duplicados. El usuario ingresó credenciales únicamente en las
aplicaciones. La sesión Windows necesitó reconexión antes de recibir los registros;
no se hicieron cambios adicionales en auth, trusted device ni configuración cloud.
El aislamiento entre cuentas A/B/local se probó con SQLite real y lifecycle de UI;
no se utilizó una segunda cuenta real en el emulador. Las entidades todavía locales
y la importación futura conservan los límites indicados arriba.
No se hizo commit ni push, ni se modificó configuración de Railway.
