<#
  ctxmenu.ps1 — poof 右键菜单管理 CLI (Windows shell context-menu)

  当前能力:禁用/恢复第三方 ContextMenuHandler(COM 处理器),本用户级、无需管理员、可逆。
  原理:把 handler 的 CLSID 写进 HKCU\...\Shell Extensions\Blocked(资源管理器据此拒绝加载该处理器),
        而不是删除 HKLM 注册键(那需要管理员)。disable 前先 reg export 备份相关 shellex 键。

  用法:
    ctxmenu.ps1 find    -Name 0HVContext          # 按子键名定位 handler,打印 CLSID/DLL
    ctxmenu.ps1 disable -Name 0HVContext          # 一键:定位 + 备份 + 屏蔽
    ctxmenu.ps1 enable  -Name 0HVContext          # 恢复(按名解屏蔽)
    ctxmenu.ps1 enable  -Clsid {GUID}             # 恢复(按 CLSID 解屏蔽)
    ctxmenu.ps1 list-blocked                      # 列已屏蔽 CLSID
    ctxmenu.ps1 status  -Clsid {GUID}             # 查某 CLSID 是否被屏蔽
    ctxmenu.ps1 backup  -Name 0HVContext          # 仅备份(不改动)

  屏蔽后需重启资源管理器生效:Stop-Process -Name explorer (会自动重启)
  添加自定义右键项(非删除)走另一条路:vendor\nilesoft-shell,后续接入。
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('find', 'status', 'backup', 'block', 'unblock', 'disable', 'enable', 'list-blocked')]
  [string]$Action = 'status',
  [string]$Name,
  [string]$Clsid,
  [string]$Label = '',
  [string]$BackupDir
)

$ErrorActionPreference = 'Stop'
if (-not $BackupDir) { $BackupDir = Join-Path $PSScriptRoot '..\..\vendor\ctxmenu-backups' }

# 文件/文件夹右键 COM 处理器所在的 4 个标准根(reg.exe 形式,用于导出备份)
$RegRoots = @(
  'HKLM\SOFTWARE\Classes\*\shellex\ContextMenuHandlers',
  'HKLM\SOFTWARE\Classes\Directory\shellex\ContextMenuHandlers',
  'HKCU\SOFTWARE\Classes\*\shellex\ContextMenuHandlers',
  'HKCU\SOFTWARE\Classes\Directory\shellex\ContextMenuHandlers'
)
# 同 4 根的 PowerShell provider 形式(用于读取)
$PsRoots = @(
  'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Classes\*\shellex\ContextMenuHandlers',
  'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Classes\Directory\shellex\ContextMenuHandlers',
  'Registry::HKEY_CURRENT_USER\SOFTWARE\Classes\*\shellex\ContextMenuHandlers',
  'Registry::HKEY_CURRENT_USER\SOFTWARE\Classes\Directory\shellex\ContextMenuHandlers'
)
$BlockedKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Shell Extensions\Blocked'

function Get-DefaultValue($psPath) {
  try { (Get-Item -LiteralPath $psPath).GetValue('') } catch { $null }
}

function Resolve-Clsid($c) {
  $base = "Registry::HKEY_CLASSES_ROOT\CLSID\$c"
  [pscustomobject]@{
    Clsid = $c
    Name  = Get-DefaultValue $base
    Dll   = Get-DefaultValue "$base\InprocServer32"
  }
}

function Find-Handler($n) {
  $hits = @()
  for ($i = 0; $i -lt $PsRoots.Count; $i++) {
    $p = "$($PsRoots[$i])\$n"
    if (Test-Path -LiteralPath $p) {
      $hits += [pscustomobject]@{
        Key     = ($p -replace '^Registry::', '')
        RegKey  = "$($RegRoots[$i])\$n"
        Clsid   = Get-DefaultValue $p
      }
    }
  }
  $hits
}

function Backup-Handler($n) {
  $hits = Find-Handler $n
  if (-not $hits) { Write-Output "没有可备份的键(handler '$n' 不存在?)"; return }
  if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $count = 0
  foreach ($h in $hits) {
    $count++
    $safe = ($h.RegKey -replace '[\\:*]', '_')
    $file = Join-Path $BackupDir "$safe`_$stamp.reg"
    reg export $h.RegKey $file /y | Out-Null
    Write-Output "  备份: $($h.RegKey)  ->  $file"
  }
  Write-Output "  ($count 个键已备份)"
}

function Block-Clsid($c, $lbl) {
  if (-not (Test-Path $BlockedKey)) { New-Item -Path $BlockedKey -Force | Out-Null }
  New-ItemProperty -Path $BlockedKey -Name $c -Value $lbl -PropertyType String -Force | Out-Null
}

function Unblock-Clsid($c) {
  if (Test-Path $BlockedKey) { Remove-ItemProperty -Path $BlockedKey -Name $c -ErrorAction SilentlyContinue }
}

function Test-Blocked($c) {
  if (-not (Test-Path $BlockedKey)) { return $false }
  $v = Get-ItemProperty -Path $BlockedKey -ErrorAction SilentlyContinue
  return ($v.PSObject.Properties.Name -contains $c)
}

switch ($Action) {
  'find' {
    if (-not $Name) { throw "find 需要 -Name <handler子键名>,例: -Name 0HVContext" }
    $hits = Find-Handler $Name
    if (-not $hits) { Write-Output "未找到名为 '$Name' 的 ContextMenuHandler"; break }
    foreach ($h in $hits) {
      $info = Resolve-Clsid $h.Clsid
      Write-Output ("KEY   {0}" -f $h.Key)
      Write-Output ("CLSID {0}  ({1})" -f $info.Clsid, $info.Name)
      Write-Output ("DLL   {0}" -f $info.Dll)
      Write-Output ("BLOCKED(本用户) = {0}" -f (Test-Blocked $h.Clsid))
      Write-Output ""
    }
  }
  'status' {
    if (-not $Clsid) { throw "status 需要 -Clsid {GUID}" }
    Write-Output ("CLSID {0}  blocked(本用户) = {1}" -f $Clsid, (Test-Blocked $Clsid))
  }
  'backup' {
    if (-not $Name) { throw "backup 需要 -Name <handler子键名>" }
    Backup-Handler $Name
  }
  'block' {
    if (-not $Clsid) { throw "block 需要 -Clsid {GUID}" }
    Block-Clsid $Clsid $Label
    Write-Output "已屏蔽(本用户,可逆): $Clsid"
  }
  'unblock' {
    if (-not $Clsid) { throw "unblock 需要 -Clsid {GUID}" }
    Unblock-Clsid $Clsid
    Write-Output "已解除屏蔽: $Clsid"
  }
  'disable' {
    if (-not $Name) { throw "disable 需要 -Name <handler子键名>,例: -Name 0HVContext" }
    $hits = Find-Handler $Name
    if (-not $hits) { throw "未找到名为 '$Name' 的 ContextMenuHandler,无法禁用" }
    $c = ($hits | Select-Object -First 1).Clsid
    $info = Resolve-Clsid $c
    Write-Output "定位 '$Name' -> CLSID $c ($($info.Name))"
    Write-Output "备份相关键:"
    Backup-Handler $Name
    $lbl = if ($Label) { $Label } else { "$Name $($info.Name)" }
    Block-Clsid $c $lbl
    Write-Output "已禁用 '$Name' (屏蔽 CLSID $c)。"
    Write-Output "重启资源管理器生效:  Stop-Process -Name explorer   (会自动重启)"
  }
  'enable' {
    if (-not $Clsid -and -not $Name) { throw "enable 需要 -Name <handler子键名> 或 -Clsid {GUID}" }
    $c = $Clsid
    if (-not $c) {
      $hits = Find-Handler $Name
      if (-not $hits) { throw "未找到 '$Name',无法按名恢复;请用 -Clsid" }
      $c = ($hits | Select-Object -First 1).Clsid
    }
    Unblock-Clsid $c
    Write-Output "已恢复(解除屏蔽): $c。重启资源管理器生效。"
  }
  'list-blocked' {
    if (Test-Path $BlockedKey) {
      (Get-ItemProperty -Path $BlockedKey).PSObject.Properties |
        Where-Object { $_.Name -notlike 'PS*' } |
        ForEach-Object { Write-Output ("{0}    {1}" -f $_.Name, $_.Value) }
    }
    else { Write-Output "无屏蔽项" }
  }
}


