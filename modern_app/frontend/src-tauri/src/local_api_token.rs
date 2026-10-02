use rand_core::{OsRng, RngCore};

fn generate_with(
  fill: impl FnOnce(&mut [u8]) -> Result<(), rand_core::Error>,
) -> Result<String, &'static str> {
  let mut bytes = [0u8; 32];
  fill(&mut bytes).map_err(|_| "No se pudo generar el token seguro del servicio local.")?;
  Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn generate() -> Result<String, &'static str> {
  generate_with(|bytes| OsRng.try_fill_bytes(bytes))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn preserves_full_entropy_and_hex_format() {
    let first = generate_with(|bytes| { bytes.fill(0x12); Ok(()) }).unwrap();
    let second = generate_with(|bytes| { bytes.fill(0xab); Ok(()) }).unwrap();
    assert_eq!(first, "12".repeat(32));
    assert_eq!(second, "ab".repeat(32));
    assert_ne!(first, second);
    let actual = generate().unwrap();
    assert_eq!(actual.len(), 64);
    assert!(actual.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
  }

  #[test]
  fn rng_failure_never_returns_a_token() {
    let failure = generate_with(|_| Err(rand_core::Error::from(
      std::num::NonZeroU32::new(rand_core::Error::CUSTOM_START).unwrap(),
    )));
    assert!(failure.is_err());
  }
}
