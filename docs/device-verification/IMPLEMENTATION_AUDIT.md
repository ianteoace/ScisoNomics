# Device verification: audit before enforcement

The existing V1 implementation is a foundation, not an authorization system.
`device_verification.rs` already creates per-account Ed25519 identities and signs
the frozen 237-byte protocol. Windows stores the private seed in WinCred. The
cloud verifier validates that same protocol; its additive schema already contains
trusted devices, OTP challenges, proof challenges and refresh families.

Missing before this milestone: enrollment endpoints, delivery of the device OTP,
atomic consumption, device authorization before session persistence, proof-bound
restoration, revocation enforcement and account device management. `cloud_devices`
is sync telemetry and must never grant trust. Android's generic keyring branch
does not supply the required encrypted native custody.

Reuse: existing purpose codes and canonical format without changes; server-generated
`users.device_key_namespace`; existing Resend/SMTP configuration; Windows WinCred;
Android's native Keystore-encrypted storage with a separate identity namespace.
No hardware fingerprint or migration of financial owners is needed.

Enforcement must cover cloud authorization, not just the OTP screen. Raw Supabase
tokens are limited to bootstrap and device handshake. Only a server-signed,
device/family-bound authorization grant may access protected cloud endpoints in
enforce mode. Device status and family revocation are checked on every request.
Provider refresh alone does not authorize restoration. Legacy endpoints remain
for rollback compatibility and cannot bypass enforce mode.

The Phase 2 implementation defaults to `enforce`; explicitly setting
`SCISONOMICS_DEVICE_VERIFICATION_MODE=off` is an operator rollback without device
protection. New clients fail closed against off/old backends. Backend and client
rollout must be coordinated; real-mail and second-profile checks remain pending.
No production deployment or configuration change is part of this local work.

Implementation and limits: [DEVICE_AUTHORIZATION.md](DEVICE_AUTHORIZATION.md).
