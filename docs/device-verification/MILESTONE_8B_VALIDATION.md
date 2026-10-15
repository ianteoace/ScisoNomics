# Milestone 8B: ensayo real de autorización de dispositivos

Estado al 2026-10-05: **pendiente de ejecución end-to-end**. Las suites aisladas
no sustituyen correo real, sesiones nativas reales ni revocación entre perfiles.
No se desplegó el backend nuevo en producción. No se cambiaron versiones,
protocolo V1, auth, sync, billing ni almacenamiento nativo.

## Aislamiento antes de iniciar

Usar un PostgreSQL nuevo sin dumps, un proyecto Supabase de prueba y un remitente
real habilitado para las direcciones de prueba. Crear dos cuentas de prueba con
emails confirmados y buzones accesibles: la segunda sirve para comprobar el
rechazo de challenges de otra cuenta. No copiar usuarios, datos, secretos JWT,
claves de entitlements ni credenciales de producción.

La presencia de `.env` en el repo no demuestra que sea staging. No cargarlos
automáticamente para este ensayo. El worktree `ScisoNomics-staging` existente
corresponde a `staging/updater-3.3.0`, no a este protocolo; no usarlo como servidor
M8B ni modificarlo. Usar el commit actual de `feature/mobile-android`.

Opciones de infraestructura:

- Backend de staging dedicado con HTTPS, PostgreSQL separado y secretos propios.
- Backend local aislado con PostgreSQL 18 nuevo en un puerto libre, escuchando
  únicamente en `127.0.0.1`. Exponer solo el backend mediante HTTPS con un túnel
  autorizado; nunca exponer PostgreSQL ni usar una URL temporal como producción.

El backend debe arrancar con `SCISONOMICS_ENV=production` y enforcement explícito,
aunque su infraestructura sea de prueba. Esto deshabilita el correo simulado y
exige configuración de firma real. Validar `/health` y `/ready`, PostgreSQL y el
commit antes de conectar clientes. `/ready` ejecuta `init_db`: llamarlo solamente
en la base nueva del ensayo. No usar la URL de Railway de producción.

## Variables exactas, sin valores secretos

Backend, en un archivo privado de staging o en el entorno exclusivo del proceso:

```dotenv
SCISONOMICS_ENV=production
SCISONOMICS_DEVICE_VERIFICATION_MODE=enforce
SCISONOMICS_CLOUD_DATABASE_URL=<DSN PostgreSQL exclusivamente de staging>
SCISONOMICS_JWT_SECRET=<secreto aleatorio nuevo de staging>
SCISONOMICS_SUPABASE_URL=https://<proyecto-de-prueba>.supabase.co
SCISONOMICS_SUPABASE_PUBLISHABLE_KEY=<publishable del proyecto de prueba>
SCISONOMICS_ALLOWED_ORIGINS=http://tauri.localhost,https://tauri.localhost,tauri://localhost
SCISONOMICS_ENTITLEMENTS_PRIVATE_KEY_FILE=<archivo RSA privado nuevo de staging>
SCISONOMICS_ACCESS_TOKEN_EXPIRE_MINUTES=15
SCISONOMICS_EMAIL_PROVIDER=resend
SCISONOMICS_EMAIL_FROM=<remitente autorizado>
SCISONOMICS_RESEND_API_KEY=<credencial privada de envío de prueba>
SCISONOMICS_EMAIL_DEV_LOG_CODES=false
SCISONOMICS_ENABLE_DEBUG_ENDPOINTS=false
SCISONOMICS_ENABLE_ADMIN_BILLING=false
```

La lista CORS debe ajustarse al `Origin` real de los clientes del ensayo, sin `*`.
Si se usa Next dev, agregar sus orígenes exactos, por ejemplo
`http://127.0.0.1:3000` y `http://localhost:3000`. No ampliar CORS en producción.
`DATABASE_URL` es una alternativa a `SCISONOMICS_CLOUD_DATABASE_URL`; no dejar una
segunda DSN apuntando a producción. El archivo RSA pertenece solo a staging y
es necesario para el startup con esta configuración; no usar la clave real.

Alternativa SMTP: sustituir proveedor/credencial Resend por:

```dotenv
SCISONOMICS_EMAIL_PROVIDER=smtp
SCISONOMICS_SMTP_HOST=<servidor de envío autorizado>
SCISONOMICS_SMTP_PORT=587
SCISONOMICS_SMTP_USERNAME=<usuario SMTP de prueba>
SCISONOMICS_SMTP_PASSWORD=<credencial SMTP de prueba>
SCISONOMICS_SMTP_USE_TLS=true
```

Opcionales: `SCISONOMICS_EMAIL_REPLY_TO`, timeouts `SCISONOMICS_RESEND_*` o
`SCISONOMICS_SMTP_*` ya existentes. Usar sus defaults salvo necesidad comprobada.
No configurar Mercado Pago, Google legacy, admin billing ni service-role.

Frontend, **al compilar cada cliente de prueba**, sin sobrescribir `.env.local`:

```dotenv
NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL=https://<backend-staging>
NEXT_PUBLIC_SUPABASE_URL=https://<proyecto-de-prueba>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable del mismo proyecto>
```

Las variables `NEXT_PUBLIC_*` quedan dentro del build; cambiar el entorno después
de compilar no cambia el APK/exe. Los secretos de backend nunca van al frontend.
Los OTP de dispositivo tienen constantes propias: TTL 600 s, cinco intentos,
cooldown 60 s y cuota de cinco envíos/hora/cuenta. Las variables
`SCISONOMICS_EMAIL_VERIFICATION_*` legacy no configuran esa política.

## Clientes nativos de prueba

La CSP actual admite los orígenes cloud/Supabase configurados de producción.
Preparar un override Tauri **local y exclusivo de staging** con `csp`/`devCsp`
que autoricen los dos orígenes HTTPS de prueba exactos. Conservar las demás
restricciones, `frame-src 'none'`, updater, claves, identifier y versión. No usar
`connect-src *`, desactivar CSP ni hacer un commit del override con credenciales.
No generar release, instalador publicado ni `latest.json` para este ensayo.
Tauri documenta la [CSP restrictiva](https://v2.tauri.app/security/csp/) y el
[override `--config`](https://v2.tauri.app/reference/cli/). Usar un archivo de
configuración adicional; no alterar la configuración comercial para probar.

Windows A debe usar un perfil de app vacío y sin datos reales. Windows B debe ser
otro usuario Windows real o VM Windows limpia con sesión de inicio de sesión
propia. No son suficientes otra pestaña ni un browser: deben ejercer WinCred y
el runtime Rust real. No copiar WinCred, AppData, identidades, WebView storage ni
SQLite entre A/B. Iniciar el exe de prueba bajo cada usuario, sin reinstalar la
app comercial ni modificar sus datos. La creación del perfil B es parte del
ensayo, una vez disponibles staging y el cliente compilado para ese entorno.

**Precaución Windows:** `AutoSyncProvider` fuerza sync en inicio/restauración y
cierre, incluso con el switch de sync apagado. Desactivar el switch no evita
esas requests. Usar datos vacíos y una barrera en el ingreso exclusivo de staging
que rechace `/sync` y `/sync/*` antes de llegar al backend, sin registrar bodies
ni headers sensibles. Comprobar cero escrituras financieras. No cambiar el sync
del producto para hacer este ensayo. No iniciar el backend desktop compartido
del usuario habitual para A/B: el puerto 8000 debe pertenecer al perfil aislado;
probar los perfiles secuencialmente si no pueden aislar la red.

En Android conservar la app debug y sus datos locales: instalación `adb install
-r`, sin uninstall, `pm clear` ni wipe-data. Tomar una comparación completa de las
seis tablas financieras, owners, tombstones, migraciones y foreign keys antes y
después; imprimir solo resultado/hash, nunca los registros. La cuenta cloud de
staging tiene un namespace nuevo: no borrar identidades ni tokens de otras
cuentas. No implementar sync, reasignar `owner=local` ni probar Google mobile.

## Ejecución y evidencia

Ingresar contraseñas y OTP directamente en la app. No pegarlos en chat, argumentos
de CLI, capturas de Network, capturas de pantalla, archivos ni el informe. Registrar
solo hora, plataforma, paso, resultado y código de error seguro. No registrar
DSN, headers, cuerpos de auth ni respuesta JSON con grants/continuaciones.

| Paso | Prueba real | Condición de aprobación |
| --- | --- | --- |
| 1 | Login Windows A nuevo | Email verificado recibe aviso de dispositivo nuevo, seis dígitos, sin sesión persistida antes del OTP |
| 2 | OTP correcto A | Enroll firmado, cuenta activa, ID interno conservado, dispositivo trusted |
| 3 | Cerrar/reabrir A | Restore con firma Refresh real de WinCred, sin envío de OTP |
| 4 | Logout/login conocido A | Firma DeviceAuthentication, sin otro email OTP |
| 5 | Misma cuenta Android nuevo | OTP previo a persistencia; no grant, familia activa ni token nativo antes de verificar |
| 6 | OTP correcto Android | Cuenta conectada; identidad protegida por Keystore; datos locales intactos |
| 7 | Force-stop/reabrir Android | Restore sin OTP, misma identidad pública, refresh rotado persistido tras la prueba |
| 8 | A revoca Android | Dispositivo revoked y familias invalidadas; grants anteriores rechazados |
| 9 | Force-stop/reabrir Android revocado | Restore rechazado, refresh local eliminado/inutilizable, cuenta no autenticada, SQLite intacta |
| 10 | Login y nuevo OTP Android | Re-enrollment válido; las familias revocadas no se reactivan |
| 11 | Windows B con misma cuenta | Nueva identidad, exige OTP; autoriza y restaura tras reiniciar la app |
| 12 | A lista/renombra B | Nombre reflejado en ambos clientes mediante prueba firmada |
| 13 | A revoca B | Siguiente restore real B rechazado y limpieza nativa comprobada |

Para OTP/abuso, usar identidades nuevas de prueba y respetar cuota/cooldown. No
reiniciar el servidor para borrar límites ni acortar el TTL para simular tiempo:

| Caso | Resultado requerido |
| --- | --- |
| Código incorrecto | Rechazo; no familia/grant ni sesión persistida |
| Cinco fallos | Conteo persistente, bloqueo posterior; código correcto tampoco autoriza ese challenge agotado |
| OTP vencido | Esperar más de 600 s reales; pedir nonce fresco para que el rechazo sea del OTP, no solo del proof de 120 s |
| Código ya usado | Completion repetida rechazada; registrar si rechaza por OTP/continuación/proof consumido |
| Reenvío antes de 60 s | Cooldown; no segundo envío ni autorización |
| Reenvío después de 60 s | Email nuevo; invalidación de challenge, continuación y proof anteriores |
| Código viejo tras reenvío | No autoriza usando la continuación antigua |
| Challenge de otra cuenta | Rechazo con el token primario real de la segunda cuenta, sin cambios de confianza |
| Challenge de otro device_id | Rechazo con firma nativa de otra identidad, sin sustituir la clave pública |

Esperar entrega real y verificar destino en el buzón; éxito de API de correo no
prueba entrega. Revisar que la dirección se obtiene del email confirmado de
Supabase y no del email enviado por el cliente ni del email legacy desactualizado.
Algunas políticas del proveedor limitan destinatarios de prueba: habilitarlos
manualmente antes de ejecutar, sin alterar el proveedor de producción.

## Logs y custodia

Revisar logs del backend staging, consola WebView, logcat y logs Windows solo del
intervalo del ensayo. Escanear de forma local sin volcar líneas sensibles al chat;
reportar cantidades/resultados, no coincidencias. Buscar OTP conocido (solo en
memoria durante la revisión), JWT/access/refresh, Authorization, PKCE verifier,
auth code, PEM/seed privado. No recopilar logs HTTP verbose o body dumps.
No guardar esos valores para construir el informe. Las claves privadas se
auditan por frontera/ACL y comportamiento nativo, no leyéndolas para compararlas.

Verificar que JS no puede invocar load/save/delete de identidades privadas y que
el backend recibe exclusivamente la clave pública y firmas. Windows mantiene la
identidad en WinCred; Android mantiene ciphertext en `noBackupFilesDir` con AAD
por cuenta y clave AES no exportable de Keystore. El emulador no garantiza respaldo
hardware/StrongBox. La seed se descifra solamente en el runtime nativo para firmar.

## Rollout propuesto, no ejecutado

El backend de esta rama tiene default `enforce`: un deploy sobre el origen actual
rechazaría clientes Windows antiguos. `off` no es una fase puente: pierde la
protección y los clientes nuevos lo rechazan. Una cabecera de versión declarada
por el cliente tampoco es una frontera de seguridad.

Recomendación: transición con **dos orígenes/pools**, de duración limitada:

1. Cerrar todas las pruebas de este documento. Ensayar en staging la convivencia
   del backend anterior con el schema aditivo nuevo y mismas cuentas sintéticas;
   comprobar que ningún init/migration antiguo elimina namespace, claves o familias.
2. Conservar el origen/backend anterior para los instaladores existentes. Preparar
   un origen nuevo con el backend V1 en `enforce` en todos sus endpoints protegidos.
   En producción compartiría la DB de usuarios/finanzas para conservar IDs, sin
   copiar datos entre owners. Antes de eso verificar backup, compatibilidad de
   schema, locks y configuración de firma entre réplicas. Nada de esto se ejecutó.
3. Preparar una versión Windows futura que apunte al origen nuevo, con CSP exacta.
   Validar updater y migración de sesión: las sesiones sin identidad/familia deben
   pedir login + OTP una vez; no confiar en refresh anteriores automáticamente.
4. Publicar esa versión solamente después de validar el nuevo origen; el updater
   existente sigue permitiendo actualizar clientes antiguos. Mantener el backend
   anterior mientras se verifica la actualización del único usuario real actual.
5. Tras confirmar todos los clientes reales actualizados y OTP/restores válidos,
   cerrar el acceso legacy y retirar el pool anterior. La app Android continúa
   sin publicarse hasta su propio cierre y validación. No borrar schema aditivo.

Durante la convivencia, el origen antiguo sigue teniendo la seguridad antigua;
no afirmar enforcement global hasta retirarlo. Definir fecha de retirada y
monitorear uso sin tokens ni datos financieros. Rollback antes de retirar ese
pool conserva acceso a los clientes anteriores y no elimina columnas/familias;
rollback de clientes nuevos requiere recuperar su versión/backend compatibles,
no poner el origen protegido en `off`.

Si no se puede operar dos orígenes, hace falta diseñar y probar una fase server-side
de compatibilidad antes del rollout. El flag actual no la implementa. No añadir
un bypass temporal improvisado ni desplegar el backend enforce primero. Este
documento evalúa esa necesidad, no agrega flags ni cambia el protocolo final.

## Registro actual

- Repo inicial limpio, `feature/mobile-android`, checkpoint `9181009`.
- Configuraciones locales existentes no acreditadas como staging; no se utilizaron
  sus DSN, claves ni cuentas para conectarse a servicios reales.
- Revisión del flujo y custodia nativa: logs nuevos de dispositivos usan eventos
  e IDs abreviados, sin OTP/tokens; no hay logging en el módulo privado Rust/Kotlin.
- `npm run test:auth`: 90/90 aprobados. Son pruebas automatizadas con servicios
  simulados; **no** constituyen Windows/Android end-to-end con correo real.
- `python -m unittest modern_app.cloud_backend.test_device_sessions -v` con el
  Python de `modern_app/cloud_backend/.venv`: 15/15 aprobados en SQLite aislado.
- Esas mismas 15 pruebas en PostgreSQL 18 temporal, bases nuevas por test: 15/15
  aprobadas. El cluster escuchó solo en localhost y quedó detenido. No se usó el
  servicio PostgreSQL instalado ni una DSN existente. El primer intento dentro
  del sandbox no pudo iniciar PostgreSQL; se repitió fuera del sandbox únicamente
  con el cluster temporal y pasó. No hubo rechazo de revisión automática.
- Correo real, Windows A/B, Android con identidad real de staging, restauración,
  revocación cruzada, re-enrollment y expiración real: **pendientes**.
- No hay defecto funcional reproducido por pruebas reales en este ensayo; no se
  modificó código funcional. Las restricciones de CSP/auto-sync son precauciones
  de aislamiento, no una modificación del producto.

**M8 no puede cerrarse oficialmente** hasta contar con configuración de staging
confirmada y evidencia aprobada de todos los casos reales de las tablas anteriores.
