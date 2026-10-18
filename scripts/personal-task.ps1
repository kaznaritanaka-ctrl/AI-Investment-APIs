param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$repositoryPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $repositoryPath
# Task Scheduler starts this wrapper with -WindowStyle Hidden. No credentials in arguments.
. (Join-Path $PSScriptRoot 'personal-key.ps1')
$taskConfig = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ($taskConfig.version -ne 'personal-automation-v1' -or $taskConfig.status -ne 'approved_for_local_operation' -or $taskConfig.enabled -ne $true -or -not $taskConfig.owner_setup_approval_ref) {
  throw 'personal_automation_unapproved'
}
$loadedKeys = @()
try {
  foreach ($entry in $taskConfig.sources) {
    if ($entry.backup_key_env -cnotmatch '^PERSONAL_BACKUP_KEY_[A-Z0-9_]+$') { throw 'personal_key_name_invalid' }
    # A missing key still permits source maintenance/deletion, and cannot stop other sources.
    [Environment]::SetEnvironmentVariable($entry.backup_key_env, $null, 'Process')
    $loadedKeys += $entry.backup_key_env
    try { Import-PersonalBackupKey -Path $entry.protected_key_path -Variable $entry.backup_key_env }
    catch { Write-Output 'personal_backup_key_unavailable' }
  }
  & node (Join-Path $PSScriptRoot 'personal-automation.mjs') once --config $ConfigPath
  $resultCode = $LASTEXITCODE
} finally {
  foreach ($keyName in $loadedKeys) { [Environment]::SetEnvironmentVariable($keyName, $null, 'Process') }
}
exit $resultCode
