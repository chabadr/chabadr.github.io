#Requires -RunAsAdministrator
<#
  Undoes setup-kiosk.ps1: the kiosk user gets the normal Windows desktop back,
  the Edge restrictions and the Task Manager block are removed, and automatic
  sign-in is turned off. The user itself is kept unless -DeleteUser is given.
#>
param(
  [string]$KioskUser = 'kita',
  [switch]$DeleteUser
)
$ErrorActionPreference = 'Stop'

$user = Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue
if ($user) {
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
      Remove-ItemProperty -Path "$hive\Software\Microsoft\Windows\CurrentVersion\Policies\System" -Name 'DisableTaskMgr' -ErrorAction SilentlyContinue
      Remove-Item -Path "$hive\Software\Policies\Microsoft\Edge" -Recurse -Force -ErrorAction SilentlyContinue
    }
  } finally {
    if ($loadedHere) {
      [gc]::Collect(); [gc]::WaitForPendingFinalizers()
      & reg.exe unload 'HKU\KioskSetup' | Out-Null
    }
  }
  if ($DeleteUser) { Remove-LocalUser -Name $KioskUser; Write-Host "Deleted user $KioskUser (its folder in C:\Users can be deleted by hand)" }
}

$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
if ((Get-ItemProperty $winlogon -ErrorAction SilentlyContinue).DefaultUserName -eq $KioskUser) {
  Set-ItemProperty $winlogon 'AutoAdminLogon' '0'
  Remove-ItemProperty $winlogon -Name 'DefaultPassword' -ErrorAction SilentlyContinue
}
Remove-Item -Path "$env:SystemDrive\Kiosk" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host 'Kiosk removed. Restart the computer.'
