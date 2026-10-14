; Drivebay Windows installer. Packs installer/staging (see stage.mjs).
; Pinokio install.js / start.js are not used by this script.

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"

!ifndef VERSION
  !define VERSION "3.29"
!endif
!ifndef VERSION4
  !define VERSION4 "3.29.0.0"
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
!define MUI_WELCOMEPAGE_TEXT "Drivebay is a password-locked file browser for every drive on this PC.$\r$\n$\r$\nThis setup includes the program and the runtime it needs. You do not need Node.js, git, or Pinokio.$\r$\n$\r$\nYou will choose Tailscale, Tailscale + Local, or a regular connection, pick a free port, and set the password."
!define MUI_FINISHPAGE_TITLE "Drivebay is installed"
!define MUI_FINISHPAGE_TEXT "Open Drivebay settings on this PC and sign in with the username and password you just chose. This PC does not open the file browser.$\r$\n$\r$\nOther devices can connect only after you open and forward the port you picked on your router.$\r$\n$\r$\nStart Drivebay from the Start menu. This PC opens the settings page. An icon stays in the notification area while it is running. Uninstall it from the Start menu or from Apps."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open Drivebay settings"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchDrivebay

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom ModePageCreate ModePageLeave
Page custom TailscalePageCreate TailscalePageLeave
Page custom TailscaleOfferPageCreate TailscaleOfferPageLeave
Page custom PortPageCreate PortPageLeave
Page custom RouterPageCreate RouterPageLeave
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
Var ModeBoth
Var ModeRegular
Var Port
Var PortMoved
Var PortField
Var LocalIp
Var PublicIp
Var OutsideUrl
Var PublicText
Var Username
Var Password
Var UsernameField
Var PasswordField
Var ConfirmField
Var Confirm
Var InstallTailscale
Var LaunchTailscale
Var Update
Var TailscaleHave
Var TailscaleHaveYes
Var TailscaleHaveNo
Var TailscaleOfferInstall
Var TailscaleOfferSkip
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
  StrCpy $Mode "tailscale"
  StrCpy $Port "8765"
  StrCpy $PortMoved "0"
  StrCpy $InstallTailscale "0"
  StrCpy $LaunchTailscale "0"
  StrCpy $Update "0"
  StrCpy $TailscaleHave "0"
  StrCpy $DesktopShortcut "1"
  StrCpy $StartWithWindows "0"
  SetShellVarContext current
  Call DetectUpdate
  ${If} $Update != "1"
    Call SuggestFreePort
  ${EndIf}
FunctionEnd

Function DigitsOnly
  StrCpy $R1 ""
  StrLen $R2 $Port
  StrCpy $R3 0
  ${While} $R3 < $R2
    StrCpy $R4 $Port 1 $R3
    ${If} $R4 >= "0"
    ${AndIf} $R4 <= "9"
      StrCpy $R1 "$R1$R4"
    ${EndIf}
    IntOp $R3 $R3 + 1
  ${EndWhile}
  StrCpy $Port $R1
FunctionEnd

Function SuggestFreePort
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -Command "$$found=0; for ($$n=0; $$n -le 128; $$n++) { $$cand=8765+$$n; if ($$cand -ge 42000 -and $$cand -le 42999) { continue }; if ($$cand -gt 65535) { break }; $$busy=$$false; try { $$c=New-Object System.Net.Sockets.TcpClient; $$a=$$c.BeginConnect([System.Net.IPAddress]::Loopback,$$cand,$$null,$$null); if ($$a.AsyncWaitHandle.WaitOne(200,$$false)) { try { $$c.EndConnect($$a); if ($$c.Connected) { $$busy=$$true } } catch {} }; $$c.Close() } catch {}; if (-not $$busy) { try { $$l=New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any,$$cand); $$l.Start(); $$l.Stop() } catch { $$busy=$$true } }; if (-not $$busy) { $$found=$$cand; break } }; if ($$found -lt 1024) { for ($$n=0; $$n -le 128; $$n++) { $$cand=18080+$$n; $$busy=$$false; try { $$c=New-Object System.Net.Sockets.TcpClient; $$a=$$c.BeginConnect([System.Net.IPAddress]::Loopback,$$cand,$$null,$$null); if ($$a.AsyncWaitHandle.WaitOne(200,$$false)) { try { $$c.EndConnect($$a); if ($$c.Connected) { $$busy=$$true } } catch {} }; $$c.Close() } catch {}; if (-not $$busy) { try { $$l=New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any,$$cand); $$l.Start(); $$l.Stop() } catch { $$busy=$$true } }; if (-not $$busy) { $$found=$$cand; break } } }; if ($$found -lt 1024) { $$found=8765 }; $$utf8=New-Object System.Text.UTF8Encoding $$false; [System.IO.File]::WriteAllText((Join-Path $$env:TEMP drivebay-suggested-port.txt), ([string]$$found), $$utf8); exit 0"'
  Pop $0
  Pop $1
  IfFileExists "$TEMP\drivebay-suggested-port.txt" 0 suggest_done
    FileOpen $R9 "$TEMP\drivebay-suggested-port.txt" r
    FileRead $R9 $Port
    FileClose $R9
    Delete "$TEMP\drivebay-suggested-port.txt"
    Call DigitsOnly
    ${If} $Port == ""
      StrCpy $Port "8765"
    ${EndIf}
  suggest_done:
FunctionEnd

Function DetectUpdate
  ; Exit 2 tailscale, 4 both, 3 regular, 0 no install. Writes the saved port when found.
  ; No nested quotes: NSIS single quotes would end the command.
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -Command "$$root=Join-Path $$env:LOCALAPPDATA Drivebay; $$cfg=Join-Path $$root config.json; $$code=0; $$portText=$$null; if (Test-Path -LiteralPath $$cfg) { try { $$j=Get-Content -LiteralPath $$cfg -Raw | ConvertFrom-Json; $$m=[string]$$j.mode; $$portNum=0; $$ok=[int]::TryParse([string]$$j.port,[ref]$$portNum); if ($$ok -and $$portNum -ge 1024 -and $$portNum -le 65535) { if ($$m.StartsWith([string][char]116)) { $$code=2; $$portText=[string]$$portNum } elseif ($$m.StartsWith([string][char]98)) { $$code=4; $$portText=[string]$$portNum } elseif ($$m.StartsWith([string][char]114)) { $$code=3; $$portText=[string]$$portNum } } } catch {} }; if ($$code -eq 0) { $$f=Join-Path $$root drivebay.port; $$a=Join-Path $$root pending-account.json; $$d=Join-Path $$root data; $$s=Join-Path $$root auth.secret; if ((Test-Path -LiteralPath $$f) -and ((Test-Path -LiteralPath $$a) -or (Test-Path -LiteralPath $$d) -or (Test-Path -LiteralPath $$s))) { $$rawPort=[System.IO.File]::ReadAllText($$f).Trim(); $$portNum=0; $$ok=[int]::TryParse($$rawPort,[ref]$$portNum); if ($$ok -and $$portNum -ge 1024 -and $$portNum -le 65535) { $$code=3; $$portText=[string]$$portNum } } }; if ($$portText) { $$utf8=New-Object System.Text.UTF8Encoding $$false; [System.IO.File]::WriteAllText((Join-Path $$env:TEMP drivebay-update-port.txt), $$portText, $$utf8) }; exit $$code"'
  Pop $0
  Pop $1
  ${If} $0 == "2"
    StrCpy $Update "1"
    StrCpy $Mode "tailscale"
  ${ElseIf} $0 == "4"
    StrCpy $Update "1"
    StrCpy $Mode "both"
  ${ElseIf} $0 == "3"
    StrCpy $Update "1"
    StrCpy $Mode "regular"
  ${EndIf}
  ${If} $Update == "1"
    IfFileExists "$TEMP\drivebay-update-port.txt" 0 update_port_done
      FileOpen $R9 "$TEMP\drivebay-update-port.txt" r
      FileRead $R9 $Port
      FileClose $R9
      Delete "$TEMP\drivebay-update-port.txt"
    update_port_done:
  ${EndIf}
FunctionEnd

Function un.onInit
  SetShellVarContext current
  StrCpy $DeleteData ${BST_UNCHECKED}
FunctionEnd

Function ModePageCreate
  ${If} $Update == "1"
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 64u "How should other devices reach this PC? Tailscale is the safer choice (Recommended). Nothing is opened to the internet. Only your own signed-in devices can reach Drivebay. Regular mode exposes the port publicly. Tailscale + Local (Both) keeps Tailscale and adds a public path that starts off."
  Pop $0
  ${NSD_CreateFirstRadioButton} 0 68u 100% 12u "Tailscale (Recommended) - reach Drivebay over your tailnet"
  Pop $ModeTailscale
  ${NSD_CreateAdditionalRadioButton} 0 84u 100% 12u "Tailscale + Local (Both)"
  Pop $ModeBoth
  ${NSD_CreateAdditionalRadioButton} 0 100u 100% 14u "No Tailscale (Regular mode)"
  Pop $ModeRegular
  ${If} $Mode == "both"
    ${NSD_SetState} $ModeBoth ${BST_CHECKED}
  ${ElseIf} $Mode == "regular"
    ${NSD_SetState} $ModeRegular ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $ModeTailscale ${BST_CHECKED}
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function ModePageLeave
  ${NSD_GetState} $ModeTailscale $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Mode "tailscale"
  ${Else}
    ${NSD_GetState} $ModeBoth $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $Mode "both"
    ${Else}
      StrCpy $Mode "regular"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function PortPageCreate
  ${If} $Update == "1"
    Abort
  ${EndIf}
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
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -Command "$$p=[int]$Port; $$busy=$$false; try { $$c=New-Object System.Net.Sockets.TcpClient; $$a=$$c.BeginConnect([System.Net.IPAddress]::Loopback,$$p,$$null,$$null); if ($$a.AsyncWaitHandle.WaitOne(500,$$false)) { try { $$c.EndConnect($$a); if ($$c.Connected) { $$busy=$$true } } catch {} }; $$c.Close() } catch {}; if (-not $$busy) { try { $$l=New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any,$$p); $$l.Start(); $$l.Stop() } catch { $$busy=$$true } }; if ($$busy) { exit 1 } else { exit 0 }"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Port $Port is already in use on this PC. Enter a different port. If this is Pinokio's Caddy (z:\pinokio\bin\miniforge\Library\bin\caddy.exe), it takes ports from 42000 to 42999 while Pinokio is running. Choose a port outside that range, such as 8765."
    Abort
  ${EndIf}
FunctionEnd

Function CollectRouterAddresses
  StrCpy $LocalIp ""
  StrCpy $PublicIp ""
  ; Writes local IP, newline, public IP. No nested quotes.
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -Command "$$local=$$null; $$best=$$null; $$public=$$null; try { $$nics=[System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces(); foreach ($$nic in $$nics) { if ($$nic.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }; foreach ($$addr in $$nic.GetIPProperties().UnicastAddresses) { if ($$addr.Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }; $$ip=$$addr.Address.ToString(); $$loop=-join @([char]49,[char]50,[char]55,[char]46,[char]48,[char]46,[char]48,[char]46,[char]49); $$apipa=-join @([char]49,[char]54,[char]57,[char]46,[char]50,[char]53,[char]52,[char]46); if ($$ip -eq $$loop -or $$ip.StartsWith($$apipa)) { continue }; if (-not $$best) { $$best=$$ip }; $$p192=-join @([char]49,[char]57,[char]50,[char]46,[char]49,[char]54,[char]56,[char]46); $$p10=-join @([char]49,[char]48,[char]46); if ($$ip.StartsWith($$p192) -or $$ip.StartsWith($$p10)) { $$local=$$ip } } } } catch {}; if (-not $$local) { $$local=$$best }; try { $$url=-join @([char]104,[char]116,[char]116,[char]112,[char]115,[char]58,[char]47,[char]47,[char]97,[char]112,[char]105,[char]46,[char]105,[char]112,[char]105,[char]102,[char]121,[char]46,[char]111,[char]114,[char]103); $$r=Invoke-WebRequest -UseBasicParsing -Uri $$url -TimeoutSec 3; $$text=([string]$$r.Content).Trim(); $$parts=$$text.Split([char]46); $$okIp=($$parts.Count -eq 4); foreach ($$part in $$parts) { $$n=0; if (-not [int]::TryParse($$part,[ref]$$n) -or $$n -lt 0 -or $$n -gt 255) { $$okIp=$$false } }; if ($$okIp) { $$public=$$text } } catch {}; $$utf8=New-Object System.Text.UTF8Encoding $$false; $$body=[string]$$local + [char]10 + [string]$$public; [System.IO.File]::WriteAllText((Join-Path $$env:TEMP drivebay-router-ip.txt), $$body, $$utf8); exit 0"'
  Pop $0
  Pop $1
  IfFileExists "$TEMP\drivebay-router-ip.txt" 0 router_ip_done
    FileOpen $R9 "$TEMP\drivebay-router-ip.txt" r
    FileRead $R9 $R8
    FileRead $R9 $R7
    FileClose $R9
    Delete "$TEMP\drivebay-router-ip.txt"
    StrCpy $LocalIp $R8
    StrCpy $PublicIp $R7
  router_ip_done:
FunctionEnd

Function RouterPageCreate
  ; Tailscale reaches the local port over the tailnet. No router forward.
  ${If} $Update == "1"
    Abort
  ${EndIf}
  ${If} $Mode == "tailscale"
    Abort
  ${EndIf}
  Call CollectRouterAddresses
  ${If} $LocalIp == ""
    StrCpy $LocalIp "not found. Run ipconfig and use the IPv4 address."
  ${EndIf}
  ${If} $PublicIp == ""
    StrCpy $OutsideUrl "http://<public-ip>:$Port/"
    StrCpy $PublicText "not found. Search the web for what is my ip."
  ${Else}
    StrCpy $OutsideUrl "http://$PublicIp:$Port/"
    StrCpy $PublicText $PublicIp
  ${EndIf}
  nsDialogs::Create 1018
  Pop $2
  ${If} $Mode == "both"
    ${NSD_CreateLabel} 0 0 100% 12u "Tailscale + Local (Both). Public access starts off."
    Pop $2
  ${Else}
    ${NSD_CreateLabel} 0 0 100% 12u "No Tailscale (Regular mode)"
    Pop $2
  ${EndIf}
  ${NSD_CreateLabel} 0 14u 100% 78u "You have to open and forward TCP port $Port on your router.$\r$\n$\r$\n1. This PC's local IP is $LocalIp.$\r$\n2. Log in to the router, usually http://192.168.0.1 or http://192.168.1.1.$\r$\n3. Add a port forward for TCP $Port to that local IP.$\r$\n4. Give this PC a reserved or static IP in DHCP so the address does not change.$\r$\n5. Public IP: $PublicText. From outside the network, open $OutsideUrl$\r$\n6. Some ISPs use CGNAT and block this. Tailscale is the easy fallback.$\r$\n7. Use a strong password. It locks every drive on this PC.$\r$\nIf Windows Firewall asks, allow TCP port $Port."
  Pop $2
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
  ${If} $Update == "1"
    Abort
  ${EndIf}
  ${If} $Mode == "regular"
    Abort
  ${EndIf}
  StrCpy $0 "0"
  IfFileExists "$PROGRAMFILES64\Tailscale\Tailscale.exe" ts_found_64 ts_check_pf
  ts_found_64:
    StrCpy $0 "1"
  ts_check_pf:
  IfFileExists "$PROGRAMFILES\Tailscale\Tailscale.exe" ts_found_pf ts_check_32
  ts_found_pf:
    StrCpy $0 "1"
  ts_check_32:
  IfFileExists "$PROGRAMFILES32\Tailscale\Tailscale.exe" ts_found_32 ts_have_ui
  ts_found_32:
    StrCpy $0 "1"
  ts_have_ui:
  nsDialogs::Create 1018
  Pop $1
  ${NSD_CreateLabel} 0 0 100% 40u "Do you already have Tailscale? If it is installed, this page selects Yes. Yes continues to the port, username, and password. No lets you install Tailscale or skip it."
  Pop $1
  ${NSD_CreateFirstRadioButton} 0 46u 100% 12u "Yes, Tailscale is already installed"
  Pop $TailscaleHaveYes
  ${NSD_CreateAdditionalRadioButton} 0 62u 100% 14u "No"
  Pop $TailscaleHaveNo
  ${If} $0 == "1"
    ${NSD_SetState} $TailscaleHaveYes ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $TailscaleHaveNo ${BST_CHECKED}
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function TailscalePageLeave
  ${If} $Update == "1"
    Return
  ${EndIf}
  ${If} $Mode == "regular"
    Return
  ${EndIf}
  ${NSD_GetState} $TailscaleHaveYes $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $TailscaleHave "1"
    StrCpy $InstallTailscale "0"
    StrCpy $LaunchTailscale "0"
  ${Else}
    StrCpy $TailscaleHave "0"
  ${EndIf}
FunctionEnd

Function TailscaleOfferPageCreate
  ${If} $Update == "1"
    Abort
  ${EndIf}
  ${If} $Mode == "regular"
    Abort
  ${EndIf}
  ${If} $TailscaleHave == "1"
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 48u "Tailscale is not installed. Drivebay can download and install Tailscale for Windows from the official installer. After it installs, sign in or create a free Tailscale account. Or skip this and set Tailscale up later."
  Pop $0
  ${NSD_CreateFirstRadioButton} 0 54u 100% 12u "Download and install Tailscale, then sign in"
  Pop $TailscaleOfferInstall
  ${NSD_CreateAdditionalRadioButton} 0 70u 100% 14u "Skip. I can install Tailscale and set it up later."
  Pop $TailscaleOfferSkip
  ${NSD_SetState} $TailscaleOfferInstall ${BST_CHECKED}
  nsDialogs::Show
FunctionEnd

Function TailscaleOfferPageLeave
  ${If} $Update == "1"
    Return
  ${EndIf}
  ${If} $Mode == "regular"
    Return
  ${EndIf}
  ${If} $TailscaleHave == "1"
    Return
  ${EndIf}
  ${NSD_GetState} $TailscaleOfferInstall $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $InstallTailscale "1"
    StrCpy $LaunchTailscale "1"
  ${Else}
    StrCpy $InstallTailscale "0"
    StrCpy $LaunchTailscale "0"
    MessageBox MB_OK "You can install Tailscale and set it up later. Setup will continue with the port, username, and password."
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
  ${If} $Update == "1"
    Abort
  ${EndIf}
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
  ${If} $Update == "1"
    Abort
  ${EndIf}
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
  ${If} $Update == "1"
    ${If} $PortMoved == "1"
      SendMessage $mui.FinishPage.Text ${WM_SETTEXT} 0 "STR:Drivebay updated to ${VERSION}.$\r$\n$\r$\nThe saved port was in the range Pinokio's Caddy uses (42000-42999), so Drivebay moved to port $Port.$\r$\n$\r$\nThe new address on this PC is http://127.0.0.1:$Port/settings. The firewall rule and shortcut were updated.$\r$\n$\r$\nOn this PC, Drivebay opens the settings page."
    ${Else}
      SendMessage $mui.FinishPage.Text ${WM_SETTEXT} 0 "STR:Drivebay updated to ${VERSION}.$\r$\n$\r$\nYour account, password, port, and settings were kept.$\r$\n$\r$\nOn this PC, Drivebay opens the settings page."
    ${EndIf}
  ${ElseIf} $Mode == "tailscale"
    SendMessage $mui.FinishPage.Text ${WM_SETTEXT} 0 "STR:Open Drivebay settings on this PC and sign in with the username and password you just chose. This PC does not open the file browser.$\r$\n$\r$\nOther devices on your tailnet open http://<this-PC-tailscale-name>:$Port/ after Tailscale is signed in on both devices. You do not forward that port on your router.$\r$\n$\r$\nStart Drivebay from the Start menu. This PC opens the settings page. An icon stays in the notification area while it is running. Uninstall it from the Start menu or from Apps."
  ${ElseIf} $Mode == "both"
    SendMessage $mui.FinishPage.Text ${WM_SETTEXT} 0 "STR:Open Drivebay settings on this PC and sign in with the username and password you just chose. This PC does not open the file browser.$\r$\n$\r$\nTailscale + Local (Both). Tailscale still reaches Drivebay. Public access is off until you turn it on from this PC or from a signed-in Tailscale device. Forward TCP port $Port before that public path can work.$\r$\n$\r$\nStart Drivebay from the Start menu. This PC opens the settings page. An icon stays in the notification area while it is running. Uninstall it from the Start menu or from Apps."
  ${EndIf}
FunctionEnd

Section "Install"
  ${If} $Update == "1"
    DetailPrint "Stopping Drivebay before the update."
    nsExec::ExecToLog '"$INSTDIR\DrivebayTray.exe" --quit'
    Pop $0
    nsExec::ExecToLog '"$INSTDIR\runtime\node.exe" "$INSTDIR\launcher.mjs" --stop'
    Pop $0
    nsExec::ExecToLog 'taskkill.exe /IM DrivebayTray.exe /F'
    Pop $0
    Sleep 400
  ${EndIf}

  SetOutPath "$INSTDIR"
  File /r "staging\*.*"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ${If} $Update == "1"
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -Command "$$root=Join-Path $$env:LOCALAPPDATA Drivebay; $$cfg=Join-Path $$root config.json; if (Test-Path -LiteralPath $$cfg) { $$j=Get-Content -LiteralPath $$cfg -Raw | ConvertFrom-Json; $$j.version=[string]${VERSION}; $$utf8=New-Object System.Text.UTF8Encoding $$false; [System.IO.File]::WriteAllText($$cfg, ($$j | ConvertTo-Json -Compress), $$utf8) }"'
    Pop $0
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\windows\migrate-listen-port.ps1"'
    Pop $0
    IfFileExists "$TEMP\drivebay-migrated-port.txt" 0 migrate_port_keep
      StrCpy $R7 $Port
      FileOpen $R9 "$TEMP\drivebay-migrated-port.txt" r
      FileRead $R9 $Port
      FileClose $R9
      Delete "$TEMP\drivebay-migrated-port.txt"
      Call DigitsOnly
      ${If} $Port == ""
        StrCpy $Port $R7
        DetailPrint "Keeping the existing account, password, port, and settings."
      ${Else}
        StrCpy $PortMoved "1"
        DetailPrint "The saved port was in the range Pinokio's Caddy uses (42000-42999). Drivebay moved to port $Port. The new address on this PC is http://127.0.0.1:$Port/settings. The firewall rule and shortcut were updated."
      ${EndIf}
      Goto update_files_done
    migrate_port_keep:
    DetailPrint "Keeping the existing account, password, port, and settings."
    Goto update_files_done
  ${EndIf}

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

  update_files_done:
  ${If} $Mode == "tailscale"
    DetailPrint "Tailscale mode: other devices use the tailnet address of this PC on port $Port. No router port forward is required."
  ${ElseIf} $Mode == "both"
    DetailPrint "Tailscale + Local (Both): Tailscale stays on. Public access starts off. Forward TCP port $Port on your router before that path can work."
  ${Else}
    DetailPrint "You must open and forward TCP port $Port on your router."
  ${EndIf}
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows\firewall.ps1" -Action add'
  Pop $0

  ${If} $Update != "1"
  ${AndIf} $Mode != "regular"
  ${AndIf} $InstallTailscale == "1"
    DetailPrint "Downloading the official Tailscale installer..."
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows\install-tailscale.ps1" -Quiet'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "Tailscale was not installed. Drivebay is still installed. Download Tailscale from https://tailscale.com/download/windows and sign in so this PC joins your tailnet. Other devices use http://<this-PC-tailscale-name>:$Port/."
    ${Else}
      nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows\launch-tailscale.ps1"'
      Pop $0
      MessageBox MB_OK "Tailscale is installed. Sign in, or create a free Tailscale account.$\r$\n$\r$\n1. The Tailscale window is open.$\r$\n2. Click Sign in, or create a free account if you do not have one.$\r$\n3. Finish the sign-in in the browser.$\r$\n4. Click OK when this PC shows as connected."
    ${EndIf}
  ${EndIf}

  CreateDirectory "$SMPROGRAMS\Drivebay"
  CreateShortCut "$SMPROGRAMS\Drivebay\Drivebay.lnk" "$INSTDIR\DrivebayTray.exe" "" "$INSTDIR\assets\drivebay.ico"
  CreateShortCut "$SMPROGRAMS\Drivebay\Stop Drivebay.lnk" "$INSTDIR\DrivebayTray.exe" "--stop" "$INSTDIR\assets\drivebay.ico"
  CreateShortCut "$SMPROGRAMS\Drivebay\Uninstall Drivebay.lnk" "$INSTDIR\uninstall.exe"
  ${If} $Update != "1"
    ${If} $DesktopShortcut == "1"
      CreateShortCut "$DESKTOP\Drivebay.lnk" "$INSTDIR\DrivebayTray.exe" "" "$INSTDIR\assets\drivebay.ico"
    ${EndIf}
    ${If} $StartWithWindows == "1"
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Drivebay" '"$INSTDIR\DrivebayTray.exe" --background'
    ${Else}
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Drivebay"
    ${EndIf}
  ${EndIf}

  WriteRegStr HKCU "Software\Drivebay" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay" "DisplayName" "Drivebay"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay" "Publisher" "Drivebay"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay" "DisplayIcon" "$INSTDIR\assets\drivebay.ico"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay" "NoRepair" 1

  ${If} $Update == "1"
    DetailPrint "Starting Drivebay."
    ExecShell "" "$INSTDIR\DrivebayTray.exe"
    nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -Command "$$ok=$$false; $$n=0; $$needle=-join @([char]68,[char]114,[char]105,[char]118,[char]101,[char]98,[char]97,[char]121); $$prefix=-join @([char]104,[char]116,[char]116,[char]112,[char]58,[char]47,[char]47,[char]49,[char]50,[char]55,[char]46,[char]48,[char]46,[char]48,[char]46,[char]49,[char]58); $$suffix=-join @([char]47,[char]97,[char]112,[char]105,[char]47,[char]104,[char]101,[char]97,[char]108,[char]116,[char]104); while ($$n -lt 30) { try { $$url=$$prefix + $Port + $$suffix; $$r=Invoke-WebRequest -UseBasicParsing -Uri $$url -TimeoutSec 2; if ([string]$$r.Content.Contains($$needle)) { $$ok=$$true; break } } catch {}; Start-Sleep -Seconds 1; $$n=$$n+1 }; if ($$ok) { exit 0 } else { exit 1 }"'
    Pop $0
    Pop $1
    ${If} $0 == "0"
      DetailPrint "Drivebay updated to ${VERSION}"
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Drivebay did not answer on port $Port. The program on that port is not this Drivebay server, so the update did not finish."
    ${EndIf}
  ${EndIf}
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
