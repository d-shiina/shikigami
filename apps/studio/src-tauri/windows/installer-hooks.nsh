; Installer hooks (bundle.windows.nsis.installerHooks).
;
; Writer was installed under the product's old name before it became
; SpellSheet: first as "<old name> Studio", then as "SpellSheet Writer" but
; still registered under the old publisher (Software\<old name>, which Tauri
; took from the old app identifier). An installer that did not know would put
; a second copy in "%LOCALAPPDATA%\SpellSheet Writer" and leave the old one
; behind, with the AI clients' MCP setup and the scheduled worker task still
; pointing at the old copy's command.
;
; So when an old install is found, this one goes into the same folder (the
; paths others saved keep working), takes over its Start menu and desktop
; shortcuts under the new name, and removes the old registry entries. Writer
; itself moves the rest on its first start (legacy.rs): the MCP setup of the
; AI clients, the worker task, its window settings. Settings and flows are
; not here: they are in %APPDATA% / %LOCALAPPDATA%\SpellSheet (moved by the
; app itself).
;
; An old install made with the MSI (per machine, in Program Files) is removed
; by its own uninstaller first. Writer then lives in this per-user install;
; the release no longer ships an MSI.

; The old name, as in its registry keys.
!define LEGACY_NAME "Shikigami"
!define LEGACY_PRODUCTNAME "${LEGACY_NAME} Studio"
!define LEGACY_MANUKEY "Software\${LEGACY_NAME}"
; The second Start menu entry: the same app opening only its Runner window,
; for people who run published flows and never edit them.
!define RUNNER_LNK "$SMPROGRAMS\SpellSheet Runner.lnk"

!define LEGACY_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${LEGACY_PRODUCTNAME}"

; The old install's folder, when this install takes it over.
Var LegacyInstallDir

!macro NSIS_HOOK_PREINSTALL
  StrCpy $LegacyInstallDir ""
  ; Registered under this publisher already: Tauri found the folder itself.
  ReadRegStr $0 SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $0 == ""
    ReadRegStr $0 SHCTX "${LEGACY_MANUKEY}\${PRODUCTNAME}" ""
    ${If} $0 == ""
      ReadRegStr $0 SHCTX "${LEGACY_MANUKEY}\${LEGACY_PRODUCTNAME}" ""
    ${EndIf}
  ${EndIf}
  ${If} $0 != ""
  ${AndIf} $0 != $INSTDIR
  ${AndIf} ${FileExists} "$0\*.exe"
    StrCpy $LegacyInstallDir $0
    StrCpy $INSTDIR $0
    SetOutPath $INSTDIR
  ${ElseIf} $0 != ""
    StrCpy $LegacyInstallDir $0
  ${Else}
    ; An MSI keeps its uninstall entry under a GUID in HKLM.
    StrCpy $1 0
    ${Do}
      EnumRegKey $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall" $1
      ${If} $0 == ""
        ${Break}
      ${EndIf}
      IntOp $1 $1 + 1
      ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$0" "DisplayName"
      ReadRegStr $R1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$0" "Publisher"
      ${If} $R0 == "${LEGACY_PRODUCTNAME}"
      ${AndIf} $R1 == "${LEGACY_NAME}"
        ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$0" "UninstallString"
        ${If} $R0 != ""
          ExecWait '$R0'
        ${EndIf}
        ${Break}
      ${EndIf}
    ${Loop}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Made on every install and update, so existing installs get it too.
  CreateShortcut "${RUNNER_LNK}" "$INSTDIR\${MAINBINARYNAME}.exe" "--runner"
  !insertmacro SetLnkAppUserModelId "${RUNNER_LNK}"

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

    ; One entry in "Apps & features", under the new name and publisher.
    DeleteRegKey SHCTX "${LEGACY_UNINSTKEY}"
    DeleteRegKey SHCTX "${LEGACY_MANUKEY}\${LEGACY_PRODUCTNAME}"
    DeleteRegKey SHCTX "${LEGACY_MANUKEY}\${PRODUCTNAME}"
    DeleteRegKey /ifempty SHCTX "${LEGACY_MANUKEY}"
  ${EndIf}

  ; The app's identifier (its notifications' sender) changed with the name,
  ; and an update does not make the shortcuts again: give them the new one.
  ${If} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ${If} ${FileExists} "${RUNNER_LNK}"
      !insertmacro UnpinShortcut "${RUNNER_LNK}"
      Delete "${RUNNER_LNK}"
    ${EndIf}
  ${EndIf}
!macroend
