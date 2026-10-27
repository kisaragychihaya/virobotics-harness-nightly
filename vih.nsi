; VIrobotics Harness NSIS installer script
; Based on rad.nsi
;
; 按用户安装（per-user）：装到 %LOCALAPPDATA%\Programs，卸载信息写 HKCU，快捷方式只建当前用户，
; 全程无需管理员权限（RequestExecutionLevel user）。

; Maximum compression: LZMA solid with largest dictionary
; Must be set before any data (including MUI macros) is added
SetCompressor /SOLID lzma
SetCompressorDictSize 64

; 按用户安装：不产生 UAC 提权要求
RequestExecutionLevel user

; HM NIS Edit Wizard helper defines
!define PRODUCT_NAME "VIrobotics Harness"
!define PRODUCT_PUBLISHER "VIRobotics, Inc."
!define PRODUCT_WEB_SITE "http://virobotics.net/"

; 版本号由打包流程从源码仓库 package.json 注入：
;   makensis /DPRODUCT_VERSION=26.9.23 /DPRODUCT_VERSION4=26.9.23.0 ...
; PRODUCT_VERSION4 仅用于 exe 版本资源(VIProductVersion)，必须是 x.x.x.x 数字格式。
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "26.9.23"
!endif

; 待打包的 electron-forge 产物目录，CI 中注入；默认值仅供本地手动打包。
!ifndef APP_SOURCE_DIR
  !define APP_SOURCE_DIR "C:\Users\yiku\Desktop\VIH\VIrobotics Harness-win32-x64"
!endif

; setup.exe 输出目录，默认输出到当前目录。
!ifndef SETUP_OUT_DIR
  !define SETUP_OUT_DIR "."
!endif

; setup.exe 文件名架构后缀，CI 按目标位数注入（x86 构建为 -x86）；默认空 = x64 命名不变。
!ifndef SETUP_NAME_SUFFIX
  !define SETUP_NAME_SUFFIX ""
!endif

!define PRODUCT_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
!define PRODUCT_UNINST_ROOT_KEY "HKCU"

; MUI 1.67 compatible ------
!include "MUI2.nsh"
!include "WinMessages.nsh"

; MUI Settings
!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\nsis3-install-alt.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\nsis3-uninstall.ico"

; Welcome page
!insertmacro MUI_PAGE_WELCOME
; Directory page
!insertmacro MUI_PAGE_DIRECTORY
; Instfiles page
!insertmacro MUI_PAGE_INSTFILES
; Finish page
!insertmacro MUI_PAGE_FINISH

; Uninstaller pages
!insertmacro MUI_UNPAGE_INSTFILES

; Language files
!insertmacro MUI_LANGUAGE "English"

; MUI end ------

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "${SETUP_OUT_DIR}\VIrobotics-Harness-Setup-v${PRODUCT_VERSION}${SETUP_NAME_SUFFIX}.exe"
; 按用户安装：默认装到用户程序目录（无需提权），用户可在目录页改选
InstallDir "$LOCALAPPDATA\Programs\VIrobotics Harness"
InstallDirRegKey HKCU "${PRODUCT_UNINST_KEY}" ""
ShowInstDetails show
ShowUnInstDetails show

; setup.exe 文件属性(资源管理器右键→属性→详细信息)里的版本信息
!ifdef PRODUCT_VERSION4
  VIProductVersion "${PRODUCT_VERSION4}"
!endif
VIAddVersionKey /LANG=0 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=0 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=0 "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=0 "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey /LANG=0 "LegalCopyright" "Copyright (c) ${PRODUCT_PUBLISHER}"
VIAddVersionKey /LANG=0 "FileDescription" "${PRODUCT_NAME} Setup"

Section "MainSection" SEC01
  SetOutPath "$INSTDIR"
  SetOverwrite ifnewer

  File /r "${APP_SOURCE_DIR}\*"

  ; 不设 SetShellVarContext all：开始菜单/桌面快捷方式只建当前用户，避免提权
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\VIrobotics Harness.exe"
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\VIrobotics Harness.exe"
SectionEnd

Section -Post
  WriteUninstaller "$INSTDIR\uninst.exe"
  WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "DisplayName" "$(^Name)"
  WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "UninstallString" "$INSTDIR\uninst.exe"

  WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "DisplayIcon" "$INSTDIR\VIrobotics Harness.exe"
  WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "URLInfoAbout" "${PRODUCT_WEB_SITE}"
  WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
SectionEnd

Function un.onUninstSuccess
  HideWindow
  MessageBox MB_ICONINFORMATION|MB_OK "$(^Name) successfully uninstalled."
FunctionEnd

Function un.onInit
  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "Are you sure you want to completely remove $(^Name) and all of its components?" IDYES +2
  Abort
FunctionEnd

Section Uninstall

  ; 与安装侧一致：只清当前用户的快捷方式
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"

  Delete "$INSTDIR\uninst.exe"
  RMDir /r "$INSTDIR"

  DeleteRegKey ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}"

  SetAutoClose true
SectionEnd
