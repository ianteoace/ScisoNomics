param(
  [Parameter(Mandatory=$true)][string]$Serial,
  [string]$Apk,
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$frontendRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../frontend'))
$androidConfig = Get-Content -LiteralPath (Join-Path $frontendRoot 'src-tauri/tauri.android.conf.json') -Raw | ConvertFrom-Json
$appConfig = Get-Content -LiteralPath (Join-Path $frontendRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$packageId = $androidConfig.identifier
if (!$Apk) { $Apk = Join-Path $frontendRoot 'src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk' }
$apkPath = (Resolve-Path -LiteralPath $Apk).Path
$sdkPath = $env:ANDROID_HOME
if (!$sdkPath) { $sdkPath = $env:ANDROID_SDK_ROOT }
if (!$sdkPath) { $sdkPath = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
$adb = Join-Path $sdkPath 'platform-tools/adb.exe'
$buildTools = Get-ChildItem -LiteralPath (Join-Path $sdkPath 'build-tools') -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'apksigner.bat') } | Sort-Object Name -Descending | Select-Object -First 1
if (!$buildTools -or !(Test-Path -LiteralPath $adb)) { throw 'Android SDK tools are missing.' }
$apksigner = Join-Path $buildTools.FullName 'apksigner.bat'
$aapt = Join-Path $buildTools.FullName 'aapt.exe'
$badging = & $aapt dump badging $apkPath 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect release APK.' }
$packageLine = $badging | Select-Object -First 1
if ($packageLine -notmatch "package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'") { throw 'Invalid APK metadata.' }
if ($Matches[1] -cne $packageId -or [int64]$Matches[2] -ne $androidConfig.bundle.android.versionCode -or $Matches[3] -cne $appConfig.version) { throw 'Wrong package or version; upgrade is blocked.' }
function Certificate([string]$file) {
  $result = & $apksigner verify --print-certs $file 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
  $digests = @($result | Where-Object { $_ -match '^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]{64})$' } | ForEach-Object { $_.ToString().Split(':')[-1].Trim().ToLowerInvariant() })
  if ($digests.Count -ne 1) { throw 'Unsupported signer set; manual review required.' }
  return $digests[0]
}
$candidateCertificate = Certificate $apkPath
$paths = & $adb -s $Serial shell pm path $packageId 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Cannot locate the existing app on that device.' }
$basePath = $paths | Where-Object { $_ -match '^package:.+/base\.apk$' } | Select-Object -First 1
if (!$basePath) { throw 'The existing release app is not installed. A new/debug sandbox cannot validate recovery.' }
$basePath = $basePath.ToString().Substring('package:'.Length)
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$tempProfile = Join-Path $tempBase ('scisonomics-upgrade-qa-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempProfile | Out-Null
try {
  $oldApk = Join-Path $tempProfile 'installed-base.apk'
  $null = & $adb -s $Serial pull $basePath $oldApk 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read the installed APK certificate. Nothing was installed.' }
  if ((Certificate $oldApk) -cne $candidateCertificate) {
    throw 'Signature differs from installed app (possible Play App Signing). STOP: do not uninstall. Use an APK signed with the existing app signing certificate; an upload-key APK cannot replace it.'
  }
  Write-Output 'Package, version and installed certificate match. No data was cleared.'
  if (!$CheckOnly) {
    $result = & $adb -s $Serial install -r $apkPath 2>&1
    if ($LASTEXITCODE -ne 0 -or $result -notcontains 'Success') { throw 'Upgrade failed. Do not uninstall or clear storage; review manually.' }
    Write-Output 'Upgrade installed with -r. Open ScisoNomics and validate recovery before syncing.'
  }
} finally {
  $resolved = [IO.Path]::GetFullPath($tempProfile)
  if ((Split-Path -Parent $resolved) -ne $tempBase -or (Split-Path -Leaf $resolved) -notlike 'scisonomics-upgrade-qa-*') { throw 'Unexpected QA temporary path.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
