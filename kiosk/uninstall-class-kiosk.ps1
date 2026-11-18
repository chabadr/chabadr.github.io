# Run in an administrator PowerShell (see the instructions of the site). Same content as the .bat file.
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
