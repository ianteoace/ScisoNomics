# Prueba canonica Ed25519 V1

Estado: propuesta tecnica para aprobacion antes de Fase 1.

## 1. Primitivas y transporte

- Firma: Ed25519 pura segun RFC 8032; no prehash y no contexto Ed25519ph/Ed25519ctx.
- Clave publica: 32 bytes.
- Firma: 64 bytes, con verificacion estricta de longitud y codificacion canonica por la biblioteca criptografica.
- Hash: SHA-256.
- Numeros multibyte: enteros sin signo en big-endian (network byte order).
- Strings de API que representen bytes: Base64URL con alfabeto RFC 4648 URL-safe (`A-Z`, `a-z`, `0-9`, `-`, `_`) y sin padding `=`. El formato firmado contiene los bytes decodificados, nunca el texto Base64URL.
- IDs mostrados como UUID en la API: formato textual canonico minusculo `8-4-4-4-12`; dentro de la firma son sus 16 bytes en orden de red. No se aceptan UUID nil.
- No se firma JSON ni texto concatenado.

La identidad es una clave distinta por cuenta y por instalacion. La clave privada permanece exclusivamente en WinCred/Rust. JavaScript puede recibir la clave publica, su hash y los identificadores publicos, pero nunca la clave privada, un seed ni una funcion de firma arbitraria.

## 2. Mensaje binario exacto

Todo mensaje V1 mide exactamente **237 bytes**. No admite bytes finales, omisiones ni longitudes alternativas.

Los offsets empiezan en cero. Cada fila ocupa el intervalo semiabierto `[offset, offset + largo)`; por ejemplo, `magic` ocupa bytes 0 a 23 inclusive y `request_hash` bytes 205 a 236 inclusive. La suma termina exactamente en offset 237.

| Offset | Largo | Campo | Codificacion y limite |
|---:|---:|---|---|
| 0 | 24 | `magic` | ASCII exacto `SCISONOMICS-DEVICE-PROOF` |
| 24 | 1 | `version` | `0x01` |
| 25 | 1 | `purpose` | enum de la seccion 3 |
| 26 | 32 | `account_binding` | 256 bits aleatorios emitidos por backend; opacos, exactos |
| 58 | 16 | `device_id` | 128 bits aleatorios generados por Tauri; no UUID nil |
| 74 | 32 | `public_key_hash` | `SHA-256(public_key_raw_32)` |
| 106 | 16 | `challenge_id` | UUID aleatorio emitido por backend; no UUID nil |
| 122 | 32 | `nonce` | 32 bytes generados por CSPRNG y emitidos por backend |
| 154 | 8 | `issued_at` | instante UTC como segundos enteros desde Unix epoch, `uint64` big-endian, emitido por backend |
| 162 | 8 | `expires_at` | instante UTC como segundos enteros desde Unix epoch, `uint64` big-endian, emitido por backend |
| 170 | 1 | `family_present` | exactamente `0x00` o `0x01` |
| 171 | 16 | `family_id` | UUID en bytes si presente; 16 ceros si ausente |
| 187 | 1 | `target_present` | exactamente `0x00` o `0x01` |
| 188 | 16 | `target_device_id` | UUID en bytes si presente; 16 ceros si ausente |
| 204 | 1 | `request_hash_present` | exactamente `0x00` o `0x01` |
| 205 | 32 | `request_hash` | SHA-256 del payload canonico si presente; 32 ceros si ausente |

Un campo no aplicable al proposito debe marcarse ausente y ocupar su slot completo con ceros. Un slot ausente con relleno distinto de cero, uno presente cuando el proposito exige ausencia o uno ausente cuando exige presencia es invalido. Un slot presente con un identificador nil tambien es invalido. El verificador debe rechazar todas esas combinaciones antes de verificar o ejecutar la operacion. Las implementaciones deben construir un buffer nuevo de 237 bytes; no deben firmar un buffer recibido de JavaScript.

## 3. Propositos admitidos

No se admiten valores fuera de esta tabla. Cada challenge se crea para un unico proposito y el backend reconstruye el mensaje desde su registro autoritativo.

| Valor | Nombre API | Familia | Target | Request hash | Uso |
|---:|---|---|---|---|---|
| `0x01` | `device_enrollment` | ausente | ausente | ausente | demostrar posesion al vincular una clave nueva despues de verificar correo |
| `0x02` | `device_authentication` | ausente | ausente | ausente | demostrar posesion de un dispositivo ya confiable durante login |
| `0x03` | `refresh` | presente | ausente | ausente | rotar un refresh token de una familia vinculada al dispositivo |
| `0x04` | `device_rename` | presente | presente | presente | cambiar el nombre del dispositivo objetivo |
| `0x05` | `device_revoke` | presente | presente | ausente | revocar el dispositivo objetivo y todas sus familias |

`family_id` siempre identifica la familia de la sesion que autoriza la operacion, no una familia elegida libremente por el cliente. Cada refresh family futura pertenece obligatoriamente a exactamente un `trusted_device_id`.

### Payload canonico de rename

`device_name` es metadato exclusivamente de UX: no identifica ni autentica al dispositivo, no concede confianza y puede repetirse. El nombre se recorta en ambos extremos, se normaliza Unicode NFC y se codifica UTF-8. Debe contener entre 1 y 64 valores escalares Unicode, ocupar entre 1 y 128 bytes UTF-8 y no contener ningun caracter de control Unicode, incluido NUL.

El preimage de `request_hash` es:

```text
name_length_u16_be || normalized_name_utf8
```

`name_length_u16_be` es la cantidad exacta de bytes UTF-8. Luego `request_hash = SHA-256(preimage)`. El backend vuelve a normalizar y calcular el hash desde el request efectivo antes de verificar la firma.

## 4. Challenge autoritativo

El backend genera y persiste como minimo: challenge ID, user/account binding, dispositivo, hash de clave publica, proposito, nonce hasheado o protegido, `issued_at`, `expires_at`, familia/target/request hash aplicables, estado y momento de consumo.

- `issued_at` y `expires_at` vienen en la respuesta del backend y se copian sin cambios al mensaje firmado.
- Tauri no usa su reloj para aceptar, rechazar ni ajustar esos timestamps.
- La duracion de 1 a 120 segundos aplica exclusivamente a `device_proof_challenges`; `expires_at` debe ser mayor que `issued_at` y la diferencia debe respetar ese rango.
- El codigo de verificacion enviado mediante Resend mantiene un TTL independiente de 10 minutos. Solicitar o renovar un `device_proof_challenge`/nonce no crea ni reenvia otro codigo Resend, no reinicia su TTL y no evita sus cooldowns o rate limits.
- Cada proof nonce nuevo contiene exactamente 32 bytes obtenidos de un CSPRNG del backend. No se deriva de timestamps, IDs, codigos Resend ni datos del usuario.
- El backend compara todos los campos con el challenge persistido, usa su propio reloj para validar `now <= expires_at` y consume el challenge atomica y una sola vez.
- No existe tolerancia de reloj del cliente. Un `issued_at` futuro o alterado no coincide con el registro y falla.
- El codigo enviado por Resend y la prueba Ed25519 son controles distintos: para enrollment ambos deben pertenecer al mismo challenge y usuario antes de emitir tokens.

Orden recomendado de validacion: parseo y limites; carga del challenge; estado/no expiracion; coincidencia de binding y campos; reglas del proposito; busqueda de clave esperada; firma Ed25519; consumo atomico condicionado a `consumed_at IS NULL`; accion autorizada. Una carrera donde dos requests presentan la misma firma debe permitir un solo ganador.

## 5. Limites de API relacionados

| Valor | Limite V1 |
|---|---:|
| Clave publica decodificada | exactamente 32 bytes |
| Firma decodificada | exactamente 64 bytes |
| Account binding decodificado | exactamente 32 bytes |
| Nonce decodificado | exactamente 32 bytes |
| Challenge/device/family/target ID | exactamente 16 bytes |
| Vida de `device_proof_challenge` | 1 a 120 segundos |
| TTL del codigo Resend | 10 minutos, independiente del proof challenge |
| Nombre normalizado | 1 a 64 escalares y 1 a 128 bytes UTF-8 |
| Mensaje firmado | exactamente 237 bytes |

Los decodificadores rechazan Base64 con padding, caracteres fuera del alfabeto URL-safe o longitud decodificada incorrecta. Los errores al cliente son seguros y no distinguen cuenta inexistente, challenge ajeno ni clave de otra cuenta.

## 6. Reglas de almacenamiento para Fase 1

Sin definir aun el DDL final, la migracion debe imponer como minimo:

- `UNIQUE(user_id, public_key_hash)`;
- `UNIQUE(user_id, device_id)`;
- una refresh family con `trusted_device_id NOT NULL` y FK a un unico dispositivo confiable al crear familias V1;
- ninguna FK ni backfill desde `cloud_devices`;
- ninguna modificacion de `users.id`, `owner_user_id` ni tablas financieras.

La transicion a `enforce` invalida refresh tokens/familias legacy sin dispositivo V1. No elimina usuarios ni datos. La siguiente autenticacion requiere vinculacion por Resend; si falla, los datos locales se conservan y solo sync queda en pausa.

## 7. Fixture interoperable

`fixtures/ed25519-proof-v1.json` contiene cinco firmas positivas, una por proposito. Todo seed o clave privada incluido es un vector publico y determinista exclusivamente de test: no procede de una cuenta, instalacion o secreto real y esta prohibido reutilizarlo fuera de pruebas. Rust y Python deben:

1. reconstruir independientemente los 237 bytes desde `common` y cada caso;
2. comparar contra `canonical_message_hex`;
3. derivar la misma clave publica desde el seed de prueba;
4. verificar la firma incluida;
5. regenerar exactamente la misma firma Ed25519;
6. comprobar que alterar cualquier campo, presencia, proposito o byte de firma falla.
