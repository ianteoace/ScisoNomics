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

## Respuesta a incidentes

Si se sospecha el robo de un secreto o una sesion:

1. Rotar inmediatamente el secreto o token afectado.
2. Revocar las familias de refresh tokens involucradas.
3. Revisar `security_audit_log` y los logs del proveedor sin exportar datos financieros.
4. Notificar a los usuarios afectados y forzar un nuevo inicio de sesion.
5. Conservar evidencia minimizada y documentar la causa y la correccion.

## Reporte responsable

No publiques vulnerabilidades con datos reales en un issue publico. Contacta al responsable del repositorio de forma privada e incluye pasos de reproduccion sin credenciales ni informacion financiera.
