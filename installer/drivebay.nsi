; Drivebay Windows installer. Packs installer/staging (see stage.mjs).
; Pinokio install.js / start.js are not used by this script.

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"

!ifndef VERSION
  !define VERSION "3.21"
!endif
!ifndef VERSION4
  !define VERSION4 "3.21.0.0"
!endif

Name "Drivebay ${VERSION}"
OutFile "dist\Drivebay-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\Drivebay"
InstallDirRegKey HKCU "Software\Drivebay" "InstallDir"
RequestExecutionLevel user
Unicode True
SetCompressor /SOLID lzma
BrandingText "Drivebay ${VERSION}"
ShowInstDetails show

!define MUI_ABORTWARNING
!define MUI_ICON "assets\drivebay.ico"
!define MUI_UNICON "assets\drivebay.ico"
!define MUI_WELCOMEPAGE_TITLE "Install Drivebay"
!define MUI_WELCOMEPAGE_TEXT "Drivebay is a password-locked file browser for every drive on this PC.$\r$\n$\r$\nThis setup includes the program and the runtime it needs. You do not need Node.js, git, or Pinokio.$\r$\n$\r$\nYou will choose Tailscale or a regular connection, pick a free port, and set the password."
!define MUI_FINISHPAGE_TITLE "Drivebay is installed"
!define MUI_FINISHPAGE_TEXT "Open Drivebay settings on this PC and sign in with the username and password you just chose. This PC does not open the file browser.$\r$\n$\r$\nOther devices can connect only after you open and forward the port you picked on your router.$\r$\n$\r$\nStart Drivebay from the Start menu. This PC opens the settings page. An icon stays in the notification area while it is running. Uninstall it from the Start menu or from Apps."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open Drivebay settings"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchDrivebay

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom ModePageCreate ModePageLeave
Page custom PortPageCreate PortPageLeave
Page custom RouterPageCreate RouterPageLeave
Page custom TailscalePageCreate TailscalePageLeave
Page custom AccountPageCreate AccountPageLeave
Page custom OptionsPageCreate OptionsPageLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishPageShow
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.DataPageCreate un.DataPageLeave
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var Mode
Var ModeTailscale
Var ModeRegular
Var Port
Var PortField
Var Username
Var Password
Var UsernameField
Var PasswordField
Var ConfirmField
Var Confirm
Var InstallTailscale
Var LaunchTailscale
Var HInstallTs
Var HLaunchTs
Var HAck
Var DesktopShortcut
Var StartWithWindows
Var HDesktop
Var HStartup
Var DeleteData
Var UnDeleteCheckbox
Var SetupError

; FileWrite writes the system ANSI code page. The setup script reads UTF-16LE,
; so an 8-character password becomes 4 characters and is rejected.
!macro WriteUtf16 FILE VALUE
  FileOpen $R9 "${FILE}" w
  FileWriteUTF16LE /BOM $R9 "${VALUE}"
  FileClose $R9
!macroend

Function .onInit
  StrCpy $Mode "regular"
  StrCpy $Port "42013"
  StrCpy $InstallTailscale "0"
  StrCpy $LaunchTailscale "0"
  StrCpy $DesktopShortcut "1"
  StrCpy $StartWithWindows "0"
  SetShellVarContext current
FunctionEnd

Function un.onInit
  SetShellVarContext current
  StrCpy $DeleteData ${BST_UNCHECKED}
FunctionEnd

Function ModePageCreate
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 36u "How should other devices reach this PC? Both modes use a local port. Tailscale reaches it over your tailnet, with no router change. Regular mode needs that port forwarded on your router."
  Pop $0
  ${NSD_CreateFirstRadioButton} 0 42u 100% 12u "Tailscale - reach Drivebay over your tailnet"
  Pop $ModeTailscale
  ${NSD_CreateAdditionalRadioButton} 0 58u 100% 14u "Regular - this network, without Tailscale"
  Pop $ModeRegular
  ${If} $Mode == "tailscale"
    ${NSD_SetState} $ModeTailscale ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $ModeRegular ${BST_CHECKED}
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function ModePageLeave
  ${NSD_GetState} $ModeTailscale $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Mode "tailscale"
  ${Else}
    StrCpy $Mode "regular"
  ${EndIf}
FunctionEnd

Function PortPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $Mode == "tailscale"
    ${NSD_CreateLabel} 0 0 100% 36u "Choose the port Drivebay listens on. This step is required. The port must be free on this PC (1024-65535). Devices on your tailnet use this port. You do not open it on your router."
    Pop $0
  ${Else}
    ${NSD_CreateLabel} 0 0 100% 36u "Choose the port Drivebay listens on. This step is required. The port must be free on this PC (1024-65535). The next page tells you to forward this same port on your router."
    Pop $0
  ${EndIf}
  ${NSD_CreateLabel} 0 42u 100% 10u "Port"
  Pop $0
  ${NSD_CreateText} 0 54u 80u 12u "$Port"
  Pop $PortField
  nsDialogs::Show
FunctionEnd

Function PortIsDigits
  ; $Port -> $0 = 1 when every character is a digit and the value is 1024-65535
  StrLen $1 $Port
  ${If} $1 < 4
  ${OrIf} $1 > 5
    StrCpy $0 0
    Return
  ${EndIf}
  StrCpy $2 0
  ${While} $2 < $1
    StrCpy $3 $Port 1 $2
    ${If} $3 < "0"
    ${OrIf} $3 > "9"
      StrCpy $0 0
      Return
    ${EndIf}
    IntOp $2 $2 + 1
  ${EndWhile}
  ${If} $Port < 1024
  ${OrIf} $Port > 65535
    StrCpy $0 0
    Return
  ${EndIf}
  StrCpy $0 1
FunctionEnd

Function PortPageLeave
  ${NSD_GetText} $PortField $Port
  Call PortIsDigits
  ${If} $0 != 1
    MessageBox MB_OK|MB_ICONEXCLAMATION "Enter a port from 1024 to 65535."
    Abort
  ${EndIf}
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -Command "try { $$l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, [int]$Port); $$l.Start(); $$l.Stop(); exit 0 } catch { exit 1 }"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Port $Port is already in use on this PC. Enter a different port."
    Abort
  ${EndIf}
FunctionEnd

Function RouterPageCreate
  ; Tailscale reaches the local port over the tailnet. No router forward.
  ${If} $Mode == "tailscale"
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 12u "Open this port on your router"
  Pop $0
  ${NSD_CreateLabel} 0 16u 100% 18u "TCP port $Port"
  Pop $0
  ${NSD_CreateLabel} 0 38u 100% 48u "You have to open and forward TCP port $Port on your router.$\r$\n$\r$\nPhones and other computers cannot reach Drivebay until your router forwards port $Port to this PC.$\r$\n$\r$\nIf Windows Firewall asks, allow Drivebay or TCP port $Port as well."
  Pop $0
  ${NSD_CreateCheckbox} 0 96u 100% 18u "I understand I must open and forward port $Port on my router."
  Pop $HAck
  nsDialogs::Show
FunctionEnd

Function RouterPageLeave
  ${If} $Mode == "tailscale"
    Return
  ${EndIf}
  ${NSD_GetState} $HAck $0
  ${If} $0 != ${BST_CHECKED}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Check the box to confirm you will open and forward port $Port on your router."
    Abort
  ${EndIf}
FunctionEnd

Function TailscalePageCreate
  ${If} $Mode != "tailscale"
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 56u "Tailscale mode. Devices on your tailnet reach this PC at http://<this-PC-tailscale-name>:$Port/ after you sign in to Tailscale on both devices. You do not open that port on your router.$\r$\n$\r$\nDrivebay can download the official Tailscale installer from pkgs.tailscale.com and run it. Tailscale's own window will open."
  Pop $0
  ${NSD_CreateCheckbox} 0 62u 100% 12u "Download and install Tailscale (official installer)"
  Pop $HInstallTs
  ${NSD_CreateCheckbox} 0 78u 100% 14u "Launch Tailscale when setup finishes"
  Pop $HLaunchTs
  ${If} $InstallTailscale == "1"
    ${NSD_SetState} $HInstallTs ${BST_CHECKED}
  ${EndIf}
  ${If} $LaunchTailscale == "1"
    ${NSD_SetState} $HLaunchTs ${BST_CHECKED}
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function TailscalePageLeave
  ${NSD_GetState} $HInstallTs $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $InstallTailscale "1"
  ${Else}
    StrCpy $InstallTailscale "0"
  ${EndIf}
  ${NSD_GetState} $HLaunchTs $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $LaunchTailscale "1"
  ${Else}
    StrCpy $LaunchTailscale "0"
  ${EndIf}
FunctionEnd

Function UsernameOk
  ; Result in $0. Scratch is $R1-$R4 only, so $Password and $Confirm stay intact.
  StrLen $R1 $Username
  ${If} $R1 < 1
  ${OrIf} $R1 > 64
    StrCpy $0 0
    Return
  ${EndIf}
  StrCpy $R2 0
  ${While} $R2 < $R1
    StrCpy $R3 $Username 1 $R2
    StrCpy $R4 0
    ${If} $R3 >= "0"
    ${AndIf} $R3 <= "9"
      StrCpy $R4 1
    ${EndIf}
    ${If} $R3 >= "A"
    ${AndIf} $R3 <= "Z"
      StrCpy $R4 1
    ${EndIf}
    ${If} $R3 >= "a"
    ${AndIf} $R3 <= "z"
      StrCpy $R4 1
    ${EndIf}
    ${If} $R2 > 0
      ${If} $R3 == "."
      ${OrIf} $R3 == "-"
      ${OrIf} $R3 == "_"
        StrCpy $R4 1
      ${EndIf}
    ${EndIf}
    ${If} $R4 != 1
      StrCpy $0 0
      Return
    ${EndIf}
    IntOp $R2 $R2 + 1
  ${EndWhile}
  StrCpy $0 1
FunctionEnd

Function AccountPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 32u "Set the only Drivebay account. After this, nobody else can sign up. Use at least 8 characters. This password is the lock for every drive on this PC."
  Pop $0
  ${NSD_CreateLabel} 0 34u 100% 8u "Username (letters, numbers, dot, dash, underscore)"
  Pop $0
  ${NSD_CreateText} 0 44u 100% 12u "$Username"
  Pop $UsernameField
  ${NSD_CreateLabel} 0 60u 100% 8u "Password"
  Pop $0
  ${NSD_CreatePassword} 0 70u 100% 12u ""
  Pop $PasswordField
  ${NSD_CreateLabel} 0 86u 100% 8u "Confirm password"
  Pop $0
  ${NSD_CreatePassword} 0 96u 100% 12u ""
  Pop $ConfirmField
  nsDialogs::Show
FunctionEnd

Function AccountPageLeave
  ${NSD_GetText} $UsernameField $Username
  ${NSD_GetText} $PasswordField $Password
  ${NSD_GetText} $ConfirmField $Confirm
  Call UsernameOk
  ${If} $0 != 1
    MessageBox MB_OK|MB_ICONEXCLAMATION "Enter a username using letters, numbers, dots, dashes, or underscores."
    Abort
  ${EndIf}
  StrLen $R1 $Password
  ${If} $R1 < 8
    MessageBox MB_OK|MB_ICONEXCLAMATION "Use a password of at least 8 characters."
    Abort
  ${EndIf}
  ${If} $Password != $Confirm
    MessageBox MB_OK|MB_ICONEXCLAMATION "Passwords do not match."
    Abort
  ${EndIf}
FunctionEnd

Function OptionsPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 32u "Shortcuts. Drivebay is added to the Start menu, with an uninstaller. Starting it puts an icon in the notification area. There is no console window."
  Pop $0
  ${NSD_CreateCheckbox} 0 40u 100% 12u "Desktop shortcut"
  Pop $HDesktop
  ${NSD_CreateCheckbox} 0 56u 100% 16u "Start Drivebay when I sign in to Windows"
  Pop $HStartup
  ${If} $DesktopShortcut == "1"
    ${NSD_SetState} $HDesktop ${BST_CHECKED}
  ${EndIf}
  ${If} $StartWithWindows == "1"
    ${NSD_SetState} $HStartup ${BST_CHECKED}
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function OptionsPageLeave
  ${NSD_GetState} $HDesktop $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $DesktopShortcut "1"
  ${Else}
    StrCpy $DesktopShortcut "0"
  ${EndIf}
  ${NSD_GetState} $HStartup $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $StartWithWindows "1"
  ${Else}
    StrCpy $StartWithWindows "0"
  ${EndIf}
FunctionEnd

Function LaunchDrivebay
  Exec '"$INSTDIR\DrivebayTray.exe"'
FunctionEnd

; $1 in and out, on the stack. One line, no quotes, capped for the message box.
Function OneLine
  Pop $1
  StrCpy $R2 $1
  StrCpy $1 ""
  ${Do}
    StrCpy $R3 $R2 1
    ${If} $R3 == ""
      ${ExitDo}
    ${EndIf}
    ${If} $R3 == '"'
    ${OrIf} $R3 == "$\r"
    ${OrIf} $R3 == "$\n"
      ${If} $R3 == '"'
        StrCpy $R3 "'"
      ${Else}
        StrCpy $R3 " "
      ${EndIf}
    ${EndIf}
    StrCpy $1 "$1$R3"
    StrCpy $R2 $R2 "" 1
    StrLen $R4 $1
    ${If} $R4 > 399
      ${ExitDo}
    ${EndIf}
  ${Loop}
  Push $1
FunctionEnd

Function FinishPageShow
  ${If} $Mode == "tailscale"
    SendMessage $mui.FinishPage.Text ${WM_SETTEXT} 0 "STR:Open Drivebay settings on this PC and sign in with the username and password you just chose. This PC does not open the file browser.$\r$\n$\r$\nOther devices on your tailnet open http://<this-PC-tailscale-name>:$Port/ after Tailscale is signed in on both devices. You do not forward that port on your router.$\r$\n$\r$\nStart Drivebay from the Start menu. This PC opens the settings page. An icon stays in the notification area while it is running. Uninstall it from the Start menu or from Apps."
  ${EndIf}
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "staging\*.*"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  !insertmacro WriteUtf16 "$TEMP\drivebay-pending-user.txt" "$Username"
  !insertmacro WriteUtf16 "$TEMP\drivebay-pending-password.txt" "$Password"
  FileOpen $R9 "$TEMP\drivebay-setup.txt" w
  FileWriteUTF16LE /BOM $R9 "$LOCALAPPDATA\Drivebay$\r$\n$Port$\r$\n$Mode$\r$\n${VERSION}$\r$\n$TEMP\drivebay-pending-user.txt$\r$\n$TEMP\drivebay-pending-password.txt$\r$\n"
  FileClose $R9
  DetailPrint "Saving the Drivebay account to $LOCALAPPDATA\Drivebay"
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\windows\write-setup.ps1" -ParamsFile "$TEMP\drivebay-setup.txt"'
  Pop $0
  Pop $1
  StrCpy $SetupError ""
  IfFileExists "$TEMP\drivebay-setup-result.txt" 0 setup_no_result
    FileOpen $R9 "$TEMP\drivebay-setup-result.txt" r
    FileReadUTF16LE $R9 $SetupError
    FileClose $R9
  setup_no_result:
  Delete "$TEMP\drivebay-setup-result.txt"
  Delete "$TEMP\drivebay-setup.txt"
  Delete "$TEMP\drivebay-pending-user.txt"
  Delete "$TEMP\drivebay-pending-password.txt"
  ${If} $SetupError == ""
    StrCpy $SetupError $1
  ${EndIf}
  Push $SetupError
  Call OneLine
  Pop $SetupError
  DetailPrint "Account setup exit $0"
  DetailPrint "$SetupError"
  ${If} $0 != 0
  ${OrIfNot} ${FileExists} "$LOCALAPPDATA\Drivebay\pending-account.json"
    ${If} $SetupError == ""
      StrCpy $SetupError "No error text was returned (exit $0)."
    ${EndIf}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Drivebay is installed, but the password file could not be saved.$\r$\n$\r$\n$SetupError$\r$\n$\r$\nSet the username and password in the browser the first time you open Drivebay. The same text is in the install log."
  ${EndIf}

  ${If} $Mode == "tailscale"
    DetailPrint "Tailscale mode: other devices use the tailnet address of this PC on port $Port. No router port forward is required."
  ${Else}
    DetailPrint "You must open and forward TCP port $Port on your router."
  ${EndIf}
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows\firewall.ps1" -Action add'
  Pop $0

  ${If} $Mode == "tailscale"
  ${AndIf} $InstallTailscale == "1"
    DetailPrint "Downloading the official Tailscale installer..."
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows\install-tailscale.ps1"'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "Tailscale was not installed. Drivebay is still installed. Download Tailscale from https://tailscale.com/download/windows and sign in so this PC joins your tailnet. Other devices use http://<this-PC-tailscale-name>:$Port/."
    ${EndIf}
  ${EndIf}
  ${If} $Mode == "tailscale"
  ${AndIf} $LaunchTailscale == "1"
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows\launch-tailscale.ps1"'
    Pop $0
  ${EndIf}

  CreateDirectory "$SMPROGRAMS\Drivebay"
  CreateShortCut "$SMPROGRAMS\Drivebay\Drivebay.lnk" "$INSTDIR\DrivebayTray.exe" "" "$INSTDIR\assets\drivebay.ico"
  CreateShortCut "$SMPROGRAMS\Drivebay\Stop Drivebay.lnk" "$INSTDIR\DrivebayTray.exe" "--stop" "$INSTDIR\assets\drivebay.ico"
  CreateShortCut "$SMPROGRAMS\Drivebay\Uninstall Drivebay.lnk" "$INSTDIR\uninstall.exe"
  ${If} $DesktopShortcut == "1"
    CreateShortCut "$DESKTOP\Drivebay.lnk" "$INSTDIR\DrivebayTray.exe" "" "$INSTDIR\assets\drivebay.ico"
  ${EndIf}
  ${If} $StartWithWindows == "1"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Drivebay" '"$INSTDIR\DrivebayTray.exe" --background'
  ${Else}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Drivebay"
  ${EndIf}

  WriteRegStr HKCU "Software\Drivebay" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay" "DisplayName" "Drivebay"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay" "Publisher" "Drivebay"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay" "DisplayIcon" "$INSTDIR\assets\drivebay.ico"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay" "NoRepair" 1
SectionEnd

Function un.DataPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 28u "Drivebay's program files, shortcuts, and startup entry will be removed. The password database stays unless you check the box below."
  Pop $0
  ${NSD_CreateCheckbox} 0 36u 100% 20u "Also delete the saved password and settings"
  Pop $UnDeleteCheckbox
  nsDialogs::Show
FunctionEnd

Function un.DataPageLeave
  ${NSD_GetState} $UnDeleteCheckbox $DeleteData
FunctionEnd

Section "Uninstall"
  nsExec::ExecToLog '"$INSTDIR\DrivebayTray.exe" --quit'
  Pop $0
  DetailPrint "Tray quit exit $0"
  nsExec::ExecToLog '"$INSTDIR\runtime\node.exe" "$INSTDIR\launcher.mjs" --stop'
  Pop $0
  nsExec::ExecToLog 'taskkill.exe /IM DrivebayTray.exe /F'
  Pop $0
  Sleep 500
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows\firewall.ps1" -Action remove'
  Pop $0
  Sleep 400
  Delete "$DESKTOP\Drivebay.lnk"
  Delete "$SMPROGRAMS\Drivebay\Drivebay.lnk"
  Delete "$SMPROGRAMS\Drivebay\Stop Drivebay.lnk"
  Delete "$SMPROGRAMS\Drivebay\Uninstall Drivebay.lnk"
  RMDir "$SMPROGRAMS\Drivebay"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Drivebay"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay"
  DeleteRegKey HKCU "Software\Drivebay"
  RMDir /r "$INSTDIR"
  ${If} $DeleteData == ${BST_CHECKED}
    RMDir /r "$LOCALAPPDATA\Drivebay"
  ${EndIf}
SectionEnd

VIProductVersion "${VERSION4}"
VIAddVersionKey "ProductName" "Drivebay"
VIAddVersionKey "FileDescription" "Drivebay setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Drivebay"
