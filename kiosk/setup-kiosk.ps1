#Requires -RunAsAdministrator
<#
  Sets up the classroom computer as a kiosk on an EXISTING Windows user
  (default: "user"):
  - signs in to that user automatically when the computer starts;
  - opens Microsoft Edge (normal mode, not InPrivate - the site keeps its
    data, and Edge keeps saved usernames and passwords) with the class site
    and Mashov as two tabs;
  - only those sites can be opened; downloads, file dialogs, developer tools
    and InPrivate are off;
  - no other program can be started (only Edge and the on-screen keyboard);
    the taskbar stays, so the network (Wi-Fi) button and the touch keyboard
    button are there, and Edge's own refresh button is on its toolbar;
  - Task Manager, the command prompt, Control Panel/Settings, the Run box
    and browsing the drives are blocked.
  Everything applies to that user only. Keep (or let this script create) a
  separate administrator account for maintenance - that is where you undo
  it, with remove-kiosk.ps1.
#>
param(
  [string]$KioskUser = 'user',
  [string]$MaintenanceAdmin = 'maintenance',
  [switch]$NoAutoLogin
)
$ErrorActionPreference = 'Stop'

$StartPages = @('https://chabadr.github.io/', 'https://web.mashov.info/')
# Allowed sites, including the services the class site itself loads from.
$AllowedSites = @('chabadr.github.io', 'mashov.info', 'googleapis.com', 'gstatic.com', 'hebcal.com', 'sms4free.co.il')
# The only programs this user may start.
$AllowedPrograms = @('msedge.exe', 'TabTip.exe', 'osk.exe')

$Edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
          "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Edge) { throw 'Microsoft Edge (msedge.exe) was not found.' }

$user = Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue
if (-not $user) { throw "There is no Windows user named '$KioskUser'. Run again with -KioskUser <name>." }
$sid = $user.SID.Value
$profilePath = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }).LocalPath
if (-not $profilePath) { throw "User '$KioskUser' has never signed in. Sign in to it once, sign out, and run this again." }

# ---- A separate administrator for maintenance (to get out and undo) ----
$adminsGroup = Get-LocalGroup -SID 'S-1-5-32-544'
$otherAdmins = $null
try {
  $otherAdmins = Get-LocalGroupMember -Group $adminsGroup | Where-Object {
    $_.ObjectClass -eq 'User' -and $_.SID.Value -ne $sid -and $_.SID.Value -notlike '*-500'
  }
} catch {
  Write-Host 'Could not list the administrators - a maintenance account will be made to be safe.'
}
if (-not $otherAdmins) {
  Write-Host "There is no other administrator account. Creating '$MaintenanceAdmin' for maintenance."
  $adminPw = Read-Host -AsSecureString "Choose a password for the maintenance account '$MaintenanceAdmin' (write it down)"
  if (-not (Get-LocalUser -Name $MaintenanceAdmin -ErrorAction SilentlyContinue)) {
    New-LocalUser -Name $MaintenanceAdmin -Password $adminPw -PasswordNeverExpires -AccountNeverExpires -Description 'Kiosk maintenance' | Out-Null
  }
  Add-LocalGroupMember -Group $adminsGroup -Member $MaintenanceAdmin -ErrorAction SilentlyContinue
}

# ---- Settings in the kiosk user's own registry ----
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

  # An earlier version of this script replaced the desktop with Edge - undo that.
  Remove-ItemProperty -Path "$hive\Software\Microsoft\Windows NT\CurrentVersion\Winlogon" -Name 'Shell' -ErrorAction SilentlyContinue

  # Open Edge with the two sites at sign-in.
  $pages = $StartPages -join ' '
  Set-Value "$hive\Software\Microsoft\Windows\CurrentVersion\Run" 'ClassKiosk' "`"$Edge`" --start-maximized --no-first-run $pages"

  # Only the allowed programs can be started; no Run box, Control Panel/Settings or drives.
  $explorerPol = "$hive\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"
  Set-Value $explorerPol 'RestrictRun' 1 'DWord'
  Set-List "$explorerPol\RestrictRun" $AllowedPrograms
  Set-Value $explorerPol 'NoRun' 1 'DWord'
  Set-Value $explorerPol 'NoControlPanel' 1 'DWord'
  Set-Value $explorerPol 'NoViewOnDrive' 67108863 'DWord'
  Set-Value "$hive\Software\Microsoft\Windows\CurrentVersion\Policies\System" 'DisableTaskMgr' 1 'DWord'
  Set-Value "$hive\Software\Policies\Microsoft\Windows\System" 'DisableCMD' 1 'DWord'

  # Touch keyboard: button on the taskbar, and it opens by itself in a text box.
  Set-Value "$hive\Software\Microsoft\TabletTip\1.7" 'TipbandDesiredVisibility' 1 'DWord'
  Set-Value "$hive\Software\Microsoft\TabletTip\1.7" 'EnableDesktopModeAutoInvoke' 1 'DWord'

  # Edge.
  $edgePol = "$hive\Software\Policies\Microsoft\Edge"
  Set-List "$edgePol\URLBlocklist" @('*', 'edge://*', 'file://*')
  Set-List "$edgePol\URLAllowlist" $AllowedSites
  Set-Value $edgePol 'InPrivateModeAvailability' 1 'DWord'      # no InPrivate
  Set-Value $edgePol 'DeveloperToolsAvailability' 2 'DWord'     # no developer tools
  Set-Value $edgePol 'DownloadRestrictions' 3 'DWord'           # no downloads
  Set-Value $edgePol 'AllowFileSelectionDialogs' 0 'DWord'      # no open/save file windows
  Set-Value $edgePol 'BrowserAddProfileEnabled' 0 'DWord'
  Set-Value $edgePol 'BrowserGuestModeEnabled' 0 'DWord'
  Set-Value $edgePol 'HideFirstRunExperience' 1 'DWord'
  Set-Value $edgePol 'HubsSidebarEnabled' 0 'DWord'
  Set-Value $edgePol 'PasswordManagerEnabled' 1 'DWord'         # keep saved usernames and passwords
  Set-Value $edgePol 'ClearBrowsingDataOnExit' 0 'DWord'        # never wipe the site's data
} finally {
  if ($loadedHere) {
    [gc]::Collect(); [gc]::WaitForPendingFinalizers()
    & reg.exe unload 'HKU\KioskSetup' | Out-Null
  }
}

# ---- Sign in to the kiosk user automatically ----
if (-not $NoAutoLogin) {
  $pw = Read-Host -AsSecureString "The Windows password of '$KioskUser' (for automatic sign-in; Enter if it has none)"
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
  $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty $winlogon 'AutoAdminLogon' '1'
  Set-ItemProperty $winlogon 'DefaultUserName' $KioskUser
  Set-ItemProperty $winlogon 'DefaultDomainName' $env:COMPUTERNAME
  Set-ItemProperty $winlogon 'DefaultPassword' $plain
}

Write-Host ''
Write-Host "Done. Restart the computer - it signs in to '$KioskUser' and opens the class site."
Write-Host 'Maintenance: Start -> the user picture -> Sign out (or Switch user) -> the administrator account.'
