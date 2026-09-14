; Codex Desktop NSIS Installer
; 原样打包 vendor\codex-desktop\windows\current\app，不执行任何改造
; 占位符 @@VERSION@@ @@SOURCE_DIR@@ @@OUT_FILE@@ 由 pack-codex-nsi.mjs 渲染

Unicode true
ManifestDPIAware true

Name "Codex"
OutFile "@@OUT_FILE@@"
InstallDir "$LOCALAPPDATA\Programs\Codex"
InstallDirRegKey HKCU "Software\Codex" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUnInstDetails show
BrandingText "Codex Desktop"

; 版本信息（X.X.X.X 四段）
VIProductVersion "@@VERSION@@"
VIAddVersionKey /LANG=2052 "ProductName" "Codex"
VIAddVersionKey /LANG=2052 "FileDescription" "Codex Desktop"
VIAddVersionKey /LANG=2052 "CompanyName" "OpenAI"
VIAddVersionKey /LANG=2052 "LegalCopyright" "OpenAI"
VIAddVersionKey /LANG=2052 "FileVersion" "@@VERSION@@"
VIAddVersionKey /LANG=2052 "ProductVersion" "@@VERSION@@"

; 安装页面
Page directory
Page instfiles

; 卸载页面
UninstPage uninstConfirm
UninstPage instfiles

; 默认安装目录从注册表读取
Function .onInit
  ReadRegStr $INSTDIR HKCU "Software\Codex" "InstallDir"
  IfErrors 0 +2
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Codex"
FunctionEnd

Section "Codex" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  ; 原样复制整个 app 目录（保持目录结构）
  File /r "@@SOURCE_DIR@@\*.*"

  ; 开始菜单快捷方式
  CreateDirectory "$SMPROGRAMS\Codex"
  CreateShortcut "$SMPROGRAMS\Codex\Codex.lnk" "$INSTDIR\ChatGPT.exe"

  ; 桌面快捷方式
  CreateShortcut "$DESKTOP\Codex.lnk" "$INSTDIR\ChatGPT.exe"

  ; 卸载注册表项（控制面板可见）
  WriteRegStr HKCU "Software\Codex" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex" "DisplayName" "Codex"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex" "DisplayIcon" "$INSTDIR\ChatGPT.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex" "DisplayVersion" "@@VERSION@@"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex" "Publisher" "OpenAI"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex" "NoRepair" 1
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex" "EstimatedSize" 1900000

  ; 卸载程序
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  ; 删除安装目录（含所有文件）
  RMDir /r "$INSTDIR"
  ; 删除快捷方式
  Delete "$SMPROGRAMS\Codex\Codex.lnk"
  RMDir "$SMPROGRAMS\Codex"
  Delete "$DESKTOP\Codex.lnk"
  ; 清理注册表
  DeleteRegKey HKCU "Software\Codex"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex"
SectionEnd
