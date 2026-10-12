# Recuperación local Android 3.3.2

La primera build de Internal Testing usó otro entorno. Actualizar la aplicación
con el mismo package y firma conserva `sqlite:scisonomics-mobile.db`. **No
desinstalar, borrar almacenamiento ni cambiar el package para probar el upgrade.**
Conservar la cuenta guardada: no cerrar sesión ni quitarla en 3.3.1 antes de
actualizar. Sin metadata anterior no se puede demostrar el email a partir de un
UUID o de los movimientos; esos casos requieren revisión manual, sin adivinar
la identidad ni borrar SQLite.

## Inicio y autorización

El build de producción fija `NEXT_PUBLIC_SCISONOMICS_MOBILE_ACCOUNT_RECOVERY=1`.
Las cuentas nuevas guardan el ámbito API + proyecto Supabase en `authEnvironment`.
Antes de hidratar tokens, las cuentas Supabase sin ámbito o de otro ámbito se
archivan en `scisonomics_mobile_account_recovery_v1`. Es metadata local sin
tokens, con el email y el ID interno originales, no una identidad nueva. No se
deduplican owners Supabase por email. Las cuentas archivadas no aparecen en el
selector ni se restauran contra producción. Si el archivo no puede escribirse,
no se reemplaza la metadata original y el gate queda cerrado.

La app continúa en modo local y permite iniciar sesión normalmente. Sólo después
del login, bootstrap y autorización del dispositivo se compara el email
normalizado (trim + lowercase) con los owners archivados. El owner destino es
`users.id` obtenido del backend, nunca el `sub` de Supabase.

Un inventario de conteos finaliza automáticamente fuentes sin filas (incluye
tombstones). Las instalaciones nuevas no tienen fuentes ni modal. Para una fuente
con datos y mismo correo, se pide consentimiento y se muestran conteos, sin UUIDs.
Cerrar el modal deja el gate pendiente y un botón para revisarlo. Elegir mantener
por separado libera el gate, conserva filas y oculta la cuenta anterior.

## Transacción

Se reutiliza `mobile_sql_transaction`, sin agregar comandos nativos ni cambiar
migraciones publicadas. Una tabla aditiva `mobile_account_recovery` registra la
operación dentro del mismo commit que:

- verifica nuevamente que el destino no contenga categorías/movimientos;
- difiere temporalmente las FKs compuestas dentro de la transacción;
- actualiza `owner_user_id` de categorías y movimientos, conservando IDs, FK,
  sync_id, valores, notas, fechas, tombstones y timestamps;
- marca pending, limpia metadata remota/errores e incrementa local_change_version;
- borra ambos cursores y verifica las FKs antes del commit.

Un contador desbordado, cambios concurrentes, destino con datos, varias fuentes
del mismo email o relaciones adicionales de planificación requieren revisión
manual; no se fusionan ni se copian filas. El ledger evita repetir la operación
y sana el gate si la app se cierra después del commit y antes de actualizar la
metadata. Sólo se migran categorías/movimientos; los datos `local` y de otras
cuentas permanecen intactos.

## Sync y credenciales anteriores

El gate se comprueba al restaurar/seleccionar cuentas, en AutoSyncProvider,
runAutoSync y en la obtención de sesión para push/pull mobile, antes de red.
Mobile mantiene su sync manual existente; no se monta el AutoSync desktop ni se
dispara push desde recovery. Tras commit se recarga la vista del owner actual y
se indica dónde sincronizar manualmente después de revisar los datos.

No se llama signOut remoto ni APIs del entorno anterior. La metadata archivada
permanece oculta como registro de recuperación. Como la build anterior no guardó
el proyecto junto a la cuenta, no se adivina el namespace seguro de su refresh
token: puede quedar cifrado en Android Keystore en el namespace antiguo,
inaccesible para el proyecto actual. No se borra el token de producción ni el
almacenamiento de la app. Una limpieza posterior necesita identificar el
namespace anterior de forma explícita, sin leer/exportar la credencial.

## Build y prueba en teléfono

Variables locales existentes, sin mostrar su valor secreto:
`NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Las dos URLs deben ser las de producción;
la key debe pertenecer a ese proyecto y provenir del entorno local seguro.

Desde `modern_app/frontend`, en PowerShell:

```powershell
npm.cmd run test:mobile
npm.cmd run test:auth
npm.cmd run test:billing
npm.cmd run build:android:production
npm.cmd run verify:android:production
npx.cmd tauri android build --apk --aab --ci
```

El override Android ejecuta nuevamente el build protegido antes del bundle.
El wrapper borra sólo `frontend/out`, construye y verifica recursivamente cero
coincidencias de ambos orígenes anteriores y al menos una de cada origen de
producción. Un fallo impide continuar al bundle. No imprime keys ni modifica
`.env.local`, keystore.properties ni el keystore. Android usa 3.3.2 / 3003002,
conservando `com.scisoftware.scisonomics` y el signing existente.

Con USB debugging habilitado y **la app anterior todavía instalada**:

```powershell
adb devices
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ..\scripts\install-android-recovery.ps1 -Serial '<serial-del-telefono>' -CheckOnly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ..\scripts\install-android-recovery.ps1 -Serial '<serial-del-telefono>'
```

El script compara package, versión y certificado con el APK instalado y sólo
usa `adb install -r` si coinciden. No instala automáticamente al ejecutarse en
CheckOnly. Comprobar la ruta del APK del build; no usar `-d`,
uninstall ni wipe-data. No usar el package `.debug`: tiene otro sandbox y no
valida esta recuperación.

**Play App Signing:** Google puede usar una firma de distribución distinta de
la upload key local. Si el certificado no coincide, el script aborta sin instalar
y sin borrar nada. No se puede prometer una prueba de actualización local sobre
una app de Play con otra firma. Se necesita un APK 3.3.2 firmado por la app signing
key existente (por ejemplo, generado por Play en App Bundle Explorer, mediante
un paso manual en Console sin rollout). El mismo script admite `-Apk '<ruta>'`.
No usar Internal App Sharing como sustituto sin comprobar la firma: puede usar
otra clave. Referencia: https://developer.android.com/studio/publish/app-signing.

Checklist manual: abrir en local; iniciar sesión con el mismo correo; completar
OTP/dispositivo en la app; revisar los conteos; aceptar; comprobar fechas, montos
y categorías; cerrar/abrir para verificar persistencia; recién entonces ejecutar
sync manual. Comprobar que no reaparece el modal ni la cuenta anterior, y probar
también destino con datos (sin merge), una instalación limpia y un tester sin
filas. No subir a Play hasta validar estos casos reales. Generar artefactos no
equivale a esa validación manual.

Windows no activa esta recuperación ni cambia su backend/sync/updater. El bump
coordinado de las fuentes de versión no regenera el sidecar Windows ni constituye
una release desktop; este entregable es Android.

Las identidades/passwords de proyectos Supabase distintos no se comparten. Si
la cuenta aún no existe en producción, crearla con el mismo correo y completar
los OTP dentro de la app. No pegar credenciales ni códigos en chats.
