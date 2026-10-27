# ST-bridge 退出 DSH 后部署脚本
#
# 用法（在 Windows PowerShell 中运行，不要用 cmd）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File "D:\AIGC\MOSS\ST-bridge\deploy\apply-after-exit.ps1"
#
# 它会：
#   1. 确认 DSH Desktop 已完全退出、43121 端口已释放
#   2. 备份并同步 profile 里的 ST-bridge
#   3. 清空桥接 Bearer token（仅本机方案 A）
#   4. 打印启动 DSH 后的验证命令
#
# 不会：启动/停止 DSH、删除会话、修改插件配置或推送 Git。

$ErrorActionPreference = 'Stop'

$Repo     = 'D:\AIGC\MOSS\ST-bridge'
$Settings = Join-Path $env:USERPROFILE '.dsh\st-bridge\settings.json'
$Port     = 43121

function Fail([string]$Message) {
  Write-Host ""
  Write-Host "[失败] $Message" -ForegroundColor Red
  exit 1
}

Write-Host "=== ST-bridge 部署（DSH 已退出） ===" -ForegroundColor Cyan

# 1. 进程检查
$proc = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)
if ($proc.Count -gt 0) {
  Fail "DSH Desktop 仍在运行（$($proc.Count) 个进程）。请从托盘完全退出后再运行本脚本。"
}

# 2. 端口检查
try {
  $client = New-Object System.Net.Sockets.TcpClient
  $client.Connect('127.0.0.1', $Port)
  $client.Close()
  Fail "端口 $Port 仍被占用，说明桥接进程没退出。请完全退出 DSH Desktop 后重试。"
} catch {
  # 连接失败 = 端口已释放，继续
}

if (-not (Test-Path (Join-Path $Repo 'deploy.mjs'))) {
  Fail "找不到 $Repo\deploy.mjs，请确认仓库路径。"
}

# 3. 同步文件
Write-Host ""
Write-Host "[1/3] 同步源码到 profile ..." -ForegroundColor Yellow
Push-Location $Repo
try {
  & node deploy.mjs --apply
  if ($LASTEXITCODE -ne 0) { Fail "deploy.mjs --apply 失败（退出码 $LASTEXITCODE）。" }
} finally {
  Pop-Location
}

# 4. 清空 token（方案 A：仅本机）
Write-Host ""
Write-Host "[2/3] 清空 Bearer token（仅本机模式） ..." -ForegroundColor Yellow
if (Test-Path $Settings) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item -LiteralPath $Settings -Destination "$Settings.bak-$stamp" -Force

  $text = [System.IO.File]::ReadAllText($Settings, [System.Text.Encoding]::UTF8)
  $json = $text | ConvertFrom-Json
  $json.authToken = ''
  $json.clearAuthToken = $true
  if (-not $json.PSObject.Properties.Name.Contains('sessionOnStale')) {
    $json | Add-Member -NotePropertyName sessionOnStale -NotePropertyValue 'recreate' -Force
  }
  if (-not $json.PSObject.Properties.Name.Contains('sessionOnArchived')) {
    $json | Add-Member -NotePropertyName sessionOnArchived -NotePropertyValue 'recreate' -Force
  }
  if (-not $json.PSObject.Properties.Name.Contains('contextOverflow')) {
    $json | Add-Member -NotePropertyName contextOverflow -NotePropertyValue 'recreate' -Force
  }
  if (-not $json.PSObject.Properties.Name.Contains('transientRetry')) {
    $json | Add-Member -NotePropertyName transientRetry -NotePropertyValue 1 -Force
  }
  if (-not $json.PSObject.Properties.Name.Contains('appendFormat')) {
    $json | Add-Member -NotePropertyName appendFormat -NotePropertyValue 'nonce' -Force
  }
  if (-not $json.PSObject.Properties.Name.Contains('appendNonce') -or -not $json.appendNonce) {
    $json | Add-Member -NotePropertyName appendNonce -NotePropertyValue ([guid]::NewGuid().ToString('N').Substring(0, 8).ToUpper()) -Force
  }
  # 玉子手机只能发普通 OpenAI 请求：预置兼容模式，让它归入固定 scope。
  # 已有配置只补缺失字段，避免覆盖用户改过的 chat_id。
  if ($json.PSObject.Properties.Name -contains 'plainCompat' -and $null -ne $json.plainCompat) {
    $json.plainCompat.enabled = $true
    if (-not $json.plainCompat.PSObject.Properties.Name.Contains('clientId') -or -not $json.plainCompat.clientId) {
      $json.plainCompat | Add-Member -NotePropertyName clientId -NotePropertyValue 'yuzi-phone' -Force
    }
    if (-not $json.plainCompat.PSObject.Properties.Name.Contains('chatId') -or -not $json.plainCompat.chatId) {
      $json.plainCompat | Add-Member -NotePropertyName chatId -NotePropertyValue 'yuzi-phone' -Force
    }
    if (-not $json.plainCompat.PSObject.Properties.Name.Contains('taskId') -or -not $json.plainCompat.taskId) {
      $json.plainCompat | Add-Member -NotePropertyName taskId -NotePropertyValue 'default' -Force
    }
    if (-not $json.plainCompat.PSObject.Properties.Name.Contains('fixedMessageCount')) {
      $json.plainCompat | Add-Member -NotePropertyName fixedMessageCount -NotePropertyValue 1 -Force
    }
    if (-not $json.plainCompat.PSObject.Properties.Name.Contains('fixedMessageTypes') -or -not $json.plainCompat.fixedMessageTypes) {
      $json.plainCompat | Add-Member -NotePropertyName fixedMessageTypes -NotePropertyValue @('prefix') -Force
    }
  } else {
    $plainCompat = [pscustomobject]@{
      enabled           = $true
      clientId          = 'yuzi-phone'
      chatId            = 'yuzi-phone'
      taskId            = 'default'
      fixedMessageCount = 1
      fixedMessageTypes = @('prefix')
    }
    $json | Add-Member -NotePropertyName plainCompat -NotePropertyValue $plainCompat -Force
  }

  # 快照差分：生成专属标记；已有标记保持不变，避免旧快照失效。
  if ($json.PSObject.Properties.Name -contains 'snapshotDiff' -and $null -ne $json.snapshotDiff) {
    if (-not $json.snapshotDiff.marker) {
      $json.snapshotDiff | Add-Member -NotePropertyName marker -NotePropertyValue ([guid]::NewGuid().ToString('N').Substring(0, 12).ToUpper()) -Force
    }
    if (-not $json.snapshotDiff.PSObject.Properties.Name.Contains('enabled')) {
      $json.snapshotDiff | Add-Member -NotePropertyName enabled -NotePropertyValue $true -Force
    }
    if (-not $json.snapshotDiff.PSObject.Properties.Name.Contains('clients')) {
      $json.snapshotDiff | Add-Member -NotePropertyName clients -NotePropertyValue @('shujuku', 'yuzi-phone') -Force
    }
    if (-not $json.snapshotDiff.PSObject.Properties.Name.Contains('onDivergence')) {
      $json.snapshotDiff | Add-Member -NotePropertyName onDivergence -NotePropertyValue 'full' -Force
    }
    if (-not $json.snapshotDiff.PSObject.Properties.Name.Contains('mode')) {
      $json.snapshotDiff | Add-Member -NotePropertyName mode -NotePropertyValue 'auto' -Force
    }
    if (-not $json.snapshotDiff.PSObject.Properties.Name.Contains('maxBlockChars')) {
      $json.snapshotDiff | Add-Member -NotePropertyName maxBlockChars -NotePropertyValue 2000 -Force
    }
  } else {
    $snapshotDiff = [pscustomobject]@{
      enabled       = $true
      mode          = 'auto'
      maxBlockChars = 2000
      marker        = [guid]::NewGuid().ToString('N').Substring(0, 12).ToUpper()
      clients       = @('shujuku', 'yuzi-phone')
      onDivergence  = 'full'
    }
    $json | Add-Member -NotePropertyName snapshotDiff -NotePropertyValue $snapshotDiff -Force
  }

  $out = $json | ConvertTo-Json -Depth 20
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Settings, $out + "`n", $utf8NoBom)
  Write-Host "      已清空 token，备份: $Settings.bak-$stamp"
  Write-Host "      已预置 plainCompat：yuzi-phone / yuzi-phone / default"
  Write-Host ("      快照标记: " + $json.snapshotDiff.marker + "（面板可复制/重新生成）")
} else {
  Write-Host "      未找到 settings.json，跳过（桥接默认无 token）"
}

# 5. 提示
Write-Host ""
Write-Host "[3/3] 完成" -ForegroundColor Green
Write-Host ""
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  1. 启动 DSH Desktop"
Write-Host "  2. 运行验证："
Write-Host "     powershell -NoProfile -ExecutionPolicy Bypass -File `"$Repo\deploy\verify-after-start.ps1`""
Write-Host ""
Write-Host "验证通过后，到 DSH 设置 -> ST-bridge -> 固定预设 查看安装状态。" -ForegroundColor Gray
