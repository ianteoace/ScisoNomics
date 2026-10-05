# Seguridad de ScisoNomics

## Configuracion obligatoria en produccion

- `SCISONOMICS_ENV=production`
- `SCISONOMICS_JWT_SECRET`: secreto aleatorio de al menos 32 bytes.
- `SCISONOMICS_ALLOWED_ORIGINS`: lista explicita de origenes permitidos.
- `SCISONOMICS_ENTITLEMENTS_PRIVATE_KEY` o `SCISONOMICS_ENTITLEMENTS_PRIVATE_KEY_FILE`.
- `SCISONOMICS_ADMIN_TOKENS_JSON`: objeto JSON con un token diferente por administrador.
- `SCISONOMICS_ADMIN_TOTP_SECRETS_JSON`: objeto JSON con el secreto TOTP de cada administrador.
- `SCISONOMICS_TRUSTED_PROXY_IPS`: solo proxies controlados que puedan fijar `X-Forwarded-For`.

Ejemplo de estructura, sin valores reales:

```text
SCISONOMICS_ADMIN_TOKENS_JSON={"billing-admin":"token-aleatorio"}
SCISONOMICS_ADMIN_TOTP_SECRETS_JSON={"billing-admin":"SECRETOBASE32"}
```

Los secretos no deben guardarse en Git, logs, capturas ni artefactos de build.

## Datos de usuarios en documentacion y ejemplos

No documentar emails reales ni valores reales de `users.id` en el repositorio
publico, incluidos scripts de diagnostico y fixtures de pruebas. Usar
placeholders inequívocamente ficticios, como `historical-user@example.com` y
`00000000-0000-0000-0000-000000000000`. Verificar las referencias reales de
produccion fuera de Git; no copiarlas a ejemplos, issues ni resultados publicados.

## Controles incorporados

- Passwords nuevas derivadas con scrypt; hashes PBKDF2 anteriores se migran al iniciar sesion.
- Access tokens de corta duracion con emisor, audiencia, tipo y `jti` validados.
- Refresh tokens rotativos con deteccion de reutilizacion y revocacion de toda la familia.
- Respuestas de autenticacion legacy con `Cache-Control: no-store` y `Pragma: no-cache`, incluidos tokens de verificacion en errores. Google legacy consulta status mediante POST con el ID en el body y consume cada resultado atomicamente una sola vez; el GET anterior queda deprecated y oculto solo por compatibilidad con instaladores antiguos, pendiente de eliminacion.
- Rate limiting por IP e identidad para autenticacion, administracion y sincronizacion.
- Segundo factor TOTP obligatorio para administradores en produccion.
- Registro de eventos sensibles en `security_audit_log` sin tokens ni datos financieros.
- Webhooks de Mercado Pago con HMAC y `compare_digest`, timestamp firmado con antiguedad maxima configurable de 300 segundos por defecto y tolerancia futura fija de 60 segundos. Firmas fuera de la ventana reciben 401. La idempotencia por `billing_webhook_events` se mantiene y Mercado Pago sigue siendo la fuente de verdad antes de actualizar Premium; la firma sola no acredita un pago.
- Limites de cuerpo, cantidad de registros y longitudes en sincronizacion.
- Refresh tokens persistentes guardados en el almacen seguro del sistema operativo.
- Backups portables cifrados con AES-256-GCM y clave derivada mediante scrypt.
- Proteccion opcional de la base activa y backups mediante EFS de Windows, activada explicitamente por el usuario.

El rate limiter incorporado protege una instancia. Si se despliegan varias replicas, debe agregarse un limite compartido en el proxy o mediante un servicio centralizado.

## IP del cliente y reverse proxies

El [proxy publico de Railway](https://docs.railway.com/networking/public-networking/specs-and-limits)
agrega `X-Real-IP` con la IP remota del cliente. Solo se confia en ese header
cuando `SCISONOMICS_ENV=production` y las tres variables del sistema
`RAILWAY_ENVIRONMENT_ID`, `RAILWAY_PROJECT_ID` y `RAILWAY_SERVICE_ID` estan
presentes y no vacias. No se detecta Railway mediante hostname ni headers.
Estas variables deben provenir del entorno del despliegue; no copiarlas a otros
entornos para habilitar confianza en headers. Esta politica corresponde al
ingreso mediante el proxy publico de Railway.

La precedencia es: `X-Real-IP` valido en Railway; primer valor de
`X-Forwarded-For`, si es valido y la IP directa pertenece a `SCISONOMICS_TRUSTED_PROXY_IPS`;
IP directa. Se validan IPv4 e IPv6 con `ipaddress.ip_address()` y se normaliza su
representacion para rate limiting. Valores invalidos o de mas de 64 caracteres
se ignoran; no se aceptan listas ni headers duplicados en `X-Real-IP`. Si la IP
directa tampoco es valida o falta, se usa `unknown`. No se agregan logs ni
headers de respuesta con IPs.

Otros reverse proxies requieren configuracion explicita mediante
`SCISONOMICS_TRUSTED_PROXY_IPS` y deben controlar el primer valor de
`X-Forwarded-For`; fuera de Railway en produccion, `X-Real-IP` se ignora.

## Controles automaticos en GitHub Actions

`Security checks` corre en pushes a `main` y `feature/**`, pull requests y el
schedule semanal existente; no se activa por tags. Conserva solo
`permissions: contents: read`.

- `secret-scanning`: Gitleaks 8.30.1, binario oficial con SHA-256 fijado, analiza
  archivos del working tree y todo el historial Git disponible (`fetch-depth: 0`,
  `--log-opts="--all"`). Usa `--redact=100` y falla si encuentra secretos.
  `.gitleaks.toml` extiende las reglas oficiales para claves privadas, JWT y
  credenciales genericas con reglas de Mercado Pago, Supabase secret keys,
  secretos configurados de ScisoNomics/Tauri, admin JSON y URLs PostgreSQL.
  Las excepciones cubren solo fixtures ficticios concretos; no se excluyen
  directorios de codigo, tests ni commits completos.
- `application-security`: tests de seguridad Python y autorizacion de dispositivos,
  smoke imports del backend
  local (`finance_app.services` y `modern_app.backend.app.main`) desde el
  checkout limpio, y `finance_app.test_restore_validation` para backup/restore.
  El smoke no inicia el servidor ni necesita secretos; los logs de importacion
  se aislan con `LOCALAPPDATA` dentro de `runner.temp`. Al importar el codigo
  trackeado y sus dependencias transitivas, CI detecta modulos faltantes aunque
  existan como archivos no trackeados en la PC del desarrollador.
  Ejecuta `pip-audit` para ambos requirements y, despues de `npm ci`, las
  suites frontend `test:auth`, `test:billing` y `test:updater`, el build frontend
  y `npm audit --omit=dev --audit-level=high`. Imports, tests o build fallidos,
  vulnerabilidades Python o high/critical de produccion npm hacen fallar CI.
  No duplica el build del sidecar ni las validaciones Rust del job `rust-tauri`.
- `rust-tauri`: instala `cargo-audit` 0.22.2 con `--locked` y audita
  `modern_app/frontend/src-tauri/Cargo.lock` sin ignorar advisories. Las
  vulnerabilidades bloquean CI; los warnings permanecen visibles en logs y no
  bloquean por si solos. Conserva checks y tests de Tauri Windows con Rust 1.88.0.
- `device-verification-postgres16`: tests de Device Verification con PostgreSQL 16.

Checkout, setup-python y setup-node estan fijadas por SHA completo, con un
comentario de la major original. Al actualizar herramientas, revisar sus
versiones y verificar nuevamente hashes y compatibilidad.

No subir secretos reales al repositorio ni confiar solo en CI para su rotacion.
Si Gitleaks detecta un secreto real, rotarlo/revocarlo antes de simplemente
borrarlo: eliminarlo del working tree no lo elimina del historial. Investigar
su exposicion sin publicar el valor en logs, issues ni artefactos. No agregar
excepciones para hacer pasar un secreto real.

La proteccion de ramas no se configura con este YAML. En GitHub, para `main`,
exigir PR, checks aprobados y branch actualizado antes de merge; bloquear force
pushes y deletion. Requerir los checks estables `application-security`,
`rust-tauri`, `device-verification-postgres16` y `secret-scanning`. Configurarlos
manualmente despues de que hayan corrido; aplicar una politica equivalente a
`feature/external-auth` si tambien se desea proteger esa rama.

## Warnings conocidos de dependencias Rust

Revisar periodicamente estos warnings y las actualizaciones compatibles del
ecosistema Tauri; no representan una lista de advisories ignorados:

- `unic-*`: warnings `unmaintained` via `tauri-utils` / `urlpattern`, tambien
  presentes en Windows.
- `proc-macro-error` (`unmaintained`) y `glib` (`unsound` en los iteradores de
  `VariantStrIter`): dependencias GTK de Linux/BSD, ausentes del target Windows.

Al no usar `--deny warnings`, tanto `unmaintained` como `unsound` se reportan sin
bloquear CI. Esto no elimina los warnings ni resuelve el problema de `glib`.

## Respuesta a incidentes

### Dispositivos cloud — Milestone 8

Windows y Android usan el mismo protocolo Ed25519 por cuenta para enrollment,
login conocido, refresh, rename y revoke. La clave privada permanece en WinCred
o cifrada con Android Keystore, fuera de JavaScript y SQLite financiera.
El nuevo dispositivo requiere OTP backend de seis digitos, TTL 10 minutos,
cinco intentos, reenvio con cooldown de 60 segundos y cuotas por cuenta.
Solo se guardan hashes/HMAC del codigo, continuacion y nonce; no se loggean.
Se reutiliza Resend/SMTP y el email confirmado por Supabase.

La proteccion aplica al backend: grants cortos ligados a dispositivo/familia,
comprobacion de revocacion por request y proofs consumidos atomicamente.
Refresh Supabase solo no restaura la sesion. Revocar exige nueva verificacion
y elimina la sesion persistida al fallar refresh, sin borrar datos locales.
Renombrar y revocar firman proposito, familia y target; revocar el actual exige
confirmacion. No se usan fingerprints ni la telemetria `cloud_devices` como trust.

El modo predeterminado ahora es `enforce`. `off` solo es rollback explicito sin
esta proteccion; clientes nuevos lo rechazan. Las sesiones antiguas sin familia
requieren re-login y OTP. iOS/Keychain y login cloud browser quedan pendientes y
fallan cerrados. Un dispositivo/WebView comprometido y el robo simultaneo de
grant/clave/email no estan resueltos por esta capa. Logout local no equivale a
revocacion remota; usar Dispositivos si se sospecha robo.

Ver [flujo, recuperacion, amenazas, rollout y evidencia](docs/device-verification/DEVICE_AUTHORIZATION.md).
El milestone sigue abierto hasta verificar correo real, restauracion y revocacion
entre PC/Android reales y un segundo perfil Windows. No se modifico produccion.

Si se sospecha el robo de un secreto o una sesion:

1. Rotar inmediatamente el secreto o token afectado.
2. Revocar las familias de refresh tokens involucradas.
3. Revisar `security_audit_log` y los logs del proveedor sin exportar datos financieros.
4. Notificar a los usuarios afectados y forzar un nuevo inicio de sesion.
5. Conservar evidencia minimizada y documentar la causa y la correccion.

## Reporte responsable

No publiques vulnerabilidades con datos reales en un issue publico. Contacta al responsable del repositorio de forma privada e incluye pasos de reproduccion sin credenciales ni informacion financiera.
