# M10B — Google Play Billing y entitlement único

Estado: implementación técnica validada localmente; prueba real Play pendiente.
Sin commit, push, deploy,
cambios Railway, cambios Play Console ni publicación de AAB.

## Mapa previo y arquitectura

Windows mantiene Mercado Pago y su checkout externo. `billing_subscriptions` ya
tenía `provider`, evidencia de pago y `paid_until`; `users` contiene la proyección
que consume `/billing/entitlements`. El backend emite una licencia RSA existente,
ligada a `users.id`, con vencimiento máximo de 24 horas. M10A separa suscripciones
archivadas de usuarios y minimiza logs de seguridad.

La proyección MP anterior era exclusiva y protegía Premium manual directamente en
`users`. Ahora `billing_entitlements.project()` es el único cálculo de esa
proyección. Conserva evidencia por proveedor y elige el mayor período válido:

- MP: período pagado verificado futuro, incluso si se canceló la renovación.
- Google: active, canceled o grace, expiry futuro y acknowledgement confirmado.
- Manual: active/trialing y período válido; sin expiry es un grant indefinido.
- Otros proveedores no conceden nada hasta implementar su validador. El modelo
  admite Apple posteriormente sin instalar StoreKit en esta fase.

Los grants manuales históricos se adoptan idempotentemente antes de modificar la
proyección. Se conserva su expiry original y su source nullable histórico. Un
admin que quita un grant manual no borra pagos válidos de otros proveedores.
No se migra Mercado Pago a Google ni se cambian owners financieros.

## Android

Plugin propio Tauri, limitado por `cfg(target_os="android")` y capability Android.
SDK oficial [Billing Library 9.1.0](https://developer.android.com/google/play/billing/release-notes).
Usa ProductDetails, queryPurchasesAsync, pending purchases, auto reconnect y un
BillingClient por activity. Las compras simultáneas se bloquean y los callbacks se
descartan después de destruir el cliente. Lifecycle requery detecta compras al
volver a foreground y al conectar inicialmente. Tests Kotlin no requieren tienda.

Producto default: `scisonomics_premium_monthly`; base plan default: `monthly`.
Precio, moneda y offer token provienen de Play. Se muestra la oferta base P1M;
no se presenta un precio hardcodeado ni un trial implícito.

Package release observado: `com.scisoftware.scisonomics`.
Debug: `com.scisoftware.scisonomics.debug`. Windows conserva su identifier global.
Proyecto generado observado: minSdk 24, compileSdk 36, targetSdk 36. No se editan
manualmente archivos regenerables ni se cambia applicationId/version.
API 36 satisface el [requisito vigente de Play para nuevas apps/updates en 2026](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en-GB);
la revisión completa de publicación sigue en M10C.

Una instalación debug no coincide con el package release del backend por default.
No debe fingir una compra release. Pruebas de tienda requieren el artefacto y
package publicados en internal testing.

## Compra, restore y ownership

1. Sesión ScisoNomics válida y autorización de dispositivo según el modo vigente.
2. GET `/billing/google-play/context`: package, productos/base plans permitidos y
   obfuscatedAccountId HMAC SHA-256 derivado por servidor del users.id interno.
3. El servidor registra el hash de ese binding. Google nunca recibe el users.id
   crudo. El SDK abre Play con ese obfuscatedAccountId y un offer token consultado.
4. Purchase updates no activan Premium. Pending se informa sin conceder acceso.
5. POST `/billing/google-play/validate` recibe sólo purchaseToken, productId y
   packageName. El backend deriva usuario desde la sesión, no acepta user_id,
   precios, timestamps ni estados de cliente.
6. Se consulta [purchases.subscriptionsv2.get](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2).
   La URL usa únicamente el package configurado; Google verifica el token dentro
   de ese package. Se exige producto/base plan permitido y binding correcto.
7. Se persiste evidencia verificada con token cifrado; todavía no se concede
   nuevo acceso si falta acknowledgement.
8. El backend usa [subscriptions.acknowledge](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions/acknowledge)
   y vuelve a consultar Google. Sólo entonces proyecta Premium. No hay comando
   Android para acknowledge. Una respuesta perdida se recupera reconsultando;
   un fallo no habilita Premium local. Renovaciones ya acknowledged no se repiten.
9. El frontend refresca el entitlement común y Android verifica su firma RSA.

Para resuscripciones fuera de la app, el acknowledgement envía el HMAC verificado
en `externalAccountIds.obfuscatedAccountId`, según la API oficial. Google elimina
`outOfAppPurchaseContext` después de acknowledge; un token ya verificado conserva
su binding persistido. Una identidad que Google sí devuelve siempre debe coincidir,
y un token desconocido sin identidad Google nunca se reclama.

Se eligió persistir validación → acknowledge confirmado → proyectar nuevo acceso,
para no habilitar Premium cuando no pudo confirmarse la operación. Un pago ya
realizado se recupera mediante Restore, RTDN o reconciliación del operador.

Restore consulta compras Play, valida cada token y reconcilia registros backend
aunque el SDK ya no devuelva un token expirado. Un token sólo tiene un owner
ScisoNomics. Otra cuenta recibe conflicto, no un traslado de compra. El teléfono
puede usar una cuenta Google distinta del email ScisoNomics: el vínculo lo define
la cuenta ScisoNomics activa al comprar, no el email del pagador.

El vínculo también permite que RTDN llegue antes que la validación del cliente:
se obtiene el binding desde Google API y se busca su registro server-side. No se
infiere usuario desde campos de la notificación. Sin un vínculo registrado no se
concede acceso. Resubscriptions externas pueden usar expiredPurchaseToken y sus
identificadores oficiales, únicamente cuando el token anterior está registrado.
Linked tokens deben pertenecer al mismo binding. Reemplazos completados marcan
el anterior superseded; pending/canceled-pending no invalidan el período anterior.

## Estados

| Estado Google verificado | Acceso Google |
| --- | --- |
| ACTIVE | Hasta expiry futuro y ack confirmado |
| CANCELED | Conserva período futuro; no implica renovación |
| IN_GRACE_PERIOD | Hasta expiry verificado extendido por Google |
| ON_HOLD / PAUSED | No concede acceso |
| EXPIRED / revocado | No concede acceso, incluso con una fecha futura inconsistente |
| PENDING / PENDING_PURCHASE_CANCELED | No concede nuevo acceso ni se acknowledge |
| Respuesta desconocida/malformada | Error; no nuevo grant |

El [lifecycle oficial](https://developer.android.com/google/play/billing/lifecycle/subscriptions)
define grace/hold. Refund sin revocación no implica necesariamente quitar acceso;
se usa el estado actual de Google, no una heurística del payload. Una revocación
confirmada elimina la contribución Google, pero no un período válido MP/manual.

## DB y concurrencia

Migración idempotente SQLite + PostgreSQL aplicada por `init_db`, con columnas y
tablas aditivas y sustitución del índice de intentos abiertos:

- Nuevas columnas billing: package_name, product_id, purchase_token_hash,
  purchase_token_ciphertext, account_binding, auto_renew, acknowledged, superseded,
  provider_state, last_rtdn_event_ms y provider_order_id.
- Índice único parcial de purchase_token_hash.
- Sustitución del índice legacy de intentos abiertos: primero se
  crea `idx_billing_mp_one_open_per_user` con el mismo límite para Mercado Pago y
  después se retira `idx_billing_one_open_per_user`. El índice anterior también
  bloqueaba tokens Google distintos al existir historial paused/pending. No se
  borran filas/columnas; el límite MP queda protegido antes de retirar el anterior.
- `google_play_reconciliation_locks`: hash, generación, watermark de evento y
  updated_at. No guarda tokens ni permite restaurar una cuenta.
- `google_play_account_bindings`: hash de binding, user_id nullable y referencia
  pseudónima de cierre. FK nueva de billing; no cambian FKs financieras existentes.

No se guarda payload Google completo, datos de tarjeta ni credenciales en DB.
El purchase token se cifra AES-256-GCM con nonce aleatorio y AAD package/product/hash.
Se conserva para validación/reconciliación real, también en el archivo comercial.
No se incluye en respuestas API ni se persiste en storage JS.

Una generación CAS descarta respuestas HTTP anteriores. El watermark de RTDN se
reserva antes del request a Google; eventos viejos no invalidan uno nuevo en vuelo.
La notificación no define expiry/plan. Locks siguen user → lease → billing; Google
I/O ocurre fuera de la transacción. La primera validación no reserva ownership antes
de verificar con Google, para evitar bloquear compras de otra cuenta. Un primer
claim autenticado verifica ownership antes de reservar la generación; luego
consulta de nuevo dentro de su generación. Un intento inválido de otra cuenta
no invalida la primera verificación legítima en vuelo.

## RTDN y reconciliación

POST `/billing/google-play/rtdn` verifica OIDC Google, audience exacta, email de la
service account verificado y subscription Pub/Sub esperada. HTTPS, body limitado,
rate limiting y errores sanitizados. Todo evento vuelve a consultar Google; no
existe endpoint de entitlement basado únicamente en una notificación.

La configuración de [push autenticado Pub/Sub](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)
requiere IAM del publicador Google Play y una identidad de push dedicada. Configurar
ack deadline suficiente para reconsulta/ack del proveedor, por ejemplo 60 segundos.
Timeout/5xx no se acknowledge al broker como éxito; Pub/Sub puede reintentar.

Herramienta exclusivamente server-side, con las mismas credenciales:

```text
python -m modern_app.cloud_backend.app.reconcile_google_play --subscription-id <id-local-billing>
python -m modern_app.cloud_backend.app.reconcile_google_play --all
```

Configurar un cron/worker real, por ejemplo cada 15 minutos, además de RTDN. La
herramienta no es un scheduler desplegado automáticamente. Sin topic/push/job
configurados, refunds no son instantáneos; la app reconcilia en foreground/restore
y la proyección expira al finalizar el período. No se afirma que haya RTDN real
funcionando sin completar Play Console y Pub/Sub.

## Cuenta eliminada, multi-device y offline

M10A pone user_id=NULL en bindings y conserva sólo referencia de cierre. Compras
conocidas y compras en vuelo reconocibles se actualizan sólo en el archivo comercial.
RTDN/reconcile nunca crea users ni concede Premium a un owner eliminado.
Eliminar ScisoNomics no cancela Google Play; la UI lo advierte.
No se ejecutan cancel/refund/revoke administrativos desde la app.

Administrar suscripción abre el [enlace oficial Google](https://developer.android.com/google/play/billing/subscriptions#deep-link)
con sku y package obtenidos del producto/instalación. No se construye a partir de
un provider_subscription_id ni se usa checkout Mercado Pago en Android.

Windows obtiene el mismo entitlement Premium desde backend sin SDK Google y sin
purchase tokens. Se conserva firma/clave pública RSA Windows. Android usa esa misma
clave, verifica user_id, tipo/algoritmo, flags y exp de la licencia antes de usarla.
Sólo guarda el token firmado; no confía en flags editables de localStorage.
El wakeup de expiración sigue el exp firmado, sin polling ni extenderlo offline.
Compra/restore requieren red. Offline sólo se mantiene un grant previamente firmado
y todavía válido; revocación remota se observa al contactar backend o al vencerlo.

Las funciones básicas/locales siguen disponibles. Módulos Premium antes habilitados
como desarrollo ahora requieren entitlement válido; sus datos físicos no se borran.
La navegación conserva drawer y rutas. Cambios de cuenta invalidan callbacks/
catálogos anteriores antes de abrir checkout o aplicar respuesta.

El shell mantiene un único listener Play por owner en todas las rutas, no sólo
en Configuración. Inicio/restauración de sesión y foreground reconsultan compras
y backend; restores simultáneos se coalescen. La pantalla Premium observa los
eventos comunes de entitlement sin registrar un segundo listener nativo. Si
Play no está configurado o no hay red, se carga sólo la licencia común verificable
y vigente; no se concede acceso por resultados locales del SDK.

## Variables server-side

| Variable | Uso |
| --- | --- |
| SCISONOMICS_GOOGLE_PLAY_PACKAGE_NAME | Package exacto; default com.scisoftware.scisonomics |
| SCISONOMICS_GOOGLE_PLAY_PRODUCT_IDS | CSV allowlist; default scisonomics_premium_monthly |
| SCISONOMICS_GOOGLE_PLAY_BASE_PLAN_IDS | CSV allowlist; default monthly |
| SCISONOMICS_GOOGLE_PLAY_SERVICE_ACCOUNT_FILE | Ruta privada JSON service_account; sólo backend |
| SCISONOMICS_GOOGLE_PLAY_BINDING_SECRET | Secreto fuerte persistente, al menos 32 bytes |
| SCISONOMICS_GOOGLE_PLAY_TOKEN_ENCRYPTION_KEY | Base64url de 32 bytes aleatorios; guardar con respaldo seguro |
| SCISONOMICS_GOOGLE_PLAY_RTDN_AUDIENCE | URL HTTPS exacta del endpoint de push |
| SCISONOMICS_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL | Identidad de push autorizada |
| SCISONOMICS_GOOGLE_PLAY_RTDN_SUBSCRIPTION | projects/…/subscriptions/… exacta |

Reutiliza configuración de sesiones/device trust y SCISONOMICS_ENTITLEMENTS_PRIVATE_KEY
existente. La clave de firma debe corresponder al public key pin de los clientes;
no usar una clave QA distinta para afirmar Premium offline real.
Google Auth oficial está fijado a 2.61.0; OAuth scope androidpublisher. El archivo
JSON debe tener type=service_account, token_uri=https://oauth2.googleapis.com/token,
client_email de la SA y private_key. No incluirlo en repo, recursos Tauri ni frontend.
No hay nueva variable NEXT_PUBLIC para credenciales o secretos.
Rotación AES exige recifrar registros; no reemplazar la clave perdiendo acceso al
archivo. Mantener estable el binding secret; vínculos existentes conservan evidencia
de bindings anteriores, pero no se migra automáticamente configuración comercial.

## Checklist manual Play Console / staging

1. Registrar/verificar cuenta desarrollador y app del package release exacto.
2. Configurar Play App Signing y firmar un release AAB con versionCode válido para
   internal testing. No publicar el package .debug como si fuera el release.
3. Crear subscription scisonomics_premium_monthly y base plan monthly auto-renewing
   P1M, activar disponibilidad/precios. Si IDs difieren, actualizar allowlists backend.
4. Agregar license testers y usuarios al internal track; instalar desde su enlace
   Play con la cuenta Google de test apropiada.
5. Habilitar Android Publisher API y dar a una SA acceso mínimo a esta app para
   consultar/gestionar subscriptions/orders y acknowledgement. Guardar JSON sólo
   en el servidor staging y configurar los secretos, signer y device enforcement.
6. Crear topic RTDN; conceder publicación a
   `google-play-developer-notifications@system.gserviceaccount.com`.
   Configurar push autenticado, audience/SA/subscription
   exactos y conectar el topic en Monetization setup. Enviar test notification.
7. Configurar job de reconciliación y observabilidad sólo de códigos/status, sin
   URLs de requests Google (contienen token), payloads, tokens ni credenciales.
8. Con cuenta ScisoNomics exclusiva: comprobar precio real, compra test, API V2,
   ack, Premium Android y actualización Windows del mismo owner.
9. Probar pending, cancelar dialog, restore después de reinicio, compra desde otro
   owner rechazada y respuesta tardía tras account switch ignorada.
10. Probar renovaciones aceleradas, canceled con período vigente, expiry, grace,
    hold/recovery, refund sin revoke y revoke. Confirmar RTDN + API + proyección.
11. Probar combinación MP/manual + Google sin perder períodos válidos, y eliminación
    de una cuenta exclusiva sin cancelar la suscripción ni recrearla por RTDN.
12. Verificar offline con licencia válida/caducada y tampering; sin nuevas compras
    ni restauración offline.

No se encontró evidencia de internal track/producto/credenciales en este entorno.

Detalle de configuración manual (sin ejecutar en esta tarea):

- En Google Cloud habilitar `androidpublisher.googleapis.com`. En Play Console,
  Usuarios y permisos, invitar el email de la SA del backend con acceso a la app
  release y los permisos de consulta financiera/pedidos y gestión de pedidos y
  suscripciones necesarios para lectura y acknowledge. No otorgar Owner/Editor
  general del proyecto ni enviar el JSON al dispositivo.
- En el topic RTDN otorgar `roles/pubsub.publisher` al publicador Google Play.
  Crear una identidad push dedicada. El agente
  `service-<PROJECT_NUMBER>@gcp-sa-pubsub.iam.gserviceaccount.com` necesita
  `roles/iam.serviceAccountTokenCreator` sobre esa identidad; quien configura el
  push necesita permiso de uso de esa SA. Configurar push HTTPS autenticado hacia
  `/billing/google-play/rtdn`, audience exacta de esa URL y subscription completa.
- El backend staging necesita la migración aditiva y las nueve variables listadas,
  además del signer RSA existente que corresponda al pin de clientes y device
  enforcement. Configurar el job de reconciliación, validar test RTDN y después
  probar con un usuario ScisoNomics exclusivo instalado desde internal testing.
- La matriz real debe verificar API/ack y Premium en Android y Windows con el
  mismo users.id; pending, restore, renovación, cancelación/expiry, grace/hold,
  refund/revoke, cuenta distinta y eliminación sin recreación por RTDN.

No se realizó ni se inventa una compra real. Validación local: build Android,
tests Kotlin/bridge, mocks estrictos del proveedor, SQLite y PostgreSQL temporal.
Resultados locales finales: regresión backend 159 tests OK, incluidos 29 Google
Play (eliminación concurrente, resuscripción fuera de app e índice legacy);
PostgreSQL aislado 4 tests OK; frontend billing 70, auth 102 y mobile 176 OK.
Build/export Next OK. Rust Windows 1.88.0 check/test --locked OK, 13 tests.
Android: build Tauri debug x86_64 y APK/AAB locales, Gradle compile/assemble OK,
3 tests Kotlin OK. El APK conserva 3.3.1, package `.debug`, target/compile API 36
y permiso BILLING. No se instalaron ni subieron artefactos de esta tarea.
Compileall, YAML, JSON/TOML, UTF-8 sin BOM y git diff --check OK.
La clave RSA pública existente, configuración Windows, updater, versiones y
dependencias JS permanecen iguales. Los resultados son pruebas locales y mocks,
no evidencia de compra/renovación/RTDN con Google real.

Decisiones legales/comerciales de plazos, reembolsos, disputes y solicitudes de
soporte siguen requiriendo revisión externa. No se fijan nuevas políticas aquí.

## Inventario M10B

Archivos modificados (20):

`	ext
.github/workflows/security.yml
SECURITY.md
docs/STORE_LEGAL_ROADMAP.md
modern_app/cloud_backend/MERCADOPAGO_BILLING.md
modern_app/cloud_backend/app/account_deletion.py
modern_app/cloud_backend/app/billing_subscriptions.py
modern_app/cloud_backend/app/db.py
modern_app/cloud_backend/app/main.py
modern_app/cloud_backend/requirements.txt
modern_app/cloud_backend/test_mercadopago_billing.py
modern_app/frontend/components/account/AccountDeletionDialog.tsx
modern_app/frontend/components/mobile/MobileApp.tsx
modern_app/frontend/components/mobile/configuracion/MobileSettings.tsx
modern_app/frontend/package.json
modern_app/frontend/services/entitlements.ts
modern_app/frontend/src-tauri/Cargo.lock
modern_app/frontend/src-tauri/Cargo.toml
modern_app/frontend/src-tauri/src/lib.rs
modern_app/frontend/src-tauri/tauri.android.dev.conf.json
modern_app/frontend/tests/mobileUi.test.cjs
`

Archivos nuevos (34, incluidos permisos generados del plugin):

`	ext
docs/GOOGLE_PLAY_BILLING.md
modern_app/cloud_backend/app/billing_entitlements.py
modern_app/cloud_backend/app/google_play_api.py
modern_app/cloud_backend/app/google_play_billing.py
modern_app/cloud_backend/app/reconcile_google_play.py
modern_app/cloud_backend/test_google_play_billing.py
modern_app/cloud_backend/test_google_play_postgres.py
modern_app/frontend/components/mobile/billing/MobilePremium.tsx
modern_app/frontend/components/mobile/useMobilePremium.ts
modern_app/frontend/services/entitlementPublicKey.ts
modern_app/frontend/services/googlePlayBilling.ts
modern_app/frontend/services/signedEntitlements.ts
modern_app/frontend/src-tauri/capabilities/mobile-billing.json
modern_app/frontend/src-tauri/plugins/google-play-billing/.gitignore
modern_app/frontend/src-tauri/plugins/google-play-billing/Cargo.toml
modern_app/frontend/src-tauri/plugins/google-play-billing/android/build.gradle.kts
modern_app/frontend/src-tauri/plugins/google-play-billing/android/src/main/AndroidManifest.xml
modern_app/frontend/src-tauri/plugins/google-play-billing/android/src/main/java/com/scisoftware/billing/BillingGate.kt
modern_app/frontend/src-tauri/plugins/google-play-billing/android/src/main/java/com/scisoftware/billing/GooglePlayBillingPlugin.kt
modern_app/frontend/src-tauri/plugins/google-play-billing/android/src/test/java/com/scisoftware/billing/BillingGateTest.kt
modern_app/frontend/src-tauri/plugins/google-play-billing/build.rs
modern_app/frontend/src-tauri/plugins/google-play-billing/permissions/autogenerated/commands/manage_subscription.toml
modern_app/frontend/src-tauri/plugins/google-play-billing/permissions/autogenerated/commands/purchase.toml
modern_app/frontend/src-tauri/plugins/google-play-billing/permissions/autogenerated/commands/query_products.toml
modern_app/frontend/src-tauri/plugins/google-play-billing/permissions/autogenerated/commands/query_purchases.toml
modern_app/frontend/src-tauri/plugins/google-play-billing/permissions/autogenerated/commands/registerListener.toml
modern_app/frontend/src-tauri/plugins/google-play-billing/permissions/autogenerated/commands/remove_listener.toml
modern_app/frontend/src-tauri/plugins/google-play-billing/permissions/autogenerated/reference.md
modern_app/frontend/src-tauri/plugins/google-play-billing/permissions/schemas/schema.json
modern_app/frontend/src-tauri/plugins/google-play-billing/src/lib.rs
modern_app/frontend/tests/googlePlayBilling.test.cjs
modern_app/frontend/tests/mobileEntitlementCache.test.cjs
modern_app/frontend/tests/mobilePremiumLifecycle.test.cjs
modern_app/frontend/tests/signedEntitlements.test.cjs
`

Git diff --stat sobre archivos ya trackeados: 20 files changed, 209 insertions(+), 56 deletions(-). Los nuevos quedan sin trackear; no se hizo staging ni commit.
