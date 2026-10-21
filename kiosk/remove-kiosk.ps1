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
    $explorerPol = "$hive\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"
    foreach ($n in 'RestrictRun', 'NoRun', 'NoControlPanel', 'NoViewOnDrive') { Remove-ItemProperty -Path $explorerPol -Name $n -ErrorAction SilentlyContinue }
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
Remove-Item -Path "$env:SystemDrive\Kiosk" -Recurse -Force -ErrorAction SilentlyContinue
if ($profilePath) {
  $names = @((-join [char[]](0x05DB, 0x05D9, 0x05EA, 0x05D4, 0x20, 0x05D6)), (-join [char[]](0x05DE, 0x05E9, 0x05D5, 0x05D1)))
  foreach ($d in @("$profilePath\Desktop", "$profilePath\OneDrive\Desktop")) {
    foreach ($n in $names) { Remove-Item -Path "$d\$n.lnk" -Force -ErrorAction SilentlyContinue }
  }
}

Write-Host 'Kiosk removed. Restart the computer.'
