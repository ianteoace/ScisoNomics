# Preparación del despliegue de Supabase Auth en Railway

Este documento prepara el despliegue. No autoriza ni ejecuta cambios en Railway.
El owner histórico es `fbfca732-c4d1-47be-95e5-75aa3142726f`, con email
`sciso123@gmail.com`. Su `users.id` permanece como referencia de sync y Premium.

## Esquema e inicialización

Frente al código anterior a Supabase (`9b0743a`), esta rama añade a `users`:

```sql
ALTER TABLE users ADD COLUMN auth_provider_id TEXT;
ALTER TABLE users ADD COLUMN password_auth_enabled INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_provider_id
    ON users(auth_provider_id)
    WHERE auth_provider_id IS NOT NULL AND auth_provider_id <> '';
```

Estas son las instrucciones equivalentes: el código comprueba cada columna
en `information_schema.columns` antes de `ALTER TABLE`, protegido por un
advisory lock de PostgreSQL. Ambos campos se aplican desde `init_db()` en
PostgreSQL y SQLite. El primero queda `NULL` en usuarios anteriores. El
segundo queda en `1` para compatibilidad con contraseñas legacy; los nuevos
usuarios Supabase se insertan con `0` y hash vacío. El login legacy también
exige un hash válido. `users.id`, `google_sub` y las claves foráneas no se
cambian. El índice parcial único de `google_sub` ya existía; el índice de email
normalizado es **no único**, por lo que se requiere una comprobación previa.
No hay otras columnas ni tablas agregadas por esta rama a la base cloud.

`startup()` ejecuta `init_db()` y aborta en producción si falla. La primera
fase DDL usa advisory lock, `lock_timeout` de 15 s y `statement_timeout` de
120 s por defecto. Si falla la transacción, PostgreSQL revierte sus columnas,
índice y demás DDL de esa transacción. La segunda fase, ya sin advisory lock,
ejecuta el backfill histórico de `remote_updated_at` en tablas de sync si
faltan valores. Por ello, `init_db()` completo no es estrictamente de solo
lectura ni se limita a las dos columnas nuevas. También rellena `plan` vacío
con `free`, `subscription_status` vacío con `active`, y `email_verified` NULL
con `1`; **no cambia** `premium`, `active` ni `2030-01-01T00:00:00Z` del caso
conocido. Una ausencia o error en cualquiera de los objetos previos puede
bloquear el startup, aunque las dos columnas nuevas sean correctas.

## Identidad histórica y conflictos

`POST /auth/supabase/bootstrap` valida el token en Supabase con la publishable
key y exige `email_confirmed_at`. Busca primero por `auth_provider_id = sub`.
Si no existe vínculo, busca `LOWER(TRIM(email)) = 'sciso123@gmail.com'`.
Si hay exactamente una fila histórica y su ID externo es `NULL`/vacío,
actualiza solo `auth_provider_id` y `updated_at` de esa fila y escribe un
registro de auditoría. Devuelve el `users.id` histórico. No modifica plan,
estado/vencimiento de suscripción, Google legacy, datos financieros ni owner
de sync. El `sub` de Supabase nunca se usa como `users.id`.

| Situación | Resultado actual |
| --- | --- |
| Dos filas con el mismo email tras trim/minúsculas | 409 `auth_email_ambiguous`; aunque el índice único legacy sobre `email` permita diferencias de mayúsculas/espacios. |
| Email histórico ya enlazado a otro sub | 409 `auth_provider_conflict`. |
| Dos sub distintos compiten por el email | Uno enlaza, otro recibe 409. |
| Mismo sub llega simultáneamente | Ambos obtienen el mismo ID interno; un único vínculo. |
| Sub ya enlazado al owner de prueba | Devuelve ese owner antes de buscar por email; **no** lo mueve al histórico ni devuelve 409. Requiere resolución manual antes del login histórico. |
| `auth_provider='google'` y `google_sub` legacy | Permanecen intactos; la nueva columna almacena además el sub de Supabase. El Google legacy sigue usando `google_sub`. |

El `users.id` histórico y su email están confirmados por el operador, pero
esta auditoría no examinó Railway. Antes de activar el login real, confirmar
en la base que el email normalizado coincide **en una sola fila** y que el sub
real no tiene vínculo con el owner vacío de prueba. El diagnóstico previo
`diagnose_cloud_user.py` requiere la columna nueva, por lo que solo puede
ejecutarse después de que el backend aplique el esquema. Resolver cualquier
conflicto de manera explícita y auditada; no copiar ni fusionar datos entre
owners para sortearlo.

## Variables y configuración

Las **únicas variables nuevas de Railway para Supabase Auth** son:

```text
SCISONOMICS_SUPABASE_URL=https://<proyecto>.supabase.co
SCISONOMICS_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Ambas deben señalar el mismo proyecto de Supabase del frontend. La clave
publishable es suficiente para `GET /auth/v1/user`; no se necesita ni se debe
agregar `service_role`, clave secreta Supabase o secreto JWT Supabase.
Con una sola variable presente, los tokens Supabase fallan con 503.

Conservar las variables **existentes**: `DATABASE_URL` o
`SCISONOMICS_CLOUD_DATABASE_URL` (esta última tiene prioridad),
`SCISONOMICS_ENV=production`, `SCISONOMICS_JWT_SECRET`,
`SCISONOMICS_ALLOWED_ORIGINS`, la clave privada de entitlements mediante
`SCISONOMICS_ENTITLEMENTS_PRIVATE_KEY` o `_FILE`, y la configuración del
Google legacy mientras esté habilitado. El frontend/instalador necesita en
su build `NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL`, `NEXT_PUBLIC_SUPABASE_URL`
y `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; su URL de backend, CSP y deep link
deben concordar con el entorno desplegado. `SCISONOMICS_DEVICE_VERIFICATION_MODE`
debe seguir en `off`/vacío en la fase actual. Los timeouts de migración son
configurables pero no requieren variables nuevas.

## Secuencia recomendada

1. Reservar una ventana de bajo tráfico; registrar el despliegue actual y
   tener respaldo verificable de PostgreSQL. Usar lecturas para confirmar
   existencia del ID/email, unicidad del email normalizado, Premium/vencimiento
   y, una vez creada la columna, ausencia de vínculo del sub real al owner de
   prueba. Una consulta por el ID histórico **no prueba** por sí sola esto
   último. No efectuar todavía login real de Supabase si hay conflicto.
2. Configurar las dos variables backend y comprobar que el JWT secret,
   firma de entitlements, DATABASE_URL y CORS anteriores siguen disponibles.
   Mantener Google legacy y el frontend anterior funcionando.
3. Desplegar primero el backend dual-auth con bootstrap. `startup()` aplica la
   migración automáticamente antes de servir tráfico. El `railway.json` actual
   usa `/health` como healthcheck; esperar su 200 con `db_status.ready=true`
   y revisar logs de fin de migración. `/ready` vuelve a ejecutar `init_db()`:
   usarlo una vez como smoke después de `/health`, no como sondeo frecuente.
   Railway documenta que el healthcheck debe responder correctamente antes de
   activar el nuevo deployment: [healthchecks](https://docs.railway.com/deployments/healthchecks).
4. Comprobar en lectura que existen las dos columnas y el índice parcial, y
   que el owner histórico conserva ID, email y Premium. Ejecutar una prueba
   con una cuenta Supabase **distinta** y sin datos reales, incluyendo
   `/auth/supabase/bootstrap` y `/auth/me`. Verificar que devuelve un ID interno
   diferente del sub.
5. Publicar el frontend/instalador configurado para ese backend y proyecto
   Supabase. Probar email+OTP y Google+PKCE+deep link antes de la cuenta
   histórica. Luego probar el primer login histórico y confirmar que bootstrap
   responde exactamente `fbfca732-c4d1-47be-95e5-75aa3142726f`.
6. Verificar Premium, los movimientos históricos y sync con ese owner antes
   de ampliar el uso de Supabase. Si aparece un owner de prueba vacío, pausar
   el flujo y resolver el vínculo manualmente; no copiar datos.

## Rollback

Ante fallo del nuevo backend, volver al último deployment compatible con
dual-auth/bootstrap siempre que exista, manteniendo la configuración de
Supabase. Railway permite rollback de deployments desde la consola; verificar
el entorno después del rollback, en especial `DATABASE_URL` y el JWT secret.
Ver [rollback de deployments](https://docs.railway.com/guides/roll-back-bad-deploy).
Si solo está disponible un backend legacy anterior a Supabase, éste puede
seguir sirviendo a usuarios legacy, pero **no** validará accesos Supabase ni
ofrecerá `/auth/supabase/bootstrap`: pausar el frontend Supabase hasta
restaurar una versión compatible. Los usuarios creados exclusivamente por
Supabase no tienen contraseña legacy.

No revertir el esquema: conservar `auth_provider_id`,
`password_auth_enabled`, el índice único parcial, `google_sub`, `users.id`,
refresh tokens legacy, registros de auditoría y todas las foreign keys. Las
versiones anteriores que usan `INSERT INTO users` con lista de columnas
funcionan con el default `password_auth_enabled=1`. No desasignar vínculos ni
borrar owners para hacer rollback. Las sesiones Supabase almacenadas en
WinCred permanecen, pero requieren un backend dual-auth para recuperar acceso.

## Smoke tests de producción

- [ ] `/health` 200 y `db_status.ready=true`; `/ready` 200 una vez.
- [ ] Columnas/índice parcial presentes; ID/email/Premium histórico idénticos.
- [ ] Login legacy email/password de una cuenta que tenga contraseña y `/auth/refresh` legacy.
- [ ] Google OAuth legacy sigue devolviendo el mismo ID interno de prueba.
- [ ] Login Supabase email/password + OTP con cuenta de prueba, bootstrap y `/auth/me`.
- [ ] Login Supabase Google + PKCE + deep link con cuenta de prueba; WinCred restaura sesión.
- [ ] Primer bootstrap del email histórico devuelve el ID exacto conocido, sin nuevo owner.
- [ ] `/billing/entitlements` muestra Premium activo y vencimiento 2030-01-01 para ese ID.
- [ ] Movimientos históricos visibles; `sync/pull` y `sync/push` operan bajo el owner interno.
- [ ] Logout/login, reinicio de la app y restauración de sesión Supabase y legacy.
- [ ] Cambio entre modo local, cuenta histórica y cuenta de prueba sin mezclar datos.

## Ensayo local realizado

El módulo `test_supabase_postgres_migration.py` toma el código/esquema real
del commit `9b0743a` y requiere una URL PostgreSQL de loopback a una base con
nombre `scisonomics_auth_migration_test*` y la tabla marcadora local
`public.scisonomics_auth_test_marker` con un valor conocido. Rechaza URLs
remotas, parámetros de conexión y bases sin marcador antes de crear schemas.
Cada test utiliza un schema temporal propio, deja intacta cualquier base
externa y borra únicamente su schema después de la prueba. La prueba carga
un usuario sintético con el ID, email, plan y vencimiento históricos y ocho
filas financieras sintéticas referenciadas; no usa datos reales.

El ensayo comprueba migración dos veces, transacciones fallidas, bootstrap,
entitlements, login/refresh y Google legacy, conflictos, carreras, PK/FK y
snapshots de las ocho tablas de sync. Una prueba separada demuestra que el
backfill previo de `remote_updated_at` sí modifica ese campo si está vacío.
No equivale a una inspección de Railway ni a un backup real de producción.
