# Releases Windows con updater firmado

ScisoNomics usa el updater oficial de Tauri v2. La app consulta
`https://github.com/ianteoace/scisonomics/releases/latest/download/latest.json`
solo en el build instalado. El JSON de la release estable apunta al instalador
NSIS x64 y contiene **el contenido** de su archivo `.sig`. Tauri compara la
versión con SemVer y verifica la firma antes de preparar el cierre o instalar.
El feed no se obtiene por scraping y no necesita servicio adicional.

## Estado y auditoría del updater (2026-10-02)

El provider se monta una vez en el layout del dashboard, fuera del árbol que
cambia con el owner. Sidebar y navegación no disparan checks. El intento
automático ocurre a los 2,5 segundos, respeta la preferencia del usuario y se
omite si ya hubo un check manual. No hay polling. Sin actualización o ante un
fallo de consulta automático, la UI queda silenciosa.

El estado compartido solo conserva `idle`, `checking`, `available`,
`downloading`, `preparing`, `installing`, `ready` y `error`. Antes, `up_to_date`
quedaba en ese contexto y Configuración lo volvía a mostrar al regresar.
Ahora es únicamente el resultado de una acción manual: «ScisoNomics está
actualizado.» aparece durante cuatro segundos en Configuración; si se reintenta
desde un error del banner, aparece como toast temporal. Ambos se limpian al
navegar o desmontar el componente, incluso si la respuesta llega después.
Los errores manuales de consulta también son locales y temporales. Solo los
fallos durante descarga, preparación o instalación quedan como error global.
La actualización disponible, su progreso y el estado instalado siguen siendo
globales. No se guarda ningún mensaje ni progreso en storage: únicamente la
preferencia de check automático y la versión pospuesta.

Checks concurrentes comparten una promesa; descargas e instalaciones también
se serializan. No se permite comprobar mientras se instala. Al desmontar se
limpian timers y suscripciones, y se espera a las operaciones activas antes de
liberar su recurso nativo. Los timeouts nativos son 15 segundos para consultar
y 5 minutos para descargar. Los errores mostrados son mensajes predefinidos,
sin propagar URLs, tokens ni detalles crudos del proveedor.

El endpoint es HTTPS y la clave pública embebida coincide con la copia pública
local auditada. El cliente exige SemVer estricta, una versión superior y un
asset NSIS x64 del repositorio, tag y nombre esperados. El generador aplica la
misma sintaxis de versión. Tauri mantiene `allowDowngrades: false` y verifica
la firma del binario antes de preparar el cierre; una firma inválida bloquea
la instalación. Esta validación inicial de URL no restringe los redirects
nativos: el cliente oficial sigue los redirects de GitHub/CDN mediante TLS.
La firma protege el binario, no firma el JSON ni vincula criptográficamente su
campo `version`; también debe protegerse la cuenta que publica el feed.

En Windows, el plugin lanza NSIS y termina la app al instalar. No se introduce
una segunda etapa ficticia «reiniciar para instalar». Si `install()` retorna
sin terminar el proceso, `ready` indica que se instaló y pide cerrar y reabrir.
El cierre seguro y la restauración del sidecar ante un fallo siguen usando los
comandos nativos existentes, sin cambios en Rust ni en sync.

Las versiones de producto auditadas están alineadas en **3.3.0** (package,
lockfiles, Tauri, Cargo y backend local). El `latest.json` generado que queda
en el directorio local `target/.../bundle/nsis` corresponde a **3.2.2** y se
dejó intacto. No debe reutilizarse como manifiesto de 3.3.0: una futura release
autorizada debe generar sus propios assets y firma. Esta auditoría no publicó
ni instaló una release, ni accedió a la clave privada. La instalación real y
su reapertura todavía requieren la prueba de staging descrita más abajo.

La clave pública está en `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).
La clave privada generada para este proyecto está fuera del repo, en
`%USERPROFILE%\.tauri\scisonomics-updater.key`; su contraseña está cifrada con
DPAPI para el usuario Windows en
`%USERPROFILE%\.tauri\scisonomics-updater.password.dpapi`. **Antes de publicar,
guardá una copia de la clave privada y la contraseña en un gestor de secretos
externo.** El archivo DPAPI solo se puede descifrar con el usuario Windows que
lo creó; copiar ese archivo a otra PC no recupera la contraseña. Ambos archivos
locales tienen ACL restringida al usuario, SYSTEM y Administradores. Para
exportarla, descifrala localmente y trasladala al gestor sin mostrarla en logs. La clave
privada no se publica ni se añade al repo. Perderla impide actualizar automáticamente instalaciones
existentes; cambiar la clave pública exigiría una instalación manual de una
versión nueva. En CI, usar un gestor de secretos y nunca guardar la clave en
variables `NEXT_PUBLIC_`.

## Preparar una versión

La versión de desarrollo en preparación es **3.3.1**. Las referencias a
**3.3.0** en la auditoría fechada arriba describen ese estado histórico.

1. Incrementar juntos las versiones en `package.json`, `package-lock.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`
   y `modern_app/backend/app/main.py`. La primera versión con updater es
   **3.2.2**: las instalaciones 3.2.1 necesitan instalarla manualmente una
   vez; desde 3.2.2 podrán recibir versiones posteriores.
2. Regenerar el sidecar desde `modern_app/backend` con
   `pyinstaller --noconfirm scisonomics-backend.spec`. `prepare:sidecar`
   comprueba versión, frescura y SHA-256 antes de empaquetarlo.
3. Desde `modern_app/frontend`, configurar en el entorno del proceso las tres
   variables públicas exigidas por `../scripts/check-installer-env.cjs`:
   `NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL`, `NEXT_PUBLIC_SUPABASE_URL` y
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (publishable, nunca service_role).
   El build de producción exige la URL cloud de Railway ya usada por la app.
4. Cargar la clave de firma en el entorno **del proceso de build**. `.env.local`
   no sirve para las variables `TAURI_SIGNING_*`:

   ```powershell
   $env:RUSTUP_TOOLCHAIN = "1.88.0"
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   $env:TAURI_SIGNING_PRIVATE_KEY = Join-Path $env:USERPROFILE ".tauri\scisonomics-updater.key"
   $encrypted = (Get-Content (Join-Path $env:USERPROFILE ".tauri\scisonomics-updater.password.dpapi") -Raw).Trim()
   $secure = ConvertTo-SecureString $encrypted
   $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
   try { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
   finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
   try {
     npm.cmd run test:auth
     npm.cmd run test:updater
     npm.cmd run release:windows
   } finally {
     Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
   }
   ```

   Cerrá la sesión de terminal tras el build. Tauri genera el instalador manual
   habitual y su firma para updater. No firmes de nuevo un archivo modificado:
   `latest.json` debe llevar la firma del **mismo** instalador que se sube.

5. `release:windows` genera también `latest.json` junto al NSIS. Para
   regenerarlo sin volver a compilar, desde `modern_app/frontend`:

   ```powershell
   npm.cmd run updater:manifest
   ```

   Se escribe `latest.json` junto al EXE, con este formato (la firma es el
   contenido real del `.sig`, no una ruta):

   ```json
   {
     "version": "3.2.2",
     "platforms": {
       "windows-x86_64": {
         "url": "https://github.com/ianteoace/scisonomics/releases/download/v3.2.2/ScisoNomics_3.2.2_x64-setup.exe",
         "signature": "<contenido completo de ScisoNomics_3.2.2_x64-setup.exe.sig>"
       }
     }
   }
   ```

6. Para publicar, crear la release estable `vX.Y.Z` y subir **el instalador
   NSIS x64**, **su `.sig`** y **`latest.json`** como assets. La `.sig` separada
   ayuda a auditar; Tauri usa la firma incluida en el JSON. El MSI y su firma
   son opcionales para descarga manual, pero no se anuncian en este feed.
   Verificar los tres assets y sus nombres antes de marcar la release como la
   última estable. No publicar un `latest.json` que apunte a assets ausentes.

## Prueba de actualización antes de una release estable

Usar una release prerelease de staging con su propio tag y una configuración
Tauri temporal fuera del repo que cambie solo `plugins.updater.endpoints` a
`https://github.com/ianteoace/scisonomics/releases/download/<tag>/latest.json`.
Construir una versión inferior y otra superior **con la misma clave pública**,
instalar la inferior en una PC de prueba y cargar el feed del tag de staging.
No usar `/releases/latest/` para staging: GitHub excluye prereleases de esa URL.
Comprobar aviso, Más tarde, descarga, firma, cierre del sidecar, instalación,
reapertura, inicio de sesión y que `127.0.0.1:8000` queda disponible.

Antes y después, comparar existencia y SHA-256 de
`%LOCALAPPDATA%\RegistroFinanzas\data\finanzas.db`, además de comprobar
`app_config`, owner, movimientos, Premium, restauración de sesión y WinCred.
Una actualización legítima puede ejecutar migraciones aditivas o modificar la
DB cuando la app arranca; el instalador en sí no elimina AppData ni WinCred.
Probar también red caída, `latest.json` inválido y firma alterada: la app debe
seguir usable y no debe lanzar el instalador. El instalador manual sigue
disponible si el updater falla.

El updater detiene el sidecar después de verificar la firma y solicita el sync
de cierre existente. Si ese sync falla o vence el plazo, aborta la instalación
sin cerrar la app. En Windows Tauri lanza NSIS y termina el proceso; el
instalador `currentUser` conserva AppData y credenciales. No se publican ni se
instalan updates desde este procedimiento automáticamente.
