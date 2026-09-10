# 给单个文件做 Authenticode 签名（SHA-256 + RFC3161 时间戳）。
# 由 tauri.conf.json -> bundle.windows.signCommand 调用，%1 占位符会被 Tauri
# 替换为待签名文件的完整路径（主程序 exe 和 NSIS 安装包各调用一次）。
# 证书不存在时仅警告并放行（CI 等无证书环境仍可出未签名包），本地开发机
# 需先运行 scripts\generate-signing-cert.ps1 生成证书。
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetFile
)
$ErrorActionPreference = "Stop"

$signingDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\signing"))
$pfxPath = Join-Path $signingDir "immersive-translator-codesign.pfx"
$passPath = Join-Path $signingDir "password.txt"
$timestampUrl = "http://timestamp.digicert.com"

if (-not (Test-Path $pfxPath)) {
    Write-Host "[WARN] 找不到 $pfxPath，跳过签名（产物将不带 Authenticode 签名）。" -ForegroundColor Yellow
    Write-Host "       本地构建请先运行 scripts\generate-signing-cert.ps1。" -ForegroundColor Yellow
    exit 0
}
if (-not (Test-Path $TargetFile)) {
    Write-Error "待签名文件不存在: $TargetFile"
    exit 1
}

# 找 signtool：先看 PATH，再扫 Windows Kits 各版本目录取最新的 x64 版
$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Source -First 1
if (-not $signtool) {
    $kitsRoot = "C:\Program Files (x86)\Windows Kits\10\bin"
    if (Test-Path $kitsRoot) {
        $signtool = Get-ChildItem $kitsRoot -Directory |
            Where-Object { $_.Name -like "10.*" } |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName "x64\signtool.exe" } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
    }
}
if (-not $signtool) {
    Write-Error "找不到 signtool.exe，请安装 Windows SDK（或 Visual Studio Build Tools）。"
    exit 1
}

$plain = (Get-Content $passPath -Raw).Trim()

Write-Host "[Sign] signtool -> $TargetFile"
& $signtool sign /fd SHA256 /td SHA256 /tr $timestampUrl /f $pfxPath /p $plain $TargetFile
if ($LASTEXITCODE -ne 0) {
    Write-Error "signtool 签名失败（exit $LASTEXITCODE）"
    exit $LASTEXITCODE
}
Write-Host "[OK] 签名完成"
exit 0
