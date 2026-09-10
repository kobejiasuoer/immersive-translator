# 生成自签代码签名证书（Authenticode），用于给 exe / NSIS 安装包签名。
# 自签证书在外部电脑上默认不受信任，需要把 .cer 导入「受信任的根证书颁发机构」+
# 「受信任的发布者」（本机或通过公司 GPO 下发），签名才会显示有效。
# 正式对外分发建议购买 CA 证书后替换 signing/ 目录下的文件即可，签名流程不变。
#
# 运行：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\generate-signing-cert.ps1
$ErrorActionPreference = "Stop"

$signingDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\signing"))
$pfxPath = Join-Path $signingDir "immersive-translator-codesign.pfx"
$cerPath = Join-Path $signingDir "immersive-translator-codesign.cer"
$passPath = Join-Path $signingDir "password.txt"

if (Test-Path $pfxPath) {
    Write-Host "[SKIP] $pfxPath 已存在，不重复生成。如需重新生成请先删除 signing 目录。" -ForegroundColor Yellow
    exit 0
}
New-Item -ItemType Directory -Force -Path $signingDir | Out-Null

# 密码：不存在则随机生成并保存到本地（password.txt 与 PFX 一样不入仓库）
if (Test-Path $passPath) {
    $plain = (Get-Content $passPath -Raw).Trim()
}
else {
    $plain = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N").Substring(0, 8)
    Set-Content -Path $passPath -Value $plain -NoNewline
}
$password = ConvertTo-SecureString -String $plain -Force -AsPlainText

$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=ImmersiveTranslator, O=ImmersiveTranslator Project" `
    -FriendlyName "ImmersiveTranslator 代码签名（自签开发证书）" `
    -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
    -KeyUsage DigitalSignature `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(5) `
    -CertStoreLocation "Cert:\CurrentUser\My"

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $password | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

Write-Host "[OK] 证书已生成：" -ForegroundColor Green
Write-Host "  PFX（签名用私钥，绝不入仓库）        : $pfxPath"
Write-Host "  CER（公开证书，分发给 IT/同事导入信任）: $cerPath"
Write-Host "  指纹: $($cert.Thumbprint)"
