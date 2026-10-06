# Android + Next development

Desde `modern_app/frontend`, con las variables staging ya configuradas en esa
terminal PowerShell:

```powershell
npm.cmd run tauri:android:dev -- --no-watch Pixel_8
```

Requiere el SDK/NDK Android y Java configurados, como el flujo Android existente.
Tauri selecciona el emulador, hace forwarding ADB del puerto 3000 y arranca Next
escuchando en `0.0.0.0`. No necesita una IP LAN ni `10.0.2.2`.

Next recibe `TAURI_DEV_HOST=127.0.0.1` del CLI para el transporte ADB. Cuando el
hook indica Android (`TAURI_ENV_PLATFORM` o `TAURI_ENV_TARGET_TRIPLE`), el origen
de los assets se mantiene en `http://localhost:3000`, igual que el WebView:
página, chunks, hot updates y WebSocket comparten origen. Usar el host ADB como
`assetPrefix` mezclaba dos orígenes y bloqueaba los hot updates por CORS.
Desktop conserva su host de assets. En producción `assetPrefix` queda
`undefined` y se conserva `output: "export"`.

## Por qué existe un override de desarrollo

El proxy mobile de Tauri expone normalmente `http://tauri.localhost/`. En Next
16.3.8, el bootstrap del App Router calcula el prefijo desde el **pathname** del
script, descartando su origen. Por eso configurar solo `assetPrefix` permite
cargar scripts pero deja el HMR intentando conectar a
`ws://tauri.localhost/_next/hmr`, sin el puerto 3000.

`tauri.android.dev.conf.json` configura una ventana directa en
`http://localhost:3000/`, distinta del `devUrl` `http://127.0.0.1:3000`. Esa
distinción evita el proxy automático: ambos hosts llegan al mismo Next mediante
ADB reverse, y HMR conecta a `ws://localhost:3000/_next/hmr`.

El override concede los permisos nativos mobile necesarios únicamente a
`http://localhost:3000/*`, en la ventana `main` y plataforma Android. Incluye el
origen OAuth staging ya utilizado por el proyecto. No habilita updater ni
sidecar. No modifica las capabilities compartidas ni el CSP.

**Usar este archivo solo con `android dev`. No pasarlo a `android build` ni a
comandos de release**: autoriza contenido del servidor de desarrollo a usar el
puente nativo. Los builds normales usan la configuración Android existente y no
incluyen esa capability remota ni una URL web para la ventana.

`npm run tauri:dev` conserva el comando y configuración de Windows. No se cambió
ninguna versión de Next, Tauri, Rust ni dependencias.

## Comprobación

El emulador debe mostrar el shell mobile y permitir abrir su menú. En DevTools,
el documento debe estar en `http://localhost:3000/` y HMR conectado en el puerto
3000. SQLite debe estar disponible por el puente Tauri; una pantalla de error de
almacenamiento no cuenta como una prueba satisfactoria.

Los mensajes de reinicialización sobre `chrome-error://chromewebdata/` eran
secundarios a la navegación fallida, no una razón para modificar las APIs Tauri.

En la revisión posterior, Fast Refresh recibió hot updates del mismo origen sin
recargar el documento. El APK nuevo todavía registró `Cannot redefine property`
al arrancar la ventana remota. La fuente instalada de wry 0.55.1 registra scripts
en document-start y también los evalúa en `onPageStarted` para peticiones no
interceptadas: eso apunta a reinyección del runtime, independiente del CORS.
Existe un [reporte upstream de estos síntomas](https://github.com/tauri-apps/tauri/issues/11722).
No se parchean propiedades globales ni librerías para ocultarlos. El puente
nativo funciona; esta observación no equivale a haber validado el login/OTP.

Referencias: [guía oficial Tauri + Next](https://v2.tauri.app/start/frontend/nextjs/)
y [capabilities Tauri](https://v2.tauri.app/security/capabilities/).

## Identidad del dispositivo en Android dev

La ventana directa de desarrollo es un origen remoto para Tauri, aunque llegue
por ADB. Los permisos de plugins no autorizan por sí solos los comandos de la
aplicación. Sin esa autorización, `get_or_create_account_device_identity` falla
antes de entrar en Rust con `not allowed. Plugin not found`; ese mensaje no
indica que falte el plugin de almacenamiento.

`build.rs` carga `dev-permissions/android-native.toml` solamente para Android,
en modo Tauri dev y con el override `android-dev-localhost`. La capability del
override concede los comandos de identidad pública/firma y la transacción
SQLite mobile existente. No concede acceso JavaScript a `loadIdentity`,
`saveIdentity`, `deleteIdentity` ni a claves privadas. Windows y Android
empaquetado conservan su configuración habitual.

Diagnóstico seguro en desarrollo:

- Consola WebView: `[device-auth]` clasifica un rechazo nativo sin imprimir su
  cuerpo ni argumentos.
- Logcat: `[device-identity]` indica validación, carga, creación y persistencia.
- Tag `ScisoSecureStorage`: indica validación del account key (43 caracteres),
  presencia del blob/key, cifrado, escritura AtomicFile y roundtrip. Solo muestra
  etapas, tipos de excepción, booleanos y longitudes en APKs debuggable.

No registrar bindings, claves, tokens, desafíos ni códigos OTP. La firma y la
clave privada permanecen en Rust/AndroidKeyStore; AES/GCM, AAD y AtomicFile no
cambian.

Si un blob existe pero falta la clave de AndroidKeyStore, la carga debe fallar;
no regenerar la clave ni sobrescribir el blob para ocultarlo. Un fallo de
autenticación del cifrado también debe detener el flujo. Conservar los archivos
y diagnosticar primero. Para pruebas prescindibles, usar manualmente otro AVD
o autorizar explícitamente un reset de datos; eso pierde la identidad y los
datos locales de prueba y requiere una nueva autorización por email. No hay
reset ni recuperación automática en este cambio.

Prueba real con staging: iniciar sesión desde el emulador, recibir el código
de autorización y escribirlo solo dentro de la app. Comprobar respuestas
correctas de `/auth/devices/context`, `/auth/devices/login`,
`/auth/devices/enrollment/challenge` y `/auth/devices/enrollment/complete`, y
estado `trusted`. No copiar cuerpos de esas respuestas a logs: contienen
credenciales o continuaciones de verificación.
