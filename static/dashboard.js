async function api(path, opts = {}) {
  const r = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const c = r.headers.get("content-type") || "";
  const d = c.includes("application/json") ? await r.json() : null;
  if (!r.ok) throw new Error((d && d.message) || `HTTP ${r.status}`);
  return d;
}

function qs(id) {
  return document.getElementById(id);
}

function monthRange() {
  const n = new Date();
  const y = n.getFullYear();
  const m = String(n.getMonth() + 1).padStart(2, "0");
  const d = String(n.getDate()).padStart(2, "0");
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${d}` };
}

function todayIso() {
  const n = new Date();
  const y = n.getFullYear();
  const m = String(n.getMonth() + 1).padStart(2, "0");
  const d = String(n.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function kpiValue(v) {
  return v == null ? 0 : v;
}

function renderOrderedKpis(el, obj, keys) {
  el.innerHTML = "";
  keys.forEach((k) => {
    const d = document.createElement("div");
    d.className = "kpi";
    d.innerHTML = `<div class="muted">${k}</div><div><b>${kpiValue(obj && obj[k])}</b></div>`;
    el.appendChild(d);
  });
}

function renderKV(el, obj) {
  el.innerHTML = "";
  Object.entries(obj || {}).forEach(([k, v]) => {
    const d = document.createElement("div");
    d.className = "kpi";
    d.innerHTML = `<div class="muted">${k}</div><div><b>${kpiValue(v)}</b></div>`;
    el.appendChild(d);
  });
}

function row(txt) {
  const li = document.createElement("li");
  li.className = "item";
  li.textContent = txt;
  return li;
}

function isoToLocalInput(v) {
  return v ? String(v).slice(0, 16) : "";
}

function formatDashboardDateTime(v) {
  if (!v) return "";
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return s;
  const yyyy = m[1];
  const mm = m[2];
  const dd = m[3];
  const hh = m[4];
  const min = m[5];
  const sec = m[6] || "00";
  return `${dd}-${mm}-${yyyy} / ${hh}:${min}:${sec}`;
}

function formatHoursToHHMM(v) {
  if (v == null || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  const totalMinutes = Math.max(0, Math.round(n * 60));
  const hh = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const mm = String(totalMinutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function options(items, valueKey, labelKey, selected) {
  return (items || [])
    .map((x) => `<option value="${x[valueKey]}" ${String(x[valueKey]) === String(selected) ? "selected" : ""}>${x[labelKey]}</option>`)
    .join("");
}

function fillSelect(el, items, valueKey, labelKey, includeBlankLabel) {
  if (!el) return;
  let html = includeBlankLabel ? `<option value="">${includeBlankLabel}</option>` : "";
  html += options(items, valueKey, labelKey);
  el.innerHTML = html;
}

async function doLogin(e) {
  e.preventDefault();
  const payload = { employee_code: qs("employee_code").value.trim(), pin: qs("pin").value.trim() };
  const out = await api("/auth/login", { method: "POST", body: JSON.stringify(payload) });
  location.href = out.redirect;
}

async function doSessionLogout() {
  await api("/auth/logout", { method: "POST" });
  location.href = "/login";
}

const adminState = { users: [], categories: [], shifts: [] };
const employeeState = { canUpdateBreak: false, isSavingBreak: false };

async function doEmployeeLogout() {
  const breakSelect = qs("logoutBreakTaken");
  if (employeeState.canUpdateBreak && breakSelect && breakSelect.value !== "") {
    try {
      await api("/api/employee/today-break", {
        method: "POST",
        body: JSON.stringify({ break_taken: Number(breakSelect.value) }),
      });
    } catch (e) {
      alert(`Could not save break status: ${e.message}`);
      return;
    }
  }
  await doSessionLogout();
}

function setBreakStatusMessage(message) {
  const statusText = qs("breakStatusMsg");
  if (statusText) statusText.textContent = message;
}

async function saveEmployeeBreakStatus() {
  const breakSelect = qs("logoutBreakTaken");
  const saveBtn = qs("saveBreakBtn");
  if (!breakSelect || !saveBtn) return;

  if (!employeeState.canUpdateBreak) {
    setBreakStatusMessage("No attendance row available for the active break date (4:00 AM cutoff).");
    return;
  }
  if (breakSelect.value === "") {
    alert("Please select Yes or No before saving break status.");
    breakSelect.focus();
    return;
  }
  if (employeeState.isSavingBreak) return;

  employeeState.isSavingBreak = true;
  saveBtn.disabled = true;
  try {
    await api("/api/employee/today-break", {
      method: "POST",
      body: JSON.stringify({ break_taken: Number(breakSelect.value) }),
    });
    setBreakStatusMessage("Break status saved successfully.");
    await Promise.all([fetchEmployeeSummary(), fetchEmployeeAttendance(), loadEmployeeBreakStatus()]);
  } catch (e) {
    setBreakStatusMessage(`Unable to save break status: ${e.message}`);
    alert(`Could not save break status: ${e.message}`);
  } finally {
    employeeState.isSavingBreak = false;
    saveBtn.disabled = !employeeState.canUpdateBreak;
  }
}

function mergedRangeQuery() {
  return `from=${qs("fromDate").value}&to=${qs("toDate").value}`;
}

function getMergedEmployeeCode() {
  return (qs("mergedEmployeeCode").value || "").trim();
}

function setMergedExportLink() {
  const code = getMergedEmployeeCode();
  const link = qs("mergedExportLink");
  if (!code) {
    link.removeAttribute("href");
    return;
  }
  link.href = `/api/admin/employee-summary.xlsx?employee_code=${encodeURIComponent(code)}&${mergedRangeQuery()}`;
}

function findUserByCode(code) {
  return adminState.users.find((u) => String(u.employee_code || "").toUpperCase() === String(code || "").trim().toUpperCase());
}

async function loadAdmin() {
  const r = monthRange();
  qs("fromDate").value = r.from;
  qs("toDate").value = r.to;

  qs("logoutBtn").onclick = doSessionLogout;
  qs("loadMergedBtn").onclick = loadMergedEmployeeView;
  qs("reloadTodayAttendance").onclick = loadTodayAttendance;

  qs("createUserForm").onsubmit = createUser;
  qs("createCategoryForm").onsubmit = createCategory;
  qs("createShiftForm").onsubmit = createShift;
  qs("assignShiftForm").onsubmit = assignShiftToEmployee;
  qs("adminEditAttendanceForm").onsubmit = submitAdminAttendanceEdit;
  qs("loadAttendanceEditBtn").onclick = loadCurrentAttendanceEdit;

  await Promise.all([fetchCategories(), fetchShifts()]);
  await Promise.all([fetchUsers(), loadTodayAttendance()]);
  setMergedExportLink();
}

async function loadMergedEmployeeView() {
  const code = getMergedEmployeeCode();
  if (!code) {
    alert("Enter employee code");
    return;
  }
  try {
    const d = await api(`/api/admin/employee-summary?employee_code=${encodeURIComponent(code)}&${mergedRangeQuery()}`);

    const summary = d.summary || {};
    renderOrderedKpis(qs("mergedSummary"), {
      absent_count: summary.absent_count,
      total_hours: summary.total_hours,
      overtime_hours: summary.overtime_hours,
      total_days_worked: summary.total_days_worked,
      late_count: summary.late_count,
    }, ["absent_count", "total_hours", "overtime_hours", "total_days_worked", "late_count"]);

    const tb = qs("mergedAttendanceTable").querySelector("tbody");
    tb.innerHTML = "";
    (d.attendance || []).forEach((i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${i.attendance_date || ""}</td><td>${formatDashboardDateTime(i.login_time)}</td><td>${formatDashboardDateTime(i.logout_time)}</td><td>${i.login_method || "-"}</td><td>${kpiValue(i.total_hours)}</td><td>${kpiValue(i.overtime)}</td><td>${formatHoursToHHMM(i.early_logout_hours)}</td><td>${kpiValue(i.late_mark)}</td><td>${Number(i.break_taken || 0) === 1 ? "Yes" : "No"}</td>`;
      tb.appendChild(tr);
    });
    setMergedExportLink();
  } catch (e) {
    qs("mergedSummary").innerHTML = "";
    qs("mergedAttendanceTable").querySelector("tbody").innerHTML = "";
    setMergedExportLink();
    alert(e.message);
  }
}

async function loadTodayAttendance() {
  const t = todayIso();
  const d = await api(`/api/admin/attendance?from=${t}&to=${t}&page=1&page_size=500`);
  const tb = qs("todaysAttendanceTable").querySelector("tbody");
  tb.innerHTML = "";
  (d.items || []).forEach((i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i.employee_code || ""}</td><td>${i.attendance_date || ""}</td><td>${formatDashboardDateTime(i.login_time)}</td><td>${formatDashboardDateTime(i.logout_time)}</td><td>${i.login_method || "-"}</td><td>${kpiValue(i.total_hours)}</td><td>${kpiValue(i.overtime)}</td><td>${formatHoursToHHMM(i.early_logout_hours)}</td><td>${kpiValue(i.late_mark)}</td><td>${Number(i.break_taken || 0) === 1 ? "Yes" : "No"}</td>`;
    tb.appendChild(tr);
  });
}

async function fetchUsers() {
  const d = await api("/api/admin/users");
  adminState.users = d.items || [];

  const tb = qs("usersTable").querySelector("tbody");
  tb.innerHTML = "";
  adminState.users.forEach((u) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${u.id}</td>
      <td><input data-k="name" value="${u.name || ""}" /></td>
      <td><input data-k="employee_code" value="${u.employee_code || ""}" /></td>
      <td>${u.pin_plain || ""}</td>
      <td>
        <select data-k="role">
          <option value="EMPLOYEE" ${u.role === "EMPLOYEE" ? "selected" : ""}>EMPLOYEE</option>
          <option value="ADMIN" ${u.role === "ADMIN" ? "selected" : ""}>ADMIN</option>
        </select>
      </td>
      <td><select data-k="category_id">${options(adminState.categories, "id", "name", u.category_id)}</select></td>
      <td><select data-k="shift_id">${options(adminState.shifts, "id", "name", u.shift_id)}</select></td>
      <td><input type="checkbox" data-k="active" ${Number(u.active) === 1 ? "checked" : ""} /></td>
      <td><input data-k="pin" placeholder="New PIN" /></td>
      <td>
        <div class="row">
          <button data-user-id="${u.id}" type="button">Save</button>
          <button data-delete-user-id="${u.id}" type="button">Delete</button>
        </div>
      </td>
    `;
    tb.appendChild(tr);
  });

  tb.querySelectorAll("button[data-user-id]").forEach((b) => {
    b.onclick = async () => {
      const tr = b.closest("tr");
      const userId = Number(b.dataset.userId);
      const payload = {
        name: tr.querySelector('[data-k="name"]').value,
        employee_code: tr.querySelector('[data-k="employee_code"]').value,
        role: tr.querySelector('[data-k="role"]').value,
        category_id: Number(tr.querySelector('[data-k="category_id"]').value),
        shift_id: Number(tr.querySelector('[data-k="shift_id"]').value),
        active: tr.querySelector('[data-k="active"]').checked ? 1 : 0,
      };
      const pin = tr.querySelector('[data-k="pin"]').value.trim();
      if (pin) payload.pin = pin;
      await api(`/api/admin/users/${userId}`, { method: "PUT", body: JSON.stringify(payload) });
      await fetchUsers();
      alert("User updated");
    };
  });

  tb.querySelectorAll("button[data-delete-user-id]").forEach((b) => {
    b.onclick = async () => {
      const userId = Number(b.dataset.deleteUserId);
      const u = adminState.users.find((x) => Number(x.id) === userId);
      const label = (u && (u.employee_code || u.name)) || `ID ${userId}`;
      if (!confirm(`Delete user ${label}? This will also delete their attendance history.`)) return;
      await api(`/api/admin/users/${userId}`, { method: "DELETE" });
      await Promise.all([fetchUsers(), loadTodayAttendance()]);
      if (u && getMergedEmployeeCode().toUpperCase() === String(u.employee_code || "").toUpperCase()) {
        qs("mergedSummary").innerHTML = "";
        qs("mergedAttendanceTable").querySelector("tbody").innerHTML = "";
        setMergedExportLink();
      }
      alert("User deleted");
    };
  });

  fillSelect(qs("uCategory"), adminState.categories, "id", "name");
  fillSelect(qs("uShift"), adminState.shifts, "id", "name");
}

async function createUser(e) {
  e.preventDefault();
  await api("/api/admin/users", {
    method: "POST",
    body: JSON.stringify({
      name: qs("uName").value,
      employee_code: qs("uCode").value,
      pin: qs("uPin").value,
      role: qs("uRole").value,
      category_id: Number(qs("uCategory").value),
      shift_id: Number(qs("uShift").value),
    }),
  });
  e.target.reset();
  await fetchUsers();
}

async function fetchCategories() {
  const d = await api("/api/admin/categories");
  adminState.categories = d.items || [];

  const tb = qs("categoryTable").querySelector("tbody");
  tb.innerHTML = "";
  adminState.categories.forEach((c) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${c.id}</td>
      <td><input data-k="name" value="${c.name || ""}" /></td>
      <td><input data-k="required_hours" value="${c.required_hours || ""}" /></td>
      <td>
        <div class="row">
          <button data-category-id="${c.id}" type="button">Save</button>
          <button data-delete-category-id="${c.id}" type="button">Delete</button>
        </div>
      </td>
    `;
    tb.appendChild(tr);
  });

  tb.querySelectorAll("button[data-category-id]").forEach((b) => {
    b.onclick = async () => {
      const tr = b.closest("tr");
      await api(`/api/admin/categories/${Number(b.dataset.categoryId)}`, {
        method: "PUT",
        body: JSON.stringify({
          name: tr.querySelector('[data-k="name"]').value,
          required_hours: Number(tr.querySelector('[data-k="required_hours"]').value),
        }),
      });
      await fetchCategories();
      await fetchUsers();
      alert("Category updated");
    };
  });

  tb.querySelectorAll("button[data-delete-category-id]").forEach((b) => {
    b.onclick = async () => {
      const categoryId = Number(b.dataset.deleteCategoryId);
      const c = adminState.categories.find((x) => Number(x.id) === categoryId);
      const label = (c && c.name) || `ID ${categoryId}`;
      if (!confirm(`Delete category ${label}? Employees using it will be moved to another category.`)) return;
      await api(`/api/admin/categories/${categoryId}`, { method: "DELETE" });
      await Promise.all([fetchCategories(), fetchUsers()]);
      alert("Category deleted");
    };
  });

  fillSelect(qs("uCategory"), adminState.categories, "id", "name");
  fillSelect(qs("editCategoryId"), adminState.categories, "id", "name", "Category (No Change)");
}

async function createCategory(e) {
  e.preventDefault();
  await api("/api/admin/categories", {
    method: "POST",
    body: JSON.stringify({ name: qs("cName").value, required_hours: qs("cReq").value }),
  });
  e.target.reset();
  await fetchCategories();
}

async function fetchShifts() {
  const d = await api("/api/admin/shifts");
  adminState.shifts = d.items || [];

  const tb = qs("shiftTable").querySelector("tbody");
  tb.innerHTML = "";
  adminState.shifts.forEach((s) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s.id}</td>
      <td><input data-k="name" value="${s.name || ""}" /></td>
      <td><input data-k="start_time" value="${s.start_time || ""}" /></td>
      <td><input data-k="end_time" value="${s.end_time || ""}" /></td>
      <td><input data-k="grace_minutes" value="${s.grace_minutes || ""}" /></td>
      <td>
        <div class="row">
          <button data-shift-id="${s.id}" type="button">Save</button>
          <button data-delete-shift-id="${s.id}" type="button">Delete</button>
        </div>
      </td>
    `;
    tb.appendChild(tr);
  });

  tb.querySelectorAll("button[data-shift-id]").forEach((b) => {
    b.onclick = async () => {
      const tr = b.closest("tr");
      await api(`/api/admin/shifts/${Number(b.dataset.shiftId)}`, {
        method: "PUT",
        body: JSON.stringify({
          name: tr.querySelector('[data-k="name"]').value,
          start_time: tr.querySelector('[data-k="start_time"]').value,
          end_time: tr.querySelector('[data-k="end_time"]').value,
          grace_minutes: Number(tr.querySelector('[data-k="grace_minutes"]').value),
        }),
      });
      await fetchShifts();
      await fetchUsers();
      alert("Shift updated");
    };
  });

  tb.querySelectorAll("button[data-delete-shift-id]").forEach((b) => {
    b.onclick = async () => {
      const shiftId = Number(b.dataset.deleteShiftId);
      const s = adminState.shifts.find((x) => Number(x.id) === shiftId);
      const label = (s && s.name) || `ID ${shiftId}`;
      if (!confirm(`Delete shift ${label}? Employees using it will be moved to another shift.`)) return;
      await api(`/api/admin/shifts/${shiftId}`, { method: "DELETE" });
      await Promise.all([fetchShifts(), fetchUsers()]);
      alert("Shift deleted");
    };
  });

  fillSelect(qs("uShift"), adminState.shifts, "id", "name");
  fillSelect(qs("assignShiftId"), adminState.shifts, "id", "name");
  fillSelect(qs("editShiftId"), adminState.shifts, "id", "name", "Shift (No Change)");
}

async function createShift(e) {
  e.preventDefault();
  await api("/api/admin/shifts", {
    method: "POST",
    body: JSON.stringify({
      name: qs("sName").value,
      start_time: qs("sStart").value,
      end_time: qs("sEnd").value,
      grace_minutes: qs("sGrace").value,
    }),
  });
  e.target.reset();
  await fetchShifts();
}

async function assignShiftToEmployee(e) {
  e.preventDefault();
  const code = (qs("assignShiftEmpCode").value || "").trim();
  const shiftId = Number(qs("assignShiftId").value);
  if (!code) {
    alert("Enter employee code");
    return;
  }
  const u = findUserByCode(code);
  if (!u) {
    alert("Employee code not found");
    return;
  }
  await api(`/api/admin/users/${u.id}`, { method: "PUT", body: JSON.stringify({ shift_id: shiftId }) });
  await fetchUsers();
  alert("Shift assigned");
}

async function loadCurrentAttendanceEdit() {
  const code = (qs("editEmpCode").value || "").trim();
  const d = qs("editAttendanceDate").value;
  if (!code || !d) {
    alert("Enter employee code and date");
    return;
  }
  const out = await api(`/api/admin/employee-summary?employee_code=${encodeURIComponent(code)}&from=${d}&to=${d}`);
  const row = (out.attendance || [])[0];
  if (!row) {
    alert("No attendance row found for selected date");
    return;
  }
  qs("editLoginTime").value = isoToLocalInput(row.login_time);
  qs("editLogoutTime").value = isoToLocalInput(row.logout_time);
  qs("editBreakTaken").value = row.break_taken === 1 ? "1" : "0";
  const user = findUserByCode(code);
  qs("editCategoryId").value = String((user && user.category_id) || "");
  qs("editShiftId").value = String((user && user.shift_id) || "");
}

async function submitAdminAttendanceEdit(e) {
  e.preventDefault();
  const code = (qs("editEmpCode").value || "").trim();
  const d = qs("editAttendanceDate").value;
  if (!code || !d) {
    alert("employee code and date are required");
    return;
  }
  const payload = { employee_code: code, attendance_date: d };
  if (qs("editLoginTime").value) payload.login_time = qs("editLoginTime").value;
  if (qs("editLogoutTime").value) payload.logout_time = qs("editLogoutTime").value;
  if (qs("editBreakTaken").value !== "") payload.break_taken = Number(qs("editBreakTaken").value);
  if (qs("editCategoryId").value) payload.category_id = Number(qs("editCategoryId").value);
  if (qs("editShiftId").value) payload.shift_id = Number(qs("editShiftId").value);

  await api("/api/admin/attendance/edit", { method: "POST", body: JSON.stringify(payload) });
  await Promise.all([fetchUsers(), loadTodayAttendance()]);
  if (getMergedEmployeeCode().toUpperCase() === code.toUpperCase()) {
    await loadMergedEmployeeView();
  }
  alert("Attendance updated");
}

function renderEmployeeProfile(user) {
  const nameEl = qs("empInfoName");
  if (!nameEl) return;

  const codeEl = qs("empInfoCode");
  const categoryEl = qs("empInfoCategory");
  const shiftEl = qs("empInfoShiftTimings");

  const name = String((user && user.name) || "").trim();
  const code = String((user && user.employee_code) || "").trim();
  const category = String((user && user.category_name) || "").trim();
  const shiftStart = String((user && user.shift_start) || "").trim();
  const shiftEnd = String((user && user.shift_end) || "").trim();
  const shiftTimings = shiftStart && shiftEnd ? `${shiftStart} - ${shiftEnd}` : (shiftStart || shiftEnd || "-");

  nameEl.textContent = name || "-";
  if (codeEl) codeEl.textContent = code || "-";
  if (categoryEl) categoryEl.textContent = category || "-";
  if (shiftEl) shiftEl.textContent = shiftTimings;
}

async function loadEmployee(currentUser) {
  let user = currentUser;
  if (!user || !user.category_name || !user.shift_start || !user.shift_end) {
    const me = await api("/auth/me");
    user = me.user || user;
  }
  renderEmployeeProfile(user);

  const r = monthRange();
  qs("fromDate").value = r.from;
  qs("toDate").value = r.to;
  qs("reloadAttendance").onclick = reloadEmployeeDashboard;
  qs("logoutBtn").onclick = doEmployeeLogout;
  qs("saveBreakBtn").onclick = saveEmployeeBreakStatus;
  await reloadEmployeeDashboard();
}

async function loadEmployeeBreakStatus() {
  const breakSelect = qs("logoutBreakTaken");
  const saveBtn = qs("saveBreakBtn");
  if (!breakSelect || !saveBtn) return;

  try {
    const d = await api("/api/employee/today-break");
    employeeState.canUpdateBreak = Boolean(d.can_update);
    if (!employeeState.canUpdateBreak) {
      breakSelect.value = "";
      breakSelect.disabled = true;
      saveBtn.disabled = true;
      setBreakStatusMessage(`No attendance record for break date ${d.attendance_date} (4:00 AM cutoff).`);
      return;
    }

    breakSelect.disabled = false;
    breakSelect.value = d.break_taken === 1 ? "1" : "0";
    saveBtn.disabled = employeeState.isSavingBreak;
    setBreakStatusMessage(`Break status loaded for ${d.attendance_date} (4:00 AM cutoff). Change selection and click Save Break Status. Logout can also save selected value.`);
  } catch (e) {
    employeeState.canUpdateBreak = false;
    breakSelect.value = "";
    breakSelect.disabled = true;
    saveBtn.disabled = true;
    setBreakStatusMessage(`Unable to load break status: ${e.message}`);
  }
}
function setEmployeeExportLink() {
  qs("myExportLink").href = `/api/employee/export.xlsx?from=${qs("fromDate").value}&to=${qs("toDate").value}`;
}

async function reloadEmployeeDashboard() {
  setEmployeeExportLink();
  await Promise.all([fetchEmployeeSummary(), fetchEmployeeAttendance(), loadEmployeeBreakStatus()]);
}

async function fetchEmployeeSummary() {
  const d = await api(`/api/employee/my-summary?from=${qs("fromDate").value}&to=${qs("toDate").value}`);
  renderOrderedKpis(
    qs("empSummary"),
    {
      total_days: d.total_days,
      present_count: d.present_count,
      absent_count: d.absent_count,
      late_count: d.late_count,
      break_taken_days: d.break_taken_days,
      overtime_hours: d.overtime_hours,
    },
    ["total_days", "present_count", "absent_count", "late_count", "break_taken_days", "overtime_hours"],
  );
}

async function fetchEmployeeAttendance() {
  const d = await api(`/api/employee/my-attendance?from=${qs("fromDate").value}&to=${qs("toDate").value}`);
  const tb = qs("attendanceTable").querySelector("tbody");
  tb.innerHTML = "";
  (d.items || []).forEach((i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i.attendance_date || ""}</td><td>${formatDashboardDateTime(i.login_time)}</td><td>${formatDashboardDateTime(i.logout_time)}</td><td>${kpiValue(i.overtime)}</td><td>${formatHoursToHHMM(i.early_logout_hours)}</td><td>${kpiValue(i.late_mark)}</td><td>${(i.break_taken || 0) === 1 ? "Yes" : "No"}</td><td>${i.status || ""}</td>`;
    tb.appendChild(tr);
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    if (qs("loginForm")) {
      qs("loginForm").onsubmit = doLogin;
      return;
    }
    const me = await api("/auth/me");
    if (document.body.dataset.role === "admin" && me.user.role === "ADMIN") return loadAdmin();
    if (document.body.dataset.role === "employee" && me.user.role === "EMPLOYEE") return loadEmployee(me.user);
  } catch (e) {
    if (location.pathname !== "/login") location.href = "/login";
    else alert(e.message);
  }
});

