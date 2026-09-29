# Auth externo: bootstrap interno y persistencia Tauri

Supabase autentica la identidad. El backend cloud conserva `users` y resuelve
el usuario interno mediante `POST /auth/supabase/bootstrap` con el access token
externo al ingresar/confirmar correo. El refresh valida `GET /auth/me`.
Ese `CloudUser.id`, nunca `Session.user.id` de Supabase, se usa como owner.
El frontend solicita el bootstrap explicito con `{}`. El backend asigna el ID;
el cliente no puede enviar identidad, email, plan ni privilegios.

## Modulos y flujo

- `lib/supabase.ts` crea clientes Auth del SDK instalado bajo demanda, uno
  por intento/cuenta. No inicializa una sesion global al importar el modulo
  y no falla el modo local si falta configuracion. Acepta publishable keys
  modernas, HTTPS o HTTP loopback. No crea clientes de datos ni realtime.
- `services/supabaseCloudAuth.ts` implementa login y registro por password,
  verificacion/reenvio de correo, recuperacion por codigo, getSession,
  refreshSession y signOut. Las sesiones del SDK quedan aisladas en memoria.
- `services/supabaseTokenStorage.ts` llama exclusivamente a los comandos Tauri
  Supabase. `src-tauri/src/supabase_tokens.rs` reutiliza WinCred/keyring bajo
  `scisonomics-supabase-refresh-token`, separado de ambos servicios legacy.
- `services/cloudAuth.ts` conserva `StoredCloudAccount`, `activeOwnerId` y
  la cache central de access tokens. Agrega `authProvider` opcional; los
  metadatos anteriores sin ese campo se interpretan como legacy.
- `AddAccountModal` ofrece Supabase y Acceso anterior; `SupabaseAccountForm`
  concentra la nueva UI. `AccountPanel` permite abrir el modal y distingue
  las cuentas Supabase temporales/recordadas del acceso anterior. Recordar
  cuenta esta disponible solamente en Tauri; en navegador es temporal.
- Sync y entitlements consumen la misma interfaz de token central. El unico
  cambio en `cloudSync.ts` pasa el owner original al refresh del retry 401
  para evitar usar el token de otra cuenta si se cambio de owner mientras
  habia una solicitud en curso. Billing y Device Proof no se modifican.

Login/signup confirmado: SDK -> access token -> bootstrap -> `CloudUser`
interno -> guardado seguro opcional -> owner activo. Signup sin sesion pide
verificacion sin crear/activar una cuenta. Confirmar con OTP completa el mismo
bootstrap. Un fallo del bootstrap o del storage seguro conserva la cuenta
activa anterior; nunca activa una identidad parcial. Los errores 409 requieren
resolver el conflicto de identidad/email, sin crear otro owner automaticamente.

## Alta interna y schema

Bootstrap exige Supabase `GET /auth/v1/user` y `email_confirmed_at`, nunca
claims decodificados sin validar ni `user_metadata.email_verified`. Metadata
solo aporta un nombre de hasta 120 caracteres. Primero resuelve el vinculo
por sub, despues un unico email normalizado, y por ultimo crea UUID propio,
plan free, subscription_status active y timestamps. Conserva el namespace de
dispositivo mediante el helper de insercion existente, sin modificar Device Proof.
Un vinculo previo siempre gana, incluso si Supabase cambio el email.

Migracion aditiva/idempotente: `password_auth_enabled INTEGER NOT NULL DEFAULT 1`.
Se mantiene el `password_hash NOT NULL` existente porque SQLite exigiria
reconstruir users para relajarlo, afectando el riesgo sobre FKs financieras.
La representacion equivalente de ausencia de password es `password_hash=''`
y `password_auth_enabled=0`; no hay password inventado ni hash falso. El login
legacy rechaza esos registros explicitamente. Los hashes/password auth legacy
y su verificacion de correo se conservan al vincular cuentas previas.

SQLite serializa bootstrap con BEGIN IMMEDIATE. PostgreSQL usa advisory locks
de transaccion por sub/email, ordenados, con timeout. CAS y el indice unico
parcial de auth_provider_id protegen carreras con /auth/me. Una colision de
creacion se relee tras rollback o responde 409; bloqueo agotado responde 503.
Se audita creacion/vinculacion en la misma transaccion con ID interno y evento,
sin tokens, emails, metadata ni datos financieros; el log usa un hash del ID.

Una cuenta interna tiene una sola entrada con su proveedor actual. Entrar
por Supabase sobre una cuenta legacy del mismo ID reemplaza sus metadatos
de sesion, sin sobrescribir su refresh token en WinCred. Otras cuentas
legacy siguen guardadas. Las cuentas externas con IDs internos distintos
no se fusionan por coincidencia de email.

## Persistencia y sesiones

`persistSession=false`, `autoRefreshToken=false`, `detectSessionInUrl=false`.
No hay service_role, claves secretas ni JWT signing secrets en el cliente.
Los SDK temporales y los de cuentas retiradas se liberan con `auth.dispose()`.

| Dato | Ubicacion |
| --- | --- |
| Metadatos legacy persistentes | localStorage existente, sin tokens |
| Metadatos Supabase | localStorage si recordados, sessionStorage si temporales; ID interno/proveedor, sin tokens |
| Access token Supabase | cache de runtime existente y sessionStorage; nunca localStorage |
| Refresh token Supabase | memoria del SDK; WinCred/keyring separado si Recordar; nunca localStorage/sessionStorage |
| Refresh token legacy | storage seguro Tauri/WinCred existente, sin migracion |

La clave segura es `SHA256(URL canonica del proyecto)::users.id` dentro del
servicio Supabase. El sub nunca es una clave financiera. Durante bootstrap
se mantiene el token en memoria y se escribe solo despues de conocer el ID
interno: no hacen falta entradas temporales ni su migracion. El comando native
comprueba una lectura exacta tras guardar y limpia copias temporales del secreto.

Al iniciar se hidratan las cuentas recordadas con refreshSession usando sus
credenciales separadas y se valida el mismo ID via /auth/me antes de publicar
el access token; restaurar otras cuentas no cambia activeOwnerId. Sin Recordar,
cerrar termina la sesion; recargar pierde el refresh en memoria y permite usar
el access token de sessionStorage solo hasta que expire. SDK persistSession
continua deshabilitado: la persistencia esta bajo control de esta capa.

Refresh se dirige por proveedor y owner; solicitudes simultaneas de una
cuenta comparten una promesa. Los tokens rotados se conservan en memoria y
storage seguro ANTES de validar el backend, para sobrevivir una caida temporal
o reinicio. Un fallo de guardado se informa, sin fallback a web storage.
Operaciones nativas de cada owner se serializan; borrar espera cualquier save
pendiente y un refresh atrasado no puede restaurar esa credencial. Se verifica
`/auth/me` y se exige el mismo ID interno antes de publicar el access token.
Un refresh atrasado no reactiva cuentas eliminadas ni reemplaza el proveedor
actual. Cambiar a modo local conserva las cuentas pero no selecciona un token
cloud para el owner `local`.

SignOut usa [scope local de Supabase](https://supabase.com/docs/reference/javascript/auth-signout)
para la sesion especifica, sin cerrar las sesiones de otros dispositivos.
La limpieza local funciona aunque no se pueda revocar remotamente. La API
devuelve `remoteRevoked` para distinguirlo. Los access JWT del proveedor
pueden seguir siendo validos hasta su expiracion; logout no implica
revocacion inmediata de cada JWT emitido.
Quitar una cuenta Supabase elimina exclusivamente su credencial externa;
no borra el refresh legacy conservado para el mismo usuario. Un error de
eliminacion devuelve ok=false para informar que la limpieza quedo incompleta.
Sin memoria SDK, logout puede limpiar el dispositivo sin revocar remotamente.

## Correo y OAuth

El registro puede devolver una sesion o requerir confirmacion, como documenta
[Supabase signUp](https://supabase.com/docs/reference/javascript/auth-signup).
La confirmacion desktop usa OTP dentro de ScisoNomics, sin enlace web,
redirect ni navegador. Signup sin sesion devuelve `verification_required`;
la UI conserva el email pendiente solo en memoria, bloquea su edicion para
evitar verificar otra identidad y muestra el campo de codigo. Usar otro email
reinicia el formulario; cerrar el modal descarta el estado pendiente.
`verifyEmailCode` usa la API oficial `auth.verifyOtp({ email, token, type: "email" })`;
la sesion confirmada pasa al bootstrap y solo despues activa users.id interno
y guarda el refresh en WinCred si corresponde. El OTP nunca se persiste ni
se imprime en logs. `persistSession=false` se mantiene.

Reenvio usa `auth.resend({ type: "signup", email })`, no otro signup ni login
passwordless. La UI espera 60 segundos despues de signup, reenvio exitoso o
reenvio limitado. Es una ayuda de UI; los limites/expiracion del proyecto
Supabase siguen siendo la autoridad. Errores de formato, codigo invalido o
vencido, demasiados intentos y reenvio bloqueado tienen mensajes explicitos.
Supabase puede usar `otp_expired` tanto para un codigo incorrecto como vencido;
la app informa ambas posibilidades sin inventar una distincion del servidor.

### Configuracion manual de Supabase (no aplicada automaticamente)

1. Mantener habilitada la confirmacion de email para el proveedor Email.
2. En Authentication -> Email Templates -> **Confirm sign up**, reemplazar el
   enlace `{{ .ConfirmationURL }}` por el codigo `{{ .Token }}`. No editar Magic
   Link para este flujo: el registro sigue siendo por email/password.
3. Usar, por ejemplo, este cuerpo y guardar la plantilla manualmente:

   ```html
   <h2>Confirmá tu correo en ScisoNomics</h2>
   <p>Ingresá este código dentro de la app:</p>
   <p><strong>{{ .Token }}</strong></p>
   <p>Si no solicitaste esta cuenta, ignorá este correo.</p>
   ```

4. Revisar expiracion de Email OTP, limites de envio y SMTP del proyecto. El
   input admite 6 a 10 digitos (preserva ceros iniciales); pegar el codigo
   completo del correo. No requiere modificar Site URL ni redirects de otros
   flujos. Correos viejos con links siguen sin servir para este flujo desktop;
   pedir un nuevo codigo despues de guardar la plantilla.

Referencias oficiales: [Email Templates](https://supabase.com/docs/guides/auth/auth-email-templates),
[verifyOtp](https://supabase.com/docs/reference/javascript/auth-verifyotp) y
[resend](https://supabase.com/docs/reference/javascript/auth-resend).

Recuperacion en la app usa `resetPasswordForEmail`, `verifyOtp(type=recovery)`
y `updateUser(password)`. Para que este flujo por codigo funcione, la plantilla
de recuperacion debe incluir `{{ .Token }}`. La plantilla de confirmacion
requiere el codigo para el flujo desktop anterior, siguiendo
[Email Templates](https://supabase.com/docs/guides/auth/auth-email-templates)
y [verifyOtp](https://supabase.com/docs/reference/javascript/auth-verifyotp).
No se modifica la configuracion real del proyecto desde este trabajo.
Un correo que solo contiene un enlace no permite completar la recuperacion
dentro de Tauri en esta fase; la UI explicita esa limitacion.

Supabase Google OAuth se posterga: faltan un redirect/callback PKCE seguro
para la app desktop, deep links o loopback controlado y pruebas del retorno
de navegador a Tauri. Google legacy sigue disponible en Acceso anterior.
No se capturan tokens desde URLs ni se habilita deteccion automatica de sesion.

## Validacion local

```powershell
cd modern_app/frontend
npm run test:auth
npm run build
cd src-tauri
cargo +1.88.0 check --locked --target x86_64-pc-windows-msvc
cargo +1.88.0 test --locked --target x86_64-pc-windows-msvc
```

Las pruebas de Node ejecutan los servicios TypeScript y el SDK real con
fetch simulado. Solo admiten hosts `.test`; WinCred se simula en el puente
Tauri y no accede a credenciales del sistema. Cubren login correcto/incorrecto,
registro, ausencia de cuenta interna, IDs, multicuentas, legacy, modo local,
refresh/rotacion/concurrencia, logout, recarga, verificacion y recuperacion.
Backend: compileall de app y unittest de test_supabase_bootstrap,
test_supabase_auth, test_email_verification y test_security. DBs SQLite
temporales, incluyendo carreras reales con threads. Rust agrega roundtrip,
rotacion y aislamiento de legacy con credenciales dummy unicas que se eliminan.
La validacion de la fase bootstrap/persistencia paso 63 tests backend, 31 frontend y 5 Rust, mas
build y cargo check. WinCred requirio ejecutar cargo test fuera del sandbox
(Windows 1312 dentro del sandbox); no se omitieron tests ni se uso un mock
para declarar correcto el roundtrip nativo.

La fase OTP paso 38 tests frontend (`npm run test:auth`) y `npm run build`.
La verificacion de UI con APIs simuladas cubrio signup pendiente, OTP
incorrecto/vencido, reenvio limitado y exitoso, bootstrap con users.id distinto
del sub y navegacion a Inicio, sin errores de consola ni overlay. No uso
Supabase ni Railway reales ni cambio plantillas del proyecto. La entrega real
del codigo por correo queda pendiente de la configuracion manual anterior.
No usan datos reales ni Railway. No sustituyen una prueba nativa empaquetada
de Tauri ni un rollout contra un proyecto Supabase de staging.

## Siguiente fase

1. Validar en staging PostgreSQL los locks, indices y errores de concurrencia;
   no se conecto a PostgreSQL/Railway real en esta fase.
2. Probar restauracion y logout en el paquete Tauri y ante cierre abrupto entre
   rotacion del proveedor y guardado nativo. Esa ventana no es atomica entre
   servicios; si se pierde la rotacion puede requerir re-login.
3. Preparar plantillas de OTP, SMTP/rate limits y callbacks de recuperacion/OAuth
   en staging. Probar el paquete Tauri y los retornos del navegador.
4. Preparar rollout coordinado backend/frontend y recovery para conflictos de
   email historicos. El cliente actualizado requiere el endpoint bootstrap.
5. Mantener registro/login/refresh/logout legacy, Google legacy y su storage
   seguro hasta una migracion explicita de las cuentas existentes.
