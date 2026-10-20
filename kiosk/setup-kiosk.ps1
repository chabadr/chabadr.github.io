#Requires -RunAsAdministrator
<#
  Sets up the classroom computer as a kiosk:
  - a separate standard Windows user (default name: kita) that signs in
    automatically and gets Microsoft Edge INSTEAD of the desktop - no taskbar,
    Start menu or File Explorer, so no other program can be opened;
  - Edge runs in normal (not InPrivate) mode, so the site keeps its data;
  - only the allowed sites can be opened; downloads, file dialogs, developer
    tools, InPrivate and extra profiles are turned off;
  - if Edge is closed it opens again by itself.
  Everything applies to the kiosk user only - the administrator account
  (yours) keeps working normally.

  To leave the kiosk: Ctrl+Alt+Del -> Switch user (or Sign out).
  To undo: run remove-kiosk.ps1 the same way.
#>
param(
  [string]$KioskUser = 'kita',
  [switch]$NoAutoLogin
)
$ErrorActionPreference = 'Stop'

# The two sites, opened as two tabs.
$StartPages = @('https://chabadr.github.io/', 'https://web.mashov.info/')
# Allowed sites, including the services the class site itself loads from
# (data, fonts, parsha names, SMS).
$AllowedSites = @('chabadr.github.io', 'mashov.info', 'googleapis.com', 'gstatic.com', 'hebcal.com', 'sms4free.co.il')

$Edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
          "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Edge) { throw 'Microsoft Edge (msedge.exe) was not found.' }

# ---- 1. The kiosk user ----
$Password = Read-Host -AsSecureString "Choose a password for the kiosk user '$KioskUser'"
$user = Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue
if (-not $user) {
  $user = New-LocalUser -Name $KioskUser -Password $Password -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword -Description 'Classroom kiosk'
  # "Users" group, looked up by its fixed SID so it works in a Hebrew Windows too.
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $KioskUser
  Write-Host "Created user $KioskUser"
} else {
  Set-LocalUser -Name $KioskUser -Password $Password
  Write-Host "User $KioskUser already exists - password updated"
}
$sid = $user.SID.Value

# Windows creates a user's profile folder on first sign-in; start a process
# as that user once so the profile (and its registry) exists.
$cred = New-Object System.Management.Automation.PSCredential($KioskUser, $Password)
Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/c exit' -Credential $cred -LoadUserProfile -WindowStyle Hidden -Wait
$profilePath = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }).LocalPath
if (-not $profilePath) { throw "The profile of $KioskUser was not created. Sign in once as $KioskUser, sign out, and run this again." }

# ---- 2. The launcher that replaces the desktop ----
$kioskDir = "$env:SystemDrive\Kiosk"
New-Item -ItemType Directory -Force -Path $kioskDir | Out-Null
$pagesLiteral = ($StartPages | ForEach-Object { "'$_'" }) -join ', '
@"
# Opens Edge with the class sites and opens it again whenever it is closed
# (checked every few seconds, only for Edge in this sign-in session).
`$edgeArgs = @('--start-maximized', '--no-first-run', $pagesLiteral)
`$mySession = (Get-Process -Id `$PID).SessionId
while (`$true) {
  `$running = Get-Process -Name msedge -ErrorAction SilentlyContinue | Where-Object { `$_.SessionId -eq `$mySession }
  if (-not `$running) { Start-Process -FilePath '$Edge' -ArgumentList `$edgeArgs }
  Start-Sleep -Seconds 3
}
"@ | Set-Content -Path "$kioskDir\start-kiosk.ps1" -Encoding UTF8
$shell = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$kioskDir\start-kiosk.ps1`""

# ---- 3. Settings in the kiosk user's own registry ----
$loadedHere = $false
$hive = "Registry::HKEY_USERS\$sid"
if (-not (Test-Path $hive)) {
  & reg.exe load "HKU\KioskSetup" "$profilePath\NTUSER.DAT" | Out-Null
  $hive = 'Registry::HKEY_USERS\KioskSetup'
  $loadedHere = $true
}
try {
  function Set-Value($path, $name, $value, $type = 'String') {
    if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
    New-ItemProperty -Path $path -Name $name -Value $value -PropertyType $type -Force | Out-Null
  }
  function Set-List($path, $values) {
    if (Test-Path $path) { Remove-Item -Path $path -Recurse -Force }
    New-Item -Path $path -Force | Out-Null
    $i = 1
    foreach ($v in $values) { New-ItemProperty -Path $path -Name "$i" -Value $v -PropertyType String -Force | Out-Null; $i++ }
  }

  # Edge instead of the desktop.
  Set-Value "$hive\Software\Microsoft\Windows NT\CurrentVersion\Winlogon" 'Shell' $shell
  # No Task Manager.
  Set-Value "$hive\Software\Microsoft\Windows\CurrentVersion\Policies\System" 'DisableTaskMgr' 1 'DWord'

  $edgePol = "$hive\Software\Policies\Microsoft\Edge"
  Set-List "$edgePol\URLBlocklist" @('*', 'edge://*', 'file://*')
  Set-List "$edgePol\URLAllowlist" $AllowedSites
  Set-Value $edgePol 'InPrivateModeAvailability' 1 'DWord'      # no InPrivate
  Set-Value $edgePol 'DeveloperToolsAvailability' 2 'DWord'     # no developer tools
  Set-Value $edgePol 'DownloadRestrictions' 3 'DWord'           # no downloads
  Set-Value $edgePol 'AllowFileSelectionDialogs' 0 'DWord'      # no open/save file windows
  Set-Value $edgePol 'BrowserAddProfileEnabled' 0 'DWord'
  Set-Value $edgePol 'BrowserGuestModeEnabled' 0 'DWord'
  Set-Value $edgePol 'BrowserSignin' 0 'DWord'
  Set-Value $edgePol 'HideFirstRunExperience' 1 'DWord'
  Set-Value $edgePol 'HubsSidebarEnabled' 0 'DWord'
  Set-Value $edgePol 'StartupBoostEnabled' 0 'DWord'
  Set-Value $edgePol 'BackgroundModeEnabled' 0 'DWord'
  Set-Value $edgePol 'PasswordManagerEnabled' 0 'DWord'         # never save the Mashov password here
} finally {
  if ($loadedHere) {
    [gc]::Collect(); [gc]::WaitForPendingFinalizers()
    & reg.exe unload 'HKU\KioskSetup' | Out-Null
  }
}

# ---- 4. Sign in to the kiosk user automatically when the computer starts ----
if (-not $NoAutoLogin) {
  $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password))
  Set-ItemProperty $winlogon 'AutoAdminLogon' '1'
  Set-ItemProperty $winlogon 'DefaultUserName' $KioskUser
  Set-ItemProperty $winlogon 'DefaultDomainName' $env:COMPUTERNAME
  Set-ItemProperty $winlogon 'DefaultPassword' $plain
}

Write-Host ''
Write-Host 'Done. Restart the computer - it will open straight into the kiosk.'
Write-Host 'To get out of the kiosk: Ctrl+Alt+Del -> Switch user.'
