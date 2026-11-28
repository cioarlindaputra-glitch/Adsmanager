import { createAuthClient } from '@neon/auth';

const $ = function (s) { return document.querySelector(s); };
const $$ = function (s) { return Array.from(document.querySelectorAll(s)); };
let config, authClient, accessToken = '', isAdmin = false, brands = [], socialBrands = [], period = 'monthly';
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
  const dashboardFilters = $('#dashboardFilters');
  if (dashboardFilters) dashboardFilters.style.display = isAdmin ? '' : 'none';
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
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const days = period === 'daily' ? 1 : 7;
    const start = period === 'monthly'
      ? monthStart.toISOString().slice(0, 10)
      : new Date(now.getTime() - (days - 1) * 864e5).toISOString().slice(0, 10);
    const query = new URLSearchParams({ start: start, end: end });
    const dashboard = await api('/api/dashboard?' + query.toString());
    renderDashboard(dashboard);
    const socialNow = new Date();
    const socialEnd = socialNow.toISOString().slice(0, 10);
    const socialPeriod = $('#socialPeriod') ? $('#socialPeriod').value : 'month';
    const socialStart = socialPeriod === 'month'
      ? new Date(Date.UTC(socialNow.getUTCFullYear(), socialNow.getUTCMonth(), 1)).toISOString().slice(0, 10)
      : new Date(socialNow.getTime() - (Number(socialPeriod || 30) - 1) * 864e5).toISOString().slice(0, 10);
    const socialQuery = new URLSearchParams({ start: socialStart, end: socialEnd });
    const social = await api('/api/social?' + socialQuery.toString());
    socialBrands = social.brands || [];
    renderSocial(social);
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
  $('#chartPeriod').textContent = period === 'daily' ? 'Hari ini' : period === 'monthly' ? 'Bulan ini' : '7 hari terakhir';
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
function renderSocial(data) {
  const selected = data && data.brands || [];
  function metric(value) { return value === null || value === undefined ? '—' : Number(value).toLocaleString('id-ID'); }
  function engagement(value) { return value === null || value === undefined ? '—' : Number(value).toFixed(2) + '%'; }
  $('#socialCards').innerHTML = selected.map(function (brand) {
    const status = brand.connected ? '<span class="status live">Terhubung</span>' : '<span class="status attn">Belum terhubung</span>';
    return '<div class="social-card"><div class="socialbrand"><span class="socialicon">◎</span>' + esc(brand.name) + '</div><div class="socialnumbers"><div><b>' + metric(brand.reach) + '</b><small>Jangkauan</small></div><div><b>' + metric(brand.interactions) + '</b><small>Interaksi</small></div><div><b>' + metric(brand.profile_links_taps) + '</b><small>Klik tautan</small></div><div><b>' + engagement(brand.engagement_pct) + '</b><small>Engagement</small></div></div><div class="connectbar">' + status + '<span class="muted">' + (brand.instagram_username ? '@' + esc(brand.instagram_username) : 'Instagram') + '</span></div></div>';
  }).join('') || '<div class="social-card">Belum ada brand sosial. Tambahkan brand sosial untuk mulai menautkan akun.</div>';
  $('#socialRows').innerHTML = selected.map(function (brand) {
    const status = brand.connected ? '<span class="status live">Terhubung</span>' : '<span class="status attn">Belum terhubung</span>';
    const actions = isAdmin ? '<div style="display:flex;gap:6px"><button class="btn small" data-social-connect="' + esc(brand.id) + '">' + (brand.connected ? 'Ganti akun' : 'Sambungkan') + '</button><button class="btn small" data-social-edit="' + esc(brand.id) + '">Ubah</button><button class="btn small" data-social-delete="' + esc(brand.id) + '">Hapus</button></div>' : '—';
    return '<tr><td>' + esc(brand.name) + '</td><td>Instagram</td><td>' + metric(brand.reach) + '</td><td>' + metric(brand.interactions) + '</td><td>' + metric(brand.profile_links_taps) + '</td><td>' + engagement(brand.engagement_pct) + '</td><td>' + status + '</td><td>' + actions + '</td></tr>';
  }).join('') || '<tr><td colspan="8">Belum ada brand sosial. Klik “Tambah brand sosial” untuk mulai.</td></tr>';
  $$('[data-social-connect]').forEach(function (button) { button.onclick = function () { connectInstagram(button.dataset.socialConnect); }; });
  $$('[data-social-edit]').forEach(function (button) { button.onclick = function () { editSocialBrand(button.dataset.socialEdit); }; });
  $$('[data-social-delete]').forEach(function (button) { button.onclick = function () { deleteSocialBrand(button.dataset.socialDelete); }; });
}
function addSocialBrand() {
  if (!isAdmin) return toast('Login admin diperlukan');
  modal('Tambah brand sosial', 'Daftar ini terpisah dari Data brand iklan.', '<div class="field"><label>Nama brand atau akun</label><input id="socialBrandName" maxlength="120" placeholder="Contoh: Brand Instagram 1"></div><div class="modal-actions"><button class="btn" id="cancelSocialBrand">Batal</button><button class="btn primary" id="modalSubmit">Tambah brand</button></div>', async function () {
    const name = $('#socialBrandName').value.trim();
    if (!name) return toast('Nama brand sosial wajib diisi.');
    try { await api('/api/social-brands', { method: 'POST', body: JSON.stringify({ name: name }) }); closeModal(); await load(); toast('Brand sosial ditambahkan.'); }
    catch (error) { toast(error.message); }
  });
  $('#cancelSocialBrand').onclick = closeModal;
}
function editSocialBrand(id) {
  const brand = socialBrands.find(function (item) { return item.id === id; });
  if (!brand) return;
  modal('Ubah nama brand sosial', 'Perubahan hanya berlaku di Insight sosial.', '<div class="field"><label>Nama brand</label><input id="socialBrandName" maxlength="120" value="' + esc(brand.name) + '"></div><div class="modal-actions"><button class="btn" id="cancelSocialBrand">Batal</button><button class="btn primary" id="modalSubmit">Simpan</button></div>', async function () {
    const name = $('#socialBrandName').value.trim();
    if (!name) return toast('Nama brand sosial wajib diisi.');
    try { await api('/api/social-brands/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ name: name }) }); closeModal(); await load(); toast('Nama brand sosial diperbarui.'); }
    catch (error) { toast(error.message); }
  });
  $('#cancelSocialBrand').onclick = closeModal;
}
async function deleteSocialBrand(id) {
  const brand = socialBrands.find(function (item) { return item.id === id; });
  if (!brand || !confirm('Hapus brand sosial “' + brand.name + '” beserta koneksi Instagram dan metriknya?')) return;
  try { await api('/api/social-brands/' + encodeURIComponent(id), { method: 'DELETE' }); await load(); toast('Brand sosial dihapus.'); }
  catch (error) { toast(error.message); }
}
async function connectInstagram(id) {
  if (!isAdmin) return toast('Login admin diperlukan');
  try {
    const result = await api('/api/instagram/connect/' + encodeURIComponent(id));
    location.href = result.url;
  } catch (error) { toast(error.message || 'Koneksi Instagram gagal.'); }
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
  const html = '<div class="authchoice"><button class="btn" id="googleLogin">Lanjutkan dengan Google</button></div><div style="text-align:center;color:#758296;font-size:11px">atau masuk dengan email dan password</div><div class="field"><label>Email</label><input id="email" type="email" placeholder="nama@perusahaan.com" autocomplete="email"></div><div class="field"><label>Password</label><input id="password" type="password" autocomplete="current-password"></div><div class="modal-actions"><button class="btn primary" id="modalSubmit">Masuk</button></div><button class="linkbtn" id="forgotPassword" type="button">Lupa password?</button><button class="linkbtn" id="switchAuth" type="button">Belum punya akun? Buat akun</button><div class="footnote">Neon Auth mendukung email/password dan Google. Login nomor telepon belum tersedia.</div>';
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
  $('#forgotPassword').onclick = function () { showForgotPassword($('#email').value.trim()); };
  $('#switchAuth').onclick = function () {
    mode = mode === 'signin' ? 'signup' : 'signin';
    $('#modalTitle').textContent = mode === 'signup' ? 'Buat akun admin' : 'Masuk sebagai admin';
    $('#modalSubmit').textContent = mode === 'signup' ? 'Buat akun' : 'Masuk';
    $('#switchAuth').textContent = mode === 'signup' ? 'Sudah punya akun? Masuk' : 'Belum punya akun? Buat akun';
  };
}

function showForgotPassword(email) {
  const html = '<div class="field"><label>Email akun</label><input id="resetEmail" type="email" placeholder="nama@perusahaan.com" autocomplete="email" value="' + esc(email) + '"></div><div class="modal-actions"><button class="btn" id="backToLogin" type="button">Kembali</button><button class="btn primary" id="modalSubmit">Kirim link reset</button></div><div class="footnote">Jika email terdaftar, link untuk membuat password baru akan dikirim ke inbox Anda.</div>';
  modal('Lupa password', 'Masukkan email yang digunakan untuk akun dashboard.', html, async function () {
    const address = $('#resetEmail').value.trim();
    if (!address) return toast('Isi email akun Anda.');
    try {
      const result = await authClient.requestPasswordReset({ email: address, redirectTo: location.origin + '/?resetPassword=1' });
      if (result.error) throw Error(result.error.message || 'Link reset gagal dikirim.');
      toast('Jika email terdaftar, link reset sudah dikirim. Periksa inbox dan folder spam.');
      closeModal();
    } catch (error) { toast(error.message || 'Link reset gagal dikirim.'); }
  });
  $('#backToLogin').onclick = login;
}

function handlePasswordResetLink() {
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  if (!token && params.get('error')) {
    history.replaceState(null, document.title, location.pathname);
    toast('Link reset tidak valid atau sudah kedaluwarsa. Minta link baru.');
    return;
  }
  if (!token) return;
  history.replaceState(null, document.title, location.pathname);
  const html = '<div class="field"><label>Password baru</label><input id="newPassword" type="password" autocomplete="new-password"></div><div class="field"><label>Ulangi password baru</label><input id="confirmPassword" type="password" autocomplete="new-password"></div><div class="modal-actions"><button class="btn primary" id="modalSubmit">Simpan password baru</button></div>';
  modal('Buat password baru', 'Pilih password baru untuk akun dashboard Anda.', html, async function () {
    const password = $('#newPassword').value;
    if (password.length < 8) return toast('Password minimal 8 karakter.');
    if (password !== $('#confirmPassword').value) return toast('Konfirmasi password belum sama.');
    try {
      const result = await authClient.resetPassword({ newPassword: password, token: token });
      if (result.error) throw Error(result.error.message || 'Password gagal diperbarui.');
      closeModal();
      toast('Password berhasil diperbarui. Silakan masuk.');
      login();
    } catch (error) { toast(error.message || 'Password gagal diperbarui.'); }
  });
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
$('#socialPeriod').onchange = function () { load(); };
$('#brandSearch').oninput = renderBrands;
$('#hamb').onclick = function () { $('#sidebar').classList.toggle('open'); };
$('#addBrand').onclick = function () {
  modal('Tambah brand', 'Brand tersimpan bersama di database Neon.', '<div class="field"><label>Nama brand</label><input id="newName"></div><div class="field"><label>Singkatan</label><input id="newTag" maxlength="3"></div><div class="modal-actions"><button class="btn" id="cancel">Batal</button><button class="btn primary" id="modalSubmit">Tambah brand</button></div>', async function () {
    try { await api('/api/brands', { method: 'POST', body: JSON.stringify({ name: $('#newName').value, short_name: $('#newTag').value }) }); closeModal(); await load(); }
    catch (error) { toast(error.message); }
  });
  $('#cancel').onclick = closeModal;
};
$('#addSocialBrand').onclick = addSocialBrand;
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
    handlePasswordResetLink();
  } catch (error) { toast(error.message); }
}
init();
