# 把固定预设配置提交给运行中的 ST-bridge
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File "D:\AIGC\MOSS\ST-bridge\deploy\apply-fixed-presets.ps1" -File "D:\path\preset.json"
#
# 可选：
#   -Port 43121
#   -Show   提交后打印当前配置（不含正文）

param(
  [Parameter(Mandatory = $true)][string]$File,
  [int]$Port = 43121,
  [switch]$Show
)

$ErrorActionPreference = 'Stop'
$Settings = Join-Path $env:USERPROFILE '.dsh\st-bridge\settings.json'

if (-not (Test-Path $File)) { throw "找不到配置文件: $File" }
$body = [System.IO.File]::ReadAllText($File, [System.Text.Encoding]::UTF8)
try { $null = $body | ConvertFrom-Json } catch { throw "配置文件不是合法 JSON" }

$headers = @{ 'content-type' = 'application/json' }
if (Test-Path $Settings) {
  $settings = [System.IO.File]::ReadAllText($Settings, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($settings.authToken) { $headers['authorization'] = "Bearer $($settings.authToken)" }
}

$uri = "http://127.0.0.1:$Port/v1/bridge/fixed-presets"
try {
  $result = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $body -TimeoutSec 10
} catch {
  throw "提交失败：$($_.Exception.Message)。请确认 DSH 与桥接正在运行，且 token 一致。"
}

Write-Host "已提交。当前配置：" -ForegroundColor Green
$result.presets | ForEach-Object {
  Write-Host ("  {0}  {1}/{2}  {3}  {4}" -f $_.id, $_.client_id, $_.task_id, $_.mode, $_.hash.Substring(0, 12))
}

if ($Show) {
  $current = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -TimeoutSec 10
  $current.installs | ForEach-Object {
    Write-Host ("  scope {0}/{1}/{2}: {3}" -f $_.client_id, $_.chat_id, $_.task_id, $_.last_status)
  }
}
