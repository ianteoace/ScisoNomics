# Auth externo en frontend/Tauri: fase paralela

Supabase autentica la identidad. El backend cloud conserva `users` y resuelve
el usuario interno mediante `GET /auth/me` con el access token externo.
Ese `CloudUser.id`, nunca `Session.user.id` de Supabase, se usa como owner.
No se solicita ni se crea un usuario interno desde el frontend.

## Modulos y flujo

- `lib/supabase.ts` crea clientes Auth del SDK instalado bajo demanda, uno
  por intento/cuenta. No inicializa una sesion global al importar el modulo
  y no falla el modo local si falta configuracion. Acepta publishable keys
  modernas, HTTPS o HTTP loopback. No crea clientes de datos ni realtime.
- `services/supabaseCloudAuth.ts` implementa login y registro por password,
  verificacion/reenvio de correo, recuperacion por codigo, getSession,
  refreshSession y signOut. Las sesiones del SDK quedan aisladas en memoria.
- `services/cloudAuth.ts` conserva `StoredCloudAccount`, `activeOwnerId` y
  la cache central de access tokens. Agrega `authProvider` opcional; los
  metadatos anteriores sin ese campo se interpretan como legacy.
- `AddAccountModal` ofrece Supabase y Acceso anterior; `SupabaseAccountForm`
  concentra la nueva UI. `AccountPanel` permite abrir el modal y distingue
  las cuentas Supabase temporales del acceso anterior.
- Sync y entitlements consumen la misma interfaz de token central. El unico
  cambio en `cloudSync.ts` pasa el owner original al refresh del retry 401
  para evitar usar el token de otra cuenta si se cambio de owner mientras
  habia una solicitud en curso. Billing y Device Proof no se modifican.

Login exitoso: SDK -> access token -> `/auth/me` -> `CloudUser` interno ->
cuenta temporal -> owner activo. Si `/auth/me` devuelve
`internal_account_required`, la UI explica que el alta interna queda para la
fase siguiente y conserva la cuenta activa anterior. Errores de identidad,
email ambiguo o vinculo incompatible tampoco agregan cuentas.

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
| Metadatos Supabase temporales | sessionStorage, con ID interno y marcador del proveedor |
| Access token Supabase | cache de runtime existente y sessionStorage; nunca localStorage |
| Refresh token Supabase | memoria del modulo/SDK; nunca localStorage, sessionStorage ni WinCred |
| Refresh token legacy | storage seguro Tauri/WinCred existente, sin migracion |

Cerrar la app termina la sesion temporal. Recargar la pagina pierde el refresh
token externo en memoria; un access token de sessionStorage sigue utilizable
hasta su expiracion y luego exige login. La UI no ofrece Recordarme para
Supabase. La futura persistencia segura debe usar un namespace separado de
legacy, vinculado a proyecto/proveedor e ID interno, y probar rotacion,
restauracion y limpieza antes de habilitarse.

Refresh se dirige por proveedor y owner; solicitudes simultaneas de una
cuenta comparten una promesa. Los tokens rotados se conservan en memoria
si la validacion del backend falla temporalmente. Se verifica nuevamente
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

## Correo y OAuth

El registro puede devolver una sesion o requerir confirmacion, como documenta
[Supabase signUp](https://supabase.com/docs/reference/javascript/auth-signup).
La confirmacion mediante enlace se realiza en Supabase; despues se vuelve
a iniciar sesion en la app. Si el correo incluye un OTP se puede usar
`verifyEmailCode`, que aplica la misma resolucion del usuario interno.

Recuperacion en la app usa `resetPasswordForEmail`, `verifyOtp(type=recovery)`
y `updateUser(password)`. Para que este flujo por codigo funcione, la plantilla
de recuperacion debe incluir `{{ .Token }}`. La plantilla de confirmacion
tambien puede incluirlo para verificar dentro de la app, siguiendo
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
```

Las pruebas de Node ejecutan los servicios TypeScript y el SDK real con
fetch simulado. Solo admiten hosts `.test`; WinCred se simula en el puente
Tauri y no accede a credenciales del sistema. Cubren login correcto/incorrecto,
registro, ausencia de cuenta interna, IDs, multicuentas, legacy, modo local,
refresh/rotacion/concurrencia, logout, recarga, verificacion y recuperacion.
No usan datos reales ni Railway. No sustituyen una prueba nativa empaquetada
de Tauri ni un rollout contra un proyecto Supabase de staging.

## Siguiente fase

1. Implementar el alta interna explicita en el backend con un nuevo `users.id`
   propio y politica de conflictos; no convertir Supabase sub en primary key.
2. Revisar confirmacion real de email en Supabase antes de vincular por email.
3. Preparar plantillas de OTP, SMTP/rate limits y callbacks de recuperacion/OAuth
   en staging. Probar el paquete Tauri y los retornos del navegador.
4. Disenar persistencia externa segura separada del storage legacy; no
   habilitar persistSession o localStorage como atajo.
5. Mantener registro/login/refresh/logout legacy, Google legacy y su storage
   seguro hasta una migracion explicita de las cuentas existentes.
