# ST-bridge 启动 DSH 后验证脚本
#
# 用法（启动 DSH Desktop 后运行）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File "D:\AIGC\MOSS\ST-bridge\deploy\verify-after-start.ps1"
#
# 会核对：运行进程指纹、/health、固定预设接口可用性。

$ErrorActionPreference = 'Stop'

$Repo     = 'D:\AIGC\MOSS\ST-bridge'
$Settings = Join-Path $env:USERPROFILE '.dsh\st-bridge\settings.json'
$Port     = 43121

function Fail([string]$Message) {
  Write-Host ""
  Write-Host "[失败] $Message" -ForegroundColor Red
  exit 1
}

Write-Host "=== ST-bridge 运行验证 ===" -ForegroundColor Cyan

if (-not (Test-Path $Settings)) {
  Fail "找不到 $Settings；桥接可能从未启动过。"
}

Push-Location $Repo
try {
  Write-Host ""
  Write-Host "[1/3] 核对运行进程与源码指纹 ..." -ForegroundColor Yellow
  & node deploy.mjs --verify-running
  if ($LASTEXITCODE -ne 0) {
    Fail @"
运行进程与源码不一致。常见原因：
  - DSH 没有完全重启（托盘退出后重新打开）
  - 部署没有真正写入 profile
  - 43121 是旧进程
请完全退出 DSH，重新运行 apply-after-exit.ps1，再启动。
"@
  }

  Write-Host ""
  Write-Host "[2/3] 读取 /health ..." -ForegroundColor Yellow
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
  $health | ConvertTo-Json -Depth 6

  Write-Host ""
  Write-Host "[3/3] 检查固定预设接口 ..." -ForegroundColor Yellow
  $presets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/bridge/fixed-presets" -TimeoutSec 5
  Write-Host ("      已配置固定预设: {0} 条；已安装 scope: {1} 个" -f $presets.presets.Count, $presets.installs.Count)
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "验证通过。" -ForegroundColor Green
Write-Host "打开 DSH 设置 -> ST-bridge -> 固定预设 可查看安装状态与字符统计。" -ForegroundColor Gray
