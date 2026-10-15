# Harness local autenticado — staging solamente

Esta carpeta se deja **sin trackear**. No requiere instalar dependencias nuevas:
usa Python del venv cloud existente, httpx y cryptography. No modifica la app.
No usar `loadtest-safe.js` para esta fase: ese archivo sigue siendo el test público
anterior y admite 100 VUs; este harness permite como máximo **50**.

## Preparación privada en Windows

Desde la raíz del repo, abrí una terminal PowerShell y ejecutá:

```powershell
.\modern_app\cloud_backend\.venv\Scripts\python.exe .\tools\loadtest\loadtest.py configure --config "$env:LOCALAPPDATA\ScisoNomicsLoadTest\config.dpapi"
```

El comando pide email/contraseña de una **cuenta QA exclusiva y con email ya
confirmado** y la publishable key de Supabase staging; las entradas secretas no
se muestran. Confirmá `QA` sólo si no es una cuenta principal/real. La configuración
se cifra con Windows DPAPI CurrentUser fuera del repo. Nunca pegues estos valores
en el chat. No admite secret key ni service_role.

Los únicos destinos aceptados son los dos staging especificados en este pedido;
no se permiten overrides de host, redirects ni desactivar TLS. La ubicación de
estado debe estar fuera del repo y tener nombre `ScisoNomicsLoadTest...`.
El código no abre WinCred, Keychain, Android Keystore ni archivos de identidad
de dispositivos reales.

## Enrolar UNA vez, antes de cargar

```powershell
.\modern_app\cloud_backend\.venv\Scripts\python.exe .\tools\loadtest\loadtest.py setup --config "$env:LOCALAPPDATA\ScisoNomicsLoadTest\config.dpapi"
```

Se genera un par Ed25519 CSPRNG nuevo y UUID v4 exclusivos de este harness, guardados
como `identity.dpapi` en el directorio externo. Nunca se importan claves nativas.
Login password Supabase → verificación de usuario/email/issuer staging → bootstrap
ScisoNomics → context `mode=enforce` → login de dispositivo → OTP → challenge y
complete del enrollment. El OTP se introduce **en esa terminal**, oculto, una vez;
no se guarda en archivo ni aparece en resultados. No hay reintentos/resends
automáticos. Esperar los límites naturales antes de repetir un setup fallido.
Si la identidad ya es trusted, se usa el flujo normal authentication/complete.

La sesión, refresh Supabase y grant quedan en `session.dpapi`, exclusivamente
fuera del repo. Password/config también está cifrado. DPAPI requiere esta misma
PC y usuario Windows; un proceso comprometido bajo ese usuario no está cubierto.
Protegé igualmente el directorio y borrá los archivos del harness cuando termines.

## Smoke y ejecución

Smoke separado, una sola request de lectura autenticada a `/sync/health`:

```powershell
.\modern_app\cloud_backend\.venv\Scripts\python.exe .\tools\loadtest\loadtest.py smoke --config "$env:LOCALAPPDATA\ScisoNomicsLoadTest\config.dpapi"
```

Carga completa (también exige su propio smoke 200 antes de iniciar VUs):

```powershell
.\modern_app\cloud_backend\.venv\Scripts\python.exe .\tools\loadtest\loadtest.py run --config "$env:LOCALAPPDATA\ScisoNomicsLoadTest\config.dpapi" --json-out "$env:LOCALAPPDATA\ScisoNomicsLoadTest\result-$(Get-Date -Format yyyyMMdd-HHmmss).json"
```

Perfil cerrado con 1 s de think time por VU y una request por iteración:

| Etapa | VUs | Duración nominal |
|---|---:|---:|
| warm-up | 5 | 20 s |
| lectura | 10 | 30 s |
| lectura | 25 | 60 s |
| lectura | 50 | 60 s |
| ramp-down lineal | 50 → 0 | 20 s |

Las requests en vuelo se drenan entre etapas. Duración real puede superar los
190 s nominales. No hay refresh/login/enrollment/OTP por VU o iteración. Antes del
smoke se verifica la sesión y, si corresponde, se renueva una vez mediante los
flujos existentes. Si el TTL del grant es demasiado corto, falla antes de cargar;
no modifica TTL ni rate limits. No reintenta requests fallidas durante carga.

Cada etapa debe pasar thresholds antes de aumentar carga: errores <1%, p95 <1 s,
5xx=0, timeouts=0. Abort adicional sobre ventana móvil de 10 s: 5xx >2%, timeouts
>1%, o p95 >3 s durante 10 s continuos con al menos 10 muestras. 401/403/429,
error de transporte o body excesivo abortan inmediatamente y no se evade el límite.
Los requests ya en vuelo pueden terminar después del aborto. Ctrl+C drena y reporta.

## Requests reales y autenticación

Mezcla probabilística:

- 50% `GET /sync/health`;
- 30% `GET /sync/pull?since=<cursor-inicial>`;
- 10% `GET /billing/subscription` (lectura local de estado, sin proveedor externo);
- 10% `GET /auth/me`.

El cursor se obtiene una vez después del smoke y permanece fijo. No se imprimen
respuestas ni datos financieros. Evitar escrituras de otras apps sobre esa cuenta
QA durante la medición si se busca pull sin cambios. El pull inicial sólo obtiene
el cursor; no modifica movimientos. No usar sync push, deletes, account deletion,
billing validate/refresh ni `/sync/debug-counts`.

Se excluye `/billing/entitlements`: su GET puede actualizar la proyección Premium.
**Read-only describe los métodos/efectos financieros del harness, no garantiza
SQL SELECT-only**: `/sync/pull` llama internamente a `init_db` y adquiere lock de
usuario, como la app actual. El harness no llama a init_db en staging ni ejecuta
DDL directamente. Bootstrap y enrollment sí escriben identidad/trust antes de
la carga, sólo de la cuenta QA dedicada.

La app actual no firma cada GET. Los GET sólo llevan `Authorization: Bearer`
con el access token de dispositivo emitido por ScisoNomics; no hay headers
inventados X-Device-* ni nonce por GET. El backend verifica JWT con
`device_authorized=true`, `sub=users.id`, `device_id`, `family_id`, TTL y estado
trusted/no revocado/no comprometido de dispositivo/familia.

Ed25519 firma exclusivamente los challenges de enrollment (purpose=1),
authentication (2) y refresh (3), en el body `proof`. Usa directamente
`app/device_verification.py:build_device_proof_message`, el mismo contrato que
Rust `src/device_verification.rs` y los vectores congelados V1:

| Campo | Bytes |
|---|---:|
| MAGIC `SCISONOMICS-DEVICE-PROOF` | 24 |
| version=1 / purpose | 1 / 1 |
| accountBinding binario / device UUID network order | 32 / 16 |
| SHA-256 public key / challenge UUID / nonce servidor | 32 / 16 / 32 |
| issuedAt / expiresAt uint64 big-endian | 8 / 8 |
| family slot / target slot / requestHash slot | 17 / 17 / 33 |

Total 237 bytes. Slots: flag 0 + relleno cero si ausentes, flag 1 + valor si
presentes. Enrollment/auth sin family/target/hash; refresh incluye family.
Public key raw 32 bytes, SHA-256 raw 32 y firma Ed25519 64 bytes: Base64URL
canónico sin padding. Nonce servidor de 32 bytes, TTL challenge ≤120 s y consumo
atómico de una sola vez; el harness nunca reutiliza un challenge ni lo modifica.
El accountBinding del servidor es propio del users.id, nunca el Supabase sub.

Contratos inspeccionados: `device_sessions.py`, `device_verification.py`,
`main.py:get_current_user`, `deviceAuthorization.ts`, `supabaseCloudAuth.ts`,
`src-tauri/src/device_verification.rs` y `ed25519-proof-v1.json`.

## Variables (sólo nombres)

Alternativa a `--config`: configurar estas variables antes de invocar el harness.
Las variables prevalecen sobre el archivo DPAPI. No reutiliza `.env.local`.

```text
SCISONOMICS_LOADTEST_CONFIG_FILE
SCISONOMICS_LOADTEST_BASE_URL
SCISONOMICS_LOADTEST_SUPABASE_URL
SCISONOMICS_LOADTEST_SUPABASE_PUBLISHABLE_KEY
SCISONOMICS_LOADTEST_QA_EMAIL
SCISONOMICS_LOADTEST_QA_PASSWORD
SCISONOMICS_LOADTEST_QA_CONFIRMED
SCISONOMICS_LOADTEST_STATE_DIR
SCISONOMICS_LOADTEST_OTP
```

OTP es opcional, sólo para setup; se prefiere el prompt oculto. No se modifica el
entorno de Railway ni producción. No se obtienen credenciales desde la app real.

## Resultados y límites

Resumen por etapa/endpoint y JSON opcional: requests, RPS, errores por status,
p50/p90/p95/p99/avg/máximo, timeouts, transporte, tasas 401/403/429/5xx,
VUs solicitados/observados y pico de requests concurrentes. Sólo números y rutas
estáticas; sin URLs con query, owner/email, tokens, keys, firmas, nonce o bodies.
Percentiles por interpolación lineal sobre todas las muestras, incluido errores.
Un JSON ya existente o dentro del repo se rechaza. Exit 0=pass; 2=fallo/aborto.

Modelo: un solo usuario QA, dispositivo y familia compartidos por hasta 50 VUs;
**no equivale a 50 usuarios independientes**. `/sync/pull` serializa mediante
lock por usuario y repite init_db; mide ese hot path y su contención. No prueba
login/OTP, refresh concurrente, writes, payloads grandes ni terceros de billing.
Closed-loop + think time reduce tasa cuando sube latencia; no es llegada constante.
Timeout HTTPX por operación 10 s, deadline de lectura 10 s comprobado entre chunks
y límite 2 MiB; una operación bloqueada puede tardar hasta el siguiente timeout.
Si la sesión/dispositivo es limitado/revocado, se reporta y aborta sin rotar
identidad, repartir sesiones, falsificar IPs ni desactivar defensas.

## Validar sin staging y mantener fuera de Git

```powershell
.\modern_app\cloud_backend\.venv\Scripts\python.exe -m unittest discover -s tools/loadtest -p test_loadtest.py -v
```

Tests: vectores Rust/Python, DPAPI con material sintético, destino/rol/path seguros,
percentiles/aborto/max50, y enrollment/replay/GETs reales contra FastAPI + SQLite
temporales con Supabase/mail simulados. No hacen requests a staging.

No hacer `git add tools/loadtest`. Para ocultar esta carpeta local sin cambiar
`.gitignore` compartido, agregá manualmente `/tools/loadtest/` a `.git/info/exclude`.
La herramienta es descartable; sus secretos/resultados permanecen fuera del repo.
Revoke el dispositivo QA desde el flujo existente de Dispositivos al terminar si
ya no se usará; borrar archivos locales por sí solo no revoca la familia server.

Estado: harness preparado y contratos verificables localmente. El smoke y la
carga reales requieren que el usuario configure primero la cuenta QA y complete
el OTP en su terminal. No se inventan resultados de staging.
