# Threat model de verificacion de dispositivos V1

Estado: propuesta tecnica para aprobacion antes de Fase 1.

## 1. Activos y fronteras de confianza

Activos: clave privada del dispositivo, desafios, codigos de Resend, access/refresh tokens, asociaciones usuario-dispositivo-familia y datos economicos locales/cloud.

Fronteras:

- Rust/Tauri y WinCred son la unica zona autorizada para crear, persistir y usar la clave privada.
- JavaScript y la UI no son custodios de la clave y solo invocan comandos tipados.
- El backend es autoritativo para usuario, account binding, challenge, timestamps, proposito, familia, target, consumo y revocacion.
- Resend transporta el factor de correo, pero nunca recibe la clave privada ni tokens de sesion.
- `cloud_devices` y headers de dispositivo existentes son datos no confiables de sincronizacion.

## 2. Amenazas y controles

### Replay de una prueba valida

Ataque: capturar y reenviar firma/challenge antes o despues de emitir tokens.

Controles: proof nonce de 32 bytes generado mediante CSPRNG, challenge ID, expiracion maxima de 120 segundos exclusiva del `device_proof_challenge`, consumo atomico de una sola vez y binding del proposito/familia/target/request. Dos requests concurrentes solo permiten un consumo. Un challenge expirado o consumido no se reactiva. El codigo Resend conserva por separado su TTL de 10 minutos; obtener otro proof nonce no genera, reenvia ni prolonga ese codigo.

Riesgo residual: malware con control activo del equipo puede solicitar y usar un challenge nuevo durante la sesion comprometida. Esto no es atestacion del dispositivo.

### Sustitucion de clave publica

Ataque: reemplazar la clave enviada por la del atacante para que su firma sea aceptada como el dispositivo de la victima.

Controles: enrollment liga el factor Resend, `account_binding`, `device_id` y `SHA-256(public_key)` al mismo challenge persistido. El backend reconstruye esos bytes desde valores autoritativos. Para dispositivos existentes obtiene la clave por `(user_id, device_id)` y exige coincidencia del hash. Los constraints unicos evitan aliases dentro de la cuenta.

Riesgo residual: compromiso simultaneo del correo y del flujo de autenticacion permite vincular una clave atacante; requiere recuperacion/revocacion de cuenta.

### Cross-account

Ataque: reutilizar una firma o identidad valida de una cuenta en otra, o correlacionar silenciosamente varias cuentas del mismo usuario local.

Controles: clave distinta por cuenta e instalacion; `account_binding` aleatorio de 32 bytes incluido en toda firma; challenge y dispositivos consultados siempre bajo el `user_id` autenticado; unicidad acotada a usuario. Un binding de cuenta nunca se deriva del email ni se comparte entre cuentas.

Riesgo residual: metadatos de red, equipo o proveedor pueden correlacionar actividad fuera de este protocolo. La arquitectura no promete anonimato de red.

### Cross-purpose y confusion de contexto

Ataque: usar una firma de login para refresh, una de rename para revoke o una operacion contra otro dispositivo.

Controles: enum de proposito firmado; reglas estrictas de presencia; challenge creado para un solo proposito; familia, target y hash del request firmados cuando aplican; magic y version separan dominios.

Los slots no aplicables deben estar marcados como ausentes y rellenos con cero. El verificador rechaza presencias, ausencias o rellenos incompatibles con el proposito, incluso si la firma criptografica fuera valida para esos bytes.

### Manipulacion de tiempo y reloj local incorrecto

Ataque: adelantar/atrasar el reloj del cliente para bloquear o extender desafios.

Controles: backend emite `issued_at`/`expires_at`; Tauri solo los serializa y firma; backend los compara con el registro y evalua expiracion con su reloj. El reloj local no participa.

### Robo del challenge o verification token

Ataque: robar nonce, challenge ID o continuacion desde JS/logs y completar el flujo.

Controles: esos valores no bastan sin la clave privada; enrollment exige ademas el codigo Resend. Continuaciones son opacas, breves, de uso unico y ligadas a usuario/proposito/clave candidata. Logs no incluyen nonce, codigo, firma completa, tokens ni email completo.

Riesgo residual: XSS o malware capaz de invocar comandos Tauri tipados mientras la app esta activa podria inducir firmas permitidas. Los comandos deben mostrar/recibir solo parametros acotados y Rust debe construir el mensaje; no se expone `sign(bytes)`.

### Robo o perdida de WinCred

Ataque: extraer la clave privada o perderla por limpieza/reinstalacion.

Controles: WinCred limita exposicion accidental; una clave perdida no se reemplaza silenciosamente. Se vuelve a autenticar y vincular una clave nueva mediante Resend. Revocar un dispositivo revoca todas sus familias. Logout normal no elimina la identidad; revoke confirmado puede hacerlo.

Riesgo residual: WinCred no protege contra un usuario/malware con control equivalente sobre la sesion Windows. Esto es prueba de posesion, no hardware-backed attestation.

### Sesiones legacy y downgrade

Ataque: conservar un refresh token anterior para evitar la vinculacion o forzar `off/observe` desde el cliente.

Controles: el modo es configuracion exclusiva del servidor y por defecto `off` hasta activacion deliberada. No existe bootstrap por refresh token. Al activar `enforce`, se invalidan solamente sesiones/familias legacy; los access tokens viejos expiran naturalmente. La primera autenticacion posterior vincula mediante Resend.

### Revocacion y modo offline

Ataque: seguir usando un access token tras revocar el dispositivo o esperar que revocacion cloud borre datos locales.

Controles futuros: access token maximo 15 minutos con `tdi` y `fid`; el backend consulta dispositivo/familia no revocados en requests autenticados; revoke invalida todas las familias del dispositivo. Offline conserva los datos locales pero detiene refresh/sync hasta reconectar.

Riesgo residual: una copia local autorizada puede seguir leyendose offline segun el modelo local de ScisoNomics. La revocacion cloud no es borrado remoto y debe comunicarse asi.

## 3. Amenazas fuera de alcance V1

- DPoP o firma de cada request.
- Atestacion de hardware, TPM o fingerprint invasivo.
- Proteccion ante control total de la cuenta Windows o del proceso Tauri.
- Borrado remoto garantizado de datos locales offline.
- Anonimato frente a correlacion por IP, proveedor o telemetria externa.

## 4. Requisitos de auditoria sin secretos

Registrar tipo de evento, resultado, IDs internos opacos o truncados, modo, motivo categorizado y duracion. No registrar email completo, clave publica completa, nonce, firma, codigo Resend, password, access/refresh token, continuacion ni credenciales del proveedor.

Eventos minimos futuros: challenge creado/expirado/consumido/replay, enrollment exitoso/fallido, proof invalido por categoria, familia emitida/rotada/revocada, dispositivo renombrado/revocado y rechazo legacy en `enforce`.

## 5. Seguridad de migracion e integridad

La Fase 1 debe ensayarse solo sobre bases sinteticas que representen: usuario real con datos economicos, multicuenta, relaciones por `owner_user_id`, refresh families legacy y ausencia de sesiones.

Antes y despues se comparan como minimo:

- cantidad y claves primarias de usuarios;
- todos los `user_id` y `owner_user_id` de tablas existentes;
- conteos y checksums deterministas de movimientos, categorias, presupuestos y metas;
- foreign-key check e integridad nativa de la base;
- capacidad de abrir y leer datos locales sin cloud;
- que `cloud_devices` no haya sido copiado a `trusted_devices`.

Rollback de schema: antes de activar `enforce`, revertir solo objetos nuevos de dispositivos/familias dentro de una transaccion ensayada y restaurar el codigo en modo `off`. Si una migracion aditiva ya fue desplegada con datos nuevos, el rollback operativo preferido es volver a `off` y dejar tablas nuevas inertes; destruirlas exige backup verificado y una migracion inversa separada. Ningun rollback toca usuarios ni datos financieros.
