# Device Proof V1 - especificacion criptografica congelada

Estado: contrato criptografico V1 congelado. No describe por si solo funcionalidad habilitada.

Esta carpeta congela el contrato criptografico de la prueba de posesion Ed25519. Historicamente, la Fase 1 agrego schema aditivo, parser de modo e identidad Ed25519 local, inertes con default `off` en esa fase. La implementacion actual de Fase 2 se describe en [DEVICE_AUTHORIZATION.md](../DEVICE_AUTHORIZATION.md); esta carpeta conserva el contrato congelado.

## Documentos

- [`canonical-proof-v1.md`](canonical-proof-v1.md): serializacion binaria, limites, propositos y reglas de validacion.
- [`threat-model-v1.md`](threat-model-v1.md): amenazas, controles, riesgos residuales y limites de confianza.
- [`fixtures/ed25519-proof-v1.json`](fixtures/ed25519-proof-v1.json): vectores deterministas compartibles por Rust y Python.

## Invariantes de producto y datos

- La clave Ed25519 es una clave distinta por cuenta y por instalacion. No existe una identidad criptografica global que permita correlacionar cuentas.
- La clave privada se genera y usa exclusivamente en Rust/Tauri y se persiste en WinCred (Windows) o cifrada por Android Keystore. Nunca atraviesa IPC hacia JavaScript.
- El backend emite `issued_at` y `expires_at`. Tauri firma esos valores sin consultar ni validar el reloj local.
- Los `device_proof_challenges` duran como maximo 120 segundos. El codigo de verificacion entregado por Resend conserva un TTL independiente de 10 minutos; renovar un proof nonce no genera ni reenvia un codigo.
- El backend valida que el challenge exista, coincida byte por byte, no haya expirado y se consuma una sola vez de forma atomica.
- `cloud_devices` sigue siendo telemetria de sincronizacion y nunca se reutiliza como fuente de confianza.
- La cuenta real existente, su `user_id`, sus `owner_user_id` y todos sus datos economicos son invariantes. Una migracion futura solo puede agregar estructuras de autenticacion.
- La perdida o el rechazo de la vinculacion nunca borra datos locales: pausa solamente autenticacion cloud/sync hasta completar una nueva vinculacion por Resend.
- Al activar `enforce`, los refresh tokens legacy se invalidan. No existe `legacy_bootstrap` por mera posesion de un refresh token. Los access tokens anteriores no autorizan requests protegidos en enforce.
- Todo seed o clave privada presente en fixtures es material publico, determinista y exclusivo de pruebas; nunca es una credencial ni material reutilizable en produccion.

## Separacion de fases

La especificacion congelada define bytes, validaciones y amenazas. La Fase 1 implementada agrega tablas y migraciones, familias de refresh preparadas, el parser `off|observe|enforce` y la identidad Ed25519 en Tauri/WinCred, con modo predeterminado `off` y sin cambios visibles de login. No implementa endpoints Device Proof V1 ni aplica verificacion.

La descripcion anterior documenta la Fase 1 historica. La Fase 2 de Milestone 8
ahora implementa `enforce`, endpoints e integracion compartida Windows/Android;
`enforce` es el default y `off` requiere rollback explicito. `observe` sigue
rechazado. Ver [implementacion, amenazas y pendientes](../DEVICE_AUTHORIZATION.md).
El contrato criptografico de esta carpeta no cambia. Faltan pruebas manuales
con correo real y segundo perfil Windows antes de cerrar el milestone.

Toda migracion de Fase 1 debe:

1. ser aditiva y transaccional;
2. probarse sobre copias sinteticas, nunca sobre la DB real;
3. comprobar conteos, claves de usuario, propietarios y relaciones antes y despues;
4. incluir rollback de schema ensayado sobre esas copias;
5. invalidar como maximo tokens/sesiones legacy, nunca entidades financieras ni usuarios.
