# Device Verification V1 - Runbook de migracion Fase 1

Este runbook acompana la preparacion aditiva de Fase 1. No autoriza ejecutar migraciones contra Railway ni contra `finanzas.db` real.

Estado: Fase 1 implementada e inerte. La especificacion criptografica Device Proof V1 esta congelada en `docs/device-verification/v1/`. La Fase 2 sigue pendiente: no existen todavia `observe`, `enforce`, endpoints V1 ni integracion frontend.

## Precondiciones

1. `SCISONOMICS_DEVICE_VERIFICATION_MODE=off`, vacia o variable ausente. El parser acepta solamente los literales exactos en minusculas `off`, `observe` y `enforce`; no recorta espacios ni normaliza mayusculas. En Fase 1, `observe` y `enforce` abortan con `device_mode_not_implemented`; otro valor aborta con `invalid_device_verification_mode`. Ninguno se degrada a `off`.
2. Backup cifrado verificado y copia completa fuera del proceso de migracion.
3. Ensayo previo sobre una base sintetica con el mismo schema anterior.
4. Registrar, sin datos sensibles, conteos, IDs de usuario, relaciones de propietario y checksums financieros antes del ensayo.

## Cambios aditivos esperados

- Columna nullable `users.device_key_namespace`, backfill aleatorio idempotente y estable, e indice unico parcial para valores no nulos.
- Tablas nuevas `trusted_devices`, `device_verification_challenges`, `device_proof_challenges` y `refresh_token_families`.
- Columnas nullable `cloud_refresh_tokens.refresh_token_family_id` y `cloud_refresh_tokens.trusted_device_id`.
- Candidate keys `(user_id, id)` y FKs compuestas que impiden vincular dispositivos o familias de otro usuario.
- Indices asociados.

No se copia ninguna fila de `cloud_devices`, no se crea ninguna familia V1 para tokens legacy y no se invalida ninguna sesion en Fase 1.

`device_key_namespace` permanece nullable durante este primer rolling deploy. Todo binario nuevo lo escribe en cada `INSERT`; cada startup repara filas `NULL` o vacias bajo el lock de migracion, con un intento inicial y hasta cinco retries posteriores (seis intentos totales), y exige `missing_namespace_count == 0` al terminar. Cada candidato se compara con valores persistidos y con los ya asignados en el mismo backfill antes de escribirlo. No se usa ni devuelve `account_binding` para una cuenta sin namespace. El `NOT NULL` se agrega en una migracion posterior, una vez retiradas todas las instancias legacy y antes de habilitar Fase 2.

## Serializacion PostgreSQL

La fase DDL de `init_db()` usa `pg_advisory_xact_lock(0x534349534F4E4F4D)` (ASCII `SCISONOM`) dentro de la transaccion. `lock_timeout` y `statement_timeout` se fijan localmente con `SCISONOMICS_DB_MIGRATION_LOCK_TIMEOUT_MS` (15 s por defecto) y `SCISONOMICS_DB_MIGRATION_STATEMENT_TIMEOUT_MS` (120 s por defecto). Las consultas a `information_schema` se limitan a `current_schema()`.

`init_db()` tiene dos etapas transaccionales. La primera serializa y aplica el schema aditivo bajo el advisory lock. La segunda ejecuta los backfills historicos de timestamps de sync, fuera del lock, para no prolongar locks DDL. Si falla la segunda etapa, su DML se revierte pero el schema aditivo de la primera queda aplicado; la aplicacion aborta startup en produccion y permanece unhealthy hasta que una ejecucion idempotente completa ambas etapas. No se usa `CREATE INDEX CONCURRENTLY` dentro de la transaccion. Los logs solo registran inicio, fin o fallo, motor, tipo de error y duracion; nunca SQL ni parametros.

## Verificacion de integridad

El ensayo automatizado `test_device_verification_phase1.py` toma un snapshot antes/despues de todas las tablas cloud financieras y comprueba:

- mismos `users.id`;
- mismos `user_id`, filas, importes y valores serializados en las tablas de sync;
- refresh token legacy intacto y referencias V1 en `NULL`;
- cero filas migradas desde `cloud_devices` a `trusted_devices`;
- namespace estable tras ejecutar `init_db()` repetidamente;
- `missing_namespace_count == 0`, incluida una fila insertada por una instancia legacy durante el rolling deploy y reparada en el startup siguiente;
- constraints unicos y consumo atomico futuro.

La validacion PostgreSQL real debe ejecutarse exclusivamente contra PostgreSQL 16 efimero; PostgreSQL 17 es adicional y nunca reemplaza la version principal. El harness exige aceptacion destructiva explicita, host loopback, base dedicada `scisonomics_device_verification_test*`, marker efimero verificable y `server_version` 16 antes de crear o eliminar schemas. Debe cubrir schema legacy sintetico, dos procesos `init_db()` simultaneos, alta legacy concurrente, segunda ejecucion idempotente, constraints/indices/FKs desde `pg_catalog`, checksums financieros, y un fallo inyectado que demuestre rollback. Una inspeccion estructural o SQLite no habilita declarar PostgreSQL verde. Nunca apuntar esta prueba a Railway.

## Toolchain Rust y lockfile

El MSRV de Tauri es Rust `1.88.0`, fijado en `Cargo.toml`, `rust-toolchain.toml` y CI para el target Windows `x86_64-pc-windows-msvc`. Check y tests se ejecutan como `cargo +1.88.0 ... --locked`.

Los cambios esperados de `Cargo.lock` se clasifican asi:

- dependencia criptografica nueva: `ed25519-dalek` y sus primitivas directas;
- transitivas necesarias: curva Ed25519, `signature`, DER/PKCS#8, hashing, aleatoriedad y zeroization requeridos por esa dependencia;
- bloques huerfanos eliminados: `windows-core 0.62.2`, `windows-result 0.4.1` y `windows-strings 0.5.1`. `cargo tree --locked --target x86_64-pc-windows-msvc --duplicates` sobre `HEAD` y sobre el worktree solo muestra la rama alcanzable `windows-core 0.61.2` / `windows-result 0.3.4` / `windows-strings 0.4.2`; los bloques eliminados ya eran inalcanzables antes de esta fase.

No se permiten upgrades ajenos. Antes del commit se debe conservar evidencia de `cargo tree --locked` antes/despues o, si el estado previo solo existe en Git, comparar el tree del worktree con uno generado desde `HEAD` usando el mismo Rust 1.88.0.

Para una migracion futura controlada se deben agregar al acta los resultados del chequeo de foreign keys del motor, los conteos por tabla y los checksums acordados. `owner_user_id` pertenece a la DB local y no es tocado por esta migracion cloud; la prueba de apertura offline debe ejecutarse sobre una copia sintetica local separada.

## Rollback

El rollback operativo seguro es:

1. mantener o restaurar el binario anterior;
2. confirmar `SCISONOMICS_DEVICE_VERIFICATION_MODE=off`;
3. dejar tablas, columnas e indices aditivos inertes;
4. comprobar login, refresh y sync legacy;
5. comparar nuevamente los checksums y relaciones financieras.

Este rollback no elimina schema porque las estructuras nuevas no cambian el comportamiento en `off`. Es la opcion preferida para proteger la cuenta real.

Un rollback fisico de schema solo puede ensayarse sobre una copia sintetica y debe eliminar en orden: indices V1, referencias nullable de `cloud_refresh_tokens`, `refresh_token_families`, `device_proof_challenges`, `device_verification_challenges`, `trusted_devices`, indice y columna `users.device_key_namespace`. En SQLite, quitar columnas puede requerir reconstruir tablas y por eso queda prohibido sobre la DB real. En PostgreSQL requiere una migracion inversa transaccional separada y backup verificado.

Ninguna variante de rollback puede ejecutar `DELETE` sobre usuarios, movimientos, categorias, presupuestos, metas, gastos, sync ni relaciones de propietario.
