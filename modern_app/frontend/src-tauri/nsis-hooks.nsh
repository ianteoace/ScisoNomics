!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Preparando actualizacion segura de ScisoNomics..."
  DetailPrint "Si Windows informa archivos en uso, cancela la instalacion y cerra ScisoNomics. No uses Omitir."
  DetailPrint "Cerrando procesos anteriores de ScisoNomics si siguen abiertos..."
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM ScisoNomics.exe' $0
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM scisonomics-backend.exe' $0
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM scisonomics-backend-x86_64-pc-windows-msvc.exe' $0
  DetailPrint "Procesos anteriores revisados. Continuando instalacion..."
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Cerrando procesos de ScisoNomics antes de desinstalar..."
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM ScisoNomics.exe' $0
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM scisonomics-backend.exe' $0
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM scisonomics-backend-x86_64-pc-windows-msvc.exe' $0
  DetailPrint "Procesos de ScisoNomics revisados. Continuando desinstalacion..."
!macroend
