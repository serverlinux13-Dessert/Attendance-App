async function api(path, opts={}){const r=await fetch(path,{credentials:'include',headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});const c=r.headers.get('content-type')||'';const d=c.includes('application/json')?await r.json():null;if(!r.ok)throw new Error((d&&d.message)||('HTTP '+r.status));return d}
function qs(id){return document.getElementById(id)}
function monthRange(){const n=new Date();const y=n.getFullYear();const m=String(n.getMonth()+1).padStart(2,'0');const d=String(n.getDate()).padStart(2,'0');return {from:`${y}-${m}-01`,to:`${y}-${m}-${d}`}}

async function doLogin(e){e.preventDefault();const payload={employee_code:qs('employee_code').value.trim(),pin:qs('pin').value.trim()};const out=await api('/auth/login',{method:'POST',body:JSON.stringify(payload)});location.href=out.redirect}
async function doLogout(){await api('/auth/logout',{method:'POST'});location.href='/login'}

function renderKV(el,obj){el.innerHTML='';Object.entries(obj).forEach(([k,v])=>{const d=document.createElement('div');d.className='kpi';d.innerHTML=`<div class="muted">${k}</div><div><b>${v??0}</b></div>`;el.appendChild(d)})}
function row(txt){const li=document.createElement('li');li.className='item';li.textContent=txt;return li}

async function loadAdmin(){
 const r=monthRange();qs('fromDate').value=r.from;qs('toDate').value=r.to;
 qs('reloadAttendance').onclick=fetchAdminAttendance;qs('logoutBtn').onclick=doLogout;
 qs('createUserForm').onsubmit=createUser;qs('createCategoryForm').onsubmit=createCategory;qs('createShiftForm').onsubmit=createShift;
 await Promise.all([fetchAdminSummary(),fetchAdminAttendance(),fetchUsers(),fetchCategories(),fetchShifts(),fetchEditReqs(),fetchAudit()]);
}
async function fetchAdminSummary(){const d=await api(`/api/admin/summary?from=${qs('fromDate').value}&to=${qs('toDate').value}`);renderKV(qs('adminSummary'),d)}
async function fetchAdminAttendance(){const s=qs('statusFilter').value;const q=`from=${qs('fromDate').value}&to=${qs('toDate').value}${s?`&status=${s}`:''}`;const d=await api('/api/admin/attendance?'+q);const tb=qs('attendanceTable').querySelector('tbody');tb.innerHTML='';d.items.forEach(i=>{const tr=document.createElement('tr');tr.innerHTML=`<td>${i.employee_name}</td><td>${i.attendance_date||''}</td><td>${i.login_time||''}</td><td>${i.logout_time||''}</td><td>${i.total_hours||0}</td><td>${i.overtime||0}</td><td>${i.late_mark||0}</td><td>${i.early_leaving||0}</td><td>${i.status||''}</td>`;tb.appendChild(tr)});qs('exportLink').href='/api/admin/export.xlsx?'+q}
async function fetchUsers(){const d=await api('/api/admin/users');const ul=qs('usersList');ul.innerHTML='';d.items.forEach(u=>ul.appendChild(row(`${u.id} | ${u.employee_code} | ${u.name} | ${u.role} | active=${u.active}`)))}
async function createUser(e){e.preventDefault();await api('/api/admin/users',{method:'POST',body:JSON.stringify({name:qs('uName').value,employee_code:qs('uCode').value,pin:qs('uPin').value,role:qs('uRole').value})});e.target.reset();await fetchUsers()}
async function fetchCategories(){const d=await api('/api/admin/categories');const ul=qs('categoryList');ul.innerHTML='';d.items.forEach(c=>ul.appendChild(row(`${c.id} | ${c.name} | req=${c.required_hours} | half=${c.half_day_hours}`)))}
async function createCategory(e){e.preventDefault();await api('/api/admin/categories',{method:'POST',body:JSON.stringify({name:qs('cName').value,required_hours:qs('cReq').value,half_day_hours:qs('cHalf').value})});e.target.reset();await fetchCategories()}
async function fetchShifts(){const d=await api('/api/admin/shifts');const ul=qs('shiftList');ul.innerHTML='';d.items.forEach(s=>ul.appendChild(row(`${s.id} | ${s.name} | ${s.start_time}-${s.end_time} | grace=${s.grace_minutes}`)))}
async function createShift(e){e.preventDefault();await api('/api/admin/shifts',{method:'POST',body:JSON.stringify({name:qs('sName').value,start_time:qs('sStart').value,end_time:qs('sEnd').value,grace_minutes:qs('sGrace').value})});e.target.reset();await fetchShifts()}
async function fetchEditReqs(){const d=await api('/api/admin/edit-requests?status=PENDING');const ul=qs('editReqList');ul.innerHTML='';d.items.forEach(r=>{const li=document.createElement('li');li.className='item';li.innerHTML=`#${r.id} ${r.employee_name} ${r.attendance_date} <button data-a="${r.id}">Approve</button> <button data-r="${r.id}">Reject</button>`;ul.appendChild(li)});ul.querySelectorAll('button[data-a]').forEach(b=>b.onclick=async()=>{await api(`/api/admin/edit-requests/${b.dataset.a}/approve`,{method:'POST'});await fetchEditReqs();await fetchAdminAttendance()});ul.querySelectorAll('button[data-r]').forEach(b=>b.onclick=async()=>{await api(`/api/admin/edit-requests/${b.dataset.r}/reject`,{method:'POST'});await fetchEditReqs()})}
async function fetchAudit(){const d=await api('/api/admin/audit');const ul=qs('auditList');ul.innerHTML='';d.items.slice(0,20).forEach(a=>ul.appendChild(row(`${a.created_at} | ${a.action} | att=${a.attendance_id||''}`)))}

async function loadEmployee(){
 const r=monthRange();qs('fromDate').value=r.from;qs('toDate').value=r.to;qs('reloadAttendance').onclick=fetchEmployeeAttendance;qs('logoutBtn').onclick=doLogout;qs('editReqForm').onsubmit=submitEditReq;
 await Promise.all([fetchEmployeeSummary(),fetchEmployeeAttendance()]);
}
async function fetchEmployeeSummary(){const d=await api(`/api/employee/my-summary?from=${qs('fromDate').value}&to=${qs('toDate').value}`);renderKV(qs('empSummary'),d)}
async function fetchEmployeeAttendance(){const d=await api(`/api/employee/my-attendance?from=${qs('fromDate').value}&to=${qs('toDate').value}`);const tb=qs('attendanceTable').querySelector('tbody');tb.innerHTML='';d.items.forEach(i=>{const tr=document.createElement('tr');tr.innerHTML=`<td>${i.id}</td><td>${i.attendance_date||''}</td><td>${i.login_time||''}</td><td>${i.logout_time||''}</td><td>${i.total_hours||0}</td><td>${i.overtime||0}</td><td>${i.late_mark||0}</td><td>${i.early_leaving||0}</td><td>${i.status||''}</td>`;tb.appendChild(tr)})}
async function submitEditReq(e){e.preventDefault();await api('/api/employee/edit-requests',{method:'POST',body:JSON.stringify({attendance_id:Number(qs('attendanceId').value),requested_login_time:qs('reqLogin').value||null,requested_logout_time:qs('reqLogout').value||null,reason:qs('reqReason').value||''})});alert('Request submitted');e.target.reset()}

window.addEventListener('DOMContentLoaded',async()=>{
 try{
  if(qs('loginForm')){qs('loginForm').onsubmit=doLogin;return}
  const me=await api('/auth/me');
  if(document.body.dataset.role==='admin'&&me.user.role==='ADMIN') return loadAdmin();
  if(document.body.dataset.role==='employee'&&me.user.role==='EMPLOYEE') return loadEmployee();
 }catch(e){if(location.pathname!='/login') location.href='/login'; else alert(e.message)}
});
