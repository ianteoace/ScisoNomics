# Desktop 3001 junto a Android 3000

Desde `modern_app/frontend`, configurar las tres variables públicas staging en
cada terminal: `NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL`,
`NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
No imprimir sus valores ni usar credenciales administrativas.

Android conserva su comando y puerto:

```powershell
npm.cmd run tauri:android:dev -- --no-watch Pixel_8
```

Desktop concurrente:

```powershell
npm.cmd run tauri:dev:concurrent -- --no-watch --target x86_64-pc-windows-msvc
```

El launcher fija Next en 3001, con assets/HMR en `http://localhost:3001` y
`distDir=.next-desktop-dev`, separado del lock/cache Android. El override Tauri
configura ese devUrl y beforeDevCommand; habilita solo los orígenes HTTPS exactos
de staging en devCsp. No cambia identifier, updater, capabilities ni producción.
`npm run dev` y `npm run tauri:dev` conservan el puerto 3000.

`SCISONOMICS_DESKTOP_CONCURRENT_DEV=1` se establece solo en el proceso del
launcher y sus hijos. El backend local permite el origen exacto
`http://localhost:3001` únicamente con ese opt-in. El token local sigue siendo
obligatorio; no se activa ningún bypass ni CORS wildcard. Un sidecar compilado
antes de este cambio debe regenerarse y copiarse con los comandos existentes:

```powershell
cd ../backend
.\.venv\Scripts\python.exe -m PyInstaller scisonomics-backend.spec --noconfirm
cd ../frontend
npm.cmd run prepare:sidecar
```

En el backend **cloud staging**, agregar `http://localhost:3001` a la lista
actual `SCISONOMICS_ALLOWED_ORIGINS`, conservando los demás orígenes y sin `*`.
Reiniciar/desplegar staging y comprobar el preflight. No cambiar producción.
La ausencia de ese origen produce fetch/CORS aunque `/health` responda 200 fuera
del WebView; Supabase accesible no prueba acceso al cloud backend.

El nuevo origen puede no contener metadata de cuentas del WebView anterior.
Iniciar sesión dentro de la ventana con la misma cuenta staging. La identidad
del dispositivo sigue en WinCred; registrar si server devuelve trusted o pide
OTP, sin copiar contraseñas/códigos/tokens. No borrar identidades ni importar
automáticamente datos locales para ejecutar esta prueba.

Para cerrar M9C: usar el sync desktop existente dos veces; comprobar en SQLite y
UI la llegada única de `prueba m9c android 20261006-193127` y el tombstone de
`prueba m9c tombstone 20261006-193127` sin resurrección. Registrar cursores e IDs
de esos dos registros de prueba exclusivamente. No resetear cursores ni copiar
datos entre owners. Comparar hashes de los otros owners antes/después.

Validaciones de configuración:

```powershell
node --test tests/desktopConcurrentDev.test.cjs tests/mobileDevConfig.test.cjs
```

Desde raíz del repo:

```powershell
.\modern_app\backend\.venv\Scripts\python.exe -m unittest modern_app.backend.test_concurrent_dev_cors -v
```

Además, build frontend y `git diff --check`. Durante el build se pueden pausar
los servidores dev y restaurarlos luego en los mismos puertos; no ejecutar dos
servidores Next compartiendo `.next`.

## Validación real M9C

Windows completó startup con health/ready 200, login de la cuenta staging y
dispositivo actual trusted (dos dispositivos autorizados). El sync de inicio
trajo los dos registros de prueba; dos syncs manuales posteriores conservaron
una sola fila de cada sync ID. El principal aparece una sola vez en Movimientos;
el tombstone permanece synced con deleted_at y no se muestra ni resucita.
Cursores UTC: `2026-10-06T00:59:37Z` antes, `2026-10-07T00:31:53Z` tras inicio,
`2026-10-07T00:33:57Z` y `2026-10-07T00:35:10Z` tras los manuales.
Se comprobaron hashes iguales para los otros owners. No hubo reset de cursores,
importación de datos locales ni cambios en el motor mobile/desktop.

Configuración tests 11/11, CORS local 2/2, build estático y compileall aprobados.
Sidecar regenerado y copiado: versión 3.3.1. CORS cloud staging fue actualizado
por el usuario con el origen exacto 3001; el WebView lo comprobó accesible.
