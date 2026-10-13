# Restauración de sesión Windows

El target de WinCred conserva su formato existente:
`scisonomics::scisonomics-supabase-refresh-token::<SHA256 del proyecto>::<users.id interno>`.
No depende de debug/release, productName, identifier ni ubicación del ejecutable.
Save/load/delete usan el mismo target. No se migran ni eliminan credenciales por
errores transitorios de lectura o escritura.

## Cambios comprobables

- Desktop espera la hidratación de cuentas persistentes antes de evaluar la sesión.
- Lectura fallida, token ausente y refresh rechazado son estados distintos.
- El refresh rotado se guarda antes de restaurar trusted-device. Un error posterior
  del backend ya no deja la rotación únicamente en memoria al cerrar el proceso.
- Guardar el refresh no concede autorización: sync continúa necesitando el grant
  y la prueba nativa existentes. Un fallo de persistencia se expone como tal.
- Los rechazos definitivos de autenticación y la revocación conservan su limpieza
  de seguridad. Android mantiene su orden de persistencia anterior.

Estos defectos y sus correcciones se prueban aisladamente. **No demuestran todavía
la causa exclusiva de la instalación release reportada**. El namespace no cambia
entre builds. Para identificar el fallo de esa instalación se necesita una nueva
reproducción con diagnóstico: no se atribuye el problema a WinCred sin evidencia.

## Reproducción con build release local

1. Usar una build Windows release que incluya estos cambios, sin publicar release.
2. Iniciar sesión con recordar cuenta habilitado. Confirmar `save_end` exitoso.
3. Cerrar completamente y volver a abrir. Revisar la secuencia de hidratación.
4. Consultar en PowerShell (no imprime tokens):

```powershell
$authLog = Join-Path $env:LOCALAPPDATA 'com.scisonomics.desktop\logs\auth-diagnostics.log'
Get-Content -LiteralPath $authLog -Tail 150
```

Release usa el plugin de logs ya instalado como dependencia, limitado al target
`desktop_auth`. El archivo tiene rotación de 256 KB y conserva un archivo anterior.
El logger operativo no recibe sidecar, URLs OAuth ni mensajes de otras librerías.
Un fallo del logger no bloquea el arranque. Debug conserva su logger existente;
las mismas filas `[auth]` también aparecen en la consola del WebView.

Eventos: `storage_availability`, `save_start/end`, `load_start/end`,
`delete_start/end`, `hydration_start/account/end`, `refresh_start/end`, `auth_state`.
Solo se admiten campos tipados y códigos de allowlist, tanto en JS como en Rust.
Owner se trunca a seis caracteres; project_tag son doce caracteres del digest del
proyecto, para comparar namespaces sin revelar la URL. No se registran tokens,
emails, claves, proofs, mensajes de excepción ni respuestas completas.

Interpretación:

- `load_end` con `found=false` y `success=true`: no existe la credencial.
- `secure_refresh_load_failed`: error de lectura; cuenta y token se conservan.
- `secure_refresh_save_failed`: el proveedor pudo rotar pero no se confirmó la
  escritura; no se informa persistencia correcta.
- `refresh_end` con `refreshSuccess=true`, `rotatedSaveSuccess=true` y
  `availability=active`: refresh, persistencia y trusted-device completados.
- `refreshSuccess=true` con `network_error`: falló una etapa posterior al refresh;
  comprobar `rotatedSaveSuccess` antes de cerrar.
- `refresh_rejected`: rechazo de autenticación, distinto de ausencia/error de storage.
- `phase=load/refresh/save/device` identifica la etapa exacta del intento.
- `supabase_not_configured`: falta configuración de identidad en esa build.
- `wincred_no_logon_session`, `wincred_access_denied` y `wincred_storage_failed`
  distinguen errores nativos sin incluir el mensaje de excepción.

El diagnóstico no consulta Railway ni modifica Supabase. No copiar registros de
otros sistemas que contengan credenciales junto con este archivo.
