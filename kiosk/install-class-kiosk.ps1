# Run in an administrator PowerShell (see the instructions of the site). Same content as the .bat file.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---------------------------------------------------------------- settings
$UserName = 'כיתה'

# The only web sites the kiosk user can open (Edge). Everything else is blocked.
# (A site name covers all its pages and sub-sites.)
$AllowedPages = @(
  '1drv.ms',
  'accounts.google.co.il',
  'accounts.google.com',
  'd.docs.live.net',
  'docs.google.com',
  'id.rimon.net.il',
  'mail.google.com',
  'myaccount.google.com',
  'onedrive.live.com',
  'script.google.com',
  'workspace.google.com',
  'pshita.im'
)
$HomePage = 'https://docs.google.com/'

# The only programs the kiosk user can start from the desktop / Start menu.
$AllowedPrograms = @('EXCEL.EXE', 'msedge.exe', 'explorer.exe')

function Show-Box($text, $buttons = 'OK', $icon = 'Information') {
  $opts = [System.Windows.Forms.MessageBoxOptions]::RtlReading -bor [System.Windows.Forms.MessageBoxOptions]::RightAlign
  return [System.Windows.Forms.MessageBox]::Show($text, 'משתמש קיוסק לכיתה', $buttons, $icon, 'Button1', $opts)
}

function Set-KioskReg($sub, $name, $value, $kind = 'DWord') {
  $p = "Registry::HKEY_USERS\ClassKioskTmp\$sub"
  if (-not (Test-Path -LiteralPath $p)) { New-Item -Path $p -Force | Out-Null }
  New-ItemProperty -LiteralPath $p -Name $name -Value $value -PropertyType $kind -Force | Out-Null
}

function Set-KioskList($sub, $items) {
  $p = "Registry::HKEY_USERS\ClassKioskTmp\$sub"
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
  New-Item -Path $p -Force | Out-Null
  $i = 1
  foreach ($it in $items) {
    New-ItemProperty -LiteralPath $p -Name ([string]$i) -Value $it -PropertyType String -Force | Out-Null
    $i++
  }
}

function Find-AppPath($exe) {
  foreach ($root in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths') {
    $k = Join-Path $root $exe
    if (Test-Path $k) {
      $v = (Get-ItemProperty $k).'(default)'
      if ($v -and (Test-Path ($v.Trim('"')))) { return $v.Trim('"') }
    }
  }
  return $null
}

function New-Shortcut($file, $target, $arguments) {
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($file)
  $lnk.TargetPath = $target
  if ($arguments) { $lnk.Arguments = $arguments }
  $lnk.Save()
}

try {
  $listText = ($AllowedPages | ForEach-Object { '  ' + $_ }) -join "`n"
  $ask = "ייווצר משתמש מקומי בשם ""$UserName"" (משתמש רגיל, לא מנהל), שיוכל להפעיל רק:`n  • אקסל`n  • דפדפן Edge, עם גישה רק לאתרים האלה:`n$listText`n`nלהמשיך?"
  if ((Show-Box $ask 'YesNo' 'Question') -ne 'Yes') { return }

  $existing = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
  if (-not $existing) {
    $cred = Get-Credential -UserName $UserName -Message "בחרו סיסמה לחשבון ""$UserName"" (שם המשתמש לא ישתנה)"
    if (-not $cred -or $cred.Password.Length -eq 0) { Show-Box 'לא הוזנה סיסמה. ההתקנה בוטלה.' 'OK' 'Warning'; return }
    New-LocalUser -Name $UserName -Password $cred.Password -FullName $UserName -Description 'חשבון קיוסק לכיתה' -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
    Write-Host 'User created.'
  } else {
    Write-Host 'User already exists - updating its restrictions (password is not changed).'
  }

  # a regular user, never an administrator
  $usersGroup = Get-LocalGroup -SID 'S-1-5-32-545'
  $adminsGroup = Get-LocalGroup -SID 'S-1-5-32-544'
  if (-not (Get-LocalGroupMember -Group $usersGroup -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*\$UserName" })) {
    Add-LocalGroupMember -Group $usersGroup -Member $UserName
  }
  if (Get-LocalGroupMember -Group $adminsGroup -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*\$UserName" }) {
    Remove-LocalGroupMember -Group $adminsGroup -Member $UserName
  }

  # the user's profile folder (made now, so the restrictions are there before the first sign-in)
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ClassKioskUserEnv {
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
  public static extern int CreateProfile([MarshalAs(UnmanagedType.LPWStr)] string pszUserSid, [MarshalAs(UnmanagedType.LPWStr)] string pszUserName, [Out][MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszProfilePath, uint cchProfilePath);
}
'@
  $sid = (Get-LocalUser -Name $UserName).SID.Value
  $sb = New-Object System.Text.StringBuilder 260
  $hr = [ClassKioskUserEnv]::CreateProfile($sid, $UserName, $sb, 260)
  if ($hr -ne 0 -and $hr -ne -2147024713) { throw "CreateProfile failed: $hr" }
  $profile = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid").ProfileImagePath
  if (-not (Test-Path -LiteralPath "$profile\NTUSER.DAT")) { throw "No profile found for $UserName" }

  # ------------------------------------------------ restrictions (only for this user)
  & reg.exe load 'HKU\ClassKioskTmp' "$profile\NTUSER.DAT" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not open the user settings (is the user signed in? sign out first).' }
  try {
    $exp = 'Software\Microsoft\Windows\CurrentVersion\Policies\Explorer'
    Set-KioskReg $exp 'RestrictRun' 1
    Set-KioskList "$exp\RestrictRun" $AllowedPrograms
    Set-KioskReg $exp 'NoRun' 1
    Set-KioskReg $exp 'NoControlPanel' 1
    $sys = 'Software\Microsoft\Windows\CurrentVersion\Policies\System'
    Set-KioskReg $sys 'DisableTaskMgr' 1
    Set-KioskReg $sys 'DisableRegistryTools' 1
    Set-KioskReg $sys 'DisableChangePassword' 1
    Set-KioskReg 'Software\Policies\Microsoft\Windows\System' 'DisableCMD' 1

    $edge = 'Software\Policies\Microsoft\Edge'
    Set-KioskList "$edge\URLBlocklist" @('*', 'edge://*', 'file://*', 'view-source:*', 'javascript:*', 'chrome://*')
    Set-KioskList "$edge\URLAllowlist" $AllowedPages
    Set-KioskReg $edge 'DeveloperToolsAvailability' 2
    Set-KioskReg $edge 'InPrivateModeAvailability' 1
    Set-KioskReg $edge 'BrowserGuestModeEnabled' 0
    Set-KioskReg $edge 'BrowserAddProfileEnabled' 0
    Set-KioskReg $edge 'DownloadRestrictions' 3
    Set-KioskReg $edge 'HomepageLocation' $HomePage 'String'
    Set-KioskReg $edge 'HomepageIsNewTabPage' 0
    Set-KioskReg $edge 'NewTabPageLocation' $HomePage 'String'
    Set-KioskReg $edge 'RestoreOnStartup' 4
    Set-KioskList "$edge\RestoreOnStartupURLs" @($HomePage)
    Set-KioskList "$edge\ExtensionInstallBlocklist" @('*')
  } finally {
    [gc]::Collect(); [gc]::WaitForPendingFinalizers()
    $ErrorActionPreference = 'Continue'
    for ($i = 0; $i -lt 5; $i++) {
      & reg.exe unload 'HKU\ClassKioskTmp' 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { break }
      Start-Sleep -Seconds 1
    }
    $ErrorActionPreference = 'Stop'
  }

  # ------------------------------------------------ shortcuts
  # No desktop shortcuts: those of earlier versions are removed. Google Docs
  # (the home page) still opens by itself at sign-in.
  $desktop = Join-Path $profile 'Desktop'
  $startup = Join-Path $profile 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup'
  New-Item -ItemType Directory -Force -Path $startup | Out-Null
  foreach ($old in 'Excel.lnk', 'Google Docs.lnk', 'Excel ב-OneDrive.lnk', 'כיתה ז.lnk', 'הנוסע המתמיד ז1.lnk', 'משוב מורים.lnk', 'pshita.lnk') {
    Remove-Item -LiteralPath (Join-Path $desktop $old) -Force -ErrorAction SilentlyContinue
    if ($old -ne 'Google Docs.lnk') { Remove-Item -LiteralPath (Join-Path $startup $old) -Force -ErrorAction SilentlyContinue }
  }
  $edgeExe = Find-AppPath 'msedge.exe'
  $notes = @()
  if ($edgeExe) { New-Shortcut (Join-Path $startup 'Google Docs.lnk') $edgeExe $HomePage }
  else { $notes += 'Edge לא נמצא במחשב.' }

  $done = "הסתיים. המשתמש ""$UserName"" מוכן.`n`nכדי לבדוק: התנתקו, והתחברו אליו."
  if ($notes.Count) { $done += "`n`n" + ($notes -join "`n") }
  Show-Box $done 'OK' 'Information' | Out-Null
} catch {
  Show-Box ("ההתקנה נכשלה:`n" + $_.Exception.Message + "`n`nבשורה: " + $_.InvocationInfo.Line.Trim()) 'OK' 'Error' | Out-Null
}
