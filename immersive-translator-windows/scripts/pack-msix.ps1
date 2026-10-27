# MSIX 商店打包：staging target/release 产物 + winapp pack 生成 .msix。
# 商店通道（MSIX 或 PWA 应用）：审核通过的包由商店自动重签名，无需代码签名证书。
# 本地安装调试：先 `winapp cert generate --if-exists skip`，再用 -CertPath 指向 devcert.pfx。
#
# 用法（在仓库 immersive-translator-windows/ 下）：
#   pwsh ./scripts/pack-msix.ps1                      # 默认从 target/release staging
#   pwsh ./scripts/pack-msix.ps1 -ReleaseDir <dir>    # 指定产物目录
param(
    # 构建产物目录（含 immersive-translator-windows.exe 与 bundle.resources）
    [string]$ReleaseDir = (Join-Path $PSScriptRoot "..\src-tauri\target\release"),
    # 输出目录（staging 布局 dist/ + 生成的 .msix）
    [string]$OutDir = (Join-Path $PSScriptRoot "..\build\msix"),
    # 可选：本地调试签名 pfx（商店提交不需要）
    [string]$CertPath = ""
)
$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$manifestSrc = Join-Path $projectRoot "src-tauri\msix\Package.appxmanifest"
$confPath = Join-Path $projectRoot "src-tauri\tauri.conf.json"
$iconsDir = Join-Path $projectRoot "src-tauri\icons"
$exeName = "immersive-translator-windows.exe"

# 1. 版本号取 tauri.conf.json（应用版本单一来源），替换清单占位符
$conf = Get-Content $confPath -Raw | ConvertFrom-Json
$version = $conf.version
if (-not $version) { throw "tauri.conf.json 缺少 version 字段" }
$manifest = (Get-Content $manifestSrc -Raw) -replace '@VERSION@', "$version.0"
if ($manifest -match '@VERSION@') { throw "清单版本占位符替换失败" }

# 2. staging 布局：exe + bundle.resources（与 NSIS 安装布局一致，资源相对 exe 解析）
$dist = Join-Path $OutDir "dist"
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$releaseExe = Join-Path $ReleaseDir $exeName
if (-not (Test-Path $releaseExe)) { throw "找不到 $releaseExe，请先执行 tauri build" }
Copy-Item $releaseExe $dist

# bundle.resources（tauri.conf.json）：models/*.onnx + DirectML.dll.payload
$modelsSrc = Join-Path $ReleaseDir "models"
if (Test-Path $modelsSrc) {
    Copy-Item $modelsSrc (Join-Path $dist "models") -Recurse
} else {
    throw "缺少资源目录 $modelsSrc（bundle.resources models/*.onnx）"
}
$dml = Join-Path $ReleaseDir "DirectML.dll.payload"
if (Test-Path $dml) { Copy-Item $dml $dist }

# 运行期可能存在的 DLL（如 WebView2Loader.dll，按配置可有可无），有则一并带上
Get-ChildItem $ReleaseDir -Filter *.dll -ErrorAction SilentlyContinue |
    ForEach-Object { Copy-Item $_.FullName $dist }

# 清单（替换版本后）+ 商店图标（tauri icon 已生成的同名的 Square/Store 资产）
Set-Content -Path (Join-Path $dist "Package.appxmanifest") -Value $manifest -Encoding UTF8
$assets = Join-Path $dist "Assets"
New-Item -ItemType Directory -Force -Path $assets | Out-Null
foreach ($name in @("Square44x44Logo.png", "Square150x150Logo.png", "Square71x71Logo.png", "Square310x310Logo.png", "StoreLogo.png")) {
    Copy-Item (Join-Path $iconsDir $name) $assets
}

# 3. winapp pack：商店提交不需要签名；本地调试传 -CertPath
Push-Location $OutDir
try {
    if ($CertPath -ne "") {
        winapp pack .\dist --cert $CertPath
        if ($LASTEXITCODE -ne 0) { throw "winapp pack 签名打包失败（exit $LASTEXITCODE）" }
    } else {
        winapp pack .\dist
        if ($LASTEXITCODE -ne 0) {
            # 部分版本 winapp 要求包必须签名：生成开发证书（自签，仅本地调试）后重试
            Write-Host "[pack-msix] 无证书打包失败，改用开发证书（自签，仅用于本地安装调试）" -ForegroundColor Yellow
            winapp cert generate --if-exists skip
            if (-not (Test-Path ".\devcert.pfx")) { throw "devcert.pfx 未生成，无法重试打包" }
            winapp pack .\dist --cert .\devcert.pfx
            if ($LASTEXITCODE -ne 0) { throw "winapp pack 失败（exit $LASTEXITCODE）" }
        }
    }
} finally {
    Pop-Location
}

# 4. 归一化产物名（对齐 NSIS 资产命名约定，便于发布流程统一处理）
$msix = Get-ChildItem $OutDir -Filter *.msix |
    Where-Object { $_.Name -notlike "ImmersiveTranslator_*" } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $msix) { throw "winapp pack 未产出 .msix" }
$assetName = "ImmersiveTranslator_${version}_x64.msix"
Copy-Item $msix.FullName (Join-Path $OutDir $assetName) -Force

Write-Host "[OK] MSIX 打包完成: $assetName"
Write-Host "[OK] 路径: $OutDir\$assetName"
