[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'LibreWolfAgentBridge\native-host'),

  [switch]$Apply,

  [switch]$RemoveManagedExtensionPolicy,

  [switch]$RemoveDedicatedProfiles,

  [string]$DedicatedProfileRoot = (Join-Path $env:LOCALAPPDATA 'LibreWolfAgentBridge\profiles')
)

$ErrorActionPreference = 'Stop'
$hostName = 'org.librewolf_agent_bridge.native'
$extensionId = 'librewolf-agent-bridge@librewolf-agent-bridge.org'
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required for a per-user native-host removal.' }

$dataRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'LibreWolfAgentBridge'))
$allowedInstallRoot = Join-Path $dataRoot 'native-host'
$resolvedInstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$runtimeRoot = Join-Path $dataRoot 'runtime'
$defaultProfileRoot = Join-Path $dataRoot 'profiles'
$resolvedProfileRoot = [IO.Path]::GetFullPath($DedicatedProfileRoot)
$registryPath = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
$policyPath = 'HKCU:\Software\Policies\Mozilla\Firefox\ExtensionSettings'

function Assert-ContainedPath([string]$Path, [string]$Root, [string]$Label) {
  $normalizedPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $normalizedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  if (
    -not $normalizedPath.Equals($normalizedRoot, [StringComparison]::OrdinalIgnoreCase) -and
    -not $normalizedPath.StartsWith("$normalizedRoot\", [StringComparison]::OrdinalIgnoreCase)
  ) { throw "$Label must stay inside $normalizedRoot." }
}

Assert-ContainedPath $resolvedInstallRoot $allowedInstallRoot 'InstallRoot'
Assert-ContainedPath $runtimeRoot $dataRoot 'Runtime root'
if ($RemoveDedicatedProfiles -and -not $resolvedProfileRoot.Equals($defaultProfileRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "DedicatedProfileRoot must be the default managed profile root: $defaultProfileRoot"
}

if (-not $Apply) {
  Write-Output "Dry run: would remove $registryPath, $resolvedInstallRoot, and the bridge runtime/discovery directory $runtimeRoot. Re-run with -Apply to make changes."
  if ($RemoveManagedExtensionPolicy) { Write-Output "Dry run: would remove only the managed policy value for $extensionId." }
  if ($RemoveDedicatedProfiles) { Write-Output "Dry run: would permanently remove dedicated profiles at $resolvedProfileRoot." }
  return
}

if ($PSCmdlet.ShouldProcess($registryPath, 'Remove per-user native messaging registration')) {
  if (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath -Force }
}
if ($PSCmdlet.ShouldProcess($resolvedInstallRoot, 'Remove copied native-host payload and manifest')) {
  if (Test-Path -LiteralPath $resolvedInstallRoot) {
    Assert-ContainedPath $resolvedInstallRoot $allowedInstallRoot 'Install root'
    Remove-Item -LiteralPath $resolvedInstallRoot -Recurse -Force
  }
}
if ($PSCmdlet.ShouldProcess($runtimeRoot, 'Remove bridge runtime discovery records')) {
  if (Test-Path -LiteralPath $runtimeRoot) {
    Assert-ContainedPath $runtimeRoot $dataRoot 'Runtime root'
    Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
  }
}
if ($RemoveManagedExtensionPolicy -and $PSCmdlet.ShouldProcess($policyPath, 'Remove optional per-user managed extension policy')) {
  if (Test-Path -LiteralPath $policyPath) {
    Remove-ItemProperty -LiteralPath $policyPath -Name $extensionId -ErrorAction SilentlyContinue
  }
}
if ($RemoveDedicatedProfiles -and $PSCmdlet.ShouldProcess($resolvedProfileRoot, 'Permanently remove dedicated controlled profiles')) {
  if (Test-Path -LiteralPath $resolvedProfileRoot) {
    Remove-Item -LiteralPath $resolvedProfileRoot -Recurse -Force
  }
}

Write-Output "Removed the per-user native-host registration, copied payload, and runtime/discovery records. No ordinary LibreWolf profile was removed."
