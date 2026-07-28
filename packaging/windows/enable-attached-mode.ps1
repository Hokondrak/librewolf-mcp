<#
.SYNOPSIS
Creates a LibreWolf shortcut that starts the browser ready for attached mode.

.DESCRIPTION
Attached mode joins the LibreWolf you already use, keeping your signed-in session while still
driving it through WebDriver BiDi — so input is native and console and network capture work.
Firefox only starts Marionette when it is passed --marionette on the command line; a preference
cannot enable it. This script therefore writes a shortcut carrying that flag, so launching
LibreWolf the way you normally do leaves it ready to attach.

SECURITY: while a browser started this way is running, it listens on a loopback automation port.
Any program running as you can drive that browser, including its signed-in sessions. Use a
dedicated shortcut you launch deliberately rather than replacing your default one, and close the
browser when you are finished. This script never replaces an existing shortcut unless -Force is
given, and it changes no browser preferences.

.EXAMPLE
.\enable-attached-mode.ps1
Previews the shortcut that would be created.

.EXAMPLE
.\enable-attached-mode.ps1 -Apply
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
  [switch]$Apply,
  [switch]$Force,
  [string]$LibreWolfPath = 'C:\Program Files\LibreWolf\librewolf.exe',
  [ValidateRange(1, 65535)][int]$MarionettePort = 2828,
  [ValidateRange(1, 65535)][int]$RemoteDebuggingPort = 9222,
  [string]$ShortcutPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'LibreWolf (agent ready).lnk')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $LibreWolfPath)) {
  throw "LibreWolf was not found at $LibreWolfPath. Pass -LibreWolfPath with its location."
}
if ((Test-Path -LiteralPath $ShortcutPath) -and -not $Force) {
  throw "$ShortcutPath already exists. Review it and re-run with -Force to replace it."
}

$arguments = "--marionette --remote-debugging-port $RemoteDebuggingPort"

if (-not $Apply) {
  Write-Output "Dry run: would create $ShortcutPath launching:"
  Write-Output "  `"$LibreWolfPath`" $arguments"
  Write-Output ''
  Write-Output 'While a browser started this way runs, it accepts local automation connections.'
  Write-Output 'Re-run with -Apply to create the shortcut.'
  return
}

if ($PSCmdlet.ShouldProcess($ShortcutPath, 'Create an attached-mode LibreWolf shortcut')) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $LibreWolfPath
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = Split-Path -Parent $LibreWolfPath
  $shortcut.Description = 'LibreWolf started so librewolf-agent-bridge can attach to this session'
  $shortcut.Save()

  Write-Output "Created $ShortcutPath"
  Write-Output ''
  Write-Output 'Launch LibreWolf from that shortcut, then configure your MCP client with:'
  Write-Output "  --mode attached --marionette-port $MarionettePort"
  Write-Output ''
  Write-Output 'Call browser_status to confirm; it should report mode "attached".'
}
