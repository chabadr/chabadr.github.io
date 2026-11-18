@echo off
rem Removes the class kiosk user (and its files). Double-click it. It asks for administrator permission.
chcp 65001 >nul
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText('%~f0',[Text.Encoding]::UTF8); $i=$t.LastIndexOf('#PS'+'-START'); iex $t.Substring($i)"
echo.
pause
exit /b
#PS-START
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$UserName = 'כיתה'
function Show-Box($text, $buttons = 'OK', $icon = 'Information') {
  $opts = [System.Windows.Forms.MessageBoxOptions]::RtlReading -bor [System.Windows.Forms.MessageBoxOptions]::RightAlign
  return [System.Windows.Forms.MessageBox]::Show($text, 'משתמש קיוסק לכיתה', $buttons, $icon, 'Button1', $opts)
}
try {
  $u = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
  if (-not $u) { Show-Box "המשתמש ""$UserName"" לא קיים." 'OK' 'Information' | Out-Null; return }
  if ((Show-Box "למחוק את המשתמש ""$UserName"" ואת כל הקבצים שלו במחשב?" 'YesNo' 'Warning') -ne 'Yes') { return }
  $sid = $u.SID.Value
  Remove-LocalUser -Name $UserName
  $prof = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }
  if ($prof) { $prof | Remove-CimInstance }
  Show-Box "המשתמש ""$UserName"" נמחק." 'OK' 'Information' | Out-Null
} catch {
  Show-Box ("המחיקה נכשלה:`n" + $_.Exception.Message + "`n(אם המשתמש מחובר, התנתקו ממנו ונסו שוב.)") 'OK' 'Error' | Out-Null
}
