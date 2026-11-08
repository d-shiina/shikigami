; Installer hooks (bundle.windows.nsis.installerHooks).
;
; Studio was installed as "Shikigami Studio" before the product became
; SpellSheet. An installer named "SpellSheet Studio" would otherwise put a
; second copy in "%LOCALAPPDATA%\SpellSheet Studio" and leave the old one
; behind, with the AI clients' MCP setup and the scheduled agent task still
; pointing at the old copy's spellsheet.exe / shikigami.exe.
;
; So when the old install is found, this one goes into the same folder (the
; paths others saved keep working), takes over its Start menu and desktop
; shortcuts under the new name, and removes the old entry from
; "Apps & features". Settings and flows are not here: they are in
; %APPDATA% / %LOCALAPPDATA%\SpellSheet (moved by the app itself).

!define LEGACY_PRODUCTNAME "Shikigami Studio"
!define LEGACY_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${LEGACY_PRODUCTNAME}"

; The old install's folder, when this install takes it over.
Var LegacyInstallDir

!macro NSIS_HOOK_PREINSTALL
  StrCpy $LegacyInstallDir ""
  ReadRegStr $0 SHCTX "${MANUKEY}\${LEGACY_PRODUCTNAME}" ""
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\${MAINBINARYNAME}.exe"
    StrCpy $LegacyInstallDir $0
    StrCpy $INSTDIR $0
    SetOutPath $INSTDIR
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $LegacyInstallDir != ""
    ; Start menu: the old shortcut goes, the new one is made even on a
    ; silent update (which otherwise makes none).
    ${If} ${FileExists} "$SMPROGRAMS\${LEGACY_PRODUCTNAME}.lnk"
      !insertmacro UnpinShortcut "$SMPROGRAMS\${LEGACY_PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${LEGACY_PRODUCTNAME}.lnk"
    ${EndIf}
    ${IfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Desktop: only when there was one.
    ${If} ${FileExists} "$DESKTOP\${LEGACY_PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${LEGACY_PRODUCTNAME}.lnk"
      ${IfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
        CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
      ${EndIf}
    ${EndIf}

    ; One entry in "Apps & features", under the new name.
    DeleteRegKey SHCTX "${LEGACY_UNINSTKEY}"
    DeleteRegKey SHCTX "${MANUKEY}\${LEGACY_PRODUCTNAME}"
  ${EndIf}
!macroend
