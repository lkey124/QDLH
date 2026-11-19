# -*- coding: utf-8 -*-
r"""
QĐLH Vault Desktop — Phần mềm Windows Native (.exe) sử dụng WebView2 + Embedded Server
- Tự động nhận diện thư mục cài đặt ở bất kỳ ổ đĩa nào (C:, D:, E:...).
- Hỗ trợ cập nhật tính năng trực tiếp qua GitHub mà không mất dữ liệu đã lưu trong máy.
"""

import os
import sys
import time
import socket
import threading
import importlib.util
from http.server import ThreadingHTTPServer
import webview


def _find_app_root():
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        for cand in (exe_dir, os.path.dirname(exe_dir), os.path.dirname(os.path.dirname(exe_dir))):
            if os.path.exists(os.path.join(cand, "public")) and os.path.exists(os.path.join(cand, "data")):
                return cand
    here = os.path.dirname(os.path.abspath(__file__))
    if os.path.exists(os.path.join(here, "public")) and os.path.exists(os.path.join(here, "data")):
        return here
    default_dir = r"C:\Users\binhl\.gemini\antigravity\scratch\qdlh-app"
    if os.path.exists(default_dir):
        return default_dir
    return here


APP_ROOT = _find_app_root()
if APP_ROOT not in sys.path:
    sys.path.insert(0, APP_ROOT)

# Nạp server.py trực tiếp từ thư mục cài đặt để khi bấm "Cập nhật tính năng" có hiệu lực ngay
server_py_path = os.path.join(APP_ROOT, "server.py")
if os.path.exists(server_py_path):
    spec = importlib.util.spec_from_file_location("server", server_py_path)
    server = importlib.util.module_from_spec(spec)
    sys.modules["server"] = server
    spec.loader.exec_module(server)
else:
    import server

PORT = 8686
URL = f"http://127.0.0.1:{PORT}"


def is_port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.05)
        return s.connect_ex(("127.0.0.1", port)) == 0


def start_embedded_server():
    if is_port_open(PORT):
        return
    server.init_db()
    server.load_seed_if_needed()
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), server.QDLHRequestHandler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    for _ in range(50):
        if is_port_open(PORT):
            break
        time.sleep(0.01)


def main():
    start_embedded_server()
    webview.create_window(
        title="QĐLH Vault — Phần mềm Quản lý & Tra cứu Quyết định Lưu hành Phân bón",
        url=URL,
        width=1480,
        height=900,
        min_size=(1080, 680),
        text_select=True,
    )
    webview.start()


if __name__ == "__main__":
    main()
