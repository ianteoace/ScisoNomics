# Premium con Mercado Pago Suscripciones

La app abre el checkout externo de Mercado Pago y el backend crea una suscripción **pendiente sin plan asociado** (`POST /preapproval`). Esta elección conserva un `external_reference` único basado en `users.id` interno sin capturar tarjetas en ScisoNomics. La [guía oficial de suscripciones con plan asociado](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/integration-configuration/subscription-associated-plan) exige `card_token_id` y estado `authorized` al crearlas. La [guía del flujo pendiente sin plan](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/integration-configuration/subscription-no-associated-plan/pending-payments) documenta el checkout externo. No configurar `SCISONOMICS_MERCADOPAGO_PREAPPROVAL_PLAN_ID` para este flujo: no se usa y no debe asumirse que las suscripciones quedan asociadas a un plan.

El cliente desktop queda versionado como `3.3.0` por la nueva capacidad Premium. No publicar el release ni habilitar pagos reales antes de la validación en el entorno de prueba del proveedor.

## Configuración de producción

Variables nuevas del backend cloud:

- `SCISONOMICS_MERCADOPAGO_ACCESS_TOKEN`: credencial privada de la aplicación vendedora. Nunca en frontend/Tauri.
- `SCISONOMICS_MERCADOPAGO_TEST_PAYER_EMAIL`: email de un comprador de prueba de Mercado Pago. Es opcional para producción, pero obligatorio y válido cuando el Access Token empieza con `TEST-`; en ese caso se usa solo como `payer_email` de `/preapproval`. Si falta o es inválido, el backend responde `503 mercadopago_test_payer_not_configured` antes de crear el intento. Con tokens no `TEST-` se usa el email real de la cuenta. No cambia `external_reference` ni `users.id`.
- `SCISONOMICS_MERCADOPAGO_MONTHLY_AMOUNT_ARS`: importe mensual fijo en ARS, por ejemplo `4500.00`. Configurarlo deliberadamente antes de habilitar el CTA.
- `SCISONOMICS_MERCADOPAGO_WEBHOOK_SECRET`: clave secreta de Webhooks de la misma aplicación de Mercado Pago.
- `SCISONOMICS_PUBLIC_API_URL`: origen HTTPS público del backend, por ejemplo `https://scisonomics-production-d8a3.up.railway.app`.

La URL exacta del webhook para ese origen es:

`https://scisonomics-production-d8a3.up.railway.app/billing/webhooks/mercadopago`

En **Tus integraciones → Webhooks**, registrar esa URL y seleccionar `subscription_preapproval` y `subscription_authorized_payment`. Copiar la clave secreta a la variable indicada. No usar IPN: no ofrece la misma firma. El retorno del checkout es `/billing/return` y solo indica volver a la app; no prueba un pago.

El endpoint de creación no acepta precio, plan ni usuario enviados por el cliente. Toma el usuario autenticado y su email de la tabla `users`, inserta primero un intento único y luego solicita la preaprobación. Una respuesta dudosa o timeout deja el intento `uncertain`; el webhook puede reconciliarlo mediante `external_reference`. No se vuelve a crear automáticamente otra suscripción para ese usuario hasta aclarar el intento con el proveedor. La API de `preapproval` no documenta `X-Idempotency-Key` como requisito, por lo que esta protección se aplica en la base propia sin asumir soporte no documentado.

Una cuenta con Premium manual aún vigente recibe `409 already_premium` al intentar contratar, para evitar un cobro duplicado.

El webhook valida `x-signature` con HMAC-SHA256 del manifiesto oficial `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, verifica que el ID del body coincida con el de la URL, consulta el recurso en Mercado Pago y busca el intento interno por `external_reference` exacto. Nunca interpreta un `user_id` del payload. Los eventos procesados se deduplican por ID/tópico. La [documentación oficial de Webhooks](https://www.mercadopago.com.ar/developers/es/docs/prestashop/additional-content/your-integrations/notifications/webhooks) explica la firma y los tópicos.

## Entitlement y cancelación

- `pending`, `paused`, cuotas pendientes o rechazadas: no conceden Premium nuevo.
- `authorized` por sí solo no concede Premium: la [primera cuota puede tardar alrededor de una hora](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/integration-configuration/subscription-no-associated-plan/authorized-payments). Se exige una factura del proveedor con `payment.status=approved` y `next_payment_date` coherente para establecer `paid_until`.
- Una cuota aprobada concede Premium al `users.id` interno hasta `paid_until`.
- Una cancelación (`PUT /preapproval/{id}` con `status=canceled`) detiene la renovación. Si existe un período pagado verificado, se conserva Premium hasta esa fecha; si no, no se concede. El vencimiento se aplica al consultar entitlements o al reconciliar con el proveedor.
- Premium manual histórico (`billing_source` nulo o `manual`) no se revoca por eventos de Mercado Pago. Una asignación administrativa posterior establece `billing_source=manual`.

El esquema es aditivo e idempotente en SQLite y PostgreSQL: `users.billing_source`, `billing_subscriptions` (FK a `users.id`, índice único del ID del proveedor e índice único parcial de intento abierto por usuario) y `billing_webhook_events`. No cambia `users.id`, el sync ni tablas financieras.

## Preparación y validación manual

1. Crear una aplicación de Mercado Pago del vendedor y obtener Access Token y clave secreta de Webhooks. No introducir credenciales reales en pruebas locales ni en el frontend.
2. Definir importe mensual y revisar impuestos, comisiones, moneda y política comercial antes de configurar la variable de producción.
3. Configurar los dos tópicos de webhook y comprobar que la URL pública acepta POST firmado. Desplegar primero el backend y verificar `/health` y `/ready`.
4. Probar con una cuenta separada en el entorno de prueba oficial: crear, abrir `init_point`, autorizar, recibir ambos eventos, comprobar una cuota aprobada, `users.id`, Premium, refresh y cancelación. Confirmar que la API devuelve un `init_point` para la variante sin plan pendiente antes de habilitar el botón a usuarios reales.
5. Publicar el frontend/instalador solo después de la prueba de extremo a extremo. La UI nunca considera el retorno del navegador como pago aprobado.

Si en otra fase se requiere **plan asociado**, habrá que integrar la tokenización de tarjeta admitida por Mercado Pago o confirmar con soporte oficial otro flujo que preserve `external_reference` individual. Crear un plan manualmente en el panel o con `POST /preapproval_plan` no modifica el flujo implementado aquí. No se crea ningún plan automáticamente.
