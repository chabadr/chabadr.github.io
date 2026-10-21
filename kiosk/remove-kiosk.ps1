#Requires -RunAsAdministrator
<#
  Undoes setup-kiosk.ps1 for the kiosk user: Edge no longer opens at
  sign-in, the program and Edge restrictions are removed, and automatic
  sign-in is turned off. Run it from the administrator (maintenance) account.
#>
param(
  [string]$KioskUser = 'user'
)
$ErrorActionPreference = 'Stop'

$user = Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue
if (-not $user) { throw "There is no Windows user named '$KioskUser'." }
$sid = $user.SID.Value
$profilePath = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }).LocalPath
$loadedHere = $false
$hive = "Registry::HKEY_USERS\$sid"
if (-not (Test-Path $hive) -and $profilePath) {
  & reg.exe load "HKU\KioskSetup" "$profilePath\NTUSER.DAT" | Out-Null
  $hive = 'Registry::HKEY_USERS\KioskSetup'
  $loadedHere = $true
}
try {
  if (Test-Path $hive) {
    Remove-ItemProperty -Path "$hive\Software\Microsoft\Windows NT\CurrentVersion\Winlogon" -Name 'Shell' -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path "$hive\Software\Microsoft\Windows\CurrentVersion\Run" -Name 'ClassKiosk' -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path "$hive\Software\Microsoft\Windows\CurrentVersion\Run" -Name 'ClassKioskMashov' -ErrorAction SilentlyContinue
    # Put back the startup programs that setup-kiosk.ps1 kept aside.
    $backupKey = "$hive\Software\ClassKiosk"
    $saved = Get-Item -Path "$backupKey\RunBackup" -ErrorAction SilentlyContinue
    if ($saved) {
      foreach ($n in $saved.GetValueNames()) {
        New-ItemProperty -Path "$hive\Software\Microsoft\Windows\CurrentVersion\Run" -Name $n -Value $saved.GetValue($n, $null, 'DoNotExpandEnvironmentNames') -PropertyType String -Force | Out-Null
      }
    }
    $approved = "$hive\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder"
    foreach ($n in @((Get-ItemProperty -Path $backupKey -Name 'DisabledCommonStartup' -ErrorAction SilentlyContinue).DisabledCommonStartup)) {
      if ($n) { Remove-ItemProperty -Path $approved -Name $n -ErrorAction SilentlyContinue }
    }
    Remove-Item -Path $backupKey -Recurse -Force -ErrorAction SilentlyContinue
    # Taskbar always shown again; normal mouse pointer.
    $stuck = "$hive\Software\Microsoft\Windows\CurrentVersion\Explorer\StuckRects3"
    $bytes = (Get-ItemProperty -Path $stuck -Name 'Settings' -ErrorAction SilentlyContinue).Settings
    if ($bytes -and $bytes.Length -gt 8) {
      $bytes[8] = $bytes[8] -band 0xFE
      New-ItemProperty -Path $stuck -Name 'Settings' -Value $bytes -PropertyType Binary -Force | Out-Null
    }
    if (Test-Path "$hive\Software\Microsoft\Accessibility") { New-ItemProperty -Path "$hive\Software\Microsoft\Accessibility" -Name 'CursorSize' -Value 1 -PropertyType DWord -Force | Out-Null }
    if (Test-Path "$hive\Control Panel\Cursors") { New-ItemProperty -Path "$hive\Control Panel\Cursors" -Name 'CursorBaseSize' -Value 32 -PropertyType DWord -Force | Out-Null }
    $explorerPol = "$hive\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"
    foreach ($n in 'RestrictRun', 'NoRun', 'NoControlPanel', 'NoViewOnDrive', 'DisableLocalMachineRun', 'DisableLocalMachineRunOnce', 'DisableCurrentUserRunOnce') { Remove-ItemProperty -Path $explorerPol -Name $n -ErrorAction SilentlyContinue }
    Remove-Item -Path "$explorerPol\RestrictRun" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path "$hive\Software\Microsoft\Windows\CurrentVersion\Policies\System" -Name 'DisableTaskMgr' -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path "$hive\Software\Policies\Microsoft\Windows\System" -Name 'DisableCMD' -ErrorAction SilentlyContinue
    Remove-Item -Path "$hive\Software\Policies\Microsoft\Edge" -Recurse -Force -ErrorAction SilentlyContinue
  }
} finally {
  if ($loadedHere) {
    [gc]::Collect(); [gc]::WaitForPendingFinalizers()
    & reg.exe unload 'HKU\KioskSetup' | Out-Null
  }
}

$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
if ((Get-ItemProperty $winlogon -ErrorAction SilentlyContinue).DefaultUserName -eq $KioskUser) {
  Set-ItemProperty $winlogon 'AutoAdminLogon' '0'
  Remove-ItemProperty $winlogon -Name 'DefaultPassword' -ErrorAction SilentlyContinue
}
if ($profilePath -and (Test-Path "$env:SystemDrive\Kiosk\StartupBackup")) {
  $startup = "$profilePath\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup"
  New-Item -ItemType Directory -Force -Path $startup | Out-Null
  Get-ChildItem "$env:SystemDrive\Kiosk\StartupBackup" -File | Move-Item -Destination $startup -Force
}
Remove-Item -Path "$env:SystemDrive\Kiosk" -Recurse -Force -ErrorAction SilentlyContinue
if ($profilePath) {
  $names = @((-join [char[]](0x05DB, 0x05D9, 0x05EA, 0x05D4, 0x20, 0x05D6)), (-join [char[]](0x05DE, 0x05E9, 0x05D5, 0x05D1)))
  foreach ($d in @("$profilePath\Desktop", "$profilePath\OneDrive\Desktop")) {
    foreach ($n in $names) { Remove-Item -Path "$d\$n.lnk" -Force -ErrorAction SilentlyContinue }
  }
}

Write-Host 'Kiosk removed. Restart the computer.'
