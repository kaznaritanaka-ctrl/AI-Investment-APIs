# Library only: importing this file creates no key or file.
# Format: personal-key-dpapi-v1:<base64 DPAPI CurrentUser ciphertext>.
[void][Reflection.Assembly]::LoadWithPartialName('System.Security')
function Import-PersonalBackupKey {
  param([Parameter(Mandatory=$true)][string]$Path, [Parameter(Mandatory=$true)][string]$Variable)
  if ($Variable -cnotmatch '^PERSONAL_BACKUP_KEY_[A-Z0-9_]+$') { throw 'personal_key_name_invalid' }
  if (-not [System.IO.Path]::IsPathRooted($Path) -or $Path.StartsWith('\\')) { throw 'personal_key_path_invalid' }
  $keyItem = [System.IO.FileInfo]::new($Path)
  if ($keyItem.Length -gt 16384 -or ($keyItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'personal_key_file_invalid' }
  $encoded = [System.IO.File]::ReadAllText($Path).Trim()
  if (-not $encoded.StartsWith('personal-key-dpapi-v1:')) { throw 'personal_key_file_invalid' }
  $plain = $null
  try {
    $cipher = [Convert]::FromBase64String($encoded.Substring(22))
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $value = [Text.Encoding]::UTF8.GetString($plain)
    if ($value -cnotmatch '^[a-fA-F0-9]{64}$') { throw 'personal_key_invalid' }
    [Environment]::SetEnvironmentVariable($Variable,$value,'Process')
  } finally {
    $value = $null
    if ($null -ne $plain) { [Array]::Clear($plain,0,$plain.Length) }
  }
}
