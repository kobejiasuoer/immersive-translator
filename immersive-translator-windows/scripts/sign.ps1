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

# SignPath 云端签名分支（CI 用）：设置了 SIGNPATH_API_TOKEN 时启用。
# 私钥由 SignPath Foundation 托管在 HSM，本地与 CI 均不接触私钥；
# 待签名文件会被签名产物原地覆盖，满足 tauri signCommand 的钩子契约
# （先签主程序 exe 再打 NSIS 包、再签安装包，保证包内包外全部 PE 带签名）。
# 配置位置（基金会开通后填写）：
#   secrets: SIGNPATH_API_TOKEN / SIGNPATH_ORGANIZATION_ID
#   vars:    SIGNPATH_PROJECT_SLUG（默认 immersive-translator）
#            SIGNPATH_SIGNING_POLICY_SLUG（默认 release-signing）
if ($env:SIGNPATH_API_TOKEN) {
    if (-not (Test-Path $TargetFile)) {
        Write-Error "待签名文件不存在: $TargetFile"
        exit 1
    }
    foreach ($required in @("SIGNPATH_ORGANIZATION_ID", "SIGNPATH_PROJECT_SLUG", "SIGNPATH_SIGNING_POLICY_SLUG")) {
        if (-not (Get-Item -Path "env:$required" -ErrorAction SilentlyContinue)) {
            Write-Error "SIGNPATH_API_TOKEN 已设置，但缺少 $required（请在仓库 vars/secrets 中配置）。"
            exit 1
        }
    }
    if (-not (Get-Module -ListAvailable -Name SignPath)) {
        Write-Host "[SignPath] 安装 PowerShell 模块 SignPath..."
        Install-Module -Name SignPath -Force -Scope CurrentUser
    }
    Import-Module -Name SignPath

    $versionLabel = if ($env:RELEASE_VERSION) { " v$($env:RELEASE_VERSION)" } else { "" }
    $description = "ImmersiveTranslator$versionLabel - $(Split-Path -Leaf $TargetFile)"
    Write-Host "[SignPath] 提交签名请求: $description"
    try {
        Submit-SigningRequest `
            -Url "https://app.signpath.io/API/v1" `
            -OrganizationId $env:SIGNPATH_ORGANIZATION_ID `
            -ProjectSlug $env:SIGNPATH_PROJECT_SLUG `
            -SigningPolicySlug $env:SIGNPATH_SIGNING_POLICY_SLUG `
            -ApiToken $env:SIGNPATH_API_TOKEN `
            -File $TargetFile `
            -Description $description `
            -WaitForCompletion `
            -Force
    } catch {
        Write-Error "SignPath 签名失败: $_"
        exit 1
    }
    # 注意：若基金会签名策略配置了人工审批，Submit-SigningRequest 会阻塞等
    # 审批完成；workflow 默认 6 小时超时足够，审批通知走 SignPath 控制台/邮件。
    Write-Host "[OK] SignPath 签名完成: $TargetFile"
    exit 0
}

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
