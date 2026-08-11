use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const MAGIC: &[u8; 24] = b"SCISONOMICS-DEVICE-PROOF";
pub(crate) const FORMAT_VERSION: u8 = 1;
pub(crate) const MESSAGE_LENGTH: usize = 237;
const MAX_TTL_SECONDS: u64 = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum Purpose {
  DeviceEnrollment = 1,
  DeviceAuthentication = 2,
  Refresh = 3,
  DeviceRename = 4,
  DeviceRevoke = 5,
}

impl Purpose {
  pub(crate) fn management(value: &str) -> Result<Self, String> {
    match value {
      "device_rename" => Ok(Self::DeviceRename),
      "device_revoke" => Ok(Self::DeviceRevoke),
      _ => Err("invalid_device_management_purpose".to_string()),
    }
  }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProofChallengeInput {
  pub challenge_id: String,
  pub nonce: String,
  pub issued_at: u64,
  pub expires_at: u64,
  pub family_id: Option<String>,
  pub target_device_id: Option<String>,
  pub request_hash: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicIdentity {
  pub format_version: u8,
  pub device_id: String,
  pub public_key: String,
  pub public_key_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignedProof {
  pub format_version: u8,
  pub device_id: String,
  pub public_key: String,
  pub public_key_hash: String,
  pub signature: String,
}

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
pub(crate) struct StoredIdentity {
  version: u8,
  device_id: String,
  private_key_seed: String,
}

fn decode_base64url(value: &str, expected_length: usize) -> Result<Vec<u8>, String> {
  if value.is_empty()
    || value.contains('=')
    || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
  {
    return Err("invalid_base64url".to_string());
  }
  let decoded = URL_SAFE_NO_PAD.decode(value).map_err(|_| "invalid_base64url".to_string())?;
  if decoded.len() != expected_length || URL_SAFE_NO_PAD.encode(&decoded) != value {
    return Err("invalid_base64url_length".to_string());
  }
  Ok(decoded)
}

fn decode_array<const N: usize>(value: &str) -> Result<[u8; N], String> {
  let decoded = Zeroizing::new(decode_base64url(value, N)?);
  decoded.as_slice().try_into().map_err(|_| "invalid_binary_length".to_string())
}

fn parse_uuid(value: &str) -> Result<[u8; 16], String> {
  if value.len() != 36 {
    return Err("invalid_uuid".to_string());
  }
  for (index, byte) in value.bytes().enumerate() {
    let separator = matches!(index, 8 | 13 | 18 | 23);
    if (separator && byte != b'-') || (!separator && !byte.is_ascii_hexdigit()) || byte.is_ascii_uppercase() {
      return Err("invalid_uuid".to_string());
    }
  }
  let compact: String = value.chars().filter(|value| *value != '-').collect();
  let mut output = [0u8; 16];
  for (index, byte) in output.iter_mut().enumerate() {
    *byte = u8::from_str_radix(&compact[index * 2..index * 2 + 2], 16).map_err(|_| "invalid_uuid".to_string())?;
  }
  if output.iter().all(|value| *value == 0) {
    return Err("invalid_uuid".to_string());
  }
  Ok(output)
}

fn format_uuid(value: &[u8; 16]) -> String {
  format!(
    "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
    value[0], value[1], value[2], value[3], value[4], value[5], value[6], value[7],
    value[8], value[9], value[10], value[11], value[12], value[13], value[14], value[15]
  )
}

pub(crate) fn validate_account_binding(value: &str) -> Result<[u8; 32], String> {
  let decoded = decode_array(value)?;
  if decoded.iter().all(|byte| *byte == 0) {
    return Err("invalid_account_binding".to_string());
  }
  Ok(decoded)
}

pub(crate) fn storage_account_key(account_binding: &str) -> Result<String, String> {
  let raw = validate_account_binding(account_binding)?;
  Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(raw)))
}

pub(crate) fn generate_identity() -> StoredIdentity {
  let signing_key = SigningKey::generate(&mut OsRng);
  let seed = Zeroizing::new(signing_key.to_bytes());
  let mut device_id = [0u8; 16];
  OsRng.fill_bytes(&mut device_id);
  device_id[6] = (device_id[6] & 0x0f) | 0x40;
  device_id[8] = (device_id[8] & 0x3f) | 0x80;
  StoredIdentity {
    version: FORMAT_VERSION,
    device_id: format_uuid(&device_id),
    private_key_seed: URL_SAFE_NO_PAD.encode(seed.as_slice()),
  }
}

pub(crate) fn encode_identity(identity: &StoredIdentity) -> Result<Zeroizing<String>, String> {
  serde_json::to_string(identity)
    .map(Zeroizing::new)
    .map_err(|_| "device_identity_encode_failed".to_string())
}

pub(crate) fn decode_identity(value: &str) -> Result<StoredIdentity, String> {
  let identity: StoredIdentity = serde_json::from_str(value).map_err(|_| "device_identity_corrupt".to_string())?;
  let decoded_seed = Zeroizing::new(
    decode_base64url(&identity.private_key_seed, 32)
      .map_err(|_| "device_identity_corrupt".to_string())?,
  );
  if identity.version != FORMAT_VERSION
    || parse_uuid(&identity.device_id).is_err()
    || decoded_seed.len() != 32
  {
    return Err("device_identity_corrupt".to_string());
  }
  Ok(identity)
}

fn signing_key(identity: &StoredIdentity) -> Result<SigningKey, String> {
  let seed = Zeroizing::new(decode_array::<32>(&identity.private_key_seed)?);
  Ok(SigningKey::from_bytes(&seed))
}

pub(crate) fn public_identity(identity: &StoredIdentity) -> Result<PublicIdentity, String> {
  let signing_key = signing_key(identity)?;
  let public_key = signing_key.verifying_key().to_bytes();
  let public_key_hash = Sha256::digest(public_key);
  Ok(PublicIdentity {
    format_version: FORMAT_VERSION,
    device_id: identity.device_id.clone(),
    public_key: URL_SAFE_NO_PAD.encode(public_key),
    public_key_hash: URL_SAFE_NO_PAD.encode(public_key_hash),
  })
}

fn optional_slot<const N: usize>(output: &mut Vec<u8>, value: Option<[u8; N]>) {
  match value {
    Some(value) => {
      output.push(1);
      output.extend_from_slice(&value);
    }
    None => {
      output.push(0);
      output.extend_from_slice(&[0u8; N]);
    }
  }
}

pub(crate) fn build_message(
  identity: &StoredIdentity,
  account_binding: &str,
  purpose: Purpose,
  challenge: &ProofChallengeInput,
) -> Result<Vec<u8>, String> {
  let account_binding = validate_account_binding(account_binding)?;
  let device_id = parse_uuid(&identity.device_id)?;
  let signing_key = signing_key(identity)?;
  let public_key_hash: [u8; 32] = Sha256::digest(signing_key.verifying_key().to_bytes()).into();
  let challenge_id = parse_uuid(&challenge.challenge_id)?;
  let nonce = decode_array::<32>(&challenge.nonce)?;
  let ttl = challenge.expires_at.checked_sub(challenge.issued_at).ok_or_else(|| "invalid_proof_ttl".to_string())?;
  if ttl == 0 || ttl > MAX_TTL_SECONDS {
    return Err("invalid_proof_ttl".to_string());
  }
  let family = challenge.family_id.as_deref().map(parse_uuid).transpose()?;
  let target = challenge.target_device_id.as_deref().map(parse_uuid).transpose()?;
  let request_hash = challenge.request_hash.as_deref().map(decode_array::<32>).transpose()?;
  let expected = match purpose {
    Purpose::DeviceEnrollment | Purpose::DeviceAuthentication => (false, false, false),
    Purpose::Refresh => (true, false, false),
    Purpose::DeviceRename => (true, true, true),
    Purpose::DeviceRevoke => (true, true, false),
  };
  if (family.is_some(), target.is_some(), request_hash.is_some()) != expected {
    return Err("invalid_purpose_fields".to_string());
  }
  let mut output = Vec::with_capacity(MESSAGE_LENGTH);
  output.extend_from_slice(MAGIC);
  output.push(FORMAT_VERSION);
  output.push(purpose as u8);
  output.extend_from_slice(&account_binding);
  output.extend_from_slice(&device_id);
  output.extend_from_slice(&public_key_hash);
  output.extend_from_slice(&challenge_id);
  output.extend_from_slice(&nonce);
  output.extend_from_slice(&challenge.issued_at.to_be_bytes());
  output.extend_from_slice(&challenge.expires_at.to_be_bytes());
  optional_slot(&mut output, family);
  optional_slot(&mut output, target);
  optional_slot(&mut output, request_hash);
  if output.len() != MESSAGE_LENGTH {
    return Err("device_proof_internal_length".to_string());
  }
  Ok(output)
}

pub(crate) fn sign_proof(
  identity: &StoredIdentity,
  account_binding: &str,
  purpose: Purpose,
  challenge: &ProofChallengeInput,
) -> Result<SignedProof, String> {
  let message = build_message(identity, account_binding, purpose, challenge)?;
  let signing_key = signing_key(identity)?;
  let signature = signing_key.sign(&message).to_bytes();
  let public = public_identity(identity)?;
  Ok(SignedProof {
    format_version: public.format_version,
    device_id: public.device_id,
    public_key: public.public_key,
    public_key_hash: public.public_key_hash,
    signature: URL_SAFE_NO_PAD.encode(signature),
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use ed25519_dalek::{Signature, Verifier, VerifyingKey};
  use serde_json::Value;

  const FIXTURE: &str = include_str!("../../../../docs/device-verification/v1/fixtures/ed25519-proof-v1.json");

  fn hex_decode(value: &str) -> Vec<u8> {
    (0..value.len()).step_by(2).map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap()).collect()
  }

  fn uuid_from_hex(value: &str) -> String {
    let bytes: [u8; 16] = hex_decode(value).try_into().unwrap();
    format_uuid(&bytes)
  }

  #[test]
  fn frozen_vectors_match_python_bytes_and_signatures() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let common = &fixture["common"];
    let seed = URL_SAFE_NO_PAD.encode(hex_decode(fixture["test_key"]["private_key_seed_hex"].as_str().unwrap()));
    let identity = StoredIdentity {
      version: FORMAT_VERSION,
      device_id: uuid_from_hex(common["device_id_hex"].as_str().unwrap()),
      private_key_seed: seed,
    };
    let account_binding = URL_SAFE_NO_PAD.encode(hex_decode(common["account_binding_hex"].as_str().unwrap()));
    for vector in fixture["vectors"].as_array().unwrap() {
      let purpose = match vector["purpose"].as_u64().unwrap() {
        1 => Purpose::DeviceEnrollment,
        2 => Purpose::DeviceAuthentication,
        3 => Purpose::Refresh,
        4 => Purpose::DeviceRename,
        5 => Purpose::DeviceRevoke,
        _ => unreachable!(),
      };
      let challenge = ProofChallengeInput {
        challenge_id: uuid_from_hex(common["challenge_id_hex"].as_str().unwrap()),
        nonce: URL_SAFE_NO_PAD.encode(hex_decode(common["nonce_hex"].as_str().unwrap())),
        issued_at: common["issued_at"].as_u64().unwrap(),
        expires_at: common["expires_at"].as_u64().unwrap(),
        family_id: vector["family_present"].as_bool().unwrap().then(|| uuid_from_hex(common["family_id_hex"].as_str().unwrap())),
        target_device_id: vector["target_present"].as_bool().unwrap().then(|| uuid_from_hex(common["target_device_id_hex"].as_str().unwrap())),
        request_hash: vector["request_hash_present"].as_bool().unwrap().then(|| URL_SAFE_NO_PAD.encode(hex_decode(common["rename_request_hash_hex"].as_str().unwrap()))),
      };
      let message = build_message(&identity, &account_binding, purpose, &challenge).unwrap();
      assert_eq!(message.len(), MESSAGE_LENGTH);
      assert_eq!(message, hex_decode(vector["canonical_message_hex"].as_str().unwrap()));
      let signed = sign_proof(&identity, &account_binding, purpose, &challenge).unwrap();
      let signature = URL_SAFE_NO_PAD.decode(signed.signature).unwrap();
      assert_eq!(signature, hex_decode(vector["signature_hex"].as_str().unwrap()));
      let public: [u8; 32] = URL_SAFE_NO_PAD.decode(signed.public_key).unwrap().try_into().unwrap();
      VerifyingKey::from_bytes(&public).unwrap().verify(&message, &Signature::from_slice(&signature).unwrap()).unwrap();
      let mut mutated = message.clone();
      mutated[26] ^= 1;
      assert!(VerifyingKey::from_bytes(&public).unwrap().verify(&mutated, &Signature::from_slice(&signature).unwrap()).is_err());
    }
  }

  #[test]
  fn corrupt_identity_and_invalid_fields_are_rejected() {
    assert!(matches!(
      decode_identity("not-json"),
      Err(error) if error == "device_identity_corrupt"
    ));
    let identity = generate_identity();
    let encoded = encode_identity(&identity).unwrap();
    let decoded = decode_identity(&encoded).unwrap();
    assert_eq!(public_identity(&identity).unwrap().device_id, public_identity(&decoded).unwrap().device_id);
    assert_eq!(
      validate_account_binding(&URL_SAFE_NO_PAD.encode([0u8; 32])).unwrap_err(),
      "invalid_account_binding"
    );
  }
}
