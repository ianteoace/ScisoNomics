# Verificacion de dispositivos V1 - Fase 0

Estado: propuesta tecnica para aprobacion antes de Fase 1.

Esta carpeta congela el contrato criptografico de la prueba de posesion Ed25519. No implementa ni habilita verificacion de dispositivos.

## Documentos

- [`canonical-proof-v1.md`](canonical-proof-v1.md): serializacion binaria, limites, propositos y reglas de validacion.
- [`threat-model-v1.md`](threat-model-v1.md): amenazas, controles, riesgos residuales y limites de confianza.
- [`fixtures/ed25519-proof-v1.json`](fixtures/ed25519-proof-v1.json): vectores deterministas compartibles por Rust y Python.

## Invariantes de producto y datos

- La clave Ed25519 es una clave distinta por cuenta y por instalacion. No existe una identidad criptografica global que permita correlacionar cuentas.
- La clave privada se genera y usa exclusivamente en Rust/Tauri y se persiste en WinCred. Nunca atraviesa IPC hacia JavaScript.
- El backend emite `issued_at` y `expires_at`. Tauri firma esos valores sin consultar ni validar el reloj local.
- Los `device_proof_challenges` duran como maximo 120 segundos. El codigo de verificacion entregado por Resend conserva un TTL independiente de 10 minutos; renovar un proof nonce no genera ni reenvia un codigo.
- El backend valida que el challenge exista, coincida byte por byte, no haya expirado y se consuma una sola vez de forma atomica.
- `cloud_devices` sigue siendo telemetria de sincronizacion y nunca se reutiliza como fuente de confianza.
- La cuenta real existente, su `user_id`, sus `owner_user_id` y todos sus datos economicos son invariantes. Una migracion futura solo puede agregar estructuras de autenticacion.
- La perdida o el rechazo de la vinculacion nunca borra datos locales: pausa solamente autenticacion cloud/sync hasta completar una nueva vinculacion por Resend.
- Al activar `enforce`, los refresh tokens legacy se invalidan. No existe `legacy_bootstrap` por mera posesion de un refresh token. Los access tokens anteriores expiran naturalmente.
- Todo seed o clave privada presente en fixtures es material publico, determinista y exclusivo de pruebas; nunca es una credencial ni material reutilizable en produccion.

## Alcance posterior aprobado

La Fase 1 podra agregar tablas y migraciones, familias de refresh normalizadas, claims preparados, el parser `off|observe|enforce` y la identidad Ed25519 en Tauri/WinCred, con modo predeterminado `off` y sin cambios visibles de login.

Toda migracion de Fase 1 debera:

1. ser aditiva y transaccional;
2. probarse sobre copias sinteticas, nunca sobre la DB real;
3. comprobar conteos, claves de usuario, propietarios y relaciones antes y despues;
4. incluir rollback de schema ensayado sobre esas copias;
5. invalidar como maximo tokens/sesiones legacy, nunca entidades financieras ni usuarios.
