# Supabase Auth: primera fase de migracion

Supabase es un proveedor de identidad externo. `users.id` sigue siendo la
identidad de ScisoNomics para sync, cuentas locales, billing, premium y datos
financieros. El UUID externo solo se guarda en `users.auth_provider_id`.

## Auditoria y alcance

| Archivo | Resultado |
| --- | --- |
| `app/main.py` | `get_current_user` centraliza la identidad. Se incorpora fallback a Supabase solamente si falla la validacion JWT legacy. Un JWT legacy validado con tipo incorrecto, usuario inexistente o email sin verificar conserva su rechazo legacy. |
| `app/auth.py` | El JWT legacy valida firma HS256, issuer, audience, expiracion, iat, sub y jti. Sin cambios. |
| `app/db.py` | SQLite y PostgreSQL conservan `users.id` y sus referencias. Se agrega la columna externa e indice parcial en el init existente. PostgreSQL conserva su advisory lock y limites de tiempo para DDL. |
| `app/schemas.py` | `UserOut.id` sigue siendo el ID interno; no se expone el identificador externo. Sin cambios. |
| `requirements.txt` | `httpx==0.28.1` ya permite la validacion remota. No se agregan dependencias. |
| `../frontend/services/cloudAuth.ts` | Las cuentas, owner y almacenamiento usan `CloudUser.id`. `cloudAuth.me(token)` ya permite resolver un Bearer mediante `/auth/me`. Login, registro, refresh y persistencia siguen siendo legacy. Sin cambios. |
| `../frontend/lib/supabase.ts` | Usa publishable key, sin persistencia, auto-refresh ni deteccion de sesion en URL. Aun no se integra con `cloudAuth`. Su import exige ambas variables publicas. Tiene un BOM preexistente tambien en HEAD; no se introduce ni modifica en esta fase. Sin cambios. |

El intento manual anterior habia dejado BOM en los archivos backend editados,
un final de linea aislado y cuatro textos mal codificados en `main.py`.
Se corrigen conservando UTF-8 sin BOM y CRLF en esos archivos, con cambios
puntuales. El frontend y el auth legacy no se reescriben.

## Validacion de identidad externa

El backend consulta `GET {SCISONOMICS_SUPABASE_URL}/auth/v1/user` con la
publishable key en `apikey` y el access token en `Authorization: Bearer`.
Es la API de `getUser`: Supabase valida el token y devuelve el usuario actual.
La estrategia esta documentada por [Supabase para validar JWT](https://supabase.com/docs/guides/auth/jwts)
y [get_user](https://supabase.com/docs/reference/python/auth-getuser).
Funciona sin compartir el secreto JWT del proyecto ni implementar algoritmos
criptograficos propios.

Se usan solamente `id` (el subject verificado), email y `email_confirmed_at`
de esa respuesta. Ni claims decodificados sin validacion ni `user_metadata`
autorizan el acceso. Se rechazan identidades anonimas y emails no confirmados.
El significado de `email_confirmed_at` esta documentado en [Users](https://supabase.com/docs/guides/auth/users).

Variables backend:

```text
SCISONOMICS_SUPABASE_URL=https://PROJECT.supabase.co
SCISONOMICS_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Esta fase acepta claves modernas `sb_publishable_...`, nunca `service_role`,
`sb_secret_...` ni claves JWT `anon` antiguas. En produccion exige HTTPS;
HTTP solo se admite para loopback en desarrollo. El frontend conserva
`NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
Ambos deben apuntar al mismo proyecto que el backend.

No se siguen redirects. El timeout HTTP es de 8 segundos por operacion.
No se registran tokens, headers, cuerpos de error ni textos de excepciones
de red. Cada solicitud con token externo hace una validacion remota;
las solicitudes legacy validas no dependen de Supabase.

## Resolucion y primer vinculo

1. Validar primero el JWT propio de ScisoNomics.
2. Si no valida y existe configuracion externa, consultar Supabase.
3. Exigir email confirmado en la respuesta de Supabase.
4. Buscar `users.auth_provider_id = sub`. Si existe, ese vinculo es
   autoritativo incluso si cambio el email del proveedor: no se mueve la
   identidad a otra cuenta con el email nuevo.
5. Si no existe vinculo, buscar `LOWER(TRIM(email))` y exigir exactamente una
   cuenta interna. No se elimina puntuacion ni se fusionan alias de email.
6. Vincular mediante UPDATE condicionado por ID interno, email y ausencia
   de otro vinculo. Un vinculo concurrente al mismo subject es idempotente;
   un vinculo incompatible devuelve conflicto. La restriccion unica protege
   tambien dos asignaciones concurrentes del mismo subject a cuentas distintas.
7. Devolver siempre `UserOut` con `users.id` y los datos internos.

No se crean usuarios automaticamente. La confirmacion externa no modifica
`email_verified` legacy, password, tokens de refresh ni entitlements.

| Estado | HTTP | Codigo |
| --- | --- | --- |
| JWT externo rechazado por Supabase | 401 | `invalid_supabase_token` |
| Identidad externa sin ID/email valido o anonima | 401 | `invalid_supabase_user` |
| Email externo no confirmado | 403 | `email_verification_required` |
| Sin cuenta interna para el email | 403 | `internal_account_required` |
| Email normalizado ambiguo | 409 | `auth_email_ambiguous` |
| Vinculo incompatible o colision del indice unico | 409 | `auth_provider_conflict` |
| Respuesta 200 de Supabase malformada | 502 | `invalid_supabase_response` |
| Configuracion parcial | 503 | `supabase_auth_not_configured` |
| URL o tipo de clave invalido | 503 | `supabase_auth_invalid_config` |
| Error de red, rate limit, outage o respuesta HTTP inesperada | 503 | `supabase_auth_unavailable` |

Si ambas variables backend estan ausentes, Supabase queda deshabilitado:
los JWT legacy funcionan y los tokens externos conservan el rechazo 401
legacy sin hacer solicitudes de red. El verificador externo llamado
directamente sin configuracion devuelve `supabase_auth_not_configured`.

## Migracion de schema

`init_db()` agrega `auth_provider_id TEXT` nullable mediante el mecanismo
idempotente de columnas existente en ambos motores y crea:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_provider_id
ON users(auth_provider_id)
WHERE auth_provider_id IS NOT NULL AND auth_provider_id <> '';
```

No se backfillea esta columna, no se modifica `users.id` y no se cambian
foreign keys. El primer vinculo escribe solamente `auth_provider_id`.
La DDL se ejecutara en el startup del backend cuando se despliegue este codigo;
no se ha aplicado a Railway durante este trabajo. El indice puede requerir
un bloqueo breve al crearse. Duplicados externos preexistentes harian fallar
la creacion del indice; deben resolverse manualmente, sin borrar cuentas.

## Pruebas locales y siguientes pasos

```powershell
python -m compileall modern_app/cloud_backend/app
python -m unittest modern_app.cloud_backend.test_supabase_auth -v
```

Las pruebas nuevas crean bases SQLite temporales y simulan Supabase. Cubren
legacy, confirmacion de email, errores externos, vinculos, ambiguedad,
concurrencia, idempotencia del schema e identidad financiera interna.
No usan credenciales reales ni una base PostgreSQL remota.

Antes de activar la migracion para usuarios:

- Mantener habilitada la confirmacion real de email en Supabase. Si el
  proyecto autoconfirma emails sin probar su control, el primer vinculo por
  email deja de ser seguro. Revisar tambien los proveedores OAuth permitidos.
- Validar la migracion y colisiones concurrentes en PostgreSQL aislado;
  esta fase se verifica ejecutando SQLite, sin acceder a Railway.
- Definir el alta interna para `internal_account_required` manteniendo un
  `users.id` propio, y un procedimiento para resolver conflictos de vinculo.
- Integrar login Supabase con `/auth/me` y consumir su ID interno antes de
  seleccionar owner local o iniciar sync. No usar `session.user.id` como owner.
- Diseñar refresh/logout y persistencia de sesiones externas en Tauri por
  separado: sus refresh tokens no deben enviarse a `/auth/refresh` legacy.
- Evaluar latencia y disponibilidad de la validacion remota antes de ampliar
  el rollout. Una caida del proveedor devuelve 503 sin desvincular cuentas.

Registro/login/refresh/logout legacy, Google OAuth legacy, Device Proof,
sync financiero, billing y entitlements permanecen con sus contratos actuales.
