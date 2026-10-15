# Store & Legal Roadmap — ScisoNomics

Última actualización: 07/10/2026

Este documento conserva decisiones de producto, privacidad y publicación para que
el release mobile, la web pública y las declaraciones de las tiendas se mantengan
alineadas. No reemplaza asesoramiento jurídico, contable ni fiscal.

## Estado de plataformas y billing

- Windows: suscripción Premium mediante Mercado Pago.
- Android: objetivo de publicación en Google Play con Google Play Billing.
- iOS/iPadOS: previsto para una etapa posterior, con compras mediante Apple/StoreKit.
- El backend debe mantener un único entitlement Premium independiente del proveedor.
- La eliminación de la cuenta ScisoNomics no cancela automáticamente una suscripción
  administrada por Mercado Pago, Google Play o Apple; el usuario debe gestionar la
  renovación/cancelación también en el proveedor correspondiente.

## Público objetivo

- Google Play v1: 18+.
- ScisoNomics no se posiciona como producto dirigido a niños o adolescentes.

## Posicionamiento financiero

Declarar ScisoNomics como aplicación de gestión de finanzas personales / presupuesto.

No presentarla como:
- banco;
- prestamista;
- broker;
- exchange/servicio crypto;
- asesor financiero profesional.

ScisoNomics registra, organiza, sincroniza, visualiza y analiza información financiera
personal ingresada por el usuario.

## Privacidad y monetización de datos

- No vender datos personales ni financieros identificables.
- No compartir historiales individuales de gasto con terceros para fines comerciales.
- Puede evaluarse en el futuro la generación de estadísticas o inteligencia de mercado
  únicamente con información agregada y verdaderamente anonimizada, sin posibilidad
  razonable de reidentificar personas.
- Si el modelo cambia hacia un uso comercial adicional de datos personales, antes de
  activarlo deberán revisarse política de privacidad, consentimiento, Data Safety,
  App Store Privacy y normativa aplicable.

Texto conceptual aprobado:

> ScisoNomics no vende datos personales ni financieros identificables de sus usuarios.
> ScisoNomics podrá utilizar información agregada y anonimizada, que no permita
> identificar razonablemente a personas individuales, para elaborar estadísticas,
> analizar tendencias, investigación o inteligencia de mercado.

## Retención operativa

- Datos de cuenta y financieros cloud: eliminar con el cierre de cuenta, salvo
  retención limitada y legítima.
- Sesiones, refresh tokens, trusted devices y challenges asociados: revocar/eliminar
  como parte del cierre.
- Logs técnicos ordinarios: hasta 90 días.
- Security audit: hasta 180 días, salvo incidente abierto o necesidad legal.
- Futuros backups cloud operados por ScisoNomics: objetivo de purga máximo 30 días
  después de eliminación.
- Billing/comercial: conservar sólo lo necesario para pagos, reembolsos, disputas,
  fraude o cumplimiento legal; plazos fiscales concretos requieren validación
  contable/profesional.
- Datos SQLite, backups y exportaciones locales: no se borran automáticamente al
  eliminar la cuenta cloud.

## Eliminación de cuenta

M10A implementa:
- flujo in-app Android y Windows;
- sesión válida + dispositivo trusted;
- OTP específico;
- confirmación `ELIMINAR`;
- firma Ed25519 nativa;
- borrado interno transaccional;
- revocación de dispositivos/sesiones;
- conservación de owners locales y caché física account-owned sin reasignación;
- archivo comercial separado;
- minimización/pseudonimización de evidencia de seguridad.

Pendiente antes de producción:
- configurar credencial administrativa exclusivamente server-side para completar
  borrado externo de Supabase;
- publicar página web externa de eliminación de cuenta;
- probar el borrado externo real en un entorno seguro.

## Página pública /delete-account

La web pública debe explicar:
- eliminación desde Configuración → Cuenta → Eliminar mi cuenta;
- qué datos cloud se eliminan;
- qué datos locales no se eliminan automáticamente;
- que eliminar la cuenta no cancela suscripciones externas;
- retención limitada de seguridad/billing cuando corresponda;
- solicitud alternativa mediante scisoftwareco@gmail.com para quien no pueda
  acceder a la app;
- verificación de identidad para prevenir eliminaciones no autorizadas;
- enlaces a Privacidad, Términos y Reembolsos/Cancelaciones.

El contrato técnico está en `docs/PUBLIC_ACCOUNT_DELETION_PAGE.md`.

## Cancelación, reembolsos y arrepentimiento

Política conceptual:
- cancelar una suscripción evita futuras renovaciones conforme al proveedor;
- salvo reembolso/revocación/regla distinta, Premium puede mantenerse hasta el fin
  del período ya abonado;
- reembolsos se gestionan según el canal de compra, políticas del proveedor y ley
  aplicable;
- deben respetarse los derechos irrenunciables del consumidor, incluido el derecho
  de arrepentimiento cuando corresponda;
- la web deberá incorporar la solución de baja/arrepentimiento exigible para el
  canal comercial que opere directamente ScisoNomics.

## Google Play — decisiones cerradas

- Público objetivo: 18+.
- Categoría funcional: finanzas personales / presupuesto.
- Premium Android: Google Play Billing.
- Sin publicidad prevista.
- No venta de datos personales/financieros identificables.
- Cuenta/cloud opcional respecto del uso local.
- Account deletion in-app: implementado técnicamente en M10A.
- Account deletion web: pendiente de publicación.
- Data Safety: completar contra el comportamiento final del release.
- Financial Features Declaration: declarar gestión de finanzas personales, no
  servicios bancarios, crédito, brokerage, crypto ni asesoría profesional.
- Target API del release: verificar contra el requisito vigente de Google Play
  antes de generar el AAB.
- Store listing, IARC, App Access, signing, testing tracks y pre-launch report:
  pendientes del bloque de publicación.

## Data Safety — baseline

Datos que pueden salir del dispositivo cuando se usa cuenta/cloud:
- email y datos de cuenta;
- identificador interno;
- información financiera ingresada por el usuario y sincronizada;
- metadata de sync;
- metadata de trusted device;
- datos técnicos de sesión/autenticación;
- OTP/challenges de seguridad;
- estado Premium y referencias limitadas del proveedor de billing;
- logs técnicos/de seguridad cuando corresponda.

Finalidades principales:
- app functionality;
- account management;
- security / fraud prevention / compliance;
- sincronización;
- gestión de suscripción.

No declarar publicidad, marketing, ubicación, contactos, cámara, micrófono, SMS,
salud o biometría salvo que el producto realmente incorpore esas funciones antes
del release.

Supabase, Railway, Resend y los proveedores de billing deben evaluarse conforme a
las definiciones vigentes de Google/Apple para determinar si cada tratamiento es
`collected`, `shared` o encaja como proveedor de servicio.

## Proveedores actualmente documentados

- Supabase: autenticación/identidad.
- Railway: infraestructura backend/cloud.
- Resend: email de verificación y OTP.
- Mercado Pago: billing Windows.
- GitHub: releases/actualizaciones Windows.
- Google Play: distribución Android y, cuando M10B quede implementado, billing Android.
- Apple: futuro; no declarar como funcionalidad activa hasta implementar la versión iOS.

## Pendientes para freeze DNDA / release mobile

Antes del snapshot DNDA definitivo, intentar incluir:
1. M10A cerrado y documentado.
2. Pase legal Windows + Android.
3. Si el tiempo lo permite, M10B Google Play Billing.
4. Verificación de package/applicationId, versionCode/versionName, target/compile/min SDK.
5. Build Android release reproducible.
6. Revisión de secretos y exclusiones del snapshot.
7. Manifest, VERSION, README DNDA, SHA-256 y tag Git del snapshot.

No incluir en el paquete DNDA:
- secretos o archivos `.env`;
- keystores o claves privadas;
- credenciales Supabase/Resend/Mercado Pago;
- bases SQLite con datos personales reales;
- caches/builds temporales;
- `.git`, `node_modules`, `target` y artefactos regenerables innecesarios.

## Pendientes web

- publicar `/delete-account`;
- publicar/actualizar política de reembolsos, cancelaciones y arrepentimiento;
- enlazar esas páginas con Términos y Privacidad existentes;
- mantener textos Windows/Android alineados con el producto real.

## Estado técnico M10B: Google Play Billing

Android integra compras y restauración mediante Google Play Billing, con precio
del catálogo Play y validación server-side. Windows mantiene Mercado Pago.
Premium es un entitlement común: se conserva el mayor período válido verificado
entre proveedores y grants manuales. Eliminar la cuenta no cancela suscripciones;
el usuario debe administrarlas en el proveedor correspondiente.

La implementación local incluye RTDN autenticado y archivo comercial tras borrar
la cuenta. Falta configurar Play Console, internal testing, license testers,
credenciales server-side, Pub/Sub y reconciliación programada en staging para
validar compra, renovación, cancelación y revocación reales. No hubo publicación,
deploy ni cambios en producción. No se modifican aquí plazos o políticas legales.
Ver [arquitectura, configuración y checklist M10B](GOOGLE_PLAY_BILLING.md).

## Pendientes profesionales

Validar con asesoría jurídica/contable cuando corresponda:
- obligaciones fiscales y documentación de suscripciones;
- plazos legales específicos de conservación comercial;
- domicilio/legal identity pública requerida;
- wording final de consumidor, arrepentimiento y jurisdicción;
- obligaciones adicionales si ScisoNomics amplía países, público objetivo o modelo
  de monetización de datos.
