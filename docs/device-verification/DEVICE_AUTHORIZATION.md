# Autorización de dispositivos compartida — Milestone 8

Implementación local para Windows y Android. **Milestone 8 todavía no está
cerrado:** faltan las pruebas con correo real y un segundo perfil Windows contra
un backend de prueba autorizado. No se desplegó ni se modificó Railway.

## Identidad y protocolo

Se reutilizan la identidad Ed25519 por cuenta, `users.device_key_namespace` y el
[contrato V1 congelado](v1/canonical-proof-v1.md), sin cambiar sus 237 bytes,
propósitos o fixtures. No se usan hardware, MAC, hostname o serial. La IP solo
interviene en el rate limiting existente; nunca concede confianza.

`users.id` sigue siendo la identidad interna. El `sub` de Supabase identifica al
proveedor; `device_id` identifica una clave por cuenta/instalación. Ninguno
sustituye owners financieros. `cloud_devices` conserva su papel de telemetría
de sync y no autoriza dispositivos.

Windows y Android consumen el mismo servicio y endpoints `/auth/devices`:

| Operación | Requisitos |
| --- | --- |
| `GET /context`, `POST /login` | Identidad Supabase verificada y usuario interno resuelto |
| `POST /resend`, `/enrollment/challenge`, `/enrollment/complete` | Identidad primaria y continuación temporal; completar exige OTP + firma `DeviceEnrollment` |
| `POST /authentication/complete` | Dispositivo trusted + firma `DeviceAuthentication` |
| `POST /refresh/challenge`, `/refresh/complete` | Identidad primaria actual, familia activa, dispositivo trusted + firma `Refresh` |
| `GET /auth/devices` | Grant autorizado del dispositivo actual |
| `POST /management/challenge`, `/management/complete` | Grant/familia del actor + firma `DeviceRename` o `DeviceRevoke` sobre target y hash de nombre cuando corresponde |

El cliente hace bootstrap antes del handshake. El backend comprueba la identidad
con la [API oficial de Supabase](https://supabase.com/docs/reference/javascript/auth-getuser)
y envía el código al email confirmado del proveedor, aunque el email legacy
almacenado sea antiguo. Los endpoints no buscan cuentas ajenas públicamente.

## Login y enrollment

1. Credenciales Supabase válidas, bootstrap y `users.id` interno.
2. Obtener/crear la identidad nativa de esa cuenta.
3. Si es trusted, firmar un challenge `DeviceAuthentication`: no pedir otro OTP.
4. Si es nueva o revocada, devolver `pending_verification`, sin grant ni familia
   activa. La sesión SDK y la continuación quedan solo en memoria. No guardar
   refresh ni activar la nueva cuenta antes de la confirmación.
5. Mostrar el diálogo compartido y completar OTP + prueba `DeviceEnrollment`.
6. Consumir ambos challenges, autorizar la clave, crear una familia y emitir un
   grant corto. Recién entonces guardar el refresh nativo si el usuario eligió
   recordar sesión, y activar la cuenta con su ID interno.

El OTP de dispositivo es distinto de la confirmación de signup de Supabase.
Una cuenta recién creada puede necesitar ambas verificaciones. Cancelar el
enrollment conserva el modo local y las otras cuentas ya conectadas.

OTP: seis dígitos aleatorios, TTL 600 segundos, máximo cinco intentos, un uso,
cooldown de 60 segundos por cuenta y máximo cinco envíos por hora por cuenta.
Se suma rate limiting de requests. Reenvío invalida el código/continuación y las
pruebas de enrollment anteriores. Renovar únicamente el nonce de firma no
extiende el TTL del email. Un fallo de envío invalida el challenge y no autoriza.

La DB almacena HMAC-SHA256 del OTP con secreto del servidor y dominio ligado a
usuario/challenge. Las continuaciones y nonces aleatorios se guardan hasheados.
Comparaciones sensibles usan `compare_digest`. Las mutaciones se serializan
por usuario: `BEGIN IMMEDIATE` en SQLite y `SELECT ... FOR UPDATE` en PostgreSQL.
El consumo es condicional y atómico; dos completions simultáneas tienen un ganador.

Se reutiliza Resend/SMTP existente con asunto «Código de verificación de
ScisoNomics», vencimiento y aviso de dispositivo nuevo. El outbox en memoria
es exclusivo de desarrollo/tests: no es almacenamiento de códigos en DB ni log.
Las respuestas llevan `no-store`; validaciones y errores no repiten inputs ni
cuerpos sensibles. Logs nuevos registran eventos y IDs opacos abreviados.

## Custodia nativa

- Windows: seed Ed25519 en WinCred por namespace opaco de cuenta. Se conserva
  el storage de refresh y PKCE existente; no se cambia updater o sidecar.
- Android: seed cifrado AES-256-GCM con una clave no exportable de Android
  Keystore. Ciphertext en `noBackupFilesDir/device_identities`, escritura
  `AtomicFile` y AAD de identidad/cuenta. Refresh usa otro directorio y AAD.
  No se guarda material privado en SQLite financiera o storage WebView.
- JavaScript solo obtiene identidad pública y firmas mediante comandos Rust.
  Las operaciones nativas de identidad no tienen permisos JS. El plugin además
  rechaza comandos desconocidos antes del fallback mobile; no puede leerse el
  blob privado invocando directamente Kotlin.
- iOS: contrato listo para el mismo protocolo; custodia Keychain pendiente y
  autenticación falla cerrada. No se promete soporte iOS implementado.

Referencia: [plugins mobile de Tauri](https://v2.tauri.app/develop/plugins/develop-mobile/)
y [Android Keystore](https://developer.android.com/privacy-and-security/keystore).
El emulador puede usar Keystore con respaldo software; no se promete StrongBox.
La clave AES no sale de Keystore. El seed Ed25519 se descifra únicamente dentro
del runtime nativo para firmar; no atraviesa IPC hacia JavaScript ni se envía al
servidor. Rust usa buffers `Zeroizing`; Kotlin/SDK tienen límites de borrado en memoria.

## Refresh, gestión, revocación y recuperación

Un refresh Supabase válido por sí solo no restaura la cuenta. Tras renovar la
identidad primaria, el cliente debe demostrar posesión con `Refresh` y la familia
activa. Solo después persiste la rotación y publica el access grant. El refresh
rotado permanece en memoria mientras falla la red: cerrar la app en ese punto
puede requerir login de nuevo si ya expiró la gracia del proveedor.

El grant tiene TTL máximo 15 minutos; la familia vence a los 30 días sin extensión
automática. Cada endpoint protegido vuelve a comprobar trusted/familia en DB.
Un token Supabase o access legacy no puede saltarse el dispositivo en `enforce`.
Los challenges de prueba duran hasta 120 segundos y son de un solo uso.

Cuenta → Dispositivos muestra nombre, plataforma, estado, este dispositivo y
último acceso; permite renombrar y revocar con pruebas firmadas. Renombrar firma
el hash del nombre normalizado, revocar firma el target. Revocar el dispositivo
actual exige confirmación explícita.

Revocar invalida todas las familias del target y sus challenges. También rechaza
un grant o proof emitido antes de la revocación. Al intentar refresh, el cliente
elimina su sesión persistida y metadata de familia. No borra datos financieros.
Un login posterior en ese equipo pide un nuevo OTP. Reenrollment no resucita
familias antiguas. Logout normal borra sesión/familia local y conserva la clave
para que un equipo todavía trusted no pida OTP en cada login. Logout offline no
revoca por sí mismo el grant remoto; usar Dispositivos para revocación remota.

Si se pierde la clave, crear una identidad nueva con login Supabase + OTP. Si
solo vence la familia, iniciar sesión otra vez: una clave todavía trusted no
requiere otro OTP. Si se pierde acceso al email, primero recuperar la cuenta
con el proveedor. Un almacén nativo corrupto falla cerrado; no hay reset
automático de claves. Requiere reparación controlada sin borrar SQLite, nunca
`wipe-data` como recuperación de auth. No hay backdoor de confianza por backup, refresh legacy, email sin confirmar o hardware.
Browser conserva modo local; login cloud de este protocolo necesita custodia
nativa y falla cerrado en browser hasta definir una estrategia segura.

## Configuración y transición

No se agregan secretos ni service-role. Se reutilizan Supabase publishable,
`SCISONOMICS_JWT_SECRET` y Resend/SMTP. La variable existente
`SCISONOMICS_DEVICE_VERIFICATION_MODE` ahora tiene default **`enforce`**;
recomendado declararla explícitamente. `observe` sigue rechazado.
`off` es rollback explícito del operador, **sin protección de dispositivo**;
los nuevos clientes lo rechazan. Los endpoints legacy se conservan como
compatibilidad interna, pero no permiten acceder ni renovar sesiones sin
autorización en `enforce`.

Esta transición exige backend/clientes coordinados. Las sesiones anteriores sin
familia/clave deben volver a iniciar sesión y pasar OTP; no se confían a ciegas.
Antes de un despliegue separado: comprobar email real, servidor en `enforce`,
clientes compatibles y pruebas manuales pendientes. No activar un backend
`off` como solución a un fallo del nuevo login.

Schema: se reutilizan las tablas aditivas existentes. Solo se agrega `platform`
nullable a `trusted_devices` y `device_verification_challenges`, idempotentemente
en SQLite/PostgreSQL. Rollback de código conserva estas columnas/tablas; nunca
borra users, owners, movimientos o Premium. No hay migración financiera nueva.

## Amenazas y límites

Se cubren refresh robado sin clave local, replay, sustitución de propósito/target,
OTP incorrecto/vencido, reenvío, carreras de consumo, identidad de otra cuenta,
revocación y bypass con token primario. No protege una sesión en un dispositivo
totalmente comprometido: código JS malicioso dentro de un WebView autorizado
puede pedir firmas y acceder al token corto en memoria. Robar simultáneamente el
grant permite usarlo durante su TTL mientras no sea revocado. Compromiso del
email, proveedor, servidor o usuario Windows queda fuera de esta garantía.
Los límites de request en memoria no son globales entre réplicas; cuota de
emails, cooldown y consumo sí se aplican con DB/locks.

## Validación y pendientes obligatorios

- Backend: 15 tests de dispositivos en SQLite y los mismos 15 contra PostgreSQL
  18 temporal localhost; datos sintéticos, sin servicios/DB existentes.
- Frontend: nuevo y conocido Windows/Android, OTP previo a persistencia,
  cancelación, Google callback pendiente, rotación autorizada, revocación,
  separación de cuentas y propósitos. `test:auth` incluye el protocolo nuevo.
- UI: código, error, reenvío/cooldown, dispositivos, rename y confirmación actual.
- APK real: enrollment firmado contra backend aislado, login conocido sin otro
  OTP, cierre/reapertura con la misma clave cifrada, Refresh firmado, rename y
  revocación por actor Windows simulado. Lectura/escritura/borrado privado desde
  JS rechazados. Logcat sin los secretos ficticios; SQLite financiera intacta.
- Windows: regresiones Rust y roundtrip de identidad sintética WinCred.
- APK debug final generado con `tauri android build --debug --target x86_64
  --apk --ci`, instalado con `adb install -r`, sin wipe-data/desinstalación.
  Inicio/local renderiza y la comparación completa de SQLite vuelve a pasar.
- Regresión completa: 169 tests backend, auth 90, mobile 115, billing 45,
  updater 32, platformStartup 24, export Next/TypeScript y 10 tests Rust Windows.
  Se corrigió únicamente la expectativa de fecha de un test financiero que ya
  simulaba un día fijo: el reloj real dejó de coincidir al cruzar medianoche.
  No cambió la lógica financiera. CI incorpora el protocolo en `test:auth` y
  los tests backend de dispositivos en `application-security`.

**Pendiente antes de cerrar M8:** entrega de correo real + credenciales Supabase
reales contra backend de prueba autorizado; persistencia/restauración de esa
sesión con el protocolo nuevo; PC A real revoca Android B real y B borra su refresh;
nuevo login B + OTP; repetir en segundo perfil Windows real. Las suites simulan
esos cruces, pero no sustituyen esta validación manual. El ensayo anterior con
cuenta real fue previo a Device Authorization y no demuestra estos requisitos.
