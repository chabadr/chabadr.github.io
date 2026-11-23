# Installs the Mashov attendance updater for this Windows user (no administrator needed).
# Run in PowerShell:  $w=New-Object Net.WebClient;$w.Encoding=[Text.Encoding]::UTF8;iex $w.DownloadString('https://chabadr.github.io/mashov/install-mashov.ps1')
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:USERPROFILE 'mashov-auto'
$base = 'https://chabadr.github.io/mashov/'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$w = New-Object Net.WebClient
$w.Encoding = [Text.Encoding]::UTF8
foreach ($f in 'mashov-update.mjs', 'package.json') {
  [IO.File]::WriteAllText((Join-Path $dir $f), $w.DownloadString($base + $f), (New-Object Text.UTF8Encoding $false))
}
Write-Host 'Files downloaded. Installing (a minute)...'
# The school network checks secure connections with its own certificate: Node uses the Windows certificates.
$env:NODE_OPTIONS = '--use-system-ca'
Push-Location $dir
& npm.cmd install --no-audit --no-fund
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw 'npm install failed' }

$desktop = [Environment]::GetFolderPath('Desktop')
$sh = New-Object -ComObject WScript.Shell
function Add-Shortcut($name, $nodeArgs, $keepOpen) {
  $lnk = $sh.CreateShortcut((Join-Path $desktop ($name + '.lnk')))
  $lnk.TargetPath = $env:ComSpec
  $flag = if ($keepOpen) { '/k' } else { '/c' }
  $lnk.Arguments = "$flag cd /d `"$dir`" && set NODE_OPTIONS=--use-system-ca && node mashov-update.mjs $nodeArgs"
  $lnk.WorkingDirectory = $dir
  $lnk.Save()
}
Add-Shortcut 'משוב - מילוי נוכחות' '' $false
Add-Shortcut 'משוב - החלפת סיסמה' '--login' $true
# The mashov-fill: link (the "מילוי נוכחות במשוב" button of the class board) starts the filler.
# Nothing from the link is passed on: it can only start the filling (which never saves).
$key = 'HKCU:\Software\Classes\mashov-fill'
New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value 'URL:Mashov attendance'
New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
Set-ItemProperty -Path "$key\shell\open\command" -Name '(default)' -Value ("`"$env:ComSpec`" /c cd /d `"$dir`" && set NODE_OPTIONS=--use-system-ca && node mashov-update.mjs")
Write-Host ''
Write-Host 'Done. Two shortcuts were added to the desktop, and the button of the class board works on this computer.'
