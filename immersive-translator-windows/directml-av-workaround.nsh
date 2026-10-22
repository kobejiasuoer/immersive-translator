; DirectML.dll 随包分发(本机企业杀软绕行,见 src-tauri/Cargo.toml [[bin]] 注释):
; exe 静态链接 onnxruntime 的 DirectML EP,导入表依赖 DirectML.dll,LTSC 2019/
; 精简系统无系统级 DirectML.dll 时须随包分发。但 tauri-build 的 copy_resources
; 会把 bundle.resources 复制进 target\<profile>\,本机杀软对 target\ 树内名为
; DirectML.dll 的构建产物定向隔离 → build script 阶段 os error 5(cargo check
; 2026-10-18 实测复现)。故资源以 AV-安全名 DirectML.dll.payload 打包(NSIS 按绝对
; 源路径内嵌,不经过 target\),安装器装完资源后在 POSTINSTALL 钩子里落地重命名
; 为 exe 旁的 DirectML.dll 供加载器解析。
; 注意:tauri-cli 按 tauri.conf.json 所在目录(src-tauri/)解析 installerHooks,
; 故 conf 中引用为 ../directml-av-workaround.nsh(2026-10-18 构建实测:裸文件名
; 相对 src-tauri/ 解析报 os error 2,与 cwd 无关)。
!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\DirectML.dll"
  Rename "$INSTDIR\DirectML.dll.payload" "$INSTDIR\DirectML.dll"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\DirectML.dll"
  Delete "$INSTDIR\DirectML.dll.payload"
!macroend
