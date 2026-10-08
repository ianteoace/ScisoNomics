# Contrato pendiente: página pública /delete-account

Texto funcional provisional, sujeto a revisión legal. No hay URL/repo público
confirmado en este proyecto. Este documento no publica ni despliega una página.

La futura página debe ser accesible sin instalar ScisoNomics ni autenticarse para
leer las instrucciones. Debe identificar ScisoNomics y explicar:

- Desde Windows o Android: Configuración → Cuenta → Eliminar mi cuenta, revisar
  consecuencias y completar confirmación por código/firma del dispositivo.
- Se elimina la cuenta activa y sus datos cloud. No se borran automáticamente
  datos locales, backups ni exportaciones; no se transfieren a otro owner.
- Borrar ScisoNomics no cancela una suscripción Mercado Pago.
- La eliminación del acceso externo puede estar pendiente; soporte debe informar
  el estado real, sin prometer que un proveedor ya lo eliminó.
- Registros comerciales/seguridad se separan de la cuenta activa. Alcance/plazos
  definitivos deben aprobarse antes de publicar, sin inventar cifras.

Sin app, ofrecer el contacto de soporte ya publicado: **scisoftwareco@gmail.com**.
El usuario puede solicitar eliminación por ese canal, sin enviar contraseña, OTP,
refresh/access tokens, claves privadas ni datos completos de tarjeta. El soporte
debe verificar identidad y registrar la solicitud; recibir un email no autoriza
automáticamente el borrado. El procedimiento de verificación/gestión manual está
pendiente de aprobación operativa/legal.

No incluir un endpoint anónimo que borre por email/user_id. Si se incorpora una
interfaz web autenticada, necesita un mecanismo de confirmación específico que no
dependa de una clave nativa ausente ni rebaje la seguridad del flujo de la app.
No incluir service role/admin keys en JavaScript, enlaces o parámetros de URL.
