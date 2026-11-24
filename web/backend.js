import { createAuthClient } from '@neon/auth';

const $ = function (s) { return document.querySelector(s); };
const $$ = function (s) { return Array.from(document.querySelectorAll(s)); };
let config, authClient, accessToken = '', isAdmin = false, brands = [], period = 'weekly';
const fmt = function (n) { return 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID'); };
const esc = function (s) { return String(s ?? '').replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
function toast(message) {
  const target = $('#toast');
  if (!target) return;
  target.textContent = message;
  target.classList.add('show');
  setTimeout(function () { target.classList.remove('show'); }, 2800);
}
async function api(path, options) {
  options = options || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
  const response = await fetch(path, Object.assign({}, options, { headers: headers }));
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw Error(data.error || ('HTTP ' + response.status));
  return data;
}
function tokenFrom(session) {
  return session && (session.token || session.access_token || session.accessToken) || '';
}
async function refreshAuth() {
  const result = await authClient.getSession();
  const sessionData = result && result.data;
  accessToken = tokenFrom(sessionData && sessionData.session);
  isAdmin = false;
  let user = sessionData && sessionData.user;
  if (accessToken) {
    try {
      const profileData = await api('/api/profile');
      isAdmin = profileData.profile && profileData.profile.role === 'admin';
      user = profileData.user || user;
    } catch (error) {
      accessToken = '';
      isAdmin = false;
    }
  }
  const name = user && (user.email || user.name) || 'Admin';
  $('#userName').textContent = name.split('@')[0];
  $('#userType').textContent = isAdmin ? 'Admin · Neon' : accessToken ? 'Viewer · Neon' : 'Akses baca saja';
  $('#avatar').textContent = (name[0] || 'A').toUpperCase();
  updateAccess();
}
function updateAccess() {
  $$('.nav button').forEach(function (button) {
    button.disabled = !isAdmin && button.dataset.page !== 'dashboard';
    button.style.opacity = button.disabled ? '.45' : '';
  });
  if (!isAdmin && $('.page.active') && $('.page.active').id !== 'page-dashboard') navigate('dashboard');
  $('#adminbar').classList.toggle('visible', isAdmin);
  $('#loginBtn').style.display = isAdmin ? 'none' : '';
  $('#logoutBtn').style.display = accessToken ? '' : 'none';
  renderBrands();
}
function navigate(page) {
  if (page !== 'dashboard' && !isAdmin) { toast('Login admin diperlukan'); page = 'dashboard'; }
  $$('.nav button').forEach(function (item) { item.classList.toggle('active', item.dataset.page === page); });
  $$('.page').forEach(function (item) { item.classList.toggle('active', item.id === 'page-' + page); });
  $('#crumb').textContent = page === 'brands' ? 'Data brand' : page === 'social' ? 'Insight sosial' : 'Dashboard';
  $('#sidebar').classList.remove('open');
}
async function load() {
  try {
    const result = await api('/api/brands');
    brands = result.brands || [];
    renderBrands();
    const now = new Date();
    const end = now.toISOString().slice(0, 10);
    const days = period === 'daily' ? 1 : period === 'monthly' ? 30 : 7;
    const start = new Date(now.getTime() - (days - 1) * 864e5).toISOString().slice(0, 10);
    const query = new URLSearchParams({ start: start, end: end });
    const dashboard = await api('/api/dashboard?' + query.toString());
    renderDashboard(dashboard);
    renderSocial();
  } catch (error) { toast(error.message); }
}
function deltaLabel(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '<span class="delta neutral">Belum ada pembanding</span>';
  const number = Number(value);
  const state = number < -40 ? 'bad' : number < 0 ? 'warn' : 'good';
  const prefix = number > 0 ? '+' : '';
  return '<span class="delta ' + state + '">' + prefix + number.toFixed(1) + '%</span>';
}
function renderDashboard(data) {
  const totals = data.totals || {};
  const ctr = totals.impressions ? (100 * (totals.clicks || 0) / totals.impressions).toFixed(2) : '0.00';
  const cards = [
    ['Total spend budget', fmt(totals.spend), '↗', 'Data Meta tersinkron'],
    ['Klik tautan', Number(totals.clicks || 0).toLocaleString('id-ID'), '⌁', 'Jumlah klik iklan'],
    ['CTR rata-rata', ctr + '%', '◉', 'Klik ÷ impresi'],
    ['Visitor website', '—', '⌖', 'Perlu integrasi GA4']
  ];
  $('#stats').innerHTML = cards.map(function (card) {
    return '<article class="stat"><div class="stathead">' + card[0] + '<span class="stat-icon">' + card[2] + '</span></div><div class="value">' + card[1] + '</div><div class="delta neutral">' + card[3] + '</div></article>';
  }).join('');
  $('#rangeLabel').textContent = data.start + ' – ' + data.end + ' · dibanding ' + data.previousStart + ' – ' + data.previousEnd;
  $('#chartPeriod').textContent = period === 'daily' ? 'Hari ini' : period === 'monthly' ? '30 hari terakhir' : '7 hari terakhir';
  $('#brandRows').innerHTML = (data.brands || []).map(function (brand) {
    const visitor = brand.website_visitors === null ? '—' : Number(brand.website_visitors).toLocaleString('id-ID');
    return '<tr><td><div class="brand-cell"><span class="branddot">' + esc(brand.short_name || brand.name.slice(0, 2)) + '</span>' + esc(brand.name) + '</div></td><td>' + fmt(brand.spend) + '</td><td>' + Number(brand.clicks || 0).toLocaleString('id-ID') + '</td><td>' + Number(brand.ctr || 0).toFixed(2) + '%</td><td>' + visitor + '</td><td>' + deltaLabel(brand.ctr_change_pct) + '</td><td><span class="status ' + (brand.connected ? 'live' : 'attn') + '">' + (brand.connected ? 'Terhubung' : 'Belum terhubung') + '</span></td></tr>';
  }).join('');
  $('.chart').innerHTML = '<div class="muted" style="padding:50px 20px">Grafik akan terisi setelah data Meta masuk.</div>';
  $('#bars').innerHTML = '<div class="muted">Grafik akan terisi setelah data Meta masuk.</div>';
  const notice = $('.notice');
  if (notice) notice.innerHTML = '<span class="i">●</span><div><strong>Dashboard data aktual.</strong> ' + esc(data.note || '') + '</div>';
}
function renderBrands() {
  const search = ($('#brandSearch') && $('#brandSearch').value || '').toLowerCase();
  const filtered = brands.filter(function (brand) { return brand.name.toLowerCase().includes(search); });
  $('#brandCount').textContent = brands.length + ' brand';
  $('#addBrand').style.display = isAdmin ? '' : 'none';
  $('#brandList').innerHTML = filtered.map(function (brand) {
    const accounts = isAdmin && brand.meta_connections && brand.meta_connections.length ? brand.meta_connections.map(function (item) { return item.ad_account_name; }).join(', ') : 'Brand';
    const actions = isAdmin
      ? '<div class="brand-actions"><button class="btn small connect" data-id="' + brand.id + '">Sambungkan Meta</button><button class="btn small edit-brand" data-id="' + brand.id + '">Ubah nama</button><button class="btn small remove" data-id="' + brand.id + '">Hapus</button></div>'
      : '';
    return '<div class="brand-row"><div class="brand-info"><span class="branddot" style="width:36px;height:36px">' + esc(brand.short_name || brand.name.slice(0, 2)) + '</span><div><b>' + esc(brand.name) + '</b><small>' + esc(accounts) + '</small></div></div>' + actions + '</div>';
  }).join('') || '<div class="brand-row">Belum ada brand.</div>';
  $$('.connect').forEach(function (button) { button.onclick = async function () { try { const result = await api('/api/meta/connect/' + encodeURIComponent(button.dataset.id)); location.href = result.url; } catch (error) { toast(error.message); } }; });
  $$('.edit-brand').forEach(function (button) { button.onclick = function () { editBrand(button.dataset.id); }; });
  $$('.remove').forEach(function (button) { button.onclick = async function () { if (confirm('Hapus brand ini dan seluruh data terkait?')) { try { await api('/api/brands/' + button.dataset.id, { method: 'DELETE' }); await load(); } catch (error) { toast(error.message); } } }; });
}
function renderSocial() {
  const selected = brands.slice(0, 4);
  $('#socialCards').innerHTML = selected.map(function (brand) {
    return '<div class="social-card"><div class="socialbrand"><span class="socialicon">◎</span>' + esc(brand.name) + '</div><div class="socialnumbers"><div><b>—</b><small>Reach</small></div><div><b>—</b><small>Interaksi</small></div><div><b>—</b><small>Engagement</small></div></div><div class="connectbar"><span class="status attn">Belum tersedia</span><span class="muted">Instagram</span></div></div>';
  }).join('');
  $('#socialRows').innerHTML = selected.map(function (brand) { return '<tr><td>' + esc(brand.name) + '</td><td>Instagram</td><td>—</td><td>—</td><td>—</td><td><span class="status attn">Belum terhubung</span></td></tr>'; }).join('');
}
function modal(title, description, html, submit) {
  $('#modalTitle').textContent = title;
  $('#modalDesc').textContent = description;
  $('#modalBody').innerHTML = html;
  $('#modal').classList.add('open');
  if (submit) $('#modalSubmit').onclick = submit;
}
function closeModal() { $('#modal').classList.remove('open'); }
function editBrand(id) {
  const brand = brands.find(function (item) { return item.id === id; });
  modal('Ubah nama brand', 'Perubahan akan tersimpan di database Neon.', '<div class="field"><label>Nama brand</label><input id="editName" value="' + esc(brand.name) + '"></div><div class="field"><label>Singkatan</label><input id="editTag" maxlength="3" value="' + esc(brand.short_name || '') + '"></div><div class="modal-actions"><button class="btn" id="cancel">Batal</button><button class="btn primary" id="modalSubmit">Simpan</button></div>', async function () {
    try { await api('/api/brands/' + id, { method: 'PATCH', body: JSON.stringify({ name: $('#editName').value, short_name: $('#editTag').value }) }); closeModal(); await load(); }
    catch (error) { toast(error.message); }
  });
  $('#cancel').onclick = closeModal;
}
function login() {
  let mode = 'signin';
  const html = '<div class="authchoice"><button class="btn" id="googleLogin">Lanjutkan dengan Google</button></div><div style="text-align:center;color:#758296;font-size:11px">atau masuk dengan email dan password</div><div class="field"><label>Email</label><input id="email" type="email" placeholder="nama@perusahaan.com" autocomplete="email"></div><div class="field"><label>Password</label><input id="password" type="password" autocomplete="current-password"></div><div class="modal-actions"><button class="btn primary" id="modalSubmit">Masuk</button></div><button class="linkbtn" id="switchAuth" type="button">Belum punya akun? Buat akun</button><div class="footnote">Neon Auth mendukung email/password dan Google. Login nomor telepon belum tersedia.</div>';
  modal('Masuk sebagai admin', 'Autentikasi dan sesi dikelola oleh Neon.', html, async function () {
    const email = $('#email').value.trim(), password = $('#password').value;
    if (!email || !password) return toast('Isi email dan password.');
    try {
      const result = mode === 'signup'
        ? await authClient.signUp.email({ email: email, password: password, name: email.split('@')[0] })
        : await authClient.signIn.email({ email: email, password: password });
      if (result.error) throw Error(result.error.message || 'Login gagal.');
      await refreshAuth();
      if (!isAdmin) { toast('Akun masuk, tetapi email ini belum mendapat akses admin.'); return; }
      closeModal(); await load(); toast(mode === 'signup' ? 'Akun berhasil dibuat' : 'Login berhasil');
    } catch (error) { toast(error.message || 'Login gagal.'); }
  });
  $('#googleLogin').onclick = async function () {
    try {
      const result = await authClient.signIn.social({ provider: 'google', callbackURL: location.origin });
      if (result && result.error) toast(result.error.message || 'Google login gagal.');
    } catch (error) { toast(error.message || 'Google login gagal.'); }
  };
  $('#switchAuth').onclick = function () {
    mode = mode === 'signin' ? 'signup' : 'signin';
    $('#modalTitle').textContent = mode === 'signup' ? 'Buat akun admin' : 'Masuk sebagai admin';
    $('#modalSubmit').textContent = mode === 'signup' ? 'Buat akun' : 'Masuk';
    $('#switchAuth').textContent = mode === 'signup' ? 'Sudah punya akun? Masuk' : 'Belum punya akun? Buat akun';
  };
}

$('#loginBtn').onclick = login;
$('#closeModal').onclick = closeModal;
$('#modal').onclick = function (event) { if (event.target.id === 'modal') closeModal(); };
$('#logoutBtn').onclick = async function () {
  try { if (authClient) await authClient.signOut(); } catch (error) {}
  accessToken = ''; isAdmin = false; await refreshAuth(); navigate('dashboard'); toast('Anda keluar');
};
$$('.nav button').forEach(function (button) { button.onclick = function () { navigate(button.dataset.page); }; });
$$('[data-goto]').forEach(function (button) { button.onclick = function () { navigate(button.dataset.goto); }; });
$('#period').onchange = function (event) { period = event.target.value; load(); };
$('#brandSearch').oninput = renderBrands;
$('#hamb').onclick = function () { $('#sidebar').classList.toggle('open'); };
$('#addBrand').onclick = function () {
  modal('Tambah brand', 'Brand tersimpan bersama di database Neon.', '<div class="field"><label>Nama brand</label><input id="newName"></div><div class="field"><label>Singkatan</label><input id="newTag" maxlength="3"></div><div class="modal-actions"><button class="btn" id="cancel">Batal</button><button class="btn primary" id="modalSubmit">Tambah brand</button></div>', async function () {
    try { await api('/api/brands', { method: 'POST', body: JSON.stringify({ name: $('#newName').value, short_name: $('#newTag').value }) }); closeModal(); await load(); }
    catch (error) { toast(error.message); }
  });
  $('#cancel').onclick = closeModal;
};
$('#connectInstagram').onclick = function () { toast('Instagram Insights belum diaktifkan pada backend ini.'); };
$('#exportBtn').onclick = function () { toast('Ekspor laporan akan tersedia setelah integrasi dashboard lengkap.'); };
async function init() {
  try {
    config = await api('/api/config');
    if (!config.neonAuthBaseUrl) throw Error('Neon Auth belum dikonfigurasi.');
    authClient = createAuthClient(config.neonAuthBaseUrl);
    const badge = $('.demo-pill');
    if (badge) badge.textContent = '● NEON · META INSIGHT';
    await refreshAuth();
    await load();
  } catch (error) { toast(error.message); }
}
init();
