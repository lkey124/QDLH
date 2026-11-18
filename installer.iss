; Script đóng gói Bộ cài đặt Windows (Setup Wizard) cho QĐLH Vault
; Hỗ trợ chọn ổ đĩa/thư mục cài đặt (C:, D:, E:...), tạo biểu tượng Desktop và tích hợp trình Gỡ cài đặt (Uninstall)

[Setup]
AppId={{8F9A2D41-5C7E-4B18-9A63-2E8C71D9F042}
AppName=QĐLH Vault - Tra cứu Quyết định Lưu hành Phân bón
AppVersion=1.2.0
AppPublisher=QĐLH Vault
DefaultDirName=C:\QDLH_Vault
DisableDirPage=no
DefaultGroupName=QĐLH Vault
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=C:\Users\binhl\.gemini\antigravity\scratch\qdlh-app\installer_out
OutputBaseFilename=QDLH_Vault_Setup
SetupIconFile=C:\Users\binhl\.gemini\antigravity\scratch\qdlh-app\qdlh_icon.ico
UninstallDisplayIcon={app}\QDLH_Vault.exe
UninstallDisplayName=Gỡ cài đặt QĐLH Vault (Tra cứu Lưu hành Phân bón)
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "Tạo biểu tượng ngoài màn hình chính (Desktop)"; GroupDescription: "Biểu tượng truy cập nhanh:"

[Files]
; Bộ thực thi PyInstaller (.exe và thư viện _internal)
Source: "C:\Users\binhl\.gemini\antigravity\scratch\qdlh-app\dist\QDLH_Vault\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

; Mã nguồn tính năng & giao diện (cho phép cập nhật tính năng qua GitHub chỉ với 1 nút bấm)
Source: "C:\Users\binhl\.gemini\antigravity\scratch\qdlh-app\server.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "C:\Users\binhl\.gemini\antigravity\scratch\qdlh-app\qdlh_desktop.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "C:\Users\binhl\.gemini\antigravity\scratch\qdlh-app\qdlh_icon.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "C:\Users\binhl\.gemini\antigravity\scratch\qdlh-app\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "C:\Users\binhl\.gemini\antigravity\scratch\qdlh-app\data\version.json"; DestDir: "{app}\data"; Flags: ignoreversion

; Cơ sở dữ liệu & Kho ảnh PDF gốc đã xoay thẳng:
; Cờ onlyifdoesntexist đảm bảo nếu cài đè/cập nhật sẽ KHÔNG BAO GIỜ ghi đè lên dữ liệu người dùng đã chỉnh sửa hoặc thêm mới!
Source: "C:\Users\binhl\.gemini\antigravity\scratch\qdlh-app\data\qdlh.sqlite"; DestDir: "{app}\data"; Flags: onlyifdoesntexist
Source: "C:\Users\binhl\.gemini\antigravity\scratch\qdlh-app\data\seed_data.json"; DestDir: "{app}\data"; Flags: onlyifdoesntexist
Source: "C:\Users\binhl\.gemini\antigravity\scratch\qdlh-app\data\pdf_pages\*"; DestDir: "{app}\data\pdf_pages"; Flags: onlyifdoesntexist recursesubdirs createallsubdirs

[Dirs]
Name: "{app}\data\user_pdfs"

[Icons]
; Biểu tượng ngoài màn hình Desktop
Name: "{userdesktop}\Tra cứu QĐLH Phân bón"; Filename: "{app}\QDLH_Vault.exe"; WorkingDir: "{app}"; IconFilename: "{app}\qdlh_icon.ico"; Tasks: desktopicon
; Biểu tượng trong Start Menu
Name: "{group}\Tra cứu QĐLH Phân bón"; Filename: "{app}\QDLH_Vault.exe"; WorkingDir: "{app}"; IconFilename: "{app}\qdlh_icon.ico"
Name: "{group}\Gỡ cài đặt QĐLH Vault"; Filename: "{uninstallexe}"
; Lối tắt Gỡ cài đặt nằm ngay bên trong thư mục cài đặt
Name: "{app}\Gỡ cài đặt QĐLH Vault"; Filename: "{uninstallexe}"; IconFilename: "{app}\qdlh_icon.ico"

[Run]
Filename: "{app}\QDLH_Vault.exe"; Description: "Mở phần mềm QĐLH Vault ngay bây giờ"; Flags: nowait postinstall skipifsilent
