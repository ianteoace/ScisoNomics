# Google en Android — 3.3.3 / 3003003

Android reutiliza Supabase OAuth + PKCE S256 + navegador externo + retorno
nativo + `exchangeCodeForSession`. Desktop conserva su flujo; iOS permanece
deshabilitado. Email/password y OTP siguen disponibles.

## Deep link y cold start

`tauri.android.conf.json` declara `plugins.deep-link.mobile` con esquema
`scisonomics`, host `auth`, ruta exacta `/callback` y `appLink: false`.
El plugin genera el intent-filter durante el build. No editar `gen/android`.
Desktop conserva su registro de esquema existente.

El listener compartido se monta después de abrir SQLite, fuera del shell
financiero que cambia con el owner. Primero suscribe `onOpenUrl` para retornos
con la app abierta/en background; luego consulta `getCurrent` para cold start.
Sólo acepta `scisonomics://auth/callback?code=...`, sin fragmentos, credenciales,
parámetros desconocidos ni repetidos. No se navega al callback ni se imprime.

## Estado seguro

Cada intento tiene cliente SDK y storage en memoria propios. La URL authorize
debe pertenecer al proyecto configurado, tener provider Google, redirect exacto,
challenge S256 de 43 caracteres y parámetros críticos únicos.
Antes de abrir el navegador se guarda exclusivamente el snapshot PKCE y se
verifica el roundtrip nativo. Si falla, Google no se abre.

Android reutiliza `mobile-secure-storage`: AES-GCM con Android Keystore y
`noBackupFilesDir`. El slot es
`SHA256("oauth-pkce:" + projectUrl)::pending_google`, separado de refresh tokens
y de owners/Supabase subjects. Base64url adapta el JSON al contrato del plugin;
Keystore cifra el contenido. Desktop mantiene su slot WinCred.

El intento vence en cinco minutos. Cold start lee sólo el slot del proyecto
actual, valida contenido/TTL y reconstruye el cliente en memoria. El pending
seguro se elimina **antes** del exchange. Los callbacks simultáneos se bloquean;
los códigos consumidos se recuerdan sólo como SHA-256 en memoria. Tras reiniciar,
el verificador consumido ya no existe. Cancelar, denegar o expirar requiere
un nuevo intento. No hay fallback a WebView storage de secretos.

## Autorización y recovery

Tras exchange se exige email confirmado y se reutiliza bootstrap. El owner
sigue siendo `users.id` interno. Un dispositivo nuevo completa el OTP existente
antes de activar la cuenta y guardar el refresh token en Keystore. Mientras
tanto la sesión queda en memoria. El access token Android también es sólo memoria.

No se cambia recovery staging → producción: los eventos compartidos de cuenta
activan la evaluación existente por email normalizado, con owner anterior
archivado, consentimiento explícito y sync bloqueado hasta resolver. Google
no mueve datos ni omite esa decisión.

## Validacion real y cierre de release

Google Android 3.3.3 fue validado en dispositivo real contra produccion: deep
link, PKCE S256, exchange, bootstrap, trusted-device, OTP cuando corresponde y
activacion final. El fallo inicial fue una publishable key de otro proyecto.
El backend productivo fue desplegado con verificacion de dispositivo en modo
`enforce`. Esta tarea no modifica esos servicios ni secretos.

La UI conserva mensajes amigables y ya no muestra codigos tecnicos `oauth_*`.
Los logs operativos Android contienen solo fallos sanitizados: callback invalido,
pending ausente/vencido/invalido, fallo de borrado, exchange, sesion invalida,
bootstrap, autorizacion y guardado. No se imprimen etapas, exitos, busy/replay ni
el OTP requerido; siguen cubiertos por tests de comportamiento.

`auth_error_code` se obtiene mediante `isAuthApiError` oficial y una allowlist;
los codigos desconocidos se convierten en `other`. Se conserva status HTTP real
y duracion cuando aplica. No se serializan mensajes, excepciones completas,
URLs, parametros, headers, cuerpos, identificadores, fingerprints, challenge,
verifier, tokens ni claves.

Los logs de ciclo de sesion del auth compartido quedan limitados a development;
su sanitizador tambien redacta identidades y URLs, incluidos avisos de limpieza.

Wry conserva su forwarding de consola solo en debug. Release usa exclusivamente
el puente especifico `log_google_oauth_diagnostic`: Rust y Kotlin rechazan
campos desconocidos, eventos ajenos a fallos, tipos/rangos invalidos y texto
arbitrario. El limite es 768 bytes. El puente no lee/escribe credenciales ni
habilita forwarding generico. Un fallo del logger no cambia la autenticacion.

## Guard de clave para empaquetado Android productivo

`npm run build:android:production` verifica las URLs exactas y el prefijo de la
clave, y luego hace un unico GET a `/auth/v1/settings` del proyecto productivo,
con la clave existente exclusivamente en el header `apikey`. Exige HTTP 200,
no sigue redirects y usa timeout de cuatro segundos. Descarta el cuerpo sin
inspeccionarlo. Un rechazo o problema de red bloquea el build antes de borrar
`out`, con mensaje generico y sin imprimir claves, headers ni cuerpos.

La comprobacion es de solo lectura y no modifica Supabase. Se limita al wrapper
Android productivo; `npm run build`, tests/CI y `--verify-only` siguen offline.
No existe bypass ni cache de aprobacion: un empaquetado productivo offline se
bloquea deliberadamente. Para trabajar offline usar desarrollo/tests/build
frontend; repetir el empaquetado cuando vuelva la conectividad. Esto evita
reutilizar una aprobacion obsoleta o publicar otra key con formato valido pero
perteneciente a otro proyecto. Una CI Android futura necesitara acceso HTTPS
al proyecto y la key del entorno seguro, sin registrarla.

Se conservan recovery habilitado y los controles de export: staging API y
Supabase cero; ambos origenes de produccion presentes. `npm run
verify:android:production` comprueba assets offline, pero no sustituye el
preflight online que precede al empaquetado. No generar APK/AAB en esta fase.
