param(
    [switch]$Copy,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
    Write-Host "Uso: powershell -File modern_app/scripts/prepare-sidecar.ps1 [-Copy]"
    Write-Host "Valida version, frescura y hash del sidecar. -Copy actualiza el binario consumido por Tauri."
    exit 0
}

$modernRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $modernRoot
$frontendRoot = Join-Path $modernRoot "frontend"
$backendRoot = Join-Path $modernRoot "backend"
$sourceExe = Join-Path $backendRoot "dist/scisonomics-backend.exe"
$targetExe = Join-Path $frontendRoot "src-tauri/binaries/scisonomics-backend-x86_64-pc-windows-msvc.exe"
$packagePath = Join-Path $frontendRoot "package.json"
$tauriConfigPath = Join-Path $frontendRoot "src-tauri/tauri.conf.json"
$localBackendPath = Join-Path $modernRoot "backend/app/main.py"

if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
    throw "Falta $sourceExe. Regenera el sidecar antes de crear el instalador."
}

$packageVersion = (Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version
$tauriVersion = (Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json).version
$backendSource = Get-Content -LiteralPath $localBackendPath -Raw
$backendMatch = [regex]::Match($backendSource, 'FastAPI\(title="Registro Finanzas API", version="([^"]+)"\)')
if (-not $backendMatch.Success) {
    throw "No se pudo detectar la version del backend local."
}
$backendVersion = $backendMatch.Groups[1].Value

if ($packageVersion -ne $tauriVersion -or $packageVersion -ne $backendVersion) {
    throw "Version inconsistente: package=$packageVersion tauri=$tauriVersion backend=$backendVersion"
}

$sourceFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $repoRoot "finance_app") -Filter "*.py" -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $backendRoot "app") -Filter "*.py" -File -Recurse
    Get-Item -LiteralPath (Join-Path $backendRoot "run_backend.py")
    Get-Item -LiteralPath (Join-Path $backendRoot "scisonomics-backend.spec")
)
$newestSource = $sourceFiles | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$sourceBinary = Get-Item -LiteralPath $sourceExe
if ($newestSource.LastWriteTimeUtc -gt $sourceBinary.LastWriteTimeUtc) {
    throw "El sidecar esta desactualizado. Regeneralo: $($newestSource.Name) es mas nuevo que $($sourceBinary.Name)."
}

if ($Copy) {
    $targetDir = Split-Path -Parent $targetExe
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    Copy-Item -LiteralPath $sourceExe -Destination $targetExe -Force
}

if (-not (Test-Path -LiteralPath $targetExe -PathType Leaf)) {
    throw "Falta $targetExe. Ejecuta este script con -Copy."
}

$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceExe).Hash
$targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $targetExe).Hash
if ($sourceHash -ne $targetHash) {
    throw "El sidecar consumido por Tauri no coincide con el EXE generado. Ejecuta este script con -Copy."
}

Write-Host "Sidecar OK. version=$packageVersion sha256=$($targetHash.Substring(0, 12))..."
