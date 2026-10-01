# Premium con checkout externo de Mercado Pago

## Arquitectura implementada

El alta utiliza **suscripciones sin plan asociado con pago pendiente**. La [guía oficial de pago pendiente](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/integration-configuration/subscription-no-associated-plan/pending-payments) documenta `POST /preapproval` con `status=pending` y la posibilidad de compartir el enlace para completar el medio de pago en Mercado Pago. La [referencia de creación](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/create-preapproval/post) describe `external_reference` e `init_point`.

Este flujo preserva atribución individual: antes de contactar al proveedor se guarda un intento local con UUID y `external_reference=scisonomics:{users.id}:{local_subscription_id}`. La referencia se envía al crear el recurso remoto y su respuesta debe coincidir exactamente. El checkout usa `preapproval_id` individual. No depende de una referencia compartida de plan, del email devuelto, ni del retorno para resolver ownership.

1. El usuario toca **Continuar con Mercado Pago**.
2. `POST /billing/subscription` autentica, comprueba Premium manual y evita intentos abiertos duplicados. Guarda primero el intento local `creating` y confirma atómicamente su paso a `uncertain` antes del POST remoto.
3. El backend envía `POST /preapproval` con `reason`, referencia individual, `payer_email`, recurrencia mensual (`frequency=1`, `frequency_type=months`, monto configurado, ARS), `back_url` y `status=pending`. No envía token de tarjeta ni ID de plan.
4. Verifica ID, referencia, estado `pending`, monto/moneda, ausencia de plan y pagador si el proveedor devuelve un email no vacío. Valida el `init_point` HTTPS, dominio exacto permitido, ruta `/subscriptions/checkout` y `preapproval_id` coincidente. Guarda ID remoto, URL, estado y fecha de sincronización.
5. Tauri abre el navegador mediante `plugin-opener`. En web se reserva una pestaña desde el click, se elimina `opener` y luego se navega al enlace validado; si el navegador bloquea la pestaña, se navega en la pestaña actual. ScisoNomics no carga formularios ni SDK de tarjetas.
6. El usuario elige entre los medios disponibles en el checkout de Mercado Pago. La app no agrega restricciones a marcas de tarjetas.
7. Webhook firmado o **Verificar estado** consulta los recursos reales. Al volver a enfocar la app se verifica el estado y luego los entitlements, sin polling y con exclusión de solicitudes simultáneas y respuestas de otra cuenta.
8. Premium se concede únicamente con cuota aprobada verificada, importe/moneda correctos y vigencia válida. La autorización sola o volver del checkout no concede Premium.

## Configuración

Backend cloud:

- `SCISONOMICS_MERCADOPAGO_ACCESS_TOKEN`: credencial privada de la aplicación vendedora; nunca en frontend.
- `SCISONOMICS_MERCADOPAGO_MONTHLY_AMOUNT_ARS`: precio mensual fijo positivo, con hasta dos decimales. La UI recibe el precio del backend.
- `SCISONOMICS_MERCADOPAGO_WEBHOOK_SECRET`: secreto de Webhooks de esa aplicación.
- `SCISONOMICS_PUBLIC_API_URL`: origen HTTPS público del backend. El retorno es `<origen>/billing/return`.
- `SCISONOMICS_MERCADOPAGO_TEST_PAYER_EMAIL`: comprador TEST obligatorio cuando el Access Token comienza con `TEST-`. El backend valida el formato antes de crear el intento. Con credenciales de producción utiliza el email real interno y no usa esta sustitución.

No se necesita Public Key en el frontend ni `SCISONOMICS_MERCADOPAGO_PREAPPROVAL_PLAN_ID`. No crear planes para este flujo. No se modificaron archivos privados de entorno ni variables de Railway durante la implementación.

Registrar `<origen>/billing/webhooks/mercadopago` en **Tus integraciones → Webhooks**, con `subscription_preapproval` y `subscription_authorized_payment`. La [documentación de Webhooks](https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks) explica la firma. Mantener la clave de la misma aplicación que las credenciales.

`/billing/return` solo indica: **Volvé a ScisoNomics. Estamos verificando tu pago.** No acepta identificadores o estados de query como evidencia de pago y no modifica entitlements. No se agregó un deep link de billing.

## Reconciliación, pagos y estados

El webhook valida HMAC de `x-signature`, ID de URL/body y consulta preapproval/factura. La fila se localiza por ID remoto verificado o referencia individual exacta; una referencia contradictoria se rechaza. Los eventos se deduplican y auditan. La notificación de preapproval también busca cuotas, para recuperar aprobaciones si no llegó su notificación específica.

La búsqueda `/authorized_payments/search` distingue la última cuota de la última cuota aprobada. Los datos públicos del cobro se limitan al estado conocido y `cc_rejected_high_risk` cuando corresponde; no se devuelven cuerpos del proveedor. La fecha del último cobro impide que un evento más antiguo reemplace su resultado visible.

- `pending`: **Completá el pago en Mercado Pago.** Se puede reabrir el checkout existente sin crear otro recurso.
- `authorized` sin cuota aprobada: **Suscripción autorizada. Esperando confirmación del cobro.**
- Cuota `approved` y entitlement vigente: **Premium activado.** Se conserva `users.id`, se establece `paid_until` desde `next_payment_date` coherente con `debit_date`, y se actualizan plan, vigencia y `billing_source=mercadopago`.
- Cuota `rejected`: mensaje para probar otro medio. `cc_rejected_high_risk`: mensaje de validación de seguridad del proveedor. Ninguno concede Premium.
- `paused` o `canceled`: no concede un nuevo período. `cancelled` se normaliza a `canceled`. Cancelar detiene la renovación y conserva un período ya pagado hasta su vencimiento.
- `uncertain`: no permite otro intento automático. Ofrece verificar el estado; si el ID remoto todavía falta, requiere recuperación por webhook o revisión manual.

Premium manual vigente bloquea alta para evitar cobros redundantes y tiene prioridad sobre reconciliaciones. El esquema agrega idempotentemente `payment_status`, `payment_status_detail` y `last_payment_at` a `billing_subscriptions`, tanto en SQLite como PostgreSQL. Son columnas nullable de resultado del cobro, sin datos de tarjeta. No modifica IDs, claves financieras o datos históricos.

## Histórico y recuperación

Se eliminó CardForm, sus estilos, la carga del SDK, sus permisos CSP y el endpoint de autorización por token. No había otros consumidores en el repo. Los instaladores antiguos que usen ese endpoint deben actualizarse; no se mantiene ese flujo de alta.

Se mantienen lectura, refresh, cancelación y reconciliación de suscripciones remotas anteriores (`pending`, `authorized`, `uncertain`, `canceled` y filas con plan histórico). Un intento CardForm `creating` sin ID remoto y sin plan puede completar el alta externa reutilizando su ID, precio y referencia originales. No se borran filas históricas.

Un timeout o respuesta inválida después del POST deja `uncertain`: el proveedor pudo haber creado una suscripción. El webhook puede recuperar la fila por referencia aun si no se guardó su ID remoto. Si el webhook falta, verificar la suscripción en Mercado Pago por referencia y realizar una reconciliación administrativa controlada; no resetear a `creating` ni repetir el POST antes de descartar un recurso remoto. No existe recuperación automática por email.

## Validación manual pendiente

1. Configurar credenciales, precio, comprador TEST y los dos tópicos de Webhooks en el entorno de prueba; no se hizo durante esta tarea.
2. Desplegar backend compatible y actualizar el instalador. Verificar health/ready y las columnas aditivas.
3. Probar con una cuenta Free separada: abrir checkout desde Windows y navegador, completar el pago y comprobar referencia individual, ID interno, cuota aprobada, `paid_until` y Premium.
4. Verificar que volver al checkout sin pagar mantiene Free; probar rechazos y high risk, refresh, regreso a la app, cambio de cuenta y cancelación.
5. Probar dos cuentas con intentos simultáneos y un timeout: no debe existir un segundo POST para el mismo intento, ni mezcla de owners. Confirmar recuperación por webhook.
6. No publicar un release hasta comprobar el checkout real en el entorno del proveedor. Las pruebas automatizadas usan SQLite temporal y respuestas simuladas; no ejercen medios de pago reales ni Railway.
