# Accesos rápidos Android

Dos tiles de acción: **+ Ingreso** y **− Gasto**. Nunca muestran datos de cuenta,
saldos ni importes. No guardan movimientos: abren el formulario habitual y el
usuario confirma con Guardar. Si falta una categoría compatible, se conserva la
validación existente; el tile no crea categorías ni elude restricciones.

## Native → frontend

El plugin local `src-tauri/plugins/quick-entry` contiene Kotlin, manifest, strings,
iconos, permisos y bridge Rust. Tauri incorpora su biblioteca Android y Gradle
fusiona su manifest. No hay código manual nuevo en `gen/android` ni modificaciones
en MainActivity. Conservar este plugin y su dependencia Android en Cargo mantiene
las personalizaciones después de regenerar el proyecto.

TileService obtiene el launcher del package actual (release o `.debug`), comprueba
su componente MainActivity y lo lanza explícitamente con NEW_TASK/CLEAR_TOP/SINGLE_TOP.
Usa la acción interna `<package>.QUICK_ENTRY` y extras cerrados: marcador, tipo
income/expense, ID aleatorio de navegación y tiempo monotónico. No usa URLs.

- API 24–33: `startActivityAndCollapse(Intent)`.
- API 34+: `startActivityAndCollapse(PendingIntent)`, UPDATE_CURRENT e IMMUTABLE,
  con request codes distintos para ingreso y gasto.
- Con pantalla bloqueada, `unlockAndRun` pide primero desbloquear.

El ciclo `Plugin.load(WebView)` inspecciona el intent inicial; `Plugin.onNewIntent`
recibe eventos warm a través del lifecycle Tauri ya existente. No hace falta que
TileService sobreviva. VIEW intents, incluidos `scisonomics://auth/callback`, no
se consumen ni se modifican por este plugin.

El plugin retiene **una última acción**, en memoria, por un máximo de dos minutos.
El frontend registra listener antes de consultar el pendiente cold; una respuesta
cold tardía no reemplaza un evento warm nuevo. Native y frontend vuelven a validar
el payload. Antes de abrir se confirma consume-once con el ID exacto.

Para evitar que un root intent de Recents reaparezca después de reiniciar el
proceso, solo se conservan IDs **ya consumidos** con vencimiento en preferencias
privadas (máximo 32; limpieza al siguiente acceso). No se persiste el pendiente,
su tipo, una cuenta ni datos financieros. Los extras se eliminan al leer el intent.

## Gates y formulario

El router mobile espera hidratación, ausencia de error de cuenta, fin de Google
OAuth/device verification y resolución de recovery. Después usa `/movimientos`.
El editor espera también datos cargados, un contexto propietario vigente y ausencia
de operaciones o diálogos abiertos. No cambia las reglas de recovery, auth o sync.
El cierre de MobileDialog emite una señal UI sin payload incluso después de su
desmontaje; se conserva la confirmación native hasta abrir el editor o vencer el
TTL, para evitar perder acciones por StrictMode/re-renders.

El tipo inicial solo se aplica a una creación, el monto está vacío y tiene autofocus
si el WebView lo admite. Una edición/draft abierto nunca se reemplaza ni se resetea.
Si llegan más tiles, queda la última acción pendiente hasta guardar/cerrar el editor,
siempre dentro del TTL. Si vence durante un gate, volver a tocar el tile.

El consumo durante un cambio de owner/desmontaje descarta la apertura; no puede
abrir un editor con la identidad anterior. Guardado, SQLite y sync siguen usando
el formulario y repositorio actuales. No hay API genérica de acciones.

## Agregar tiles

Configuración → General → Accesos rápidos de Android:

- API 33+: botones explícitos de ingreso/gasto; Android muestra su propio prompt
  con resultado agregado, ya agregado, no agregado o error. Solo en foreground.
- API 24–32: **Abrí Ajustes rápidos > Editar y agregá Ingreso/Gasto de ScisoNomics.**

Nunca se solicita agregar un tile automáticamente. Dos services exportados tienen
BIND_QUICK_SETTINGS_TILE, QS_TILE, labels e iconos monocromáticos propios. No se usa
ACTIVE_TILE ni se monitorea el estado financiero.

## Validación manual pendiente

En un teléfono con APK debug, agregar ambos tiles desde Configuración o Editar.
Probar: app cerrada, background, visible, bloqueo de pantalla, ingreso/gasto
consecutivos, draft abierto y gates de cuenta/recovery. El teclado depende del
WebView y debe comprobarse en dispositivo. Repetir en API 24–33 y API 34+.
No probar con escrituras en una cuenta financiera real: usar modo local o QA.

El build debug de validación utiliza un override temporal de beforeBuildCommand
para `npm run build`: no ejecuta el gate de producción de Supabase ni cambia su
configuración. No generar AAB ni publicar este APK.

Referencia: [Quick Settings de Android](https://developer.android.com/develop/ui/views/quicksettings-tiles).
