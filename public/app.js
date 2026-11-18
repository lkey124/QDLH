// -*- coding: utf-8 -*-
/**
 * Logic Giao diện Phần mềm Desktop QĐLH Vault — Bản Đa Người Dùng (Full Unlock + Thêm Tệp + Auto-Update Tính Năng)
 * - Mở khóa 100% chức năng: Thêm tệp PDF mới từ máy, thêm mã phân bón/QĐ mới, sửa thông tin, xuất Excel.
 * - Cập nhật tính năng qua GitHub (lkey124/QDLH) chỉ cập nhật giao diện & tính năng, bảo toàn 100% dữ liệu & tệp đã lưu trong máy.
 * - Hỗ trợ Zoom PDF (Lăn chuột, Nhấp đúp 200%, Nút ➖/100%/➕) và Kéo chuột di chuyển (Drag-to-Pan).
 */

let APP_DATA = {
  products: [],
  decisions: [],
  companies: [],
  related_docs: [],
  pdf_files: [],
  version_info: { version: "1.2.0", build_num: 2 },
  is_git_repo: false
};

let PRODUCTS_BY_ID = new Map();
let SIBLINGS_MAP = new Map();
let FILTERED_PRODUCTS = [];
let SELECTED_PRODUCT = null;
let SHOW_ALL_SIBLINGS_IN_TABLE = false;
let IS_PDF_OPEN = false;

let TABS_RENDERED = {
  companies: false,
  decisions: false,
  files: false
};

let CURRENT_FULL_PROFILE_TEXT = "";
let CURRENT_LABEL_TEXT = "";
let PDF_DEBOUNCE_TIMER = null;
let SEARCH_RAF_ID = null;

let ADD_UPLOADED_PDF_PATH = "";
let ADD_UPLOADED_MD5 = "";

let PDF_STATE = {
  path: "",
  page: 1,
  totalPages: 2,
  extraRot: 0,
  sttPage: 2,
  zoom: 100
};

function removeAccents(str) {
  if (!str) return "";
  return String(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showToast(msg, duration = 2200) {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

async function copyText(text, label = "nội dung") {
  const sel = window.getSelection ? window.getSelection().toString() : "";
  if (sel && sel.trim().length > 0) return;

  const clean = (text || "").trim();
  try {
    await navigator.clipboard.writeText(clean);
  } catch (err) {
    const ta = document.createElement("textarea");
    ta.value = clean;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  showToast(`✅ Đã copy ${label}`);
}

function parseVNDate(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (!m) return null;
  let day = parseInt(m[1], 10);
  let month = parseInt(m[2], 10) - 1;
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  return new Date(year, month, day);
}

function getValidityStatus(ngayHetHan) {
  const exp = parseVNDate(ngayHetHan);
  if (!exp) return { code: "active", label: "🟢 Đang lưu hành" };
  const now = new Date();
  const diffDays = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return { code: "expiring", label: `🔴 Hết hạn (${ngayHetHan})` };
  if (diffDays <= 365) return { code: "expiring", label: `🟡 Sắp hết hạn (${ngayHetHan} • còn ${diffDays} ngày)` };
  return { code: "active", label: `🟢 Hiệu lực đến ${ngayHetHan}` };
}

function buildFastIndexes() {
  PRODUCTS_BY_ID.clear();
  SIBLINGS_MAP.clear();

  for (let i = 0; i < APP_DATA.products.length; i++) {
    const p = APP_DATA.products[i];
    PRODUCTS_BY_ID.set(p.id, p);

    p._validity = getValidityStatus(p.ngay_het_han);
    p._searchStr = removeAccents(
      `${p.mslh} LH${p.mslh} ${p.ten_phan_bon} ${p.loai_phan_bon} ${p.so_qd_full} QĐ${p.qd_key} QD${p.qd_key} ${p.don_vi_dang_ky} ${p.dia_chi_goc} ${p.dia_chi_sap_nhap} ${p.chi_tieu_chat_luong}`
    );

    const groupKey = p.doc_id || `qd_${p.qd_key}`;
    if (!SIBLINGS_MAP.has(groupKey)) {
      SIBLINGS_MAP.set(groupKey, []);
    }
    SIBLINGS_MAP.get(groupKey).push(p);
  }
}

async function loadAllData() {
  const res = await fetch("/api/data");
  APP_DATA = await res.json();

  buildFastIndexes();

  document.getElementById("badge-companies").textContent = APP_DATA.companies.length;
  document.getElementById("badge-decisions").textContent = APP_DATA.decisions.length;
  document.getElementById("badge-files").textContent = APP_DATA.pdf_files.length;

  if (APP_DATA.version_info && APP_DATA.version_info.version) {
    document.getElementById("app-version-badge").textContent = `v${APP_DATA.version_info.version}`;
  }

  const pubBtn = document.getElementById("btn-publish-update");
  if (pubBtn) {
    pubBtn.classList.toggle("hidden", !APP_DATA.is_git_repo);
  }

  TABS_RENDERED = { companies: false, decisions: false, files: false };

  populateCompanyFilter();
  applyFiltersAndRender(false);

  if (!SELECTED_PRODUCT && FILTERED_PRODUCTS.length > 0) {
    selectProduct(FILTERED_PRODUCTS[0]);
  }
}

async function checkRemoteUpdate(silent = true) {
  try {
    const res = await fetch("/api/check-update");
    const data = await res.json();
    const btnPull = document.getElementById("btn-pull-update");
    const dot = document.getElementById("update-dot");
    if (data.has_update && data.remote) {
      dot.classList.remove("hidden");
      btnPull.classList.add("has-update");
      btnPull.title = `Có bản cập nhật tính năng mới v${data.remote.version}: ${data.remote.note || ""}`;
      showToast(`🔔 Có bản cập nhật tính năng mới (v${data.remote.version})! Bấm nút "🔄 Cập nhật" trên thanh công cụ.`, 4000);
      return true;
    } else {
      dot.classList.add("hidden");
      btnPull.classList.remove("has-update");
      if (!silent) {
        const curV = (data.local && data.local.version) ? data.local.version : "1.2.0";
        showToast(`✅ Phần mềm đang ở phiên bản tính năng mới nhất (v${curV}).`);
      }
      return false;
    }
  } catch (e) {
    if (!silent) {
      showToast("⚠️ Không thể kết nối kho GitHub để kiểm tra cập nhật.");
    }
    return false;
  }
}

function populateCompanyFilter() {
  const sel = document.getElementById("filter-company");
  const current = sel.value;
  const html = [`<option value="">Tất cả Đơn vị (${APP_DATA.companies.length})</option>`];
  for (let i = 0; i < APP_DATA.companies.length; i++) {
    const c = APP_DATA.companies[i];
    html.push(`<option value="${escapeHtml(c.don_vi_dang_ky)}">${escapeHtml(c.don_vi_dang_ky)} (${c.product_count})</option>`);
  }
  sel.innerHTML = html.join("");
  sel.value = current;
}

function applyFiltersAndRender(showDropdown = true) {
  const qRaw = document.getElementById("main-search").value.trim();
  document.getElementById("clear-search").classList.toggle("hidden", !qRaw);

  const qNorm = removeAccents(qRaw);
  const scope = document.getElementById("filter-scope").value;
  const companyFilter = document.getElementById("filter-company").value;

  const matched = [];
  const allProds = APP_DATA.products;
  for (let i = 0; i < allProds.length; i++) {
    const p = allProds[i];
    if (scope === "folder" && !p.is_in_folder) continue;
    if (companyFilter && p.don_vi_dang_ky !== companyFilter) continue;
    if (qNorm && !p._searchStr.includes(qNorm)) continue;
    matched.push(p);
  }

  if (qRaw) {
    const cleanDigits = qRaw.replace(/\D/g, "");
    matched.sort((a, b) => {
      const aExact = a.mslh === qRaw || (cleanDigits.length === 5 && a.mslh === cleanDigits) ? 1 : 0;
      const bExact = b.mslh === qRaw || (cleanDigits.length === 5 && b.mslh === cleanDigits) ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      const aStart = cleanDigits.length >= 2 && a.mslh.startsWith(cleanDigits) ? 1 : 0;
      const bStart = cleanDigits.length >= 2 && b.mslh.startsWith(cleanDigits) ? 1 : 0;
      return bStart - aStart;
    });
  }

  FILTERED_PRODUCTS = matched;

  let hasExact5Digit = false;
  if (FILTERED_PRODUCTS.length > 0) {
    const cleanCode = qRaw.replace(/^LH/i, "").trim();
    const exactMatch = qRaw ? FILTERED_PRODUCTS.find((p) => p.mslh === qRaw || p.mslh === cleanCode) : null;
    if (exactMatch) {
      SELECTED_PRODUCT = exactMatch;
      hasExact5Digit = FILTERED_PRODUCTS.filter((p) => p.mslh === exactMatch.mslh).length === 1;
    } else if (!SELECTED_PRODUCT || !FILTERED_PRODUCTS.some((x) => x.id === SELECTED_PRODUCT.id)) {
      SELECTED_PRODUCT = FILTERED_PRODUCTS[0];
    }
  }

  if (SELECTED_PRODUCT && FILTERED_PRODUCTS.length > 0) {
    renderProductDetail(SELECTED_PRODUCT);
  }

  if (showDropdown && qRaw && !hasExact5Digit) {
    renderSearchDropdown();
  } else {
    hideSearchDropdown();
  }
}

function renderSearchDropdown() {
  const dropEl = document.getElementById("search-dropdown");
  if (!dropEl) return;

  if (FILTERED_PRODUCTS.length === 0) {
    dropEl.innerHTML = `<div style="padding:10px 12px;color:#64748b;font-size:12.5px;">Không tìm thấy mã phân bón phù hợp. Bấm <b>➕ Thêm Tệp / Mã</b> để thêm mới.</div>`;
    dropEl.classList.remove("hidden");
    return;
  }

  const topItems = FILTERED_PRODUCTS.slice(0, 25);
  const selId = SELECTED_PRODUCT ? SELECTED_PRODUCT.id : -1;
  dropEl.innerHTML = topItems.map((p) => `
    <div class="sdrop-item ${p.id === selId ? "active" : ""}" data-id="${p.id}">
      <div class="sdrop-left">
        <span class="sdrop-code">${escapeHtml(p.mslh)}</span>
        <span class="sdrop-name">${escapeHtml(p.ten_phan_bon)}</span>
      </div>
      <span class="sdrop-meta">QĐ ${escapeHtml(p.qd_key)} (STT ${escapeHtml(p.stt)}) • ${escapeHtml(p.don_vi_dang_ky)}</span>
    </div>
  `).join("");
  dropEl.classList.remove("hidden");
}

function hideSearchDropdown() {
  const dropEl = document.getElementById("search-dropdown");
  if (dropEl) dropEl.classList.add("hidden");
}

function selectProduct(p) {
  if (!p) return;
  SELECTED_PRODUCT = p;
  renderProductDetail(p);
}

function renderProductDetail(p) {
  document.getElementById("empty-detail").classList.add("hidden");
  const container = document.getElementById("product-detail-content");
  container.classList.remove("hidden");

  const st = p._validity || getValidityStatus(p.ngay_het_han);
  const groupKey = p.doc_id || `qd_${p.qd_key}`;
  const siblings = SIBLINGS_MAP.get(groupKey) || [p];
  const tableRowsData = SHOW_ALL_SIBLINGS_IN_TABLE ? siblings : [p];

  CURRENT_FULL_PROFILE_TEXT = [
    `MÃ SỐ PHÂN BÓN: ${p.mslh}`,
    `Tên phân bón: ${p.ten_phan_bon}`,
    `Loại phân bón: ${p.loai_phan_bon}`,
    `Phương thức sử dụng: ${p.phuong_thuc_su_dung}`,
    `Quyết định lưu hành số: ${p.so_qd_full} ngày ${p.ngay_ban_hanh} (STT ${p.stt})`,
    `Thời hạn lưu hành: Từ ${p.ngay_hieu_luc || p.ngay_ban_hanh} đến ${p.ngay_het_han}`,
    `Đơn vị đăng ký: ${p.don_vi_dang_ky}`,
    `Mã số doanh nghiệp: ${p.ma_so_doanh_nghiep || ""} | Điện thoại: ${p.dien_thoai || ""}`,
    `Địa chỉ trong Quyết định: ${p.dia_chi_goc}`,
    `Địa chỉ sau sáp nhập: ${p.dia_chi_sap_nhap}`,
    `Chỉ tiêu chất lượng:\n${p.chi_tieu_chat_luong}`,
    `Hướng dẫn sử dụng:\n${p.huong_dan_su_dung}`,
    `Hạn sử dụng: ${p.han_su_dung}`
  ].join("\n");

  CURRENT_LABEL_TEXT = [
    `TÊN PHÂN BÓN: ${p.ten_phan_bon}`,
    `Loại phân bón: ${p.loai_phan_bon} — Mã số phân bón: ${p.mslh}`,
    `Quyết định lưu hành số: ${p.so_qd_full} ngày ${p.ngay_ban_hanh} của Cục Bảo vệ thực vật`,
    `Đơn vị đăng ký: ${p.don_vi_dang_ky}`,
    `Địa chỉ (theo QĐ): ${p.dia_chi_goc}`,
    `Địa chỉ (sau sáp nhập): ${p.dia_chi_sap_nhap}`,
    `Phương thức sử dụng: ${p.phuong_thuc_su_dung}`,
    `Chỉ tiêu chất lượng:\n${p.chi_tieu_chat_luong}`,
    `Hướng dẫn sử dụng:\n${p.huong_dan_su_dung}`,
    `Hạn sử dụng: ${p.han_su_dung}`
  ].join("\n");

  container.innerHTML = `
    <!-- 1. THANH SẢN PHẨM GỌN (COMPACT PRODUCT BAR) -->
    <div class="prod-topbar">
      <div class="prod-identity">
        <div class="mslh-hero-btn" data-copy="${escapeHtml(p.mslh)}" data-label="Mã số phân bón ${escapeHtml(p.mslh)}" title="Bấm để copy Mã số phân bón">
          <small>Mã số PB</small>
          <strong>${escapeHtml(p.mslh)}</strong>
        </div>
        <div class="prod-titles">
          <h1>${escapeHtml(p.ten_phan_bon)}</h1>
          <div class="prod-badges">
            <span class="badge">📦 ${escapeHtml(p.loai_phan_bon)}</span>
            <span class="badge">🌱 ${escapeHtml(p.phuong_thuc_su_dung)}</span>
            <span class="badge">📜 QĐ ${escapeHtml(p.so_qd_full)} (STT ${escapeHtml(p.stt)})</span>
            <span class="badge ${st.code}">${escapeHtml(st.label)}</span>
          </div>
        </div>
      </div>

      <div class="prod-actions">
        <button class="btn-action primary" data-action="copy-all">
          📋 Copy Trọn Bộ
        </button>
        <button class="btn-action secondary" data-action="copy-label">
          🏷️ Copy Nhãn Phụ
        </button>
        <button class="btn-action amber ${IS_PDF_OPEN ? "active" : ""}" id="btn-toggle-pdf" data-action="toggle-pdf">
          📄 ${IS_PDF_OPEN ? "Đóng PDF" : "Xem PDF Gốc"}
        </button>
        <button class="btn-action secondary" data-action="reveal-disk" title="Mở thư mục chứa tệp PDF này">
          📂 Mở Thư Mục
        </button>
        <button class="btn-action secondary" data-action="edit-record">
          ✏️ Sửa
        </button>
      </div>
    </div>

    <!-- 2. KHỐI PHÁP LÝ & ĐỐI CHIẾU ĐỊA CHỈ SÁP NHẬP (GỌN TRÊN 2 HÀNG - CHẠM LÀ COPY) -->
    <div class="sheet-card">
      <div class="legal-strip">
        <div class="cbox" data-copy="${escapeHtml(`Số ${p.so_qd_full} ngày ${p.ngay_ban_hanh}`)}" data-label="Số Quyết định & Ngày cấp">
          <div class="cbox-lbl">Số Quyết định &amp; Ngày cấp</div>
          <div class="cbox-val">Số ${escapeHtml(p.so_qd_full)}</div>
          <div class="cbox-sub">Ngày ban hành: ${escapeHtml(p.ngay_ban_hanh)}</div>
        </div>

        <div class="cbox" data-copy="${escapeHtml(`Từ ${p.ngay_hieu_luc || p.ngay_ban_hanh} đến ${p.ngay_het_han}`)}" data-label="Thời hạn lưu hành">
          <div class="cbox-lbl">Thời hạn lưu hành</div>
          <div class="cbox-val">Đến ${escapeHtml(p.ngay_het_han)}</div>
          <div class="cbox-sub">Người ký: ${escapeHtml(p.nguoi_ky || "Cục BVTV")}</div>
        </div>

        <div class="cbox" data-copy="${escapeHtml(p.don_vi_dang_ky)}" data-label="Tên Đơn vị đăng ký">
          <div class="cbox-lbl">Đơn vị đăng ký</div>
          <div class="cbox-val">${escapeHtml(p.don_vi_dang_ky)}</div>
        </div>

        <div class="cbox" data-copy="${escapeHtml(p.ma_so_doanh_nghiep)}" data-label="Mã số doanh nghiệp">
          <div class="cbox-lbl">Mã số DN &amp; Điện thoại</div>
          <div class="cbox-val" style="font-family:var(--font-mono);">${escapeHtml(p.ma_so_doanh_nghiep || "N/A")}</div>
          <div class="cbox-sub">ĐT: ${escapeHtml(p.dien_thoai || "N/A")}</div>
        </div>
      </div>

      <div class="address-strip">
        <div class="cbox orig" data-copy="${escapeHtml(p.dia_chi_goc)}" data-label="Địa chỉ gốc ghi trong Quyết định">
          <div class="cbox-lbl">📍 Địa chỉ đơn vị ghi trong Văn bản Quyết định (Địa chỉ gốc)</div>
          <div class="cbox-val">${escapeHtml(p.dia_chi_goc || "Đang cập nhật")}</div>
        </div>

        <div class="cbox merged" data-copy="${escapeHtml(p.dia_chi_sap_nhap)}" data-label="Địa chỉ mới sau sáp nhập hành chính">
          <div class="cbox-lbl">🗺️ Địa chỉ đơn vị sau Sáp nhập Hành chính (Địa chỉ mới)</div>
          <div class="cbox-val">${escapeHtml(p.dia_chi_sap_nhap || p.dia_chi_goc || "Đang cập nhật")}</div>
          ${p.ghi_chu_sap_nhap ? `<div class="cbox-note">💡 ${escapeHtml(p.ghi_chu_sap_nhap)}</div>` : ""}
        </div>
      </div>
    </div>

    <!-- 3. BẢNG PHỤ LỤC 8 CỘT CHUẨN QUYẾT ĐỊNH (HIỂN THỊ NGAY TRÊN MÀN HÌNH, BẤM Ô NÀO COPY Ô ĐÓ) -->
    <div class="sheet-card">
      <div class="table-header-bar">
        <div>
          <span class="table-title-inline">📋 BẢNG PHỤ LỤC CÔNG NHẬN PHÂN BÓN LƯU HÀNH</span>
          <span class="table-sub-inline"> — (Kèm theo Quyết định số ${escapeHtml(p.so_qd_full)} ngày ${escapeHtml(p.ngay_ban_hanh)})</span>
        </div>

        ${siblings.length > 1 ? `
          <button class="btn-action secondary" data-action="toggle-siblings" style="height:28px;font-size:12px;">
            ${SHOW_ALL_SIBLINGS_IN_TABLE
              ? `🎯 Chỉ hiện mã ${escapeHtml(p.mslh)} (STT ${escapeHtml(p.stt)})`
              : `📋 Xem cả ${siblings.length} sản phẩm cùng QĐ ${escapeHtml(p.so_qd_full)}`}
          </button>
        ` : `<span style="font-size:11.5px;color:#64748b;">💡 Bấm vào bất kỳ ô nào trong bảng để Copy</span>`}
      </div>

      <table class="qd-table">
        <thead>
          <tr>
            <th style="width:44px;">STT</th>
            <th style="width:125px;">Loại<br>phân bón</th>
            <th style="width:145px;">Tên<br>phân bón</th>
            <th style="width:92px;">Mã số<br>phân bón<sup>(*)</sup></th>
            <th style="width:25%;">Chỉ tiêu chất lượng</th>
            <th style="width:95px;">Phương thức<br>sử dụng<sup>(**)</sup></th>
            <th>Hướng dẫn sử dụng</th>
            <th style="width:92px;">Hạn<br>sử dụng</th>
          </tr>
        </thead>
        <tbody>
          ${tableRowsData.map((row) => `
            <tr class="${row.id === p.id && SHOW_ALL_SIBLINGS_IN_TABLE ? "current-row" : ""}">
              <td class="td-c" data-copy="${escapeHtml(row.stt)}" data-label="STT ${escapeHtml(row.stt)}">
                <b>${escapeHtml(row.stt)}</b>
              </td>
              <td class="td-c" data-copy="${escapeHtml(row.loai_phan_bon)}" data-label="Loại phân bón">
                ${escapeHtml(row.loai_phan_bon)}
              </td>
              <td class="td-c" style="font-weight:700;" data-copy="${escapeHtml(row.ten_phan_bon)}" data-label="Tên phân bón">
                ${escapeHtml(row.ten_phan_bon)}
              </td>
              <td class="td-code" data-copy="${escapeHtml(row.mslh)}" data-label="Mã số phân bón ${escapeHtml(row.mslh)}">
                ${escapeHtml(row.mslh)}
              </td>
              <td data-copy="${escapeHtml(row.chi_tieu_chat_luong)}" data-label="Chỉ tiêu chất lượng (${escapeHtml(row.mslh)})">
                <div class="pre-line">${escapeHtml(row.chi_tieu_chat_luong)}</div>
              </td>
              <td class="td-c" data-copy="${escapeHtml(row.phuong_thuc_su_dung)}" data-label="Phương thức sử dụng">
                ${escapeHtml(row.phuong_thuc_su_dung)}
              </td>
              <td data-copy="${escapeHtml(row.huong_dan_su_dung)}" data-label="Hướng dẫn sử dụng (${escapeHtml(row.mslh)})">
                <div class="pre-line">${escapeHtml(row.huong_dan_su_dung)}</div>
              </td>
              <td class="td-c" data-copy="${escapeHtml(row.han_su_dung)}" data-label="Hạn sử dụng">
                ${escapeHtml(row.han_su_dung)}
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>

      ${siblings.length > 1 ? `
        <div class="siblings-bar">
          <span style="font-size:11.5px;font-weight:700;color:#64748b;">Cùng QĐ ${escapeHtml(p.so_qd_full)}:</span>
          ${siblings.map((s) => `
            <button class="sib-chip ${s.id === p.id ? "current" : ""}" data-sibling-id="${s.id}">
              STT ${escapeHtml(s.stt)}: <b>${escapeHtml(s.mslh)}</b> (${escapeHtml(s.ten_phan_bon)})
            </button>
          `).join("")}
        </div>
      ` : ""}

      ${(p.related_docs && p.related_docs.length > 0) ? `
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;">
          ${p.related_docs.map((rd) => `
            <div class="cbox" style="background:#fffbeb;border-color:#fde68a;" data-copy="${escapeHtml(rd.chi_tieu_chat_luong || rd.tom_tat)}" data-label="Hồ sơ ${escapeHtml(rd.doc_type)}">
              <div class="cbox-lbl" style="color:#b45309;">📎 Hồ sơ ${escapeHtml(rd.doc_type)} đi kèm — Số hiệu: ${escapeHtml(rd.so_hieu)} (${escapeHtml(rd.ngay_cap)})</div>
              <div class="cbox-val" style="font-size:13px;">${escapeHtml(rd.tom_tat)}</div>
              ${rd.chi_tieu_chat_luong ? `<div class="cbox-sub"><b>Chỉ tiêu:</b> ${escapeHtml(rd.chi_tieu_chat_luong)}</div>` : ""}
            </div>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;

  PDF_STATE.path = p.pdf_path;
  PDF_STATE.sttPage = p.page_num || 2;
  PDF_STATE.page = p.page_num || 2;
  PDF_STATE.totalPages = p.pdf_page_count || 2;
  PDF_STATE.extraRot = 0;

  if (IS_PDF_OPEN) {
    if (PDF_DEBOUNCE_TIMER) clearTimeout(PDF_DEBOUNCE_TIMER);
    PDF_DEBOUNCE_TIMER = setTimeout(() => {
      loadPdfIntoViewer(p.pdf_path, p.page_num || 2, p.page_num || 2, p.pdf_page_count || 2);
    }, 35);
  }
}

function togglePdfDrawer(open) {
  IS_PDF_OPEN = open;
  const drawer = document.getElementById("pdf-viewer-panel");
  const btn = document.getElementById("btn-toggle-pdf");
  drawer.classList.toggle("hidden", !IS_PDF_OPEN);
  if (btn) {
    btn.classList.toggle("active", IS_PDF_OPEN);
    btn.innerHTML = `📄 ${IS_PDF_OPEN ? "Đóng PDF" : "Xem PDF Gốc"}`;
  }
  if (IS_PDF_OPEN && SELECTED_PRODUCT) {
    loadPdfIntoViewer(
      SELECTED_PRODUCT.pdf_path,
      SELECTED_PRODUCT.page_num || 2,
      SELECTED_PRODUCT.page_num || 2,
      SELECTED_PRODUCT.pdf_page_count || 2
    );
  }
}

function setPdfZoom(newZoom) {
  PDF_STATE.zoom = Math.min(350, Math.max(50, Math.round(newZoom)));
  const img = document.getElementById("pdf-page-img");
  const btnReset = document.getElementById("btn-zoom-reset");
  if (img) {
    img.style.width = `${PDF_STATE.zoom}%`;
  }
  if (btnReset) {
    btnReset.textContent = `${PDF_STATE.zoom}%`;
  }
}

function loadPdfIntoViewer(pdfPath, initialPage = 1, sttPage = 2, knownTotalPages = 2) {
  const banner = document.getElementById("pdf-file-banner");
  const img = document.getElementById("pdf-page-img");
  if (!pdfPath) {
    banner.textContent = "Không có tệp PDF";
    img.classList.add("hidden");
    return;
  }

  PDF_STATE.path = pdfPath;
  PDF_STATE.totalPages = Math.max(1, knownTotalPages || 2);
  PDF_STATE.page = Math.min(PDF_STATE.totalPages, Math.max(1, initialPage));
  PDF_STATE.sttPage = Math.min(PDF_STATE.totalPages, Math.max(1, sttPage || 2));
  PDF_STATE.extraRot = 0;
  banner.textContent = `📄 ${pdfPath}`;

  renderCurrentPdfPage();

  if (PDF_STATE.page !== 1) {
    const preImg = new Image();
    preImg.src = `/api/pdf-page?path=${encodeURIComponent(pdfPath)}&page=1&rot=0&dpi=165`;
  }
}

function renderCurrentPdfPage() {
  if (!PDF_STATE.path) return;
  const img = document.getElementById("pdf-page-img");
  const loading = document.getElementById("pdf-loading");
  const indicator = document.getElementById("pdf-page-indicator");

  indicator.textContent = `${PDF_STATE.page} / ${PDF_STATE.totalPages}`;
  document.getElementById("btn-page-qd").classList.toggle("active", PDF_STATE.page === 1);
  document.getElementById("btn-page-stt").classList.toggle("active", PDF_STATE.page !== 1);

  img.style.width = `${PDF_STATE.zoom}%`;

  if (img.classList.contains("hidden")) {
    loading.classList.remove("hidden");
  } else {
    img.style.opacity = "0.55";
  }

  const url = `/api/pdf-page?path=${encodeURIComponent(PDF_STATE.path)}&page=${PDF_STATE.page}&rot=${PDF_STATE.extraRot}&dpi=165`;
  img.onload = () => {
    loading.classList.add("hidden");
    img.classList.remove("hidden");
    img.style.opacity = "1";
  };
  img.src = url;
}

async function openFileOnDisk(pdfPath, mode = "select") {
  if (!pdfPath) return;
  const res = await fetch("/api/open-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: pdfPath, mode })
  });
  if (res.ok) {
    showToast(mode === "open" ? "📂 Đã mở tệp PDF trên máy" : "📂 Đã mở thư mục chứa tệp PDF");
  } else {
    togglePdfDrawer(true);
    showToast("📄 Đã mở trang văn bản trong trình xem PDF tích hợp");
  }
}

// ==================== MÀN HÌNH 2: ĐƠN VỊ & ĐỊA CHỈ SÁP NHẬP ====================
function renderCompaniesTab() {
  if (TABS_RENDERED.companies) return;
  TABS_RENDERED.companies = true;

  const grid = document.getElementById("companies-grid");
  grid.innerHTML = APP_DATA.companies.map((c) => `
    <div class="sheet-card" style="display:flex;flex-direction:column;gap:8px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--brand);">${escapeHtml(c.don_vi_dang_ky)}</div>
          <div style="font-size:12px;color:var(--text-sec);">
            MST: <b style="font-family:var(--font-mono);">${escapeHtml(c.ma_so_doanh_nghiep || "N/A")}</b> • ĐT: <b>${escapeHtml(c.dien_thoai || "N/A")}</b>
          </div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn-action secondary" data-edit-company="${escapeHtml(c.don_vi_dang_ky)}" style="height:28px;font-size:12px;">
            ✏️ Sửa ĐC
          </button>
          <button class="btn-action secondary" data-filter-company="${escapeHtml(c.don_vi_dang_ky)}" style="height:28px;font-size:12px;">
            Xem ${c.product_count} mã SP →
          </button>
        </div>
      </div>

      <div class="cbox orig" data-copy="${escapeHtml(c.dia_chi_goc)}" data-label="Địa chỉ gốc trong QĐ">
        <div class="cbox-lbl">📍 Địa chỉ ghi trong Quyết định (Bản gốc)</div>
        <div class="cbox-val">${escapeHtml(c.dia_chi_goc)}</div>
      </div>

      <div class="cbox merged" data-copy="${escapeHtml(c.dia_chi_sap_nhap)}" data-label="Địa chỉ sau sáp nhập">
        <div class="cbox-lbl">🗺️ Địa chỉ sau Sáp nhập Hành chính</div>
        <div class="cbox-val">${escapeHtml(c.dia_chi_sap_nhap)}</div>
        ${c.ghi_chu_sap_nhap ? `<div class="cbox-note">💡 ${escapeHtml(c.ghi_chu_sap_nhap)}</div>` : ""}
      </div>
    </div>
  `).join("");
}

// ==================== MÀN HÌNH 3: VĂN BẢN QUYẾT ĐỊNH ====================
function renderDecisionsTab() {
  if (TABS_RENDERED.decisions) return;
  TABS_RENDERED.decisions = true;

  const list = document.getElementById("decisions-list");
  list.innerHTML = APP_DATA.decisions.map((d) => {
    const groupKey = d.doc_id || `qd_${d.qd_key}`;
    const prods = SIBLINGS_MAP.get(groupKey) || [];
    const st = getValidityStatus(d.ngay_het_han);
    return `
      <div class="sheet-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div style="font-size:14.5px;font-weight:700;color:var(--brand);">
            📜 Quyết định số ${escapeHtml(d.so_qd)} (Ngày ${escapeHtml(d.ngay_ban_hanh)}) — ${escapeHtml(d.don_vi_dang_ky)}
          </div>
          <span class="badge ${st.code}">${escapeHtml(st.label)}</span>
        </div>

        <div class="address-strip">
          <div class="cbox orig" data-copy="${escapeHtml(d.dia_chi_goc)}" data-label="Địa chỉ QĐ">
            <div class="cbox-lbl">📍 Địa chỉ trong Quyết định</div>
            <div class="cbox-val">${escapeHtml(d.dia_chi_goc)}</div>
          </div>
          <div class="cbox merged" data-copy="${escapeHtml(d.dia_chi_sap_nhap)}" data-label="Địa chỉ sáp nhập">
            <div class="cbox-lbl">🗺️ Địa chỉ sau Sáp nhập</div>
            <div class="cbox-val">${escapeHtml(d.dia_chi_sap_nhap)}</div>
          </div>
        </div>

        <div class="siblings-bar">
          ${prods.map((p) => `
            <button class="sib-chip" data-jump-prod="${p.id}">
              STT ${escapeHtml(p.stt)}: <b>${escapeHtml(p.mslh)}</b> — ${escapeHtml(p.ten_phan_bon)}
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }).join("");
}

// ==================== MÀN HÌNH 4: KHO TỆP PDF ====================
function renderFilesTab() {
  if (TABS_RENDERED.files) return;
  TABS_RENDERED.files = true;

  const wrapper = document.getElementById("files-table-wrapper");
  wrapper.innerHTML = `
    <table class="qd-table">
      <thead>
        <tr>
          <th style="width:45px;">#</th>
          <th style="width:70px;">Loại</th>
          <th style="width:90px;">MSLH</th>
          <th style="width:85px;">Số QĐ</th>
          <th>Tên tệp PDF</th>
          <th style="width:80px;">Số trang</th>
          <th style="width:170px;">Thao tác</th>
        </tr>
      </thead>
      <tbody>
        ${APP_DATA.pdf_files.map((f, idx) => `
          <tr>
            <td class="td-c">${idx + 1}</td>
            <td class="td-c"><b>${escapeHtml(f.doc_type)}</b></td>
            <td class="td-code">${escapeHtml(f.mslh || "-")}</td>
            <td class="td-c">${f.qd_key ? `QĐ ${escapeHtml(f.qd_key)}` : "-"}</td>
            <td>${escapeHtml(f.file_name)}</td>
            <td class="td-c">${f.page_count} trang</td>
            <td class="td-c">
              <button class="sib-chip" data-open-disk="${escapeHtml(f.full_path)}" data-mode="open">Mở PDF</button>
              <button class="sib-chip" data-open-disk="${escapeHtml(f.full_path)}" data-mode="select">Thư mục</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// ==================== MODAL CHỈNH SỬA HỒ SƠ ĐÃ CÓ ====================
function openEditModal(p) {
  const modal = document.getElementById("edit-modal");
  const body = document.getElementById("modal-body");
  modal.classList.remove("hidden");

  body.innerHTML = `
    <div class="form-group">
      <label>Mã số phân bón (MSLH)</label>
      <input type="text" id="edit-mslh" value="${escapeHtml(p.mslh)}" />
    </div>
    <div class="form-group">
      <label>STT trong Quyết định &amp; Trang PDF</label>
      <div style="display:flex;gap:8px;">
        <input type="number" id="edit-stt" value="${escapeHtml(p.stt)}" style="width:50%;" />
        <input type="number" id="edit-page" value="${escapeHtml(p.page_num || 2)}" style="width:50%;" />
      </div>
    </div>
    <div class="form-group">
      <label>Tên phân bón</label>
      <input type="text" id="edit-ten" value="${escapeHtml(p.ten_phan_bon)}" />
    </div>
    <div class="form-group">
      <label>Loại phân bón</label>
      <input type="text" id="edit-loai" value="${escapeHtml(p.loai_phan_bon)}" />
    </div>
    <div class="form-group">
      <label>Phương thức sử dụng</label>
      <input type="text" id="edit-phuong-thuc" value="${escapeHtml(p.phuong_thuc_su_dung)}" />
    </div>
    <div class="form-group">
      <label>Hạn sử dụng</label>
      <input type="text" id="edit-hsd" value="${escapeHtml(p.han_su_dung)}" />
    </div>
    <div class="form-group full">
      <label>Chỉ tiêu chất lượng</label>
      <textarea id="edit-chi-tieu" rows="3">${escapeHtml(p.chi_tieu_chat_luong)}</textarea>
    </div>
    <div class="form-group full">
      <label>Hướng dẫn sử dụng</label>
      <textarea id="edit-hdsd" rows="4">${escapeHtml(p.huong_dan_su_dung)}</textarea>
    </div>
    <div class="form-group">
      <label>Tên Đơn vị đăng ký</label>
      <input type="text" id="edit-don-vi" value="${escapeHtml(p.don_vi_dang_ky)}" />
    </div>
    <div class="form-group">
      <label>MSDN &amp; Điện thoại</label>
      <div style="display:flex;gap:8px;">
        <input type="text" id="edit-msdn" value="${escapeHtml(p.ma_so_doanh_nghiep)}" style="width:50%;" />
        <input type="text" id="edit-sdt" value="${escapeHtml(p.dien_thoai)}" style="width:50%;" />
      </div>
    </div>
    <div class="form-group full">
      <label>📍 Địa chỉ gốc (ghi trong Quyết định)</label>
      <input type="text" id="edit-dc-goc" value="${escapeHtml(p.dia_chi_goc)}" />
    </div>
    <div class="form-group full">
      <label>🗺️ Địa chỉ sau Sáp nhập đơn vị hành chính</label>
      <input type="text" id="edit-dc-sap-nhap" value="${escapeHtml(p.dia_chi_sap_nhap)}" />
    </div>
    <div class="form-group full">
      <label>💡 Ghi chú chi tiết sáp nhập</label>
      <input type="text" id="edit-ghi-chu-sn" value="${escapeHtml(p.ghi_chu_sap_nhap)}" />
    </div>
  `;

  document.getElementById("btn-delete-modal").onclick = async () => {
    if (!confirm(`Bạn có chắc muốn xóa mã phân bón ${p.mslh} (${p.ten_phan_bon}) khỏi máy?`)) return;
    await fetch("/api/delete-product", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: p.id })
    });
    modal.classList.add("hidden");
    showToast(`🗑️ Đã xóa mã ${p.mslh}`);
    SELECTED_PRODUCT = null;
    await loadAllData();
  };

  document.getElementById("btn-save-modal").onclick = async () => {
    await fetch("/api/update-product", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: p.id,
        mslh: document.getElementById("edit-mslh").value.trim(),
        stt: document.getElementById("edit-stt").value,
        page_num: document.getElementById("edit-page").value,
        ten_phan_bon: document.getElementById("edit-ten").value.trim(),
        loai_phan_bon: document.getElementById("edit-loai").value.trim(),
        phuong_thuc_su_dung: document.getElementById("edit-phuong-thuc").value.trim(),
        han_su_dung: document.getElementById("edit-hsd").value.trim(),
        chi_tieu_chat_luong: document.getElementById("edit-chi-tieu").value.trim(),
        huong_dan_su_dung: document.getElementById("edit-hdsd").value.trim()
      })
    });

    if (p.doc_id) {
      await fetch("/api/update-decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doc_id: p.doc_id,
          so_qd: p.so_qd_full,
          ngay_ban_hanh: p.ngay_ban_hanh,
          ngay_hieu_luc: p.ngay_hieu_luc,
          ngay_het_han: p.ngay_het_han,
          loai_qd: p.loai_qd,
          nguoi_ky: p.nguoi_ky,
          don_vi_dang_ky: document.getElementById("edit-don-vi").value.trim(),
          ma_so_doanh_nghiep: document.getElementById("edit-msdn").value.trim(),
          dien_thoai: document.getElementById("edit-sdt").value.trim(),
          dia_chi_goc: document.getElementById("edit-dc-goc").value.trim(),
          dia_chi_sap_nhap: document.getElementById("edit-dc-sap-nhap").value.trim(),
          ghi_chu_sap_nhap: document.getElementById("edit-ghi-chu-sn").value.trim()
        })
      });
    }

    modal.classList.add("hidden");
    showToast("💾 Đã lưu thay đổi vào máy");
    const currentId = p.id;
    await loadAllData();
    const updated = PRODUCTS_BY_ID.get(currentId);
    if (updated) selectProduct(updated);
  };
}

// ==================== MODAL THÊM TỆP PDF / MÃ MỚI ====================
function openAddModal() {
  ADD_UPLOADED_PDF_PATH = "";
  ADD_UPLOADED_MD5 = "";
  document.getElementById("add-pdf-file-input").value = "";
  document.getElementById("add-pdf-status").innerHTML = "Tệp PDF sẽ được tự động sao chép vào bộ nhớ phần mềm và xoay thẳng trang phụ lục.";
  document.getElementById("add-doc-type").value = "LH";
  document.getElementById("add-mslh").value = "";
  document.getElementById("add-ten").value = "";
  document.getElementById("add-loai").value = "Phân bón hữu cơ";
  document.getElementById("add-stt").value = "1";
  document.getElementById("add-page").value = "2";
  document.getElementById("add-phuong-thuc").value = "Bón rễ";
  document.getElementById("add-hsd").value = "36 tháng kể từ ngày sản xuất";
  document.getElementById("add-chi-tieu").value = "";
  document.getElementById("add-hdsd").value = "";
  document.getElementById("add-so-qd").value = "";
  document.getElementById("add-ngay-bh").value = "";
  document.getElementById("add-ngay-hh").value = "";
  document.getElementById("add-don-vi").value = "";
  document.getElementById("add-msdn").value = "";
  document.getElementById("add-sdt").value = "";
  document.getElementById("add-dc-goc").value = "";
  document.getElementById("add-dc-sap-nhap").value = "";
  document.getElementById("add-ghi-chu-sn").value = "";

  document.getElementById("add-modal").classList.remove("hidden");
}

function fillDecisionFieldsIfMatched(dec) {
  if (!dec) return;
  if (dec.so_qd) document.getElementById("add-so-qd").value = dec.so_qd;
  if (dec.ngay_ban_hanh) document.getElementById("add-ngay-bh").value = dec.ngay_ban_hanh;
  if (dec.ngay_het_han) document.getElementById("add-ngay-hh").value = dec.ngay_het_han;
  if (dec.don_vi_dang_ky) document.getElementById("add-don-vi").value = dec.don_vi_dang_ky;
  if (dec.ma_so_doanh_nghiep) document.getElementById("add-msdn").value = dec.ma_so_doanh_nghiep;
  if (dec.dien_thoai) document.getElementById("add-sdt").value = dec.dien_thoai;
  if (dec.dia_chi_goc) document.getElementById("add-dc-goc").value = dec.dia_chi_goc;
  if (dec.dia_chi_sap_nhap) document.getElementById("add-dc-sap-nhap").value = dec.dia_chi_sap_nhap;
  if (dec.ghi_chu_sap_nhap) document.getElementById("add-ghi-chu-sn").value = dec.ghi_chu_sap_nhap;
}

function switchTab(tabName) {
  if (tabName === "companies") renderCompaniesTab();
  else if (tabName === "decisions") renderDecisionsTab();
  else if (tabName === "files") renderFilesTab();

  document.querySelectorAll(".tab-pill").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tabName);
  });
  document.querySelectorAll(".app-body").forEach((sec) => {
    sec.classList.toggle("active", sec.id === `tab-${tabName}`);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadAllData();
  setTimeout(() => checkRemoteUpdate(true), 1200);

  // 1. Ủy quyền sự kiện cho Menu Gợi ý tìm kiếm (#search-dropdown)
  document.getElementById("search-dropdown").addEventListener("click", (e) => {
    const item = e.target.closest(".sdrop-item");
    if (!item) return;
    const id = parseInt(item.getAttribute("data-id"), 10);
    const prod = PRODUCTS_BY_ID.get(id);
    if (prod) {
      selectProduct(prod);
      hideSearchDropdown();
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#search-box-wrap")) {
      hideSearchDropdown();
    }
  });

  // 2. Ủy quyền sự kiện cho Khung Chi tiết (#product-detail-content)
  document.getElementById("product-detail-content").addEventListener("click", (e) => {
    const copyEl = e.target.closest("[data-copy]");
    if (copyEl) {
      e.stopPropagation();
      copyText(copyEl.getAttribute("data-copy"), copyEl.getAttribute("data-label"));
      return;
    }

    const sibBtn = e.target.closest("[data-sibling-id]");
    if (sibBtn) {
      const sid = parseInt(sibBtn.getAttribute("data-sibling-id"), 10);
      const target = PRODUCTS_BY_ID.get(sid);
      if (target) selectProduct(target);
      return;
    }

    const actBtn = e.target.closest("[data-action]");
    if (actBtn && SELECTED_PRODUCT) {
      const act = actBtn.getAttribute("data-action");
      if (act === "copy-all") copyText(CURRENT_FULL_PROFILE_TEXT, `trọn bộ hồ sơ mã ${SELECTED_PRODUCT.mslh}`);
      else if (act === "copy-label") copyText(CURRENT_LABEL_TEXT, `mẫu nhãn phụ mã ${SELECTED_PRODUCT.mslh}`);
      else if (act === "toggle-pdf") togglePdfDrawer(!IS_PDF_OPEN);
      else if (act === "reveal-disk") openFileOnDisk(SELECTED_PRODUCT.pdf_path, "select");
      else if (act === "edit-record") openEditModal(SELECTED_PRODUCT);
      else if (act === "toggle-siblings") {
        SHOW_ALL_SIBLINGS_IN_TABLE = !SHOW_ALL_SIBLINGS_IN_TABLE;
        renderProductDetail(SELECTED_PRODUCT);
      }
    }
  });

  // 3. Ủy quyền sự kiện cho các Tab phụ (Companies, Decisions, Files)
  document.getElementById("companies-grid").addEventListener("click", (e) => {
    const copyEl = e.target.closest("[data-copy]");
    if (copyEl) {
      copyText(copyEl.getAttribute("data-copy"), copyEl.getAttribute("data-label"));
      return;
    }
    const editBtn = e.target.closest("[data-edit-company]");
    if (editBtn) {
      const compName = editBtn.getAttribute("data-edit-company");
      const sampleProd = APP_DATA.products.find((x) => x.don_vi_dang_ky === compName);
      if (sampleProd) openEditModal(sampleProd);
      return;
    }
    const filterBtn = e.target.closest("[data-filter-company]");
    if (filterBtn) {
      document.getElementById("filter-company").value = filterBtn.getAttribute("data-filter-company");
      document.getElementById("main-search").value = "";
      switchTab("lookup");
      applyFiltersAndRender(true);
    }
  });

  document.getElementById("decisions-list").addEventListener("click", (e) => {
    const copyEl = e.target.closest("[data-copy]");
    if (copyEl) {
      copyText(copyEl.getAttribute("data-copy"), copyEl.getAttribute("data-label"));
      return;
    }
    const jumpBtn = e.target.closest("[data-jump-prod]");
    if (jumpBtn) {
      const id = parseInt(jumpBtn.getAttribute("data-jump-prod"), 10);
      const prod = PRODUCTS_BY_ID.get(id);
      if (prod) {
        switchTab("lookup");
        selectProduct(prod);
      }
    }
  });

  document.getElementById("files-table-wrapper").addEventListener("click", (e) => {
    const diskBtn = e.target.closest("[data-open-disk]");
    if (diskBtn) {
      openFileOnDisk(diskBtn.getAttribute("data-open-disk"), diskBtn.getAttribute("data-mode"));
    }
  });

  // ==================== TÍNH NĂNG THÊM TỆP PDF / MÃ MỚI ====================
  document.getElementById("btn-add-new").addEventListener("click", openAddModal);
  const btnAddDec = document.getElementById("btn-add-from-decisions");
  if (btnAddDec) btnAddDec.addEventListener("click", openAddModal);

  document.getElementById("btn-close-add-modal").addEventListener("click", () => {
    document.getElementById("add-modal").classList.add("hidden");
  });
  document.getElementById("btn-cancel-add-modal").addEventListener("click", () => {
    document.getElementById("add-modal").classList.add("hidden");
  });

  document.getElementById("btn-pick-pdf").addEventListener("click", () => {
    document.getElementById("add-pdf-file-input").click();
  });

  document.getElementById("add-pdf-file-input").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById("add-pdf-status");
    statusEl.innerHTML = `⏳ Đang nạp và xoay thẳng tệp <b>${escapeHtml(file.name)}</b>...`;
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch(`/api/upload-pdf?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: buf
      });
      const data = await res.json();
      if (!data.ok) {
        statusEl.innerHTML = `<span style="color:#dc2626;">❌ Lỗi: ${escapeHtml(data.error || "Không nạp được PDF")}</span>`;
        return;
      }
      ADD_UPLOADED_PDF_PATH = data.saved_path;
      ADD_UPLOADED_MD5 = data.md5_hash || "";
      statusEl.innerHTML = `<span style="color:#047857;font-weight:700;">✅ Đã lưu vào máy: ${escapeHtml(data.file_name)} (${data.page_count} trang)</span>`;

      const meta = data.parsed_meta || {};
      if (meta.doc_type) document.getElementById("add-doc-type").value = meta.doc_type;
      if (meta.mslh && !document.getElementById("add-mslh").value) document.getElementById("add-mslh").value = meta.mslh;
      if (meta.stt) document.getElementById("add-stt").value = meta.stt;
      if (meta.suggested_name && !document.getElementById("add-ten").value) {
        document.getElementById("add-ten").value = meta.suggested_name;
      }
      if (data.matched_decision) {
        fillDecisionFieldsIfMatched(data.matched_decision);
      } else if (meta.qd_key && !document.getElementById("add-so-qd").value) {
        document.getElementById("add-so-qd").value = `${meta.qd_key}/QĐ-BVTV-PB`;
      }
      showToast(`📄 Đã nạp tệp PDF (${data.page_count} trang) vào máy`);
    } catch (err) {
      statusEl.innerHTML = `<span style="color:#dc2626;">❌ Không thể nạp tệp PDF: ${escapeHtml(err.message)}</span>`;
    }
  });

  // Tự động điền thông tin công ty/địa chỉ khi người dùng gõ Số QĐ đã có trong hệ thống
  document.getElementById("add-so-qd").addEventListener("input", (e) => {
    const val = e.target.value.trim();
    const m = val.match(/(\d+)/);
    if (!m) return;
    const key = m[1];
    const matched = APP_DATA.decisions.find((d) => d.qd_key === key || d.so_qd === val);
    if (matched && !document.getElementById("add-don-vi").value) {
      fillDecisionFieldsIfMatched(matched);
    }
  });

  document.getElementById("btn-save-add-modal").addEventListener("click", async () => {
    const mslh = document.getElementById("add-mslh").value.trim();
    const ten = document.getElementById("add-ten").value.trim();
    const docType = document.getElementById("add-doc-type").value;

    if (!mslh && !ADD_UPLOADED_PDF_PATH) {
      showToast("⚠️ Vui lòng nhập Mã số phân bón (MSLH) hoặc chọn tệp PDF!");
      document.getElementById("add-mslh").focus();
      return;
    }

    const res = await fetch("/api/add-record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        doc_type: docType,
        mslh: mslh,
        ten_phan_bon: ten,
        loai_phan_bon: document.getElementById("add-loai").value.trim(),
        stt: document.getElementById("add-stt").value,
        page_num: document.getElementById("add-page").value,
        phuong_thuc_su_dung: document.getElementById("add-phuong-thuc").value.trim(),
        han_su_dung: document.getElementById("add-hsd").value.trim(),
        chi_tieu_chat_luong: document.getElementById("add-chi-tieu").value.trim(),
        huong_dan_su_dung: document.getElementById("add-hdsd").value.trim(),
        so_qd: document.getElementById("add-so-qd").value.trim(),
        ngay_ban_hanh: document.getElementById("add-ngay-bh").value.trim(),
        ngay_het_han: document.getElementById("add-ngay-hh").value.trim(),
        don_vi_dang_ky: document.getElementById("add-don-vi").value.trim(),
        ma_so_doanh_nghiep: document.getElementById("add-msdn").value.trim(),
        dien_thoai: document.getElementById("add-sdt").value.trim(),
        dia_chi_goc: document.getElementById("add-dc-goc").value.trim(),
        dia_chi_sap_nhap: document.getElementById("add-dc-sap-nhap").value.trim(),
        ghi_chu_sap_nhap: document.getElementById("add-ghi-chu-sn").value.trim(),
        pdf_path: ADD_UPLOADED_PDF_PATH,
        md5_hash: ADD_UPLOADED_MD5
      })
    });

    const data = await res.json();
    if (!data.ok) {
      showToast(`❌ Lỗi: ${data.error || "Không thể lưu hồ sơ"}`);
      return;
    }

    document.getElementById("add-modal").classList.add("hidden");
    showToast(`✅ Đã thêm mã ${data.mslh || ""} vào máy thành công!`);
    await loadAllData();
    switchTab("lookup");
    if (data.product_id && PRODUCTS_BY_ID.has(data.product_id)) {
      selectProduct(PRODUCTS_BY_ID.get(data.product_id));
      if (ADD_UPLOADED_PDF_PATH) togglePdfDrawer(true);
    }
  });

  // Nạp hàng loạt tệp PDF từ tab Tệp
  const btnMultiPdf = document.getElementById("btn-upload-multi-pdf");
  const multiInput = document.getElementById("multi-pdf-input");
  if (btnMultiPdf && multiInput) {
    btnMultiPdf.addEventListener("click", () => multiInput.click());
    multiInput.addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;
      showToast(`⏳ Đang nạp ${files.length} tệp PDF vào máy...`);
      let okCount = 0;
      for (const f of files) {
        try {
          const buf = await f.arrayBuffer();
          const res = await fetch(`/api/upload-pdf?name=${encodeURIComponent(f.name)}`, {
            method: "POST",
            headers: { "Content-Type": "application/pdf" },
            body: buf
          });
          const d = await res.json();
          if (d.ok) okCount++;
        } catch (err) {}
      }
      multiInput.value = "";
      await loadAllData();
      TABS_RENDERED.files = false;
      renderFilesTab();
      showToast(`✅ Đã nạp thêm ${okCount}/${files.length} tệp PDF vào máy!`);
    });
  }

  // ==================== NÚT CẬP NHẬT TÍNH NĂNG (KHÔNG MẤT DỮ LIỆU ĐÃ SỬA) ====================
  document.getElementById("btn-pull-update").addEventListener("click", async () => {
    showToast("🔄 Đang kiểm tra & tải bản cập nhật tính năng từ GitHub...");
    try {
      const res = await fetch("/api/pull-update", { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        showToast(`⚠️ ${data.error || "Chưa có bản cập nhật mới trên GitHub"}`, 3200);
        return;
      }
      const ver = (data.version_info && data.version_info.version) ? data.version_info.version : "mới";
      showToast(`✅ Đã cập nhật tính năng lên v${ver}! Toàn bộ tệp và dữ liệu của bạn được giữ nguyên 100%.`, 3000);
      setTimeout(() => window.location.reload(), 1000);
    } catch (err) {
      showToast("⚠️ Không thể kết nối tới GitHub để cập nhật.");
    }
  });

  // Nút Phát hành bản cập nhật tính năng lên GitHub (Dành cho máy của bạn)
  const btnPublish = document.getElementById("btn-publish-update");
  if (btnPublish) {
    btnPublish.addEventListener("click", async () => {
      const note = prompt("Nhập ghi chú cho bản cập nhật tính năng này (để trống sẽ tự đặt tên):", "Cập nhật tính năng mới QĐLH Vault");
      if (note === null) return;
      showToast("☁️ Đang đẩy bản cập nhật tính năng lên GitHub (lkey124/QDLH)...", 4000);
      try {
        const res = await fetch("/api/publish-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note })
        });
        const data = await res.json();
        if (!data.ok) {
          showToast(`❌ ${data.error || "Lỗi khi đẩy lên GitHub"}`, 4000);
          return;
        }
        const ver = data.version_info.version;
        document.getElementById("app-version-badge").textContent = `v${ver}`;
        showToast(`🎉 Đã phát hành v${ver} lên GitHub! Các máy khác bấm "🔄 Cập nhật" sẽ nhận được ngay.`, 4000);
      } catch (err) {
        showToast("❌ Lỗi kết nối khi phát hành lên GitHub.");
      }
    });
  }

  // Tìm kiếm mượt 120fps
  document.getElementById("main-search").addEventListener("input", () => {
    if (SEARCH_RAF_ID) cancelAnimationFrame(SEARCH_RAF_ID);
    SEARCH_RAF_ID = requestAnimationFrame(() => {
      switchTab("lookup");
      applyFiltersAndRender(true);
    });
  });

  document.getElementById("main-search").addEventListener("focus", () => {
    const qRaw = document.getElementById("main-search").value.trim();
    if (qRaw && FILTERED_PRODUCTS.length > 1) {
      renderSearchDropdown();
    }
  });

  document.getElementById("clear-search").addEventListener("click", () => {
    const inp = document.getElementById("main-search");
    inp.value = "";
    inp.focus();
    applyFiltersAndRender(false);
  });

  document.getElementById("filter-scope").addEventListener("change", () => applyFiltersAndRender(false));
  document.getElementById("filter-company").addEventListener("change", () => {
    switchTab("lookup");
    applyFiltersAndRender(true);
  });

  document.querySelectorAll(".tab-pill").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.getAttribute("data-tab")));
  });

  // Phím tắt mũi tên Lên / Xuống để duyệt nhanh danh sách Mã số phân bón
  document.addEventListener("keydown", (e) => {
    if (!document.getElementById("edit-modal").classList.contains("hidden")) return;
    if (!document.getElementById("add-modal").classList.contains("hidden")) return;
    if (e.key === "Escape") {
      hideSearchDropdown();
      return;
    }
    if (e.key === "Enter" && document.activeElement.id === "main-search") {
      hideSearchDropdown();
      return;
    }
    if ((e.ctrlKey && e.key.toLowerCase() === "f") || (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA")) {
      e.preventDefault();
      const inp = document.getElementById("main-search");
      inp.focus();
      inp.select();
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && document.activeElement.tagName !== "TEXTAREA") {
      if (FILTERED_PRODUCTS.length === 0) return;
      e.preventDefault();
      const idx = FILTERED_PRODUCTS.findIndex((x) => SELECTED_PRODUCT && x.id === SELECTED_PRODUCT.id);
      let nextIdx = 0;
      if (e.key === "ArrowDown") {
        nextIdx = idx < FILTERED_PRODUCTS.length - 1 ? idx + 1 : 0;
      } else {
        nextIdx = idx > 0 ? idx - 1 : FILTERED_PRODUCTS.length - 1;
      }
      selectProduct(FILTERED_PRODUCTS[nextIdx]);
      const dropEl = document.getElementById("search-dropdown");
      if (dropEl && !dropEl.classList.contains("hidden")) {
        renderSearchDropdown();
      }
    }
  });

  // ==================== ĐIỀU KHIỂN TRANG & ZOOM PDF ====================
  document.getElementById("btn-page-qd").addEventListener("click", () => {
    PDF_STATE.page = 1;
    renderCurrentPdfPage();
  });
  document.getElementById("btn-page-stt").addEventListener("click", () => {
    PDF_STATE.page = PDF_STATE.sttPage || 2;
    renderCurrentPdfPage();
  });
  document.getElementById("btn-prev-page").addEventListener("click", () => {
    if (PDF_STATE.page > 1) {
      PDF_STATE.page--;
      renderCurrentPdfPage();
    }
  });
  document.getElementById("btn-next-page").addEventListener("click", () => {
    if (PDF_STATE.page < PDF_STATE.totalPages) {
      PDF_STATE.page++;
      renderCurrentPdfPage();
    }
  });

  document.getElementById("btn-zoom-out").addEventListener("click", () => {
    setPdfZoom(PDF_STATE.zoom - 25);
  });
  document.getElementById("btn-zoom-reset").addEventListener("click", () => {
    setPdfZoom(100);
  });
  document.getElementById("btn-zoom-in").addEventListener("click", () => {
    setPdfZoom(PDF_STATE.zoom + 25);
  });

  const pdfViewport = document.getElementById("pdf-canvas-container");
  pdfViewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 20 : -20;
    const oldZoom = PDF_STATE.zoom;
    const nextZoom = Math.min(350, Math.max(50, oldZoom + delta));
    if (nextZoom === oldZoom) return;

    const rect = pdfViewport.getBoundingClientRect();
    const offsetX = e.clientX - rect.left + pdfViewport.scrollLeft;
    const offsetY = e.clientY - rect.top + pdfViewport.scrollTop;
    const ratio = nextZoom / oldZoom;

    setPdfZoom(nextZoom);

    pdfViewport.scrollLeft = offsetX * ratio - (e.clientX - rect.left);
    pdfViewport.scrollTop = offsetY * ratio - (e.clientY - rect.top);
  }, { passive: false });

  pdfViewport.addEventListener("dblclick", (e) => {
    const rect = pdfViewport.getBoundingClientRect();
    const oldZoom = PDF_STATE.zoom;
    const nextZoom = oldZoom < 160 ? 200 : 100;
    const offsetX = e.clientX - rect.left + pdfViewport.scrollLeft;
    const offsetY = e.clientY - rect.top + pdfViewport.scrollTop;
    const ratio = nextZoom / oldZoom;

    setPdfZoom(nextZoom);

    pdfViewport.scrollLeft = offsetX * ratio - (e.clientX - rect.left);
    pdfViewport.scrollTop = offsetY * ratio - (e.clientY - rect.top);
  });

  let isDraggingPdf = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let startScrollLeft = 0;
  let startScrollTop = 0;

  pdfViewport.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    isDraggingPdf = true;
    pdfViewport.classList.add("dragging");
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    startScrollLeft = pdfViewport.scrollLeft;
    startScrollTop = pdfViewport.scrollTop;
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDraggingPdf) return;
    pdfViewport.scrollLeft = startScrollLeft - (e.clientX - dragStartX);
    pdfViewport.scrollTop = startScrollTop - (e.clientY - dragStartY);
  });

  window.addEventListener("mouseup", () => {
    if (isDraggingPdf) {
      isDraggingPdf = false;
      pdfViewport.classList.remove("dragging");
    }
  });

  document.getElementById("btn-rot-left").addEventListener("click", () => {
    PDF_STATE.extraRot = (PDF_STATE.extraRot + 270) % 360;
    renderCurrentPdfPage();
  });
  document.getElementById("btn-rot-right").addEventListener("click", () => {
    PDF_STATE.extraRot = (PDF_STATE.extraRot + 90) % 360;
    renderCurrentPdfPage();
  });
  document.getElementById("btn-open-external-pdf").addEventListener("click", () => {
    if (PDF_STATE.path) openFileOnDisk(PDF_STATE.path, "open");
  });
  document.getElementById("btn-close-pdf").addEventListener("click", () => {
    togglePdfDrawer(false);
  });

  document.getElementById("btn-close-modal").addEventListener("click", () => {
    document.getElementById("edit-modal").classList.add("hidden");
  });
  document.getElementById("btn-cancel-modal").addEventListener("click", () => {
    document.getElementById("edit-modal").classList.add("hidden");
  });

  document.getElementById("btn-export-excel").addEventListener("click", async () => {
    const res = await fetch("/api/save-excel", { method: "POST" });
    const data = await res.json();
    if (data.saved_path) {
      showToast(`📊 Đã xuất file Excel tại: ${data.saved_path}`);
    } else if (data.fallback_url) {
      window.location.href = "/api/export-csv";
    }
  });

  const btnSync = document.getElementById("btn-sync");
  if (btnSync) {
    btnSync.addEventListener("click", async () => {
      showToast("🔄 Đang quét lại thư mục PDF...");
      const res = await fetch("/api/sync-folder", { method: "POST" });
      const data = await res.json();
      await loadAllData();
      TABS_RENDERED.files = false;
      renderFilesTab();
      showToast(`✅ Đã đồng bộ ${data.scanned_files} tệp PDF`);
    });
  }
});
