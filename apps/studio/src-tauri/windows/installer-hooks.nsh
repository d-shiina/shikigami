; Installer hooks (bundle.windows.nsis.installerHooks).
;
; Writer was installed as "Shikigami Studio" before the product became
; SpellSheet. An installer named "SpellSheet Writer" would otherwise put a
; second copy in "%LOCALAPPDATA%\SpellSheet Writer" and leave the old one
; behind, with the AI clients' MCP setup and the scheduled agent task still
; pointing at the old copy's spellsheet.exe / shikigami.exe.
;
; So when the old install is found, this one goes into the same folder (the
; paths others saved keep working), takes over its Start menu and desktop
; shortcuts under the new name, and removes the old entry from
; "Apps & features". Settings and flows are not here: they are in
; %APPDATA% / %LOCALAPPDATA%\SpellSheet (moved by the app itself).
;
; An old install made with the MSI (per machine, in Program Files) is removed
; by its own uninstaller first, as Tauri does for an MSI of the same name (it
; looks only for the current name). Writer then lives in this per-user
; install; the release no longer ships an MSI.

!define LEGACY_PRODUCTNAME "Shikigami Studio"
; The second Start menu entry: the same app opening only its Runner window,
; for people who run published flows and never edit them.
!define RUNNER_LNK "$SMPROGRAMS\SpellSheet Runner.lnk"
; Runner's own AppUserModelID (runner.rs, `runner_app_id`). The Start menu
; lists one entry per ID, so with Writer's ID Runner did not show there.
!define RUNNER_APPID "${BUNDLEID}.runner"

!define LEGACY_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${LEGACY_PRODUCTNAME}"

; Tauri's SetLnkAppUserModelId (utils.nsh), with the ID to give.
!macro SetLnkAppUserModelIdTo shortcut appid
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
  ${If} $0 P<> 0
    ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
    ${If} $1 P<> 0
      ${IPersistFile::Load} $1 '("${shortcut}", ${STGM_READWRITE})'
      ${IUnknown::QueryInterface} $0 '("${IID_IPropertyStore}",.r2)'
      ${If} $2 P<> 0
        System::Call 'Oleaut32::SysAllocString(w "${appid}") i.r3'
        System::Call '*${SYSSTRUCT_PROPERTYKEY}(${PKEY_AppUserModel_ID})p.r4'
        System::Call '*${SYSSTRUCT_PROPVARIANT}(${VT_BSTR},,&i4 $3)p.r5'
        ${IPropertyStore::SetValue} $2 '($4,$5)'

        System::Call 'Oleaut32::SysFreeString($3)'
        System::Free $4
        System::Free $5
        ${IPropertyStore::Commit} $2 ""
        ${IUnknown::Release} $2 ""
        ${IPersistFile::Save} $1 '("${shortcut}",1)'
      ${EndIf}
      ${IUnknown::Release} $1 ""
    ${EndIf}
    ${IUnknown::Release} $0 ""
  ${EndIf}
!macroend

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
      ${If} "$R0$R1" == "${LEGACY_PRODUCTNAME}${MANUFACTURER}"
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
  !insertmacro SetLnkAppUserModelIdTo "${RUNNER_LNK}" "${RUNNER_APPID}"

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

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ${If} ${FileExists} "${RUNNER_LNK}"
      !insertmacro UnpinShortcut "${RUNNER_LNK}"
      Delete "${RUNNER_LNK}"
    ${EndIf}
  ${EndIf}
!macroend
