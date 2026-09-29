!macro SCISO_REQUIRE_STOPPED processName
  nsis_tauri_utils::FindProcessCurrentUser "${processName}"
  Pop $0
  ${If} $0 = 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "Cerrá ${processName} antes de continuar. Volvé a ejecutar el instalador cuando termine de cerrarse."
    Abort "ScisoNomics sigue en ejecución."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro SCISO_REQUIRE_STOPPED "ScisoNomics.exe"
  !insertmacro SCISO_REQUIRE_STOPPED "scisonomics-backend.exe"
  !insertmacro SCISO_REQUIRE_STOPPED "scisonomics-backend-x86_64-pc-windows-msvc.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro SCISO_REQUIRE_STOPPED "ScisoNomics.exe"
  !insertmacro SCISO_REQUIRE_STOPPED "scisonomics-backend.exe"
  !insertmacro SCISO_REQUIRE_STOPPED "scisonomics-backend-x86_64-pc-windows-msvc.exe"
!macroend
