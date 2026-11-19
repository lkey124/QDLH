# -*- coding: utf-8 -*-
r"""
Backend Server Tốc Độ Cao cho Ứng dụng Quản lý & Tra cứu Quyết định Lưu hành Phân bón (QĐLH Vault)
- Mở khóa 100% tính năng cho mọi người dùng (Thêm tệp PDF mới, Thêm mã phân bón, Chỉnh sửa, Xuất Excel).
- Tự động cập nhật Tính năng & Giao diện từ GitHub (lkey124/QDLH) mà KHÔNG làm mất hay thay đổi dữ liệu/tệp đã lưu trong máy.
- Hỗ trợ xem & zoom PDF Offline trên mọi máy tính thông qua bộ trang ảnh PDF đã xoay thẳng.
"""

import os
import re
import io
import csv
import sys
import time
import json
import shutil
import sqlite3
import hashlib
import threading
import urllib.parse
import urllib.request
import subprocess
from datetime import datetime
from collections import OrderedDict
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import pymupdf as fitz  # PyMuPDF


def _resolve_base_dir():
    # Ưu tiên thư mục cài đặt cạnh file .exe nếu có sẵn public/ và data/
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        if os.path.exists(os.path.join(exe_dir, "public")) and os.path.exists(os.path.join(exe_dir, "data")):
            return exe_dir
        parent_dir = os.path.dirname(exe_dir)
        if os.path.exists(os.path.join(parent_dir, "public")) and os.path.exists(os.path.join(parent_dir, "data")):
            return parent_dir
    here = os.path.dirname(os.path.abspath(__file__))
    if os.path.exists(os.path.join(here, "public")) and os.path.exists(os.path.join(here, "data")):
        return here
    default_dir = r"C:\Users\binhl\.gemini\antigravity\scratch\qdlh-app"
    if os.path.exists(os.path.join(default_dir, "public")) and os.path.exists(os.path.join(default_dir, "data")):
        return default_dir
    return here


BASE_DIR = _resolve_base_dir()
STATIC_DIR = os.path.join(BASE_DIR, "public")
DB_PATH = os.path.join(BASE_DIR, "data", "qdlh.sqlite")
SEED_JSON_PATH = os.path.join(BASE_DIR, "data", "seed_data.json")
VERSION_JSON_PATH = os.path.join(BASE_DIR, "data", "version.json")
PDF_PAGES_DIR = os.path.join(BASE_DIR, "data", "pdf_pages")
USER_PDFS_DIR = os.path.join(BASE_DIR, "data", "user_pdfs")
PDF_ROOT = r"E:\QĐLH"
PORT = 8686

GITHUB_REPO_SLUG = "lkey124/QDLH"
GITHUB_RAW_BASE = f"https://raw.githubusercontent.com/{GITHUB_REPO_SLUG}/main"
GITHUB_REPO_URL = f"https://github.com/{GITHUB_REPO_SLUG}.git"

# Các MD5 của file QĐ 17 và QĐ 491 có trang phụ lục xoay ngược chiều (cần xoay 270 độ thay vì 90 độ)
CCW_MD5_PREFIXES = {"3745fd46", "b7e7e62e", "2174c19e"}
NO_ROT_TYPES = {"COA", "HQ", "UQ", "KQPT"}

# Bộ nhớ đệm RAM siêu tốc
_CACHE_LOCK = threading.Lock()
DATA_CACHE_BYTES = None
PDF_META_CACHE = {}  # norm_path -> {"md5_prefix": str, "page_count": int, "file_size": int}
PDF_PAGE_CACHE = OrderedDict()  # (norm_path, page_num, extra_rot, dpi) -> bytes
MAX_PDF_PAGE_CACHE = 200


def _norm_path(p):
    if not p:
        return ""
    return os.path.normcase(os.path.normpath(str(p).strip()))


def _open_pdf(full_path):
    with open(full_path, "rb") as fp:
        return fitz.open(stream=fp.read(), filetype="pdf")


def get_local_version():
    if os.path.exists(VERSION_JSON_PATH):
        try:
            with open(VERSION_JSON_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"version": "1.2.0", "build_num": 2, "updated_at": "", "repo": GITHUB_REPO_SLUG}


def get_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def normalize_qd_key(so_qd):
    if not so_qd:
        return ""
    m = re.search(r"(\d+)", str(so_qd))
    return m.group(1) if m else str(so_qd).strip()


def init_db():
    os.makedirs(PDF_PAGES_DIR, exist_ok=True)
    os.makedirs(USER_PDFS_DIR, exist_ok=True)
    conn = get_db()
    cur = conn.cursor()
    cur.executescript("""
        CREATE TABLE IF NOT EXISTS decisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT UNIQUE,
            qd_key TEXT,
            so_qd TEXT,
            ngay_ban_hanh TEXT,
            ngay_hieu_luc TEXT,
            ngay_het_han TEXT,
            loai_qd TEXT,
            nguoi_ky TEXT,
            don_vi_dang_ky TEXT,
            dia_chi_goc TEXT,
            dien_thoai TEXT,
            ma_so_doanh_nghiep TEXT,
            dia_chi_sap_nhap TEXT,
            ghi_chu_sap_nhap TEXT,
            pdf_md5 TEXT,
            default_pdf_path TEXT
        );

        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mslh TEXT,
            stt INTEGER,
            loai_phan_bon TEXT,
            ten_phan_bon TEXT,
            chi_tieu_chat_luong TEXT,
            phuong_thuc_su_dung TEXT,
            huong_dan_su_dung TEXT,
            han_su_dung TEXT,
            page_num INTEGER DEFAULT 2,
            so_qd TEXT,
            qd_key TEXT,
            doc_id TEXT,
            pdf_path TEXT,
            is_in_folder INTEGER DEFAULT 0,
            UNIQUE(mslh, qd_key, stt)
        );

        CREATE TABLE IF NOT EXISTS related_docs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT,
            doc_type TEXT,
            mslh TEXT,
            so_hieu TEXT,
            ngay_cap TEXT,
            ngay_het_han TEXT,
            don_vi_cap TEXT,
            don_vi_dang_ky TEXT,
            dia_chi_goc TEXT,
            chi_tieu_chat_luong TEXT,
            tom_tat TEXT,
            pdf_path TEXT
        );

        CREATE TABLE IF NOT EXISTS pdf_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_name TEXT,
            full_path TEXT UNIQUE,
            file_size INTEGER,
            md5_hash TEXT,
            doc_type TEXT,
            mslh TEXT,
            qd_key TEXT,
            stt INTEGER,
            page_count INTEGER
        );
    """)
    conn.commit()
    conn.close()


def parse_filename_metadata(filename):
    """Phân tích tên file để gợi ý Loại hồ sơ, MSLH, Số QĐ, STT, Tên SP."""
    upper = filename.upper()
    if upper.startswith("COA"):
        dtype = "COA"
    elif upper.startswith("HQ"):
        dtype = "HQ"
    elif "GUQ" in upper or "HĐUQ" in upper:
        dtype = "UQ"
    elif upper.startswith("KQPT"):
        dtype = "KQPT"
    else:
        dtype = "LH"

    mslh = ""
    if "18658" in filename:
        mslh = "18658"
    elif "27351" in filename:
        mslh = "27351"
    elif "LHKaliBo-Agrosa-98" in filename:
        mslh = "31862"
    else:
        m_code = re.search(r"^(?:LH|COA|HQ|HQ_LH)\s*(\d{5})", filename, re.IGNORECASE)
        if m_code:
            mslh = m_code.group(1)
        else:
            m_any = re.search(r"(?<!\d)(\d{5})(?!\d)", filename)
            if m_any and not filename.startswith("2026"):
                mslh = m_any.group(1)

    m_qd = re.search(r"(?:QĐ|QD)\s*(\d+)", filename, re.IGNORECASE)
    qd_key = m_qd.group(1) if m_qd else ""
    if not qd_key and "Agrosa-98" in filename:
        qd_key = "98"
    if not qd_key and "28704" in filename:
        qd_key = "2200"

    m_stt = re.search(r"STT\s*(\d+)", filename, re.IGNORECASE)
    stt = int(m_stt.group(1)) if m_stt else 1

    # Gợi ý tên phân bón từ phần giữa tên file
    base_no_ext = os.path.splitext(filename)[0]
    parts = [p.strip() for p in base_no_ext.split("_") if p.strip()]
    suggested_name = parts[1] if len(parts) >= 2 else ""

    return {
        "doc_type": dtype,
        "mslh": mslh,
        "qd_key": qd_key,
        "stt": stt,
        "suggested_name": suggested_name
    }


def compute_auto_rot_for_page(md5_prefix, filename, page_idx, page):
    page_num_1based = page_idx + 1
    if md5_prefix == "9d86a8ee" and page_num_1based in (3, 4, 5, 6):
        return 270
    if md5_prefix == "df5b2b33" and page_num_1based in (3, 5):
        return 270
    if md5_prefix == "5c021656" and page_num_1based in (8, 9, 10, 11):
        return 270
    if page_idx == 0:
        return 0
    upper = filename.upper()
    if any(upper.startswith(t) for t in ("COA", "HQ", "KQPT")) or "GUQ" in upper or "HĐUQ" in upper:
        return 0
    rect = page.rect
    if rect.width < rect.height:
        return 270 if md5_prefix in CCW_MD5_PREFIXES else 90
    return 0


def pre_render_pdf_pages(raw_pdf_bytes, filename, md5_prefix):
    """Kết xuất sẵn các trang ảnh JPEG đã xoay thẳng vào data/pdf_pages để xem siêu tốc & offline."""
    os.makedirs(PDF_PAGES_DIR, exist_ok=True)
    doc = fitz.open(stream=raw_pdf_bytes, filetype="pdf")
    pcount = len(doc)
    for idx in range(pcount):
        page_num = idx + 1
        out_jpg = os.path.join(PDF_PAGES_DIR, f"{md5_prefix}_p{page_num}.jpg")
        if not os.path.exists(out_jpg):
            page = doc[idx]
            auto_rot = compute_auto_rot_for_page(md5_prefix, filename, idx, page)
            page.set_rotation((page.rotation + auto_rot) % 360)
            pix = page.get_pixmap(dpi=150, alpha=False)
            with open(out_jpg, "wb") as fp:
                fp.write(pix.tobytes("jpeg", jpg_quality=88))
    doc.close()
    return pcount


def scan_pdf_folder(conn):
    r"""Quét thư mục E:\QĐLH và data/user_pdfs để cập nhật bảng pdf_files."""
    cur = conn.cursor()
    count = 0
    roots_to_scan = [r for r in (PDF_ROOT, USER_PDFS_DIR) if os.path.exists(r)]
    for root_dir in roots_to_scan:
        for dirpath, _, filenames in os.walk(root_dir):
            for fname in filenames:
                if not fname.lower().endswith(".pdf"):
                    continue
                full_path = os.path.join(dirpath, fname)
                try:
                    fsize = os.path.getsize(full_path)
                    with open(full_path, "rb") as fp:
                        raw_pdf = fp.read()
                    md5_hash = hashlib.md5(raw_pdf).hexdigest()
                    pcount = pre_render_pdf_pages(raw_pdf, fname, md5_hash[:8])
                except Exception:
                    fsize = 0
                    md5_hash = ""
                    pcount = 0

                meta = parse_filename_metadata(fname)
                cur.execute("""
                    INSERT INTO pdf_files (file_name, full_path, file_size, md5_hash, doc_type, mslh, qd_key, stt, page_count)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(full_path) DO UPDATE SET
                        file_size=excluded.file_size,
                        md5_hash=excluded.md5_hash,
                        doc_type=excluded.doc_type,
                        mslh=excluded.mslh,
                        qd_key=excluded.qd_key,
                        stt=excluded.stt,
                        page_count=excluded.page_count
                """, (fname, full_path, fsize, md5_hash, meta["doc_type"], meta["mslh"], meta["qd_key"], meta["stt"], pcount))
                count += 1
    conn.commit()
    return count


def import_seed_data(conn, seed):
    cur = conn.cursor()
    doc_map = seed.get("doc_map", {})
    folder_mslhs = set(
        r["mslh"] for r in cur.execute("SELECT DISTINCT mslh FROM pdf_files WHERE mslh != ''").fetchall()
    )

    for d in seed.get("decisions", []):
        doc_id = d.get("doc_id", "")
        so_qd = d.get("so_qd", "")
        qd_key = normalize_qd_key(so_qd)
        d_info = doc_map.get(doc_id, {})
        md5_val = d_info.get("md5", "")
        pdf_path = d_info.get("path", "")

        cur.execute("""
            INSERT INTO decisions (
                doc_id, qd_key, so_qd, ngay_ban_hanh, ngay_hieu_luc, ngay_het_han,
                loai_qd, nguoi_ky, don_vi_dang_ky, dia_chi_goc, dien_thoai,
                ma_so_doanh_nghiep, dia_chi_sap_nhap, ghi_chu_sap_nhap, pdf_md5, default_pdf_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(doc_id) DO UPDATE SET
                qd_key=excluded.qd_key,
                so_qd=excluded.so_qd,
                ngay_ban_hanh=excluded.ngay_ban_hanh,
                ngay_hieu_luc=excluded.ngay_hieu_luc,
                ngay_het_han=excluded.ngay_het_han,
                loai_qd=excluded.loai_qd,
                nguoi_ky=excluded.nguoi_ky,
                don_vi_dang_ky=excluded.don_vi_dang_ky,
                dia_chi_goc=excluded.dia_chi_goc,
                dien_thoai=excluded.dien_thoai,
                ma_so_doanh_nghiep=excluded.ma_so_doanh_nghiep,
                dia_chi_sap_nhap=excluded.dia_chi_sap_nhap,
                ghi_chu_sap_nhap=excluded.ghi_chu_sap_nhap,
                pdf_md5=excluded.pdf_md5,
                default_pdf_path=excluded.default_pdf_path
        """, (
            doc_id, qd_key, so_qd, d.get("ngay_ban_hanh", ""), d.get("ngay_hieu_luc", ""),
            d.get("ngay_het_han", ""), d.get("loai_qd", ""), d.get("nguoi_ky", ""),
            d.get("don_vi_dang_ky", ""), d.get("dia_chi_goc", ""), d.get("dien_thoai", ""),
            d.get("ma_so_doanh_nghiep", ""), d.get("dia_chi_sap_nhap", ""),
            d.get("ghi_chu_sap_nhap", ""), md5_val, pdf_path
        ))

        for p in d.get("products", []):
            mslh = str(p.get("mslh", "")).strip()
            stt = p.get("stt", 1)
            row_file = cur.execute(
                "SELECT full_path FROM pdf_files WHERE mslh=? AND doc_type='LH' LIMIT 1", (mslh,)
            ).fetchone()
            specific_pdf = row_file["full_path"] if row_file else pdf_path
            in_folder = 1 if (mslh in folder_mslhs or row_file is not None) else 0

            cur.execute("""
                INSERT INTO products (
                    mslh, stt, loai_phan_bon, ten_phan_bon, chi_tieu_chat_luong,
                    phuong_thuc_su_dung, huong_dan_su_dung, han_su_dung,
                    page_num, so_qd, qd_key, doc_id, pdf_path, is_in_folder
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(mslh, qd_key, stt) DO UPDATE SET
                    loai_phan_bon=excluded.loai_phan_bon,
                    ten_phan_bon=excluded.ten_phan_bon,
                    chi_tieu_chat_luong=excluded.chi_tieu_chat_luong,
                    phuong_thuc_su_dung=excluded.phuong_thuc_su_dung,
                    huong_dan_su_dung=excluded.huong_dan_su_dung,
                    han_su_dung=excluded.han_su_dung,
                    page_num=excluded.page_num,
                    so_qd=excluded.so_qd,
                    doc_id=excluded.doc_id,
                    pdf_path=excluded.pdf_path,
                    is_in_folder=excluded.is_in_folder
            """, (
                mslh, stt, p.get("loai_phan_bon", ""), p.get("ten_phan_bon", ""),
                p.get("chi_tieu_chat_luong", ""), p.get("phuong_thuc_su_dung", ""),
                p.get("huong_dan_su_dung", ""), p.get("han_su_dung", ""),
                p.get("page_num", 2), so_qd, qd_key, doc_id, specific_pdf, in_folder
            ))

    cur.execute("DELETE FROM related_docs")
    for r in seed.get("related_docs", []):
        doc_id = r.get("doc_id", "")
        d_info = doc_map.get(doc_id, {})
        pdf_path = r.get("pdf_path") or d_info.get("path", "")
        mslh_val = r.get("mslh", "")
        if isinstance(mslh_val, list):
            mslh_val = ", ".join(str(x) for x in mslh_val)
        cur.execute("""
            INSERT INTO related_docs (
                doc_id, doc_type, mslh, so_hieu, ngay_cap, ngay_het_han,
                don_vi_cap, don_vi_dang_ky, dia_chi_goc, chi_tieu_chat_luong, tom_tat, pdf_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            doc_id, r.get("doc_type", ""), str(mslh_val), r.get("so_hieu", ""),
            r.get("ngay_cap", ""), r.get("ngay_het_han", ""), r.get("don_vi_cap", ""),
            r.get("don_vi_dang_ky", ""), r.get("dia_chi_goc", ""),
            r.get("chi_tieu_chat_luong", ""), r.get("tom_tat", ""), pdf_path
        ))

    conn.commit()


def refresh_memory_cache():
    """Đọc toàn bộ dữ liệu từ SQLite vào bộ nhớ RAM 1 lần duy nhất (< 8ms), không quét ổ đĩa."""
    global DATA_CACHE_BYTES, PDF_META_CACHE
    conn = get_db()
    cur = conn.cursor()

    decisions = [dict(r) for r in cur.execute("SELECT * FROM decisions ORDER BY id").fetchall()]
    dec_by_doc = {d["doc_id"]: d for d in decisions}
    dec_by_qd = {}
    for d in decisions:
        if d["qd_key"]:
            dec_by_qd.setdefault(d["qd_key"], d)

    products_raw = [dict(r) for r in cur.execute("SELECT * FROM products ORDER BY is_in_folder DESC, mslh ASC, stt ASC").fetchall()]
    pdf_files = [dict(r) for r in cur.execute("SELECT * FROM pdf_files ORDER BY id DESC, file_name ASC").fetchall()]
    related_docs = [dict(r) for r in cur.execute("SELECT * FROM related_docs ORDER BY id ASC").fetchall()]
    conn.close()

    meta_map = {}
    known_paths = set()
    for pf in pdf_files:
        fp = pf.get("full_path") or ""
        if fp:
            nk = _norm_path(fp)
            known_paths.add(nk)
            entry = {
                "md5_prefix": (pf.get("md5_hash") or "")[:8],
                "page_count": pf.get("page_count") or 1,
                "file_size": pf.get("file_size") or 0,
                "file_name": pf.get("file_name") or os.path.basename(fp)
            }
            meta_map[nk] = entry
            bname = os.path.basename(fp).lower()
            if bname and bname not in meta_map:
                meta_map[bname] = entry

    for d in decisions:
        dp = d.get("default_pdf_path") or ""
        if dp:
            nk = _norm_path(dp)
            if nk not in meta_map:
                meta_map[nk] = {
                    "md5_prefix": (d.get("pdf_md5") or "")[:8],
                    "page_count": 2,
                    "file_size": 0,
                    "file_name": os.path.basename(dp)
                }

    files_by_mslh = {}
    files_by_qd = {}
    for pf in pdf_files:
        if pf["mslh"]:
            files_by_mslh.setdefault(pf["mslh"], []).append(pf)
        if pf["qd_key"]:
            files_by_qd.setdefault(pf["qd_key"], []).append(pf)

    rel_by_mslh = {}
    for rd in related_docs:
        for code in re.findall(r"\d{5}", rd.get("mslh", "")):
            rel_by_mslh.setdefault(code, []).append(rd)

    products = []
    for p in products_raw:
        d = dec_by_doc.get(p["doc_id"]) or dec_by_qd.get(p["qd_key"]) or {}
        mslh = p["mslh"]
        p_files = files_by_mslh.get(mslh, [])
        if not p_files and p["qd_key"]:
            p_files = files_by_qd.get(p["qd_key"], [])

        best_pdf = p["pdf_path"]
        if not best_pdf or (_norm_path(best_pdf) not in known_paths and not os.path.exists(best_pdf)):
            if p_files:
                best_pdf = p_files[0]["full_path"]
            elif d.get("default_pdf_path"):
                best_pdf = d["default_pdf_path"]

        pdf_meta = meta_map.get(_norm_path(best_pdf), {})
        pdf_page_count = pdf_meta.get("page_count") or (p_files[0]["page_count"] if p_files else 2)

        products.append({
            **p,
            "pdf_path": best_pdf,
            "pdf_page_count": pdf_page_count,
            "so_qd_full": d.get("so_qd") or p.get("so_qd") or "",
            "ngay_ban_hanh": d.get("ngay_ban_hanh", ""),
            "ngay_hieu_luc": d.get("ngay_hieu_luc", ""),
            "ngay_het_han": d.get("ngay_het_han", ""),
            "loai_qd": d.get("loai_qd", ""),
            "nguoi_ky": d.get("nguoi_ky", ""),
            "don_vi_dang_ky": d.get("don_vi_dang_ky", ""),
            "dia_chi_goc": d.get("dia_chi_goc", ""),
            "dien_thoai": d.get("dien_thoai", ""),
            "ma_so_doanh_nghiep": d.get("ma_so_doanh_nghiep", ""),
            "dia_chi_sap_nhap": d.get("dia_chi_sap_nhap", ""),
            "ghi_chu_sap_nhap": d.get("ghi_chu_sap_nhap", ""),
            "related_docs": rel_by_mslh.get(mslh, [])
        })

    companies_map = {}
    for d in decisions:
        cname = (d.get("don_vi_dang_ky") or "").strip()
        if not cname:
            continue
        key = cname.upper()
        if key not in companies_map:
            companies_map[key] = {
                "don_vi_dang_ky": cname,
                "ma_so_doanh_nghiep": d.get("ma_so_doanh_nghiep", ""),
                "dien_thoai": d.get("dien_thoai", ""),
                "dia_chi_goc": d.get("dia_chi_goc", ""),
                "dia_chi_sap_nhap": d.get("dia_chi_sap_nhap", ""),
                "ghi_chu_sap_nhap": d.get("ghi_chu_sap_nhap", ""),
                "decisions": [],
                "product_count": 0
            }
        else:
            cur_goc = companies_map[key]["dia_chi_goc"].lower()
            new_goc = (d.get("dia_chi_goc") or "").lower()
            if ("quận" not in cur_goc and "huyện" not in cur_goc) and ("quận" in new_goc or "huyện" in new_goc):
                companies_map[key]["dia_chi_goc"] = d.get("dia_chi_goc", "")
                companies_map[key]["ghi_chu_sap_nhap"] = d.get("ghi_chu_sap_nhap", "")
            if "số 12" in cur_goc and "số 29" in new_goc:
                companies_map[key]["dia_chi_goc"] = d.get("dia_chi_goc", "")
                companies_map[key]["dia_chi_sap_nhap"] = d.get("dia_chi_sap_nhap", "")
                companies_map[key]["ghi_chu_sap_nhap"] = d.get("ghi_chu_sap_nhap", "")
        companies_map[key]["decisions"].append({
            "doc_id": d["doc_id"],
            "so_qd": d["so_qd"],
            "ngay_ban_hanh": d["ngay_ban_hanh"],
            "ngay_het_han": d["ngay_het_han"],
            "dia_chi_goc": d["dia_chi_goc"],
            "dia_chi_sap_nhap": d["dia_chi_sap_nhap"]
        })

    for p in products:
        key = (p.get("don_vi_dang_ky") or "").strip().upper()
        if key in companies_map:
            companies_map[key]["product_count"] += 1

    payload_bytes = json.dumps({
        "products": products,
        "decisions": decisions,
        "companies": list(companies_map.values()),
        "related_docs": related_docs,
        "pdf_files": pdf_files,
        "version_info": get_local_version(),
        "is_git_repo": os.path.exists(os.path.join(BASE_DIR, ".git"))
    }, ensure_ascii=False).encode("utf-8")

    with _CACHE_LOCK:
        PDF_META_CACHE = meta_map
        DATA_CACHE_BYTES = payload_bytes


def load_seed_if_needed():
    """Chỉ quét thư mục PDF khi bảng pdf_files chưa có dữ liệu, giúp khởi động tức thì."""
    conn = get_db()
    cur = conn.cursor()
    f_count = cur.execute("SELECT COUNT(*) FROM pdf_files").fetchone()[0]
    if f_count == 0:
        scan_pdf_folder(conn)

    p_count = cur.execute("SELECT COUNT(*) FROM products").fetchone()[0]
    if p_count == 0 and os.path.exists(SEED_JSON_PATH):
        with open(SEED_JSON_PATH, "r", encoding="utf-8") as f:
            seed = json.load(f)
        import_seed_data(conn, seed)
    conn.close()
    refresh_memory_cache()


class QDLHRequestHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def log_message(self, format, *args):
        pass

    def send_raw_bytes(self, raw_bytes, content_type, status=200, cache_control="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw_bytes)))
        self.send_header("Cache-Control", cache_control)
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(raw_bytes)

    def send_json(self, data, status=200):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_raw_bytes(raw, "application/json; charset=utf-8", status=status)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/data":
            self.handle_get_data()
        elif path == "/api/check-update":
            self.handle_check_update()
        elif path == "/api/pdf-page":
            self.handle_pdf_page(qs)
        elif path == "/api/pdf-info":
            self.handle_pdf_info(qs)
        elif path == "/api/pdf-stream":
            self.handle_pdf_stream(qs)
        elif path == "/api/export-csv":
            self.handle_export_csv()
        else:
            if path == "/":
                path = "/index.html"
            if path in ("/index.html", "/styles.css", "/app.js"):
                self.handle_static_fast(path)
                return
            self.path = path
            return super().do_GET()

    def handle_static_fast(self, url_path):
        rel = url_path.lstrip("/")
        full = os.path.join(STATIC_DIR, rel)
        if not os.path.exists(full):
            self.send_response(404)
            self.end_headers()
            return
        ctype = "text/html; charset=utf-8"
        if rel.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif rel.endswith(".js"):
            ctype = "application/javascript; charset=utf-8"
        with open(full, "rb") as f:
            raw = f.read()
        self.send_raw_bytes(raw, ctype, status=200, cache_control="no-cache")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        length = int(self.headers.get("Content-Length", 0))

        # Xử lý tải lên tệp PDF nhị phân trực tiếp
        if path == "/api/upload-pdf":
            raw_bytes = self.rfile.read(length) if length > 0 else b""
            self.handle_upload_pdf(qs, raw_bytes)
            return

        body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}

        if path == "/api/update-product":
            self.handle_update_product(body)
        elif path == "/api/update-decision":
            self.handle_update_decision(body)
        elif path == "/api/add-record":
            self.handle_add_record(body)
        elif path == "/api/delete-product":
            self.handle_delete_product(body)
        elif path == "/api/open-file":
            self.handle_open_file(body)
        elif path == "/api/sync-folder":
            self.handle_sync_folder()
        elif path == "/api/pull-update":
            self.handle_pull_update()
        elif path == "/api/publish-update":
            self.handle_publish_update(body)
        elif path == "/api/save-excel":
            self.handle_save_excel()
        else:
            self.send_json({"error": "Not found"}, 404)

    def handle_get_data(self):
        global DATA_CACHE_BYTES
        if DATA_CACHE_BYTES is None:
            refresh_memory_cache()
        self.send_raw_bytes(DATA_CACHE_BYTES, "application/json; charset=utf-8")

    def handle_upload_pdf(self, qs, raw_bytes):
        """Lưu tệp PDF do người dùng chọn vào thư mục data/user_pdfs của máy, xoay thẳng trang và trích xuất gợi ý."""
        raw_name = qs.get("name", ["Ho_So_Moi.pdf"])[0]
        safe_name = os.path.basename(raw_name).strip()
        if not safe_name.lower().endswith(".pdf"):
            safe_name += ".pdf"

        if not raw_bytes:
            return self.send_json({"ok": False, "error": "Tệp PDF rỗng"}, 400)

        os.makedirs(USER_PDFS_DIR, exist_ok=True)
        dest_path = os.path.join(USER_PDFS_DIR, safe_name)
        if os.path.exists(dest_path):
            base_n, ext_n = os.path.splitext(safe_name)
            dest_path = os.path.join(USER_PDFS_DIR, f"{base_n}_{int(time.time())}{ext_n}")
            safe_name = os.path.basename(dest_path)

        try:
            with open(dest_path, "wb") as fp:
                fp.write(raw_bytes)
            fsize = len(raw_bytes)
            md5_hash = hashlib.md5(raw_bytes).hexdigest()
            pcount = pre_render_pdf_pages(raw_bytes, safe_name, md5_hash[:8])
            meta = parse_filename_metadata(safe_name)

            conn = get_db()
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO pdf_files (file_name, full_path, file_size, md5_hash, doc_type, mslh, qd_key, stt, page_count)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(full_path) DO UPDATE SET
                    file_size=excluded.file_size,
                    md5_hash=excluded.md5_hash,
                    doc_type=excluded.doc_type,
                    mslh=excluded.mslh,
                    qd_key=excluded.qd_key,
                    stt=excluded.stt,
                    page_count=excluded.page_count
            """, (safe_name, dest_path, fsize, md5_hash, meta["doc_type"], meta["mslh"], meta["qd_key"], meta["stt"], pcount))

            matched_dec = None
            if meta["qd_key"]:
                row_dec = cur.execute("SELECT * FROM decisions WHERE qd_key=? LIMIT 1", (meta["qd_key"],)).fetchone()
                if row_dec:
                    matched_dec = dict(row_dec)

            conn.commit()
            conn.close()
            refresh_memory_cache()

            self.send_json({
                "ok": True,
                "saved_path": dest_path,
                "file_name": safe_name,
                "page_count": pcount,
                "md5_hash": md5_hash,
                "parsed_meta": meta,
                "matched_decision": matched_dec
            })
        except Exception as e:
            self.send_json({"ok": False, "error": f"Không đọc được tệp PDF: {e}"}, 500)

    def handle_add_record(self, body):
        """Thêm mới Mã phân bón / Quyết định / Hồ sơ đính kèm vào máy người dùng."""
        doc_type = (body.get("doc_type") or "LH").strip().upper()
        mslh = (body.get("mslh") or "").strip()
        stt = int(body.get("stt") or 1)
        page_num = int(body.get("page_num") or 2)
        ten_phan_bon = (body.get("ten_phan_bon") or "").strip()
        loai_phan_bon = (body.get("loai_phan_bon") or "Phân bón").strip()
        phuong_thuc = (body.get("phuong_thuc_su_dung") or "Bón rễ").strip()
        han_su_dung = (body.get("han_su_dung") or "36 tháng kể từ ngày sản xuất").strip()
        chi_tieu = (body.get("chi_tieu_chat_luong") or "").strip()
        hdsd = (body.get("huong_dan_su_dung") or "").strip()

        so_qd = (body.get("so_qd") or "").strip()
        qd_key = normalize_qd_key(so_qd) or mslh or str(int(time.time()))[-4:]
        if not so_qd:
            so_qd = f"{qd_key}/QĐ-BVTV-PB"

        ngay_ban_hanh = (body.get("ngay_ban_hanh") or "").strip()
        ngay_het_han = (body.get("ngay_het_han") or "").strip()
        nguoi_ky = (body.get("nguoi_ky") or "Cục BVTV").strip()
        don_vi = (body.get("don_vi_dang_ky") or "Đơn vị đăng ký").strip()
        msdn = (body.get("ma_so_doanh_nghiep") or "").strip()
        sdt = (body.get("dien_thoai") or "").strip()
        dc_goc = (body.get("dia_chi_goc") or "").strip()
        dc_sn = (body.get("dia_chi_sap_nhap") or dc_goc).strip()
        ghi_chu_sn = (body.get("ghi_chu_sap_nhap") or "").strip()
        pdf_path = (body.get("pdf_path") or "").strip()
        md5_hash = (body.get("md5_hash") or "").strip()

        conn = get_db()
        cur = conn.cursor()

        # Tìm hoặc tạo Decision
        existing_dec = cur.execute(
            "SELECT * FROM decisions WHERE so_qd=? OR (qd_key != '' AND qd_key=?) LIMIT 1",
            (so_qd, qd_key)
        ).fetchone()

        if existing_dec:
            doc_id = existing_dec["doc_id"]
            cur.execute("""
                UPDATE decisions SET
                    so_qd=?, ngay_ban_hanh= COALESCE(NULLIF(?, ''), ngay_ban_hanh),
                    ngay_het_han= COALESCE(NULLIF(?, ''), ngay_het_han),
                    don_vi_dang_ky= COALESCE(NULLIF(?, ''), don_vi_dang_ky),
                    ma_so_doanh_nghiep= COALESCE(NULLIF(?, ''), ma_so_doanh_nghiep),
                    dien_thoai= COALESCE(NULLIF(?, ''), dien_thoai),
                    dia_chi_goc= COALESCE(NULLIF(?, ''), dia_chi_goc),
                    dia_chi_sap_nhap= COALESCE(NULLIF(?, ''), dia_chi_sap_nhap),
                    ghi_chu_sap_nhap= COALESCE(NULLIF(?, ''), ghi_chu_sap_nhap),
                    default_pdf_path= COALESCE(NULLIF(?, ''), default_pdf_path)
                WHERE doc_id=?
            """, (so_qd, ngay_ban_hanh, ngay_het_han, don_vi, msdn, sdt, dc_goc, dc_sn, ghi_chu_sn, pdf_path, doc_id))
        else:
            doc_id = f"doc_user_{int(time.time() * 1000)}"
            cur.execute("""
                INSERT INTO decisions (
                    doc_id, qd_key, so_qd, ngay_ban_hanh, ngay_hieu_luc, ngay_het_han,
                    loai_qd, nguoi_ky, don_vi_dang_ky, dia_chi_goc, dien_thoai,
                    ma_so_doanh_nghiep, dia_chi_sap_nhap, ghi_chu_sap_nhap, pdf_md5, default_pdf_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                doc_id, qd_key, so_qd, ngay_ban_hanh, ngay_ban_hanh, ngay_het_han,
                "Công nhận phân bón lưu hành", nguoi_ky, don_vi, dc_goc, sdt,
                msdn, dc_sn, ghi_chu_sn, md5_hash, pdf_path
            ))

        new_prod_id = None
        if doc_type != "LH" and not ten_phan_bon:
            # Nếu chỉ thêm Hồ sơ liên quan (HQ, COA, UQ, KQPT) cho mã đã có
            cur.execute("""
                INSERT INTO related_docs (
                    doc_id, doc_type, mslh, so_hieu, ngay_cap, ngay_het_han,
                    don_vi_cap, don_vi_dang_ky, dia_chi_goc, chi_tieu_chat_luong, tom_tat, pdf_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                doc_id, doc_type, mslh, so_qd, ngay_ban_hanh, ngay_het_han,
                nguoi_ky, don_vi, dc_goc, chi_tieu, hdsd or f"Hồ sơ {doc_type} của mã {mslh}", pdf_path
            ))
            row_p = cur.execute("SELECT id FROM products WHERE mslh=? LIMIT 1", (mslh,)).fetchone()
            if row_p:
                new_prod_id = row_p["id"]
        else:
            if not mslh:
                mslh = str(int(time.time()))[-5:]
            if not ten_phan_bon:
                ten_phan_bon = f"Sản phẩm phân bón {mslh}"
            cur.execute("""
                INSERT INTO products (
                    mslh, stt, loai_phan_bon, ten_phan_bon, chi_tieu_chat_luong,
                    phuong_thuc_su_dung, huong_dan_su_dung, han_su_dung,
                    page_num, so_qd, qd_key, doc_id, pdf_path, is_in_folder
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(mslh, qd_key, stt) DO UPDATE SET
                    loai_phan_bon=excluded.loai_phan_bon,
                    ten_phan_bon=excluded.ten_phan_bon,
                    chi_tieu_chat_luong=excluded.chi_tieu_chat_luong,
                    phuong_thuc_su_dung=excluded.phuong_thuc_su_dung,
                    huong_dan_su_dung=excluded.huong_dan_su_dung,
                    han_su_dung=excluded.han_su_dung,
                    page_num=excluded.page_num,
                    so_qd=excluded.so_qd,
                    doc_id=excluded.doc_id,
                    pdf_path=COALESCE(NULLIF(excluded.pdf_path, ''), products.pdf_path),
                    is_in_folder=1
            """, (
                mslh, stt, loai_phan_bon, ten_phan_bon, chi_tieu,
                phuong_thuc, hdsd, han_su_dung,
                page_num, so_qd, qd_key, doc_id, pdf_path
            ))
            row_p = cur.execute(
                "SELECT id FROM products WHERE mslh=? AND qd_key=? AND stt=? LIMIT 1",
                (mslh, qd_key, stt)
            ).fetchone()
            if row_p:
                new_prod_id = row_p["id"]

            if doc_type != "LH":
                cur.execute("""
                    INSERT INTO related_docs (
                        doc_id, doc_type, mslh, so_hieu, ngay_cap, ngay_het_han,
                        don_vi_cap, don_vi_dang_ky, dia_chi_goc, chi_tieu_chat_luong, tom_tat, pdf_path
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    doc_id, doc_type, mslh, so_qd, ngay_ban_hanh, ngay_het_han,
                    nguoi_ky, don_vi, dc_goc, chi_tieu, f"Hồ sơ {doc_type} kèm theo mã {mslh}", pdf_path
                ))

        conn.commit()
        conn.close()
        refresh_memory_cache()
        self.send_json({"ok": True, "product_id": new_prod_id, "mslh": mslh})

    def handle_delete_product(self, body):
        pid = body.get("id")
        if not pid:
            return self.send_json({"ok": False, "error": "Thiếu ID sản phẩm"}, 400)
        conn = get_db()
        conn.execute("DELETE FROM products WHERE id=?", (int(pid),))
        conn.commit()
        conn.close()
        refresh_memory_cache()
        self.send_json({"ok": True})

    def get_auto_rotation(self, full_path, page_idx, page):
        nk = _norm_path(full_path)
        meta = PDF_META_CACHE.get(nk)
        md5_prefix = meta["md5_prefix"] if (meta and meta.get("md5_prefix")) else ""
        return compute_auto_rot_for_page(md5_prefix, os.path.basename(full_path), page_idx, page)

    def handle_pdf_info(self, qs):
        pdf_path = qs.get("path", [""])[0]
        if not pdf_path:
            return self.send_json({"error": "Không tìm thấy tệp PDF"}, 404)

        nk = _norm_path(pdf_path)
        cached = PDF_META_CACHE.get(nk) or PDF_META_CACHE.get(os.path.basename(pdf_path).lower())
        if cached and cached.get("page_count"):
            return self.send_json({
                "path": pdf_path,
                "file_name": cached.get("file_name") or os.path.basename(pdf_path),
                "page_count": cached["page_count"],
                "file_size": cached.get("file_size", 0)
            })

        if not os.path.exists(pdf_path):
            return self.send_json({"error": "Không tìm thấy tệp PDF"}, 404)
        try:
            doc = _open_pdf(pdf_path)
            pcount = len(doc)
            doc.close()
            fsize = os.path.getsize(pdf_path)
            with _CACHE_LOCK:
                PDF_META_CACHE[nk] = {
                    "md5_prefix": "",
                    "page_count": pcount,
                    "file_size": fsize,
                    "file_name": os.path.basename(pdf_path)
                }
            self.send_json({
                "path": pdf_path,
                "file_name": os.path.basename(pdf_path),
                "page_count": pcount,
                "file_size": fsize
            })
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def handle_pdf_page(self, qs):
        pdf_path = qs.get("path", [""])[0]
        page_num = max(1, int(qs.get("page", ["1"])[0]))
        extra_rot = int(qs.get("rot", ["0"])[0]) % 360
        dpi = min(220, max(72, int(qs.get("dpi", ["165"])[0])))

        if not pdf_path:
            self.send_raw_bytes(b"", "text/plain", status=404)
            return

        nk = _norm_path(pdf_path)
        cache_key = (nk, page_num, extra_rot, dpi)

        with _CACHE_LOCK:
            if cache_key in PDF_PAGE_CACHE:
                PDF_PAGE_CACHE.move_to_end(cache_key)
                img_bytes = PDF_PAGE_CACHE[cache_key]
                return self.send_raw_bytes(img_bytes, "image/jpeg", status=200, cache_control="max-age=86400")

        meta = PDF_META_CACHE.get(nk) or PDF_META_CACHE.get(os.path.basename(pdf_path).lower(), {})
        md5_prefix = meta.get("md5_prefix", "")
        pre_jpg_path = os.path.join(PDF_PAGES_DIR, f"{md5_prefix}_p{page_num}.jpg") if md5_prefix else ""

        # 1. Nếu có sẵn trang ảnh đã xoay thẳng trong data/pdf_pages (chạy Offline trên mọi máy tính)
        if pre_jpg_path and os.path.exists(pre_jpg_path) and extra_rot == 0:
            try:
                with open(pre_jpg_path, "rb") as fp:
                    img_bytes = fp.read()
                with _CACHE_LOCK:
                    PDF_PAGE_CACHE[cache_key] = img_bytes
                    if len(PDF_PAGE_CACHE) > MAX_PDF_PAGE_CACHE:
                        PDF_PAGE_CACHE.popitem(last=False)
                return self.send_raw_bytes(img_bytes, "image/jpeg", status=200, cache_control="max-age=86400")
            except Exception:
                pass

        # 2. Nếu máy người dùng không có file PDF gốc -> dùng ảnh trong data/pdf_pages hoặc tải từ GitHub
        if not os.path.exists(pdf_path) and md5_prefix:
            os.makedirs(PDF_PAGES_DIR, exist_ok=True)
            if not os.path.exists(pre_jpg_path):
                try:
                    remote_jpg_url = f"{GITHUB_RAW_BASE}/data/pdf_pages/{md5_prefix}_p{page_num}.jpg"
                    req = urllib.request.Request(remote_jpg_url, headers={"User-Agent": "QDLH-Vault/1.2"})
                    with urllib.request.urlopen(req, timeout=8) as resp:
                        jpg_data = resp.read()
                    with open(pre_jpg_path, "wb") as fp:
                        fp.write(jpg_data)
                except Exception:
                    pass

            if os.path.exists(pre_jpg_path):
                try:
                    with open(pre_jpg_path, "rb") as fp:
                        raw_jpg = fp.read()
                    if extra_rot == 0:
                        img_bytes = raw_jpg
                    else:
                        doc = fitz.open(stream=raw_jpg, filetype="jpeg")
                        pdf_conv = doc.convert_to_pdf()
                        doc.close()
                        pdoc = fitz.open("pdf", pdf_conv)
                        pdoc[0].set_rotation(extra_rot)
                        img_bytes = pdoc[0].get_pixmap(dpi=150, alpha=False).tobytes("jpeg", jpg_quality=90)
                        pdoc.close()
                    with _CACHE_LOCK:
                        PDF_PAGE_CACHE[cache_key] = img_bytes
                        if len(PDF_PAGE_CACHE) > MAX_PDF_PAGE_CACHE:
                            PDF_PAGE_CACHE.popitem(last=False)
                    return self.send_raw_bytes(img_bytes, "image/jpeg", status=200, cache_control="max-age=86400")
                except Exception:
                    pass

        if not os.path.exists(pdf_path):
            self.send_raw_bytes(b"", "text/plain", status=404)
            return

        try:
            doc = _open_pdf(pdf_path)
            idx = min(len(doc) - 1, page_num - 1)
            page = doc[idx]
            auto_rot = self.get_auto_rotation(pdf_path, idx, page)
            total_rot = (page.rotation + auto_rot + extra_rot) % 360
            page.set_rotation(total_rot)
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            img_bytes = pix.tobytes("jpeg", jpg_quality=92)
            doc.close()

            with _CACHE_LOCK:
                PDF_PAGE_CACHE[cache_key] = img_bytes
                if len(PDF_PAGE_CACHE) > MAX_PDF_PAGE_CACHE:
                    PDF_PAGE_CACHE.popitem(last=False)

            self.send_raw_bytes(img_bytes, "image/jpeg", status=200, cache_control="max-age=86400")
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def handle_pdf_stream(self, qs):
        pdf_path = qs.get("path", [""])[0]
        if not pdf_path or not os.path.exists(pdf_path):
            self.send_raw_bytes(b"", "text/plain", status=404)
            return
        try:
            doc = _open_pdf(pdf_path)
            for idx in range(1, len(doc)):
                page = doc[idx]
                auto_rot = self.get_auto_rotation(pdf_path, idx, page)
                if auto_rot:
                    page.set_rotation((page.rotation + auto_rot) % 360)
            pdf_bytes = doc.tobytes()
            doc.close()
            self.send_raw_bytes(pdf_bytes, "application/pdf", status=200)
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def handle_update_product(self, body):
        conn = get_db()
        cur = conn.cursor()
        pid = body.get("id")
        if pid:
            cur.execute("""
                UPDATE products SET
                    mslh=?, stt=?, loai_phan_bon=?, ten_phan_bon=?,
                    chi_tieu_chat_luong=?, phuong_thuc_su_dung=?,
                    huong_dan_su_dung=?, han_su_dung=?, page_num=?
                WHERE id=?
            """, (
                body.get("mslh", ""), int(body.get("stt", 1)),
                body.get("loai_phan_bon", ""), body.get("ten_phan_bon", ""),
                body.get("chi_tieu_chat_luong", ""), body.get("phuong_thuc_su_dung", ""),
                body.get("huong_dan_su_dung", ""), body.get("han_su_dung", ""),
                int(body.get("page_num", 2)), int(pid)
            ))
        conn.commit()
        conn.close()
        refresh_memory_cache()
        self.send_json({"ok": True})

    def handle_update_decision(self, body):
        conn = get_db()
        cur = conn.cursor()
        doc_id = body.get("doc_id")
        msdn = (body.get("ma_so_doanh_nghiep") or "").strip()
        don_vi = (body.get("don_vi_dang_ky") or "").strip()
        if doc_id:
            cur.execute("""
                UPDATE decisions SET
                    so_qd=?, ngay_ban_hanh=?, ngay_hieu_luc=?, ngay_het_han=?,
                    loai_qd=?, nguoi_ky=?, don_vi_dang_ky=?, dia_chi_goc=?,
                    dien_thoai=?, ma_so_doanh_nghiep=?, dia_chi_sap_nhap=?, ghi_chu_sap_nhap=?
                WHERE doc_id=?
            """, (
                body.get("so_qd", ""), body.get("ngay_ban_hanh", ""),
                body.get("ngay_hieu_luc", ""), body.get("ngay_het_han", ""),
                body.get("loai_qd", ""), body.get("nguoi_ky", ""),
                don_vi, body.get("dia_chi_goc", ""),
                body.get("dien_thoai", ""), msdn,
                body.get("dia_chi_sap_nhap", ""), body.get("ghi_chu_sap_nhap", ""),
                doc_id
            ))
        if msdn:
            cur.execute("""
                UPDATE decisions SET
                    don_vi_dang_ky=?, dien_thoai=?, dia_chi_sap_nhap=?, ghi_chu_sap_nhap=?
                WHERE ma_so_doanh_nghiep=?
            """, (
                don_vi, body.get("dien_thoai", ""),
                body.get("dia_chi_sap_nhap", ""), body.get("ghi_chu_sap_nhap", ""),
                msdn
            ))
        conn.commit()
        conn.close()
        refresh_memory_cache()
        self.send_json({"ok": True})

    def handle_open_file(self, body):
        pdf_path = body.get("path", "")
        mode = body.get("mode", "select")
        if pdf_path and os.path.exists(pdf_path):
            try:
                if mode == "open":
                    os.startfile(pdf_path)
                else:
                    subprocess.Popen(["explorer.exe", f"/select,{os.path.normpath(pdf_path)}"])
                return self.send_json({"ok": True})
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)
        return self.send_json({"error": "Tệp gốc không nằm trên ổ đĩa máy này (đang xem qua bộ ảnh PDF tích hợp sẵn)"}, 404)

    def handle_sync_folder(self):
        conn = get_db()
        count = scan_pdf_folder(conn)
        conn.close()
        refresh_memory_cache()
        self.send_json({"ok": True, "scanned_files": count})

    def handle_check_update(self):
        local_ver = get_local_version()
        remote_ver = None
        has_update = False
        try:
            url = f"{GITHUB_RAW_BASE}/data/version.json?t={int(time.time())}"
            req = urllib.request.Request(url, headers={"User-Agent": "QDLH-Vault/1.2", "Cache-Control": "no-cache"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                remote_ver = json.loads(resp.read().decode("utf-8"))
            if int(remote_ver.get("build_num", 0)) > int(local_ver.get("build_num", 0)):
                has_update = True
        except Exception as e:
            return self.send_json({
                "ok": False,
                "local": local_ver,
                "remote": None,
                "has_update": False,
                "error": str(e)
            })

        self.send_json({
            "ok": True,
            "local": local_ver,
            "remote": remote_ver,
            "has_update": has_update
        })

    def handle_pull_update(self):
        """
        CHỈ CẬP NHẬT TÍNH NĂNG & GIAO DIỆN TỪ GITHUB (lkey124/QDLH):
        Tuyệt đối KHÔNG ghi đè qdlh.sqlite, seed_data.json hay thư mục user_pdfs để bảo toàn 100%
        các tệp đã thêm và thông tin đã chỉnh sửa trên máy người dùng!
        """
        files_to_pull = [
            ("data/version.json", VERSION_JSON_PATH),
            ("public/index.html", os.path.join(STATIC_DIR, "index.html")),
            ("public/styles.css", os.path.join(STATIC_DIR, "styles.css")),
            ("public/app.js", os.path.join(STATIC_DIR, "app.js")),
            ("server.py", os.path.join(BASE_DIR, "server.py")),
            ("qdlh_desktop.py", os.path.join(BASE_DIR, "qdlh_desktop.py")),
        ]
        ts = int(time.time())
        pulled = []
        try:
            for rel_url, dest_path in files_to_pull:
                url = f"{GITHUB_RAW_BASE}/{rel_url}?t={ts}"
                req = urllib.request.Request(url, headers={"User-Agent": "QDLH-Vault/1.2", "Cache-Control": "no-cache"})
                with urllib.request.urlopen(req, timeout=15) as resp:
                    raw = resp.read()
                os.makedirs(os.path.dirname(dest_path), exist_ok=True)
                tmp_path = dest_path + ".tmp"
                with open(tmp_path, "wb") as fp:
                    fp.write(raw)
                os.replace(tmp_path, dest_path)
                pulled.append(rel_url)

            init_db()
            refresh_memory_cache()
            new_ver = get_local_version()
            self.send_json({
                "ok": True,
                "pulled_files": pulled,
                "version_info": new_ver
            })
        except Exception as e:
            self.send_json({"ok": False, "error": f"Không thể tải bản cập nhật tính năng từ GitHub: {e}"}, 500)

    def handle_publish_update(self, body):
        """Phát hành phiên bản Tính năng mới lên GitHub lkey124/QDLH."""
        local_ver = get_local_version()
        new_build = int(local_ver.get("build_num", 1)) + 1
        parts = str(local_ver.get("version", "1.2.0")).split(".")
        if len(parts) == 3 and parts[2].isdigit():
            new_ver_str = f"{parts[0]}.{parts[1]}.{int(parts[2]) + 1}"
        else:
            new_ver_str = f"1.2.{new_build}"

        note = (body.get("note") or "").strip() or f"Nâng cấp tính năng QĐLH Vault v{new_ver_str}"
        now_str = datetime.now().strftime("%d/%m/%Y %H:%M")

        new_ver_obj = {
            "version": new_ver_str,
            "build_num": new_build,
            "updated_at": now_str,
            "repo": GITHUB_REPO_SLUG,
            "note": note
        }

        try:
            with open(VERSION_JSON_PATH, "w", encoding="utf-8") as f:
                json.dump(new_ver_obj, f, ensure_ascii=False, indent=2)

            refresh_memory_cache()

            subprocess.run(["git", "add", "data/version.json", "public/", "server.py", "qdlh_desktop.py"], cwd=BASE_DIR, check=False)
            subprocess.run(["git", "commit", "-m", f"Release Feature Update v{new_ver_str}: {note}"], cwd=BASE_DIR, check=False)
            push_res = subprocess.run(
                ["git", "push", "-u", "origin", "main"],
                cwd=BASE_DIR,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace"
            )
            if push_res.returncode != 0:
                return self.send_json({
                    "ok": False,
                    "error": f"Lỗi khi đẩy lên GitHub: {push_res.stderr or push_res.stdout}"
                }, 500)

            self.send_json({
                "ok": True,
                "version_info": new_ver_obj
            })
        except Exception as e:
            self.send_json({"ok": False, "error": str(e)}, 500)

    def handle_save_excel(self):
        conn = get_db()
        cur = conn.cursor()
        rows = cur.execute("""
            SELECT
                p.mslh, p.stt, p.loai_phan_bon, p.ten_phan_bon,
                p.chi_tieu_chat_luong, p.phuong_thuc_su_dung, p.huong_dan_su_dung, p.han_su_dung,
                d.so_qd, d.ngay_ban_hanh, d.ngay_het_han,
                d.don_vi_dang_ky, d.ma_so_doanh_nghiep, d.dien_thoai,
                d.dia_chi_goc, d.dia_chi_sap_nhap, d.ghi_chu_sap_nhap,
                p.pdf_path
            FROM products p
            LEFT JOIN decisions d ON p.doc_id = d.doc_id
            ORDER BY p.is_in_folder DESC, p.mslh ASC
        """).fetchall()
        conn.close()

        out_dir = PDF_ROOT if os.path.exists(PDF_ROOT) else BASE_DIR
        out_path = os.path.join(out_dir, "Danh_Muc_QDLH_Phan_Bon.csv")
        with open(out_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f)
            writer.writerow([
                "Mã số phân bón (MSLH)", "STT", "Loại phân bón", "Tên phân bón",
                "Chỉ tiêu chất lượng", "Phương thức sử dụng", "Hướng dẫn sử dụng", "Hạn sử dụng",
                "Số Quyết định", "Ngày ban hành", "Ngày hết hạn",
                "Đơn vị đăng ký", "Mã số doanh nghiệp", "Điện thoại",
                "Địa chỉ gốc (trong QĐ)", "Địa chỉ sau Sáp nhập hành chính", "Ghi chú Sáp nhập",
                "Đường dẫn tệp PDF"
            ])
            for r in rows:
                writer.writerow(list(r))

        try:
            subprocess.Popen(["explorer.exe", f"/select,{os.path.normpath(out_path)}"])
        except Exception:
            pass
        self.send_json({"ok": True, "saved_path": out_path})

    def handle_export_csv(self):
        conn = get_db()
        cur = conn.cursor()
        rows = cur.execute("""
            SELECT
                p.mslh, p.stt, p.loai_phan_bon, p.ten_phan_bon,
                p.chi_tieu_chat_luong, p.phuong_thuc_su_dung, p.huong_dan_su_dung, p.han_su_dung,
                d.so_qd, d.ngay_ban_hanh, d.ngay_het_han,
                d.don_vi_dang_ky, d.ma_so_doanh_nghiep, d.dien_thoai,
                d.dia_chi_goc, d.dia_chi_sap_nhap, d.ghi_chu_sap_nhap,
                p.pdf_path
            FROM products p
            LEFT JOIN decisions d ON p.doc_id = d.doc_id
            ORDER BY p.is_in_folder DESC, p.mslh ASC
        """).fetchall()
        conn.close()

        output = io.StringIO()
        output.write("\ufeff")
        writer = csv.writer(output)
        writer.writerow([
            "Mã số phân bón (MSLH)", "STT", "Loại phân bón", "Tên phân bón",
            "Chỉ tiêu chất lượng", "Phương thức sử dụng", "Hướng dẫn sử dụng", "Hạn sử dụng",
            "Số Quyết định", "Ngày ban hành", "Ngày hết hạn",
            "Đơn vị đăng ký", "Mã số doanh nghiệp", "Điện thoại",
            "Địa chỉ gốc (trong QĐ)", "Địa chỉ sau Sáp nhập hành chính", "Ghi chú Sáp nhập",
            "Đường dẫn tệp PDF"
        ])
        for r in rows:
            writer.writerow(list(r))

        csv_bytes = output.getvalue().encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="Danh_Muc_QDLH_Phan_Bon.csv"')
        self.send_header("Content-Length", str(len(csv_bytes)))
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(csv_bytes)


def main():
    init_db()
    load_seed_if_needed()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), QDLHRequestHandler)
    print(f"============================================================")
    print(f"  QĐLH Vault Server đang chạy tại: http://localhost:{PORT}")
    print(f"  Thư mục dữ liệu gốc: {BASE_DIR}")
    print(f"============================================================")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nĐã dừng server.")


if __name__ == "__main__":
    main()
