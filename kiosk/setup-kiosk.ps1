#Requires -RunAsAdministrator
<#
  Sets up the classroom computer as a kiosk on an EXISTING Windows user
  (default: "user"):
  - signs in to that user automatically when the computer starts;
  - opens the class site and Mashov each in its own app window of Microsoft
    Edge (no address bar or tabs - like installed apps; normal mode, not
    InPrivate, so the site keeps its data and Edge keeps saved usernames and
    passwords);
  - only those sites can be opened; downloads, file dialogs, developer tools
    and InPrivate are off;
  - no other program can be started (only Edge and the on-screen keyboard);
    the taskbar stays, so the network (Wi-Fi) button and the on-screen
    keyboard button are there, and Edge's own refresh button is on its toolbar;
  - Task Manager, the command prompt, Control Panel/Settings, the Run box
    and browsing the drives are blocked;
  - desktop shortcuts open each site again if its window was closed;
  - nothing else starts at sign-in (other startup programs would only show
    the "restrictions in effect" message), so each site opens once;
  - the taskbar hides itself and shows when the mouse goes to the bottom;
  - a large mouse pointer.
  Everything applies to that user only. Keep (or let this script create) a
  separate administrator account for maintenance - that is where you undo
  it, with remove-kiosk.ps1.
#>
param(
  [string]$KioskUser = 'user',
  [string]$MaintenanceAdmin = 'maintenance',
  [ValidateRange(1, 15)][int]$CursorSize = 8,
  [switch]$NoAutoLogin
)
$ErrorActionPreference = 'Stop'

$StartPages = @('https://chabadr.github.io/', 'https://web.mashov.info/')
# Allowed sites, including the services the class site itself loads from.
$AllowedSites = @('chabadr.github.io', 'mashov.info', 'googleapis.com', 'gstatic.com', 'hebcal.com', 'sms4free.co.il')
# The only programs this user may start.
$AllowedPrograms = @('msedge.exe', 'msedge_proxy.exe', 'TabTip.exe', 'osk.exe')

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

  # Nothing else starts at sign-in: every other startup program is blocked
  # anyway and would only pop up "restrictions in effect", and an old Edge
  # entry would open the site a second time. They are kept aside so that
  # remove-kiosk.ps1 can put them back.
  $runKey = "$hive\Software\Microsoft\Windows\CurrentVersion\Run"
  $backupKey = "$hive\Software\ClassKiosk"
  if (-not (Test-Path "$backupKey\RunBackup")) { New-Item -Path "$backupKey\RunBackup" -Force | Out-Null }
  $run = Get-Item -Path $runKey -ErrorAction SilentlyContinue
  if ($run) {
    foreach ($n in $run.GetValueNames()) {
      if ($n -in @('ClassKiosk', 'ClassKioskMashov', '')) { continue }
      New-ItemProperty -Path "$backupKey\RunBackup" -Name $n -Value $run.GetValue($n, $null, 'DoNotExpandEnvironmentNames') -PropertyType String -Force | Out-Null
      Remove-ItemProperty -Path $runKey -Name $n
    }
  }
  $explorerPol = "$hive\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"
  Set-Value $explorerPol 'DisableLocalMachineRun' 1 'DWord'      # programs set to start for every user
  Set-Value $explorerPol 'DisableLocalMachineRunOnce' 1 'DWord'
  Set-Value $explorerPol 'DisableCurrentUserRunOnce' 1 'DWord'
  # The all-users Startup folder: turned off for this user only.
  $approved = "$hive\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder"
  $off = [byte[]](3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  $disabledCommon = @()
  foreach ($f in Get-ChildItem "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp" -File -ErrorAction SilentlyContinue) {
    if ($f.Name -eq 'desktop.ini') { continue }
    Set-Value $approved $f.Name $off 'Binary'
    $disabledCommon += $f.Name
  }
  Set-Value $backupKey 'DisabledCommonStartup' ([string[]]$disabledCommon) 'MultiString'

  # Open each site in its own app window at sign-in.
  Set-Value $runKey 'ClassKiosk' "`"$Edge`" --app=$($StartPages[0]) --start-maximized --no-first-run"
  Set-Value $runKey 'ClassKioskMashov' "`"$Edge`" --app=$($StartPages[1]) --start-maximized --no-first-run"

  # Only the allowed programs can be started; no Run box, Control Panel/Settings or drives.
  Set-Value $explorerPol 'RestrictRun' 1 'DWord'
  Set-List "$explorerPol\RestrictRun" $AllowedPrograms
  Set-Value $explorerPol 'NoRun' 1 'DWord'
  Set-Value $explorerPol 'NoControlPanel' 1 'DWord'
  Set-Value $explorerPol 'NoViewOnDrive' 67108863 'DWord'
  Set-Value "$hive\Software\Microsoft\Windows\CurrentVersion\Policies\System" 'DisableTaskMgr' 1 'DWord'
  Set-Value "$hive\Software\Policies\Microsoft\Windows\System" 'DisableCMD' 1 'DWord'

  # On-screen keyboard button on the taskbar (works with the mouse - there is
  # no physical keyboard).
  Set-Value "$hive\Software\Microsoft\TabletTip\1.7" 'TipbandDesiredVisibility' 1 'DWord'

  # The taskbar hides itself; it shows when the mouse goes to the bottom of
  # the screen.
  $stuck = "$hive\Software\Microsoft\Windows\CurrentVersion\Explorer\StuckRects3"
  $bytes = (Get-ItemProperty -Path $stuck -Name 'Settings' -ErrorAction SilentlyContinue).Settings
  if ($bytes -and $bytes.Length -gt 8) {
    $bytes[8] = $bytes[8] -bor 1
    Set-Value $stuck 'Settings' $bytes 'Binary'
  } else {
    Write-Host 'Could not set the taskbar to hide itself - set it by hand: right-click the taskbar -> Taskbar settings -> Automatically hide the taskbar.'
  }

  # A large mouse pointer (1 = normal ... 15 = largest).
  Set-Value "$hive\Software\Microsoft\Accessibility" 'CursorSize' $CursorSize 'DWord'
  Set-Value "$hive\Control Panel\Cursors" 'CursorBaseSize' (32 + 16 * ($CursorSize - 1)) 'DWord'

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
  Set-Value $edgePol 'StartupBoostEnabled' 0 'DWord'            # Edge does not reopen windows by itself at sign-in
  Set-Value $edgePol 'BackgroundModeEnabled' 0 'DWord'
} finally {
  if ($loadedHere) {
    [gc]::Collect(); [gc]::WaitForPendingFinalizers()
    & reg.exe unload 'HKU\KioskSetup' | Out-Null
  }
}

$kioskDir = "$env:SystemDrive\Kiosk"
New-Item -ItemType Directory -Force -Path $kioskDir | Out-Null

# ---- The user's own Startup folder: emptied (kept aside in C:\Kiosk) ----
$startup = "$profilePath\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup"
$startupBackup = "$kioskDir\StartupBackup"
foreach ($f in Get-ChildItem $startup -File -ErrorAction SilentlyContinue) {
  if ($f.Name -eq 'desktop.ini') { continue }
  New-Item -ItemType Directory -Force -Path $startupBackup | Out-Null
  Move-Item -Path $f.FullName -Destination $startupBackup -Force
}

# ---- Desktop shortcuts: open each site again if its window was closed ----
$classIcon = "$kioskDir\class.ico"
try { Invoke-WebRequest -Uri 'https://chabadr.github.io/icons/icon.ico' -OutFile $classIcon -UseBasicParsing } catch { $classIcon = $null }
# The kiosk user's desktop folder (it may have been moved, e.g. to OneDrive).
$desktop = "$profilePath\Desktop"
& reg.exe load "HKU\KioskShell" "$profilePath\NTUSER.DAT" 2>$null | Out-Null
foreach ($root in @("Registry::HKEY_USERS\$sid", 'Registry::HKEY_USERS\KioskShell')) {
  $folders = Get-ItemProperty "$root\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders" -ErrorAction SilentlyContinue
  if ($folders -and $folders.Desktop) { $desktop = $folders.Desktop -replace '%USERPROFILE%', $profilePath; break }
}
[gc]::Collect(); [gc]::WaitForPendingFinalizers()
& reg.exe unload 'HKU\KioskShell' 2>$null | Out-Null
New-Item -ItemType Directory -Force -Path $desktop | Out-Null
# Hebrew names, written as character codes so this file stays plain ASCII.
$className = -join [char[]](0x05DB, 0x05D9, 0x05EA, 0x05D4, 0x20, 0x05D6)   # kita zayin
$mashovName = -join [char[]](0x05DE, 0x05E9, 0x05D5, 0x05D1)              # mashov
$shell = New-Object -ComObject WScript.Shell
foreach ($sc in @(@{ Name = $className; Url = $StartPages[0]; Icon = $classIcon }, @{ Name = $mashovName; Url = $StartPages[1]; Icon = $null })) {
  $lnk = $shell.CreateShortcut("$desktop\$($sc.Name).lnk")
  $lnk.TargetPath = $Edge
  $lnk.Arguments = "--app=$($sc.Url) --start-maximized"
  if ($sc.Icon) { $lnk.IconLocation = $sc.Icon } else { $lnk.IconLocation = "$Edge,0" }
  $lnk.Save()
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
