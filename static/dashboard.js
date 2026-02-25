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

async function doLogout() {
  await api("/auth/logout", { method: "POST" });
  location.href = "/login";
}

const adminState = { users: [], categories: [], shifts: [] };

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

  qs("logoutBtn").onclick = doLogout;
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
      tr.innerHTML = `<td>${i.attendance_date || ""}</td><td>${i.login_time || ""}</td><td>${i.logout_time || ""}</td><td>${kpiValue(i.total_hours)}</td><td>${kpiValue(i.overtime)}</td><td>${kpiValue(i.late_mark)}</td>`;
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
    tr.innerHTML = `<td>${i.employee_code || ""}</td><td>${i.attendance_date || ""}</td><td>${i.login_time || ""}</td><td>${i.logout_time || ""}</td><td>${kpiValue(i.total_hours)}</td><td>${kpiValue(i.overtime)}</td><td>${kpiValue(i.late_mark)}</td>`;
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
      <td><button data-user-id="${u.id}" type="button">Save</button></td>
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
      <td><button data-category-id="${c.id}" type="button">Save</button></td>
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

  fillSelect(qs("uCategory"), adminState.categories, "id", "name");
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
      <td><button data-shift-id="${s.id}" type="button">Save</button></td>
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
  if (qs("editShiftId").value) payload.shift_id = Number(qs("editShiftId").value);

  await api("/api/admin/attendance/edit", { method: "POST", body: JSON.stringify(payload) });
  await Promise.all([fetchUsers(), loadTodayAttendance()]);
  if (getMergedEmployeeCode().toUpperCase() === code.toUpperCase()) {
    await loadMergedEmployeeView();
  }
  alert("Attendance updated");
}

async function loadEmployee() {
  const r = monthRange();
  qs("fromDate").value = r.from;
  qs("toDate").value = r.to;
  qs("reloadAttendance").onclick = reloadEmployeeDashboard;
  qs("logoutBtn").onclick = doLogout;
  await reloadEmployeeDashboard();
}

function setEmployeeExportLink() {
  qs("myExportLink").href = `/api/employee/export.xlsx?from=${qs("fromDate").value}&to=${qs("toDate").value}`;
}

async function reloadEmployeeDashboard() {
  setEmployeeExportLink();
  await Promise.all([fetchEmployeeSummary(), fetchEmployeeAttendance()]);
}

async function fetchEmployeeSummary() {
  const d = await api(`/api/employee/my-summary?from=${qs("fromDate").value}&to=${qs("toDate").value}`);
  renderKV(qs("empSummary"), d);
}

async function fetchEmployeeAttendance() {
  const d = await api(`/api/employee/my-attendance?from=${qs("fromDate").value}&to=${qs("toDate").value}`);
  const tb = qs("attendanceTable").querySelector("tbody");
  tb.innerHTML = "";
  (d.items || []).forEach((i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i.id}</td><td>${i.attendance_date || ""}</td><td>${i.login_time || ""}</td><td>${i.logout_time || ""}</td><td>${kpiValue(i.total_hours)}</td><td>${kpiValue(i.overtime)}</td><td>${kpiValue(i.late_mark)}</td><td>${(i.break_taken || 0) === 1 ? "Yes" : "No"}</td><td>${i.status || ""}</td>`;
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
    if (document.body.dataset.role === "employee" && me.user.role === "EMPLOYEE") return loadEmployee();
  } catch (e) {
    if (location.pathname !== "/login") location.href = "/login";
    else alert(e.message);
  }
});
