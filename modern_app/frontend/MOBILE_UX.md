# Mobile UX: numeric editing, Premium, Settings Back and Android launch

Version remains 3.3.3 / Android versionCode 3003003.

## Numeric drafts

Desktop and Mobile financial forms share `NumericInput` and `lib/numericInput`.
The display uses dots for grouping and a comma for decimals. Draft editing is
string-only, preserves trailing decimals and never rounds. On submit the existing
`parseCurrencyInput` entry point delegates to the centralized parser; financial
models keep their existing numeric types. A lone dot with three trailing digits
is interpreted as grouping; a comma is preferred for an ambiguous decimal.
Paste accepts `1234.56`, `1.234,56` and `1,234.56`. Dates, IDs and percentages
do not use this component.

## Premium confirmation

Purchased Play results still go through the existing backend ownership validation
and server acknowledgement. After that, refresh/reconciliation and verified
entitlement loading run immediately, then after waits of 1, 2 and 4 seconds if
still unconfirmed. Validation is not repeated by the retry loop. Timers stop on
account change or cancellation of the initiating screen. Failure to confirm
never grants access locally; the UI keeps a confirmation message and manual
Restore purchases remains available. Opening Premium refreshes server state with
a five-second throttle. Existing native resume/purchase listeners and shell
foreground handling remain responsible for out-of-app completions.

## Settings Back

Android detail selection pushes one real browser history entry above Settings
root, preserving Next metadata. Switching details replaces that entry. Direct
`section`/`panel=cuenta` links prepare a root entry once. Visual and physical Back
therefore return to Settings root first; a second Back follows normal app
navigation. No global native Back listener or dialog interception is installed.
Desktop retains replacement navigation.

## Native launch

Tracked templates live in `src-tauri/android-runtime`. The Android build/dev hooks
run `../scripts/prepare-android-runtime.cjs` to copy only MainActivity and launch
resources into the regenerable project. Signing, manifest, Gradle, launcher icons,
package identifiers and version are untouched.

Android 12+ uses the system SplashScreen exit callback and the existing foreground
icon. API 24–30 continues the starting-window logo in a native overlay. Animation
is 500ms plus a 120ms fade, with no keep-on-screen condition or delay of auth,
database initialization or Quick Entry dispatch. Warm resume has no splash code.
System-disabled animations are honored on API 26+; API 24–25 uses the short
fallback. No second frontend splash or extra Activity is created.

## Local debug APK (no production wrapper / no AAB)

From `modern_app/frontend` in PowerShell, after setting any intended build
environment outside these commands:

```powershell
npm.cmd run build
$config = Join-Path $env:TEMP 'sciso-local-debug.json'
[IO.File]::WriteAllText($config, '{"build":{"beforeBuildCommand":"node ../scripts/prepare-android-runtime.cjs"}}', [Text.UTF8Encoding]::new($false))
npx.cmd tauri android build --debug --apk --target aarch64 --config $config
```

The override packages the export already built above. It never invokes the
production identity-key check. The resulting universal debug APK contains ARM64
only; default filename is `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.

Manual checks: cold launcher start, warm resume, Android tile cold start, Settings
detail Back twice, numeric typing/paste and cancellation. Real Play purchase
verification requires the configured store/testing installation; a sideloaded
`.debug` package cannot prove store ownership or backend billing configuration.
An actual successful Google callback requires a test account and real PKCE
exchange; a canceled callback can only prove lifecycle/deep-link delivery.
