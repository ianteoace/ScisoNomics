# M10A — eliminación de cuenta y preparación legal

Estado: M10A técnico validado en QA aislado; sin deploy, commit ni push.
La eliminación externa y las decisiones legales pendientes se detallan abajo.

## Mapa de datos auditado

Las tablas cloud utilizan `user_id`; el SQLite financiero de los dispositivos utiliza
`owner_user_id`. El `users.id` interno sigue siendo la identidad financiera.

| Datos | Relación | Tratamiento al cerrar |
| --- | --- | --- |
| `users` | PK interno; `auth_provider_id` / `google_sub` externos | Borrado real, incluidos credenciales y Premium activo |
| `cloud_movimientos`, `cloud_categorias`, `cloud_metas_ahorro`, `cloud_gastos_programados`, `cloud_gastos_fijos`, `cloud_presupuestos`, `cloud_tags`, `cloud_movimiento_tags` | FK `user_id → users`; unicidad `(user_id, sync_id)` | Borrado físico de activos y tombstones del usuario |
| `cloud_devices` | FK user; telemetría/sync | Borrado del usuario |
| `cloud_refresh_tokens` | FK user + FKs compuestas a familia/dispositivo; legacy también | Borrado de todas sus familias/tokens |
| `device_proof_challenges` | FK user/dispositivo/familia/target | Borrado antes de familias/dispositivos |
| `device_verification_challenges`, `email_verification_codes` | FK user; OTP/challenges | Borrado |
| `refresh_token_families`, `trusted_devices` | FK user y relación compuesta entre ambos | Borrado, sin grants utilizables |
| `google_login_requests` | `user_id` nullable, sin FK | Borrado de resultados asociados; solicitudes aún sin identidad no pueden restaurar al user eliminado |
| `billing_subscriptions` | FK user NOT NULL; proveedor, referencia, pago/vigencia | Traslado técnico a archivo independiente, luego borrado de la relación activa |
| `billing_webhook_events` | Event key/fecha; sin FK user | Conservado; sin contenido financiero/credenciales |
| `security_audit_log` | Actor/target no son FK; IP/details | Conservado, minimizado/pseudonimizado para la cuenta |
| SQLite/backups/exportaciones del dispositivo | Otros owners y `local` | No se borran, copian ni reasignan |

Las FKs actuales no tienen `ON DELETE CASCADE`. Se realiza borrado explícito en
orden de dependencias. Las tres tablas nuevas son aditivas e idempotentes en SQLite
y PostgreSQL: `account_deletion_requests`, `deleted_account_identities` y
`retained_billing_subscriptions`. No se reconstruyen tablas ni cambian FKs existentes.

## Autorización y threat model

Endpoints POST consistentes con la gestión de dispositivos existente:

- `/account/delete/request`: grant vigente, dispositivo/familia trusted; genera
  capacidad temporal y OTP específico. Usuario derivado del JWT, sin user_id cliente.
- `/account/delete/challenge`: mismo usuario, dispositivo y familia; nonce nuevo.
- `/account/delete/complete`: exige `ELIMINAR`, OTP y firma nativa válida.

Un access token robado no alcanza: falta la clave Ed25519 del dispositivo y el
código de correo. La identidad privada existente se reutiliza desde WinCred/Keystore
sin exponerla a JavaScript. El signer nuevo tiene su dominio propio; **no cambia**
Device Proof V1, sus cinco propósitos, sus 237 bytes ni sus fixtures.

Mensaje firmado, todos los campos obligatorios:

`SCISONOMICS-ACCOUNT-DELETE-V1\0 || binding[32] || device_uuid[16] || pubkey_hash[32]
|| request_uuid[16] || nonce[32] || issued_at_u64_be || expires_at_u64_be
|| family_uuid[16] || request_hash[32]`

Son 222 bytes. `binding` pertenece inequívocamente al usuario interno; request_hash
liga la acción `delete_account` al request. El backend revalida sesión/familia bajo
lock y compara todos los campos con su journal. Una firma de otro propósito,
dispositivo, familia, usuario, nonce o request no sirve.

OTP: seis dígitos, HMAC con secreto existente y dominio específico, 300 segundos,
cinco intentos. Proof: 120 segundos como máximo, nuevo nonce al renovarlo. Requests:
cinco/hora y cooldown DB de 60 segundos por usuario; se suma rate limiting IP/actor
para request/challenge/complete. No se loggean códigos, proofs, tokens o datos
financieros; respuestas y errores no reflejan inputs y llevan `no-store`.

Auth utiliza Bearer explícito, sin cookies de sesión: un formulario cross-site no
puede aportar esa credencial ni firmar. Se conserva la política CORS existente; no
hay endpoint anónimo de borrado ni service role en frontend/bundle.

## Transacción, concurrencia e idempotencia

1. Crear intent/OTP sin cerrar la cuenta; fallo de envío invalida el intent.
2. En completion, bloquear user (`BEGIN IMMEDIATE` SQLite / `FOR UPDATE` PG),
   revalidar familia/trust, prueba, expiración y OTP.
3. Registrar barreras de identidad externa, archivar billing, minimizar auditoría.
4. Borrar datos cloud y dependencias, luego `users`.
5. Guardar recibo sin user_id, OTP, nonce, binding ni clave pública y COMMIT.
6. Después del commit intentar eliminar la identidad externa; nunca al revés.

Los writes de sync, emisión de refresh y reconciliación/alta billing comparten el
lock de usuario cuando pueden competir con close. No se refactoriza el motor de
sync. Si delete gana, nuevas operaciones fallan cerradas; si un write ya tenía el
lock, termina antes del borrado. Un fallo DB revierte también proof/archivo/barreras:
la cuenta no queda parcialmente cerrada y no se llama a Supabase.

El proof autoriza una única mutación. Durante diez minutos, un retry **idéntico**
(capacidad, request completo y hash del mismo Bearer previamente autorizado) puede
recuperar únicamente el recibo ya confirmado, aun después de revocar las sesiones.
No reejecuta delete ni concede una sesión. Un replay alterado es rechazado; dos
completions simultáneas producen un solo efecto. OTP/signature/token/capacidad se
mantienen sólo en memoria del cliente para recuperar una respuesta perdida.

## Supabase y recuperación

El proveedor se usa sólo para identidad. El admin delete sigue el
[API oficial de eliminación](https://supabase.com/docs/reference/javascript/auth-admin-deleteuser).
La variable opcional **server-only** `SCISONOMICS_SUPABASE_SECRET_KEY` debe ser una
secret key moderna del mismo proyecto. Se envía en `apikey`, nunca como Bearer,
según la [documentación de API keys](https://supabase.com/docs/guides/getting-started/api-keys).
Se reutiliza `SCISONOMICS_SUPABASE_URL`, se exige HTTPS y se deshabilitan redirects.
No se añaden secretos a Next, Tauri ni archivos públicos.

Sin esa credencial, o ante error/timeout del proveedor, el borrado interno queda
confirmado y `external_auth_status=pending` se devuelve explícitamente. La barrera
por hash de identidad impide que bootstrap/login recree la cuenta con el sub viejo.
El sub se conserva únicamente en el outbox pendiente para poder efectuar admin delete;
después de éxito se elimina. Un JWT externo aún vigente no reabre ScisoNomics.

Reintento operador, uno por vez y sólo de una eliminación interna ya completada:

```powershell
python -m modern_app.cloud_backend.app.retry_account_deletion --request-id <request-de-eliminación>
```

No ejecutarlo contra producción sin el procedimiento operativo autorizado. El
worker usa lease de 30 segundos y timeout HTTP de 8; admite recuperación tras crash
y `user_not_found` del proveedor. No inventa éxito a partir de un 404 genérico.
Objetos propiedad del usuario en Supabase Storage pueden impedir el admin delete;
no se borra Storage de otros servicios a ciegas. Su revisión requiere soporte.

## Billing, seguridad y dispositivo

El archivo conserva ID comercial/proveedor, importe/moneda, estado, pagos y fechas.
Excluye user_id, checkout_url y referencia original que contiene el owner; conserva
su hash para correlación. No hay FK a cuenta activa. Un webhook de una suscripción
archivada se reconoce sin volver a otorgar Premium ni recrear usuarios.

**Eliminar cuenta no cancela Mercado Pago**. Un POST remoto ya en vuelo puede haber
creado una suscripción; su referencia archivada permite seguimiento. El usuario debe
administrarla en Mercado Pago. No se inventan reembolsos ni se cancelan recursos.

Los logs asociados sustituyen actor/target por referencia de cierre, eliminan IP y
minimizan details a etiquetas operativas. Se conservan tipo, tiempo y outcome. Esto
es pseudonimización, no una garantía de anonimización. Eventos no vinculables con
certeza a esa cuenta no se borran por coincidencias de email/IP.

El cliente limpia sólo sesión, identidad nativa y cache de entitlements de esa cuenta,
cambia inmediatamente a `local` y descarta el contexto financiero anterior. Una
respuesta `account_deleted` recibida por otro dispositivo desconecta sólo el owner
cuyo grant envió el request; una respuesta tardía de A no cierra B.

El SQLite account-owned puede permanecer físicamente; no se activa ni reasigna a
`local`. Otros owners, backups y exportaciones quedan intactos. Un dispositivo
offline no recibe una revocación remota hasta contactar al servidor; no se añade
background sync ni se promete borrar remotamente copias locales/licencias offline.

## Validación y pendientes externos

Validaciones automatizadas ejecutadas durante M10A:

- Backend: 130 pruebas de eliminación, seguridad, sesiones, dual-auth, bootstrap y
  Mercado Pago; todas pasaron con el código final. Incluyen 11 casos de eliminación.
- PostgreSQL efímero local: 3 pruebas, con migración repetida, foreign keys reales,
  concurrencia y rollback. SQLite también se verifica en las pruebas de backend.
- Frontend: auth 102, mobile 172 y billing 45 pruebas; todas pasaron. Las nuevas
  pruebas usan las migraciones SQLite mobile reales y verifican hashes de A/B/local.
- Rust Windows locked: check correcto y 13 tests correctos, incluido el vector
  interoperable de firma de eliminación. Build frontend, compileall, YAML y
  `git diff --check` correctos.

Cubren auth/trust/proof, expiry, replay, OTP incorrecto, rollback, cierre,
revocación/refresh/sync posteriores, bootstrap bloqueado, archivo billing,
minimización audit, éxito/fallo/timeout/retry Supabase y limpieza del cliente.

### Validación real completada

Se utilizó exclusivamente el backend SQLite temporal en loopback, sin credencial
admin Supabase ni Mercado Pago. No se accedió ni modificó la base Railway.

1. El usuario inició sesión con la cuenta de prueba en Android y Windows y completó
   los OTP de autorización. Se verificó un mismo users.id interno, diferente de los
   owners protegidos, con dos dispositivos trusted y dos familias.
2. Desde Android se creó una categoría ficticia y un gasto de 1, se subieron al
   cloud QA y Windows los descargó mediante su sync existente.
3. El usuario completó en Android OTP de eliminación + ELIMINAR + firma nativa.
   La transacción eliminó la cuenta y todas sus filas dependientes. Sin violaciones
   de foreign keys; material de OTP/proof/binding borrado del recibo.
4. Android volvió a local, sin cuenta recordada. Al solicitar sync desde Windows,
   también perdió el acceso y volvió a local. Recargar ambas apps no restauró la cuenta.
5. Las lecturas nativas confirmaron ausencia del refresh de QA en Keystore y
   WinCred, sin retornar su contenido a logs. No quedaron dispositivos ni familias.
6. El usuario intentó login otra vez y recibió «La cuenta fue eliminada, esta cuenta
   ya no puede utilizarse». La base continuó sin users: bootstrap no recreó nada.
7. Hashes de todas las filas y conteos de seis tablas financieras permanecieron
   idénticos después del borrado en ambos dispositivos, incluyendo el cache de QA,
   local y los otros owners. No se borró, copió ni reasignó a local ningún movimiento.

Se comprobó presencia/conservación de un backup en las carpetas conocidas durante
la limpieza del segundo dispositivo. El baseline de archivos se tomó después de
la transacción cloud, por lo que esa comparación no cubre la fase anterior.
No se enumeraron exportaciones fuera de esas carpetas; el flujo no invoca su borrado.

El outbox real quedó external_auth_status=pending / not_configured. Supabase **no**
fue eliminado; el acceso interno quedó bloqueado por hash de identidad. No activar
admin delete ni reintentar el outbox de QA contra cuentas fuera de esta prueba.
La cuenta real usada fue Free, sin suscripción: archivo comercial, Premium y
webhooks posteriores se verificaron en pruebas aisladas, no con cobros reales.

Durante QA se corrigió el launcher temporal: debe cargar
`SCISONOMICS_RESEND_API_KEY`, no `RESEND_API_KEY`. El login puede solicitar OTP para
autorizar un dispositivo nuevo. Dos regresiones nuevas comprueban que el servicio
permite reingresar sobre una cuenta guardada con sesión vencida, sin quitarla.
El caso reportado en la UI real todavía requiere confirmar plataforma/contexto.

QA utiliza un signer RSA efímero cifrado con DPAPI para emitir entitlements; no se
modifican claves del producto. El verificador desktop conserva su clave pública
real y rechaza firmas QA para licencias offline. Por eso esta prueba real de una
cuenta Free no demuestra activación Premium offline; su cierre/reconciliación se
verifican en las pruebas de backend y frontend aisladas.

No se encontró un repo de web pública dentro de este proyecto. El contrato para
`/delete-account` está en [PUBLIC_ACCOUNT_DELETION_PAGE.md](PUBLIC_ACCOUNT_DELETION_PAGE.md).
No se inventa URL publicada ni se despliega la página de la app como sitio público.

Requieren decisión/revisión externa: plazos y base de retención comercial/seguridad,
eliminación en backups del operador, solicitudes sin app, identidad y tiempos de
soporte, reembolso/cobros remotos, jurisdicción/domicilio y wording legal definitivo.
Los TTL técnicos de OTP/proof/recibo no son plazos legales de retención.
