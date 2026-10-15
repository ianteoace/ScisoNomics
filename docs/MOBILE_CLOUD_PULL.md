# M9B, primera etapa: cloud → Android

La etapa siguiente [M9C](MOBILE_CLOUD_PUSH.md) agrega creación/edición en el
contexto explícito de cuenta y push manual. El registro de validación M9B de
este documento corresponde a su primera etapa, con la vista de consulta.

El pull es manual desde Configuración → Cuenta → **Sincronizar ahora**.
Las categorías y movimientos descargados se muestran allí en una vista de
consulta (los 50 movimientos más recientes). Los módulos financieros existentes
siguen usando `owner_user_id='local'`; no se reasignan sus datos ni se habilita
edición/push de datos cloud en esta etapa.

## Protocolo y autorización

Se usa el `/sync/pull` existente: `ok`, `cursor`, `incremental` y arrays por
entidad. La sesión Supabase resuelta por el servicio compartido devuelve el
grant autorizado y el `users.id` interno. Ese ID es el owner SQLite, nunca email
ni Supabase sub. El backend revalida dispositivo/familia trusted. El adaptador
no agrega autorización paralela, no accede a Postgres/Supabase tables y no usa
FastAPI local. No persiste credenciales en la base.

El servidor devuelve cambios con `sync_id`, campos de entidad, `created_at`,
`updated_at`, `deleted_at`, `remote_updated_at` y metadata del último dispositivo.
El incremental filtra `remote_updated_at > since` y `<= cursor`. Un cursor vacío
pide un pull completo. Mobile resuelve `categoria_sync_id` dentro del mismo
owner; ignora el `categoria_id` numérico del servidor. Una referencia faltante
falla el lote entero, sin inventar categorías ni avanzar el cursor.

## Persistencia y conflictos

La migración SQLx 4 conserva filas/IDs/owners y agrega `mobile_pull_state`,
`last_remote_updated_at` y `last_remote_device_id` para categorías/movimientos.
Reemplaza solo los índices globales de sync por índices únicos de
`(owner_user_id,sync_id)`, necesarios para no mezclar cuentas. SQLx aplica cada
migración una vez y verifica su historial; no se reejecuta directamente el SQL.

Cada lote usa la transacción nativa existente. Tres statements: compare-and-set
del cursor, upsert de categorías, upsert de movimientos. Los arrays se pasan
como parámetros JSON a SQLite; no se interpola SQL ni se limita el lote a 16
registros. La extensión opcional `expected_rows` del bridge revierte si el CAS
no modifica exactamente una fila. Cualquier fallo posterior también revierte
el cursor y todos los cambios. Las llamadas simultáneas por cuenta comparten
una request; un cambio de cuenta durante la descarga impide aplicar su respuesta.

Los upserts comparan la revisión cloud y, en empate, el ID del último dispositivo,
como `_remote_is_newer` en desktop. Se conserva precisión de microsegundos; no
se decide por el reloj local de `updated_at`. Se preserva `created_at` existente.
Tombstones permanecen como filas con `deleted_at`; no se borran físicamente ni
se resucitan al repetir una revisión vieja. Borrar una categoría no borra
movimientos por sí solo, igual que el contrato desktop.

Un conflicto de nombre/tipo de categoría con otro sync ID falla explícitamente:
esta etapa no porta el merge desktop que mueve referencias entre categorías.
La vista cloud es de consulta y no genera pendientes propios. Antes de push se
debe completar la gestión/observabilidad de conflictos locales y revisar esos
merges, conservando la regla de revisión del protocolo actual.

## Entidades no soportadas

Se ignoran `tags`, `movimiento_tags`, `metas_ahorro`, `gastos_programados`,
`gastos_fijos` y `presupuestos`. No son dependencias FK del payload cloud de
categorías/movimientos actual; el contrato de movimientos no incluye notas ni
metas. No se crean asociaciones ficticias. En development se registran solo
conteos por entidad y conteos aplicados, nunca payloads, tokens ni bindings.

El cursor está asociado a `supported_entities_version=1`. **Cuando se agregue
otra entidad hay que invalidar/resetear el cursor mediante una migración segura
de esa versión y realizar un pull completo**, pues el cursor actual ya dejó
atrás sus cambios ignorados. No inferir que esas entidades ya se sincronizan.

## Prueba staging

Desde `modern_app/frontend`, con las tres variables públicas staging ya
configuradas y SDK/NDK/Java preparados:

```powershell
npm.cmd run tauri:android:dev -- --no-watch Pixel_8
```

Instalar sobre el APK debug existente, conservando SQLite y Keystore. Abrir
Configuración → Cuenta; restaurar/iniciar sesión y completar autorización si
corresponde. Descargar manualmente. Comprobar `prueba m8` si sigue existiendo,
reiniciar la app, comprobar que permanece y repetir el pull. Validar cursor
SQLite por owner y conteo por sync ID, sin imprimir datos de otras cuentas.
Verificar también que todas las filas originales `local` siguen intactas.
No tomar un test mock como evidencia de correo, red o persistencia en Pixel_8.

## Evidencia real, 2026-10-06

- APK debug compilado e instalado con `tauri:android:dev -- --no-watch Pixel_8`,
  sobre `com.scisoftware.scisonomics.debug`, sin borrar SQLite/Keystore.
- La sesión staging ya trusted restauró correctamente, sin pedir credenciales.
- Primer pull: HTTP 200, cursor previo vacío, una categoría y un movimiento;
  `prueba m8` recibido, persistido y visible en Configuración → Cuenta.
- Cursor guardado: `2026-10-06T18:55:07.314104+00:00`.
- Force-stop y reapertura: sesión restaurada, movimiento visible, mismo cursor
  SQLite y exactamente una fila para `prueba m8`.
- Segundo pull incremental: HTTP 200, cero categorías y cero movimientos nuevos,
  cursor `2026-10-06T18:57:50.553699+00:00`; la fila previa se conserva.
- Los hashes de todos los campos originales de las seis tablas `local`
  coincidieron antes de migrar, después del pull y tras reiniciar. Conteos locales:
  categorías 5, movimientos 6, gastos fijos 1, presupuestos 1, metas 1, programados 2.
- SQLx registró versiones 1–4; `PRAGMA foreign_key_check` sin errores.
- La prueba nativa `expected_rows` rechazó un UPDATE de cero filas y revirtió
  creación/insert de una tabla diagnóstica dentro del mismo lote. Sin cambios
  financieros ni tabla residual.
- Tests mobile 140/140, auth 92/92, adaptador SQLite 15/15; build estático y
  cargo check Windows con toolchain 1.88.0 aprobados. Sin cambio de dependencias,
  backend, protocolo cloud, ni despliegue. No se ejecutó push de datos.
