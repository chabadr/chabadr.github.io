# Changes the password of the class kiosk user. Run in an administrator PowerShell (see the instructions of the site).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$UserName = 'כיתה'
function Show-Box($text, $buttons = 'OK', $icon = 'Information') {
  $opts = [System.Windows.Forms.MessageBoxOptions]::RtlReading -bor [System.Windows.Forms.MessageBoxOptions]::RightAlign
  return [System.Windows.Forms.MessageBox]::Show($text, 'משתמש קיוסק לכיתה', $buttons, $icon, 'Button1', $opts)
}
try {
  $u = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
  if (-not $u) { Show-Box "המשתמש ""$UserName"" לא קיים במחשב הזה." 'OK' 'Warning' | Out-Null; return }
  $cred = Get-Credential -UserName $UserName -Message "בחרו סיסמה חדשה למשתמש ""$UserName"" (שם המשתמש לא ישתנה)"
  if (-not $cred -or $cred.Password.Length -eq 0) { Show-Box 'לא הוזנה סיסמה. הסיסמה לא שונתה.' 'OK' 'Warning' | Out-Null; return }
  Set-LocalUser -Name $UserName -Password $cred.Password
  Show-Box "הסיסמה של ""$UserName"" שונתה." 'OK' 'Information' | Out-Null
} catch {
  Show-Box ("שינוי הסיסמה נכשל:`n" + $_.Exception.Message) 'OK' 'Error' | Out-Null
}
