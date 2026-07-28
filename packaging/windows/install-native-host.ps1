[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
  [string]$PayloadRoot,

  [string]$NodePath,

  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'LibreWolfAgentBridge\native-host'),

  [switch]$Apply,

  [switch]$Force,

  [switch]$RegisterManagedExtensionPolicy,

  [string]$ManagedExtensionXpiPath
)

$ErrorActionPreference = 'Stop'
$hostName = 'org.librewolf_agent_bridge.native'
$extensionId = 'librewolf-agent-bridge@librewolf-agent-bridge.org'

if (-not $env:LOCALAPPDATA) {
  throw 'LOCALAPPDATA is required for a per-user native-host installation.'
}

$dataRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'LibreWolfAgentBridge'))
$allowedInstallRoot = Join-Path $dataRoot 'native-host'
$resolvedInstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$resolvedPayloadRoot = (Resolve-Path -LiteralPath $PayloadRoot).Path
$templatePath = Join-Path $PSScriptRoot 'native-host.manifest.template.json'

function Assert-ContainedPath([string]$Path, [string]$Root, [string]$Label) {
  $normalizedPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $normalizedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  if (
    -not $normalizedPath.Equals($normalizedRoot, [StringComparison]::OrdinalIgnoreCase) -and
    -not $normalizedPath.StartsWith("$normalizedRoot\", [StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "$Label must stay inside $normalizedRoot."
  }
}

function Resolve-CompatibleNode([string]$RequestedPath, [string]$PayloadPath) {
  $candidates = @()
  if ($RequestedPath) { $candidates += $RequestedPath }
  $bundled = Join-Path $PayloadPath 'node\node.exe'
  if (Test-Path -LiteralPath $bundled -PathType Leaf) { $candidates += $bundled }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }

  foreach ($candidate in $candidates | Select-Object -Unique) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
      $version = (& $candidate --version 2>$null).Trim()
      if ($version -notmatch '^v?(\d+)\.(\d+)\.(\d+)') { continue }
      $major = [int]$Matches[1]
      $minor = [int]$Matches[2]
      if ($major -gt 20 -or ($major -eq 20 -and $minor -ge 19)) {
        return (Resolve-Path -LiteralPath $candidate).Path
      }
    } catch {
      continue
    }
  }
  throw 'Node.js >=20.19.0 was not found. Supply -NodePath or include node\node.exe in the payload.'
}

function Set-CurrentUserOnlyAcl([string]$Path) {
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $currentUser) { throw 'Could not determine the current Windows user SID.' }
  $items = @((Get-Item -LiteralPath $Path)) + @(Get-ChildItem -LiteralPath $Path -Force -Recurse)
  if ($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
    throw 'Refusing to secure a payload containing a reparse point.'
  }
  foreach ($item in $items) {
    $acl = if ($item.PSIsContainer) {
      [Security.AccessControl.DirectorySecurity]::new()
    } else {
      [Security.AccessControl.FileSecurity]::new()
    }
    $inheritance = if ($item.PSIsContainer) {
      [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
      [Security.AccessControl.InheritanceFlags]::None
    }
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $currentUser,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.SetOwner($currentUser)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $item.FullName -AclObject $acl
  }
}

Assert-ContainedPath $resolvedInstallRoot $allowedInstallRoot 'InstallRoot'
foreach ($required in @('dist\cli.js', 'dist\native\secure-pipe-helper.exe')) {
  $candidate = Join-Path $resolvedPayloadRoot $required
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "Packaged native-host payload is missing ${required}: $candidate"
  }
}
if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) {
  throw "Native-host manifest template was not found: $templatePath"
}
if ((Test-Path -LiteralPath $resolvedInstallRoot) -and -not $Force) {
  throw "Install root already exists: $resolvedInstallRoot. Review it and re-run with -Force to replace it."
}
if ($RegisterManagedExtensionPolicy) {
  if (-not $ManagedExtensionXpiPath) {
    throw '-RegisterManagedExtensionPolicy requires -ManagedExtensionXpiPath.'
  }
  if (-not (Test-Path -LiteralPath $ManagedExtensionXpiPath -PathType Leaf)) {
    throw "Managed extension XPI was not found: $ManagedExtensionXpiPath"
  }
}

$resolvedNode = Resolve-CompatibleNode $NodePath $resolvedPayloadRoot
$manifestPath = Join-Path $resolvedInstallRoot "$hostName.json"
$launcherPath = Join-Path $resolvedInstallRoot 'librewolf-agent-native-host.cmd'
$registryPath = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
$policyPath = 'HKCU:\Software\Policies\Mozilla\Firefox\ExtensionSettings'
$stageRoot = Join-Path $dataRoot "staging\native-host-$PID"

if (-not $Apply) {
  Write-Output "Dry run: would copy $resolvedPayloadRoot to $resolvedInstallRoot, require Node >=20.19.0 at $resolvedNode, create $manifestPath, secure it to the current user, and register $registryPath. Re-run with -Apply to make changes."
  if ($RegisterManagedExtensionPolicy) {
    Write-Output "Dry run: would add the optional per-user managed-extension policy at $policyPath for $extensionId."
  }
  return
}

if ($PSCmdlet.ShouldProcess($resolvedInstallRoot, 'Install per-user native host and secure helper')) {
  Assert-ContainedPath $stageRoot $dataRoot 'Staging path'
  if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  Copy-Item -LiteralPath $resolvedPayloadRoot -Destination (Join-Path $stageRoot 'payload') -Recurse -Force

  # Firefox launches a native messaging host as: <host> <manifest-path> <extension-id>. The host
  # verifies the calling extension ID and refuses to start without the manifest path, so both
  # must be forwarded verbatim. Synthesising --extension-id here dropped the manifest path and
  # made every launch fail with "Native host manifest path is missing or invalid."
  $launcher = "@echo off`r`nsetlocal DisableDelayedExpansion`r`n`"$resolvedNode`" `"%~dp0payload\dist\cli.js`" %*`r`nexit /b %ERRORLEVEL%`r`n"
  Set-Content -LiteralPath (Join-Path $stageRoot 'librewolf-agent-native-host.cmd') -Value $launcher -Encoding ascii
  $escapedLauncher = $launcherPath.Replace('\', '\\')
  $manifest = (Get-Content -LiteralPath $templatePath -Raw).Replace('__HOST_PATH__', $escapedLauncher)
  # Firefox rejects a native-messaging manifest that carries a UTF-8 BOM, and Windows
  # PowerShell 5.1 — the default shell on Windows — has no "utf8NoBOM" encoding. Write the
  # bytes directly so this works on both 5.1 and PowerShell 7+.
  [System.IO.File]::WriteAllText(
    (Join-Path $stageRoot "$hostName.json"),
    $manifest,
    (New-Object System.Text.UTF8Encoding $false)
  )

  if (Test-Path -LiteralPath $resolvedInstallRoot) {
    Assert-ContainedPath $resolvedInstallRoot $allowedInstallRoot 'Existing install root'
    Remove-Item -LiteralPath $resolvedInstallRoot -Recurse -Force
  }
  Move-Item -LiteralPath $stageRoot -Destination $resolvedInstallRoot
  Set-CurrentUserOnlyAcl $resolvedInstallRoot

  New-Item -Path $registryPath -Force | Out-Null
  Set-Item -LiteralPath $registryPath -Value $manifestPath

  if ($RegisterManagedExtensionPolicy) {
    $xpiUri = ([Uri]((Resolve-Path -LiteralPath $ManagedExtensionXpiPath).Path)).AbsoluteUri
    $policy = @{ installation_mode = 'force_installed'; install_url = $xpiUri } | ConvertTo-Json -Compress
    New-Item -Path $policyPath -Force | Out-Null
    New-ItemProperty -Path $policyPath -Name $extensionId -Value $policy -PropertyType String -Force | Out-Null
  }
}

Write-Output "Installed $hostName for the current user. The copied payload includes the secure Windows pipe helper; confirm companion capabilities with browser_status."
