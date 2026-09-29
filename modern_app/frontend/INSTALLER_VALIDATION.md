# Instalador Windows 3.2.0: validación de release

Este build de 3.2.0 valida el empaquetado de la fase de auth externo. No cambia
la versión del backend local ni los datos. Para publicar una versión nueva,
actualizar juntos `package.json`, `tauri.conf.json`, `Cargo.toml`, el backend
local y su EXE PyInstaller; `prepare:sidecar` exige que coincidan.

## Build reproducible

En PowerShell, desde `modern_app/frontend`, definir las tres variables públicas
en el entorno del proceso. La publishable key se obtiene del proyecto Supabase;
no usar `service_role`, secretos ni una URL cloud de staging. El preflight de
`tauri:build` exige la URL de Railway de producción y coteja Supabase con CSP y
el permiso de apertura de Google. Rust recibe la URL cloud del mismo entorno.

```powershell
$env:RUSTUP_TOOLCHAIN = "1.88.0"
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL = "https://scisonomics-production-d8a3.up.railway.app"
$env:NEXT_PUBLIC_SUPABASE_URL = "https://egwxtvroruvjwhpizbeg.supabase.co"
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "<publishable key del proyecto>"
npm.cmd run test:auth
npm.cmd run build
npm.cmd run prepare:sidecar
npm.cmd run tauri:build
```

El script de Tauri usa explícitamente `--target x86_64-pc-windows-msvc` y
`bundle.active=true`. El binario instalado se llama `ScisoNomics.exe` para que
el instalador compruebe el proceso correcto antes de actualizar. `tauri:build`
ejecuta otra vez el build web y valida el
hash del sidecar antes de crear NSIS/MSI. El frontend se exporta a `out/` y el
sidecar procede de `backend/dist/scisonomics-backend.exe`, empaquetado con
PyInstaller; no necesita Python ni venv en la máquina de destino.

## Smoke test en la instalación real

1. **Antes de instalar:** cerrar `tauri:dev` y ScisoNomics. Comprobar que
   `Get-NetTCPConnection -LocalPort 8000 -State Listen` no devuelve un proceso.
   Anotar existencia, tamaño y hash de
   `%LOCALAPPDATA%\RegistroFinanzas\data\finanzas.db`; conservar también
   backups. El hook NSIS bloquea la instalación si quedan procesos de la app
   o el sidecar; no los termina a la fuerza. Si Windows informa archivos en
   uso, cancelar, cerrar la app y volver a instalar: no elegir Omitir.
2. **Instalar:** ejecutar el `ScisoNomics_3.2.0_x64-setup.exe` NSIS para el
   usuario actual. Confirmar en Windows que `scisonomics://` queda asociado al
   ejecutable instalado. El MSI registra el scheme a nivel máquina (HKLM);
   preferir NSIS para esta prueba por usuario. No desinstalar una versión previa
   como paso inicial.
3. **Inicio y datos:** abrir la app instalada. Verificar dashboard, modo local,
   movimientos existentes y `%LOCALAPPDATA%\RegistroFinanzas\data\finanzas.db`.
   Confirmar que `/health` del sidecar responde en `127.0.0.1:8000`; no debe
   requerir Python/venv. Comprobar el hash de la DB solo si la app no hizo
   cambios legítimos; el instalador por sí mismo no debe modificarla.
4. **Puerto ocupado:** con la app cerrada, ocupar `:8000` con un proceso ajeno
   de prueba y abrir ScisoNomics. Debe aparecer el error de puerto, sin matar
   ese proceso ni lanzar un segundo backend. Liberar el puerto y reabrir.
5. **Google:** desde la app instalada elegir Continuar con Google. Confirmar
   navegador externo, consentimiento y retorno a
   `scisonomics://auth/callback`; queda una sola instancia. Tras bootstrap, la
   cuenta histórica conserva su `users.id`, Premium y movimientos.
6. **Deep link inválido:** sin un intento OAuth pendiente, ejecutar
   `Start-Process 'scisonomics://auth/callback?code=local-parser-test'`.
   Debe abrir/enfocar ScisoNomics sin crash, rechazar el callback por falta de
   PKCE pendiente y no activar otra cuenta. Repetir con la app cerrada. No usar
   un código real en consola o logs.
7. **WinCred y sesión:** marcar Recordar, cerrar la app, confirmar que el
   sidecar sale y `:8000` queda libre, reabrir y comprobar restauración de la
   cuenta. Cerrar sesión, reabrir y verificar que la sesión eliminada no vuelve.
   Probar dos cuentas y modo local: cada una conserva su owner interno y su
   credencial separada; no inspeccionar ni imprimir refresh tokens.
8. **Email y OTP:** iniciar sesión con email/password. Si se dispone de cuenta
   de prueba, confirmar signup y recuperación por OTP dentro de la app. No
   crear un segundo owner para el usuario histórico.
9. **Upgrade:** si hay un instalador anterior con el mismo identifier y modo
   de instalación, instalar encima con la app cerrada; comparar el ID interno,
   movimientos, Premium, backups y acceso recordado. Si la versión previa usa
   otro identifier o modo per-machine, detenerse y revisar la ruta de instalación
   antes de continuar: podría quedar una segunda copia. Un build anterior de
   esta rama generaba `app.exe`; si llegó a instalarse, cerrarlo también antes
   del upgrade. Su desinstalador antiguo puede tener una política de cierre
   distinta, por lo que ese salto requiere una prueba específica.

## Rollback y límites

Cerrar la app y reinstalar el último instalador conocido y compatible para el
mismo usuario; evitar desinstalar primero. Mantener intactos
`%LOCALAPPDATA%\RegistroFinanzas`, WinCred, datos cloud y las columnas
`auth_provider_id`/`password_auth_enabled` de Railway. Un frontend anterior que
no soporte Supabase puede requerir volver a iniciar sesión, aunque la credencial
externa permanezca en WinCred. No ejecutar migraciones ni borrar cuentas.

El build automatizado y los tests no sustituyen la prueba interactiva del
instalador: consentimiento Google, asociación real de Windows, sidecar después
de instalar, persistencia de WinCred y upgrade solo se confirman con el smoke
test anterior. El esquema y el callback son `scisonomics` y
`scisonomics://auth/callback`; cambiar cualquiera exige actualizar la
configuración de Supabase y volver a probar el paquete.
