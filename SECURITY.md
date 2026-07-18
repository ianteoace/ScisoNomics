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

## Controles incorporados

- Passwords nuevas derivadas con scrypt; hashes PBKDF2 anteriores se migran al iniciar sesion.
- Access tokens de corta duracion con emisor, audiencia, tipo y `jti` validados.
- Refresh tokens rotativos con deteccion de reutilizacion y revocacion de toda la familia.
- Rate limiting por IP e identidad para autenticacion, administracion y sincronizacion.
- Segundo factor TOTP obligatorio para administradores en produccion.
- Registro de eventos sensibles en `security_audit_log` sin tokens ni datos financieros.
- Limites de cuerpo, cantidad de registros y longitudes en sincronizacion.
- Refresh tokens persistentes guardados en el almacen seguro del sistema operativo.
- Backups portables cifrados con AES-256-GCM y clave derivada mediante scrypt.
- Proteccion opcional de la base activa y backups mediante EFS de Windows, activada explicitamente por el usuario.

El rate limiter incorporado protege una instancia. Si se despliegan varias replicas, debe agregarse un limite compartido en el proxy o mediante un servicio centralizado.

## Respuesta a incidentes

Si se sospecha el robo de un secreto o una sesion:

1. Rotar inmediatamente el secreto o token afectado.
2. Revocar las familias de refresh tokens involucradas.
3. Revisar `security_audit_log` y los logs del proveedor sin exportar datos financieros.
4. Notificar a los usuarios afectados y forzar un nuevo inicio de sesion.
5. Conservar evidencia minimizada y documentar la causa y la correccion.

## Reporte responsable

No publiques vulnerabilidades con datos reales en un issue publico. Contacta al responsable del repositorio de forma privada e incluye pasos de reproduccion sin credenciales ni informacion financiera.
