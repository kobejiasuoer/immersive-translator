# MSIX 商店打包：staging target/release 产物 + MakeAppx 生成 .msix。
# 商店通道（MSIX 或 PWA 应用）：审核通过的包由商店自动重签名，无需代码签名证书；
# 打包只需 makeappx（Windows SDK 自带，GitHub windows runner 与本机均有）。
# 不用 winapp CLI：它要求 Windows 11 且经 winget 安装，CI Server runner 上两者皆缺
# （v0.11.1 实测 winget/winapp 双双 exit 1）。
# 本地安装调试：自行用 winapp cert generate / signtool 对产物签名后再 Add-AppxPackage。
#
# 用法（在仓库 immersive-translator-windows/ 下）：
#   pwsh ./scripts/pack-msix.ps1                      # 默认从 target/release staging
#   pwsh ./scripts/pack-msix.ps1 -ReleaseDir <dir>    # 指定产物目录
param(
    # 构建产物目录（含 immersive-translator-windows.exe 与 bundle.resources）
    [string]$ReleaseDir = (Join-Path $PSScriptRoot "..\src-tauri\target\release"),
    # 输出目录（staging 布局 dist/ + 生成的 .msix）
    [string]$OutDir = (Join-Path $PSScriptRoot "..\build\msix")
)
$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$manifestSrc = Join-Path $projectRoot "src-tauri\msix\Package.appxmanifest"
$confPath = Join-Path $projectRoot "src-tauri\tauri.conf.json"
$iconsDir = Join-Path $projectRoot "src-tauri\icons"
$exeName = "immersive-translator-windows.exe"

# 1. 版本号取 tauri.conf.json（应用版本单一来源），替换清单占位符。
# -Encoding UTF8 必须显式指定：PS 5.1 无 BOM 的 UTF-8 会按系统 ANSI（GBK）误读，
# 中文 productName 变乱码后 JSON 直接解析失败。
$conf = Get-Content $confPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $conf.version
if (-not $version) { throw "tauri.conf.json 缺少 version 字段" }
$manifest = (Get-Content $manifestSrc -Raw -Encoding UTF8) -replace '@VERSION@', "$version.0"
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
# 只 staging NSIS 安装布局中的内容：exe + models/ + DirectML.dll.payload。
# release 目录里的杂散 DLL（cdylib 产物、DirectML.dll 运行时解包产物）不属于
# 安装布局，不带入 MSIX。
$dml = Join-Path $ReleaseDir "DirectML.dll.payload"
if (Test-Path $dml) { Copy-Item $dml $dist }

# 清单（替换版本后）+ 商店图标（tauri icon 已生成的同名的 Square/Store 资产）。
# 注意：makeappx 要求包内清单文件名为 AppxManifest.xml（Package.appxmanifest 只是
# VS 工程侧的源文件名），缺它会报 0x80080203 缺 footprint 文件。
Set-Content -Path (Join-Path $dist "AppxManifest.xml") -Value $manifest -Encoding UTF8
$assets = Join-Path $dist "Assets"
New-Item -ItemType Directory -Force -Path $assets | Out-Null
foreach ($name in @("Square44x44Logo.png", "Square150x150Logo.png", "Square71x71Logo.png", "Square310x310Logo.png", "StoreLogo.png")) {
    Copy-Item (Join-Path $iconsDir $name) $assets
}

# 3. 找 makeappx：先看 PATH，再扫 Windows Kits 各版本目录取最新的 x64 版（同 sign.ps1 找 signtool 的方式）
$makeappx = Get-Command makeappx.exe -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Source -First 1
if (-not $makeappx) {
    $kitsRoot = "C:\Program Files (x86)\Windows Kits\10\bin"
    if (Test-Path $kitsRoot) {
        $makeappx = Get-ChildItem $kitsRoot -Directory |
            Where-Object { $_.Name -like "10.*" } |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName "x64\makeappx.exe" } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
    }
}
if (-not $makeappx) {
    throw "找不到 makeappx.exe，请安装 Windows SDK（或 Visual Studio Build Tools）。"
}

# 4. 打包（不签名：商店提交由 Store 重签名；/o 覆盖已存在输出）
$msixPath = Join-Path $OutDir "ImmersiveTranslator_${version}_x64.msix"
if (Test-Path $msixPath) { Remove-Item $msixPath -Force }
Write-Host "[pack-msix] makeappx -> $msixPath"
& $makeappx pack /d $dist /p $msixPath /o
if ($LASTEXITCODE -ne 0) {
    throw "makeappx pack 失败（exit $LASTEXITCODE）"
}

Write-Host "[OK] MSIX 打包完成: $msixPath"
