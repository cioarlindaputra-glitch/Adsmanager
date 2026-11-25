import express from 'express';
import helmet from 'helmet';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const required = ['DATABASE_URL','NEON_AUTH_BASE_URL','NEON_AUTH_JWKS_URL','APP_ORIGIN','META_APP_ID','META_APP_SECRET','META_GRAPH_VERSION','META_TOKEN_ENCRYPTION_KEY','META_OAUTH_REDIRECT_URI'];
const missing = required.filter(function (key) { return !process.env[key]; });
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000 }) : null;
const jwks = process.env.NEON_AUTH_JWKS_URL ? createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL)) : null;
const tokenKey = process.env.META_TOKEN_ENCRYPTION_KEY && /^[a-f0-9]{64}$/i.test(process.env.META_TOKEN_ENCRYPTION_KEY) ? Buffer.from(process.env.META_TOKEN_ENCRYPTION_KEY, 'hex') : null;
const graph = process.env.META_GRAPH_VERSION;

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(function (req, res, next) {
  const origin = process.env.APP_ORIGIN;
  if (origin && req.headers.origin === origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const json = function (res, status, data) { return res.status(status).json(data); };
function encrypt(value) {
  if (!tokenKey) throw Error('Meta token encryption is not configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}
async function currentUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !jwks) return null;
  const result = await jwtVerify(token, jwks, { issuer: new URL(process.env.NEON_AUTH_BASE_URL).origin, algorithms: ['EdDSA'] });
  const payload = result.payload;
  if (!payload.sub) return null;
  return { id: String(payload.sub), email: typeof payload.email === 'string' ? payload.email : null, name: typeof payload.name === 'string' ? payload.name : null };
}
async function ensureProfile(user) {
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const role = user.email && adminEmail && user.email.toLowerCase() === adminEmail ? 'admin' : 'viewer';
  const result = await pool.query(
    "INSERT INTO public.profiles (id, display_name, role) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), public.profiles.display_name), role = CASE WHEN EXCLUDED.role = 'admin' THEN 'admin' ELSE public.profiles.role END RETURNING id, display_name, role",
    [user.id, user.name || user.email || '', role]
  );
  return result.rows[0];
}
async function admin(req, res, next) {
  try {
    if (!pool) return json(res, 503, { error: 'Database Neon belum dikonfigurasi' });
    const user = await currentUser(req);
    if (!user) return json(res, 401, { error: 'Login admin diperlukan' });
    const profile = await ensureProfile(user);
    if (profile.role !== 'admin') return json(res, 403, { error: 'Akun ini belum mendapat akses admin.' });
    req.user = user;
    return next();
  } catch (error) {
    if (error.code && error.code.startsWith('ERR_JWT')) return json(res, 401, { error: 'Sesi tidak valid. Silakan masuk kembali.' });
    return next(error);
  }
}
async function graphGet(url, params) {
  const u = new URL(url);
  Object.entries(params || {}).forEach(function (pair) { u.searchParams.set(pair[0], String(pair[1])); });
  const response = await fetch(u);
  const data = await response.json();
  if (!response.ok) throw Error((data && data.error && data.error.message) || ('Meta API error ' + response.status));
  return data;
}

app.get('/api/health', async function (req, res) {
  let database = false;
  if (pool) {
    try { await pool.query('SELECT 1'); database = true; } catch (error) {}
  }
  return json(res, database ? 200 : 503, { ok: database, database: database, authConfigured: !!jwks, metaConfigured: !missing.some(function (k) { return k.startsWith('META_'); }), missing: missing });
});
app.get('/api/config', function (req, res) { return json(res, 200, { neonAuthBaseUrl: process.env.NEON_AUTH_BASE_URL || null }); });
app.get('/api/profile', async function (req, res, next) {
  try {
    if (!pool) return json(res, 503, { error: 'Database Neon belum dikonfigurasi' });
    const user = await currentUser(req);
    if (!user) return json(res, 401, { error: 'Login diperlukan' });
    const profile = await ensureProfile(user);
    return json(res, 200, { user: user, profile: profile });
  } catch (error) { return next(error); }
});
app.get('/api/brands', async function (req, res) {
  try {
    if (!pool) return json(res, 503, { error: 'Database Neon belum dikonfigurasi' });
    let isAdmin = false;
    try {
      const user = await currentUser(req);
      if (user) isAdmin = (await ensureProfile(user)).role === 'admin';
    } catch (error) {}
    const fields = isAdmin
      ? "b.id,b.name,b.short_name,b.created_at,COALESCE(json_agg(json_build_object('id',m.id,'ad_account_id',m.ad_account_id,'ad_account_name',m.ad_account_name,'last_synced_at',m.last_synced_at)) FILTER (WHERE m.id IS NOT NULL), '[]'::json) AS meta_connections"
      : "b.id,b.name,b.short_name,b.created_at,'[]'::json AS meta_connections";
    const result = await pool.query('SELECT ' + fields + ' FROM public.brands b LEFT JOIN public.meta_connections m ON m.brand_id=b.id GROUP BY b.id ORDER BY b.created_at');
    return json(res, 200, { brands: result.rows });
  } catch (error) { return json(res, 500, { error: 'Gagal memuat brand.' }); }
});
app.get('/api/dashboard', async function (req, res) {
  try {
    if (!pool) return json(res, 503, { error: 'Database Neon belum dikonfigurasi' });
    const start = req.query.start, end = req.query.end;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '') || start > end)
      return json(res, 400, { error: 'start dan end harus tanggal YYYY-MM-DD yang valid' });
    const periodDays = Math.floor((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1;
    if (periodDays > 366) return json(res, 400, { error: 'Rentang maksimal 366 hari.' });
    const previousEnd = new Date(Date.parse(start + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    const previousStart = new Date(Date.parse(start + 'T00:00:00Z') - periodDays * 86400000).toISOString().slice(0, 10);
    const sql = [
      'WITH current_metrics AS (SELECT brand_id,SUM(spend) AS spend,SUM(impressions) AS impressions,SUM(link_clicks) AS clicks FROM public.daily_metrics WHERE day BETWEEN $1::date AND $2::date GROUP BY brand_id),',
      'previous_metrics AS (SELECT brand_id,SUM(spend) AS spend,SUM(impressions) AS impressions,SUM(link_clicks) AS clicks FROM public.daily_metrics WHERE day BETWEEN $3::date AND $4::date GROUP BY brand_id),',
      'connections AS (SELECT brand_id,COUNT(*)::int AS count FROM public.meta_connections GROUP BY brand_id)',
      'SELECT b.id,b.name,b.short_name,COALESCE(c.count,0)>0 AS connected,COALESCE(cm.spend,0)::numeric AS spend,COALESCE(cm.impressions,0)::bigint AS impressions,COALESCE(cm.clicks,0)::bigint AS clicks,',
      'CASE WHEN COALESCE(cm.impressions,0)>0 THEN 100.0*COALESCE(cm.clicks,0)/cm.impressions ELSE 0 END AS ctr,',
      'CASE WHEN COALESCE(pm.impressions,0)>0 THEN 100.0*COALESCE(pm.clicks,0)/pm.impressions ELSE 0 END AS previous_ctr,',
      'CASE WHEN COALESCE(pm.impressions,0)>0 AND COALESCE(pm.clicks,0)>0 THEN 100.0*((100.0*COALESCE(cm.clicks,0)/NULLIF(cm.impressions,0))-(100.0*pm.clicks/pm.impressions))/(100.0*pm.clicks/pm.impressions) ELSE NULL END AS ctr_change_pct',
      'FROM public.brands b LEFT JOIN current_metrics cm ON cm.brand_id=b.id LEFT JOIN previous_metrics pm ON pm.brand_id=b.id LEFT JOIN connections c ON c.brand_id=b.id ORDER BY b.created_at'
    ].join(' ');
    const result = await pool.query(sql, [start, end, previousStart, previousEnd]);
    const brands = result.rows.map(function (row) {
      return Object.assign({}, row, {
        spend: Number(row.spend || 0), impressions: Number(row.impressions || 0), clicks: Number(row.clicks || 0),
        ctr: Number(row.ctr || 0), previous_ctr: Number(row.previous_ctr || 0),
        ctr_change_pct: row.ctr_change_pct === null ? null : Number(row.ctr_change_pct), website_visitors: null
      });
    });
    const totals = brands.reduce(function (a, b) { return { spend: a.spend + b.spend, clicks: a.clicks + b.clicks, impressions: a.impressions + b.impressions }; }, { spend: 0, clicks: 0, impressions: 0 });
    totals.ctr = totals.impressions ? 100 * totals.clicks / totals.impressions : 0;
    return json(res, 200, { start: start, end: end, previousStart: previousStart, previousEnd: previousEnd, brands: brands, totals: totals, note: 'Data dihitung dari akun Meta yang sudah tersambung. Pengunjung website perlu integrasi GA4.' });
  } catch (error) { console.error(error); return json(res, 500, { error: 'Gagal memuat metrik dashboard.' }); }
});
app.post('/api/brands', admin, async function (req, res) {
  const name = String(req.body.name || '').trim();
  const shortName = String(req.body.short_name || '').trim().slice(0, 3).toUpperCase();
  if (!name) return json(res, 400, { error: 'Nama brand wajib diisi' });
  try {
    const result = await pool.query('INSERT INTO public.brands (name,short_name,created_by) VALUES ($1,$2,$3) RETURNING id,name,short_name', [name, shortName, req.user.id]);
    return json(res, 201, { brand: result.rows[0] });
  } catch (error) { return json(res, 400, { error: 'Brand gagal ditambahkan.' }); }
});
app.patch('/api/brands/:id', admin, async function (req, res) {
  const name = String(req.body.name || '').trim();
  const shortName = String(req.body.short_name || '').trim().slice(0, 3).toUpperCase();
  if (!name) return json(res, 400, { error: 'Nama brand wajib diisi' });
  try {
    const result = await pool.query('UPDATE public.brands SET name=$1,short_name=$2,updated_at=now() WHERE id=$3 RETURNING id,name,short_name', [name, shortName, req.params.id]);
    return result.rows[0] ? json(res, 200, { brand: result.rows[0] }) : json(res, 404, { error: 'Brand tidak ditemukan.' });
  } catch (error) { return json(res, 400, { error: 'Brand gagal diperbarui.' }); }
});
app.delete('/api/brands/:id', admin, async function (req, res) {
  try {
    const result = await pool.query('DELETE FROM public.brands WHERE id=$1', [req.params.id]);
    return result.rowCount ? res.sendStatus(204) : json(res, 404, { error: 'Brand tidak ditemukan.' });
  } catch (error) { return json(res, 400, { error: 'Brand gagal dihapus.' }); }
});
app.get('/api/meta/connect/:brandId', admin, async function (req, res) {
  try {
    if (!process.env.META_APP_ID || !process.env.META_APP_SECRET || !graph || !process.env.META_OAUTH_REDIRECT_URI)
      return json(res, 503, { error: 'Meta App belum dikonfigurasi di Render.' });
    const exists = await pool.query('SELECT 1 FROM public.brands WHERE id=$1', [req.params.brandId]);
    if (!exists.rowCount) return json(res, 404, { error: 'Brand tidak ditemukan.' });
    const stateId = crypto.randomBytes(20).toString('hex');
    const payload = Buffer.from(JSON.stringify({ brandId: req.params.brandId, userId: req.user.id, stateId: stateId, exp: Date.now() + 600000 })).toString('base64url');
    const sig = crypto.createHmac('sha256', process.env.META_APP_SECRET).update(payload).digest('base64url');
    const redirect = new URL('https://www.facebook.com/' + graph + '/dialog/oauth');
    redirect.searchParams.set('client_id', process.env.META_APP_ID);
    redirect.searchParams.set('redirect_uri', process.env.META_OAUTH_REDIRECT_URI);
    redirect.searchParams.set('state', payload + '.' + sig);
    redirect.searchParams.set('scope', 'ads_read');
    redirect.searchParams.set('response_type', 'code');
    return json(res, 200, { url: redirect.toString() });
  } catch (error) { return json(res, 500, { error: 'Tidak bisa memulai koneksi Meta.' }); }
});
app.get('/api/meta/callback', async function (req, res) {
  try {
    if (req.query.error) return res.status(400).send('Meta login dibatalkan atau tidak mendapat izin. Silakan kembali ke dashboard.');
    const parts = String(req.query.state || '').split('.');
    if (!parts[0] || !parts[1]) return res.status(400).send('State OAuth tidak valid. Silakan mulai lagi.');
    const payload = parts[0], sig = parts[1];
    const expected = crypto.createHmac('sha256', process.env.META_APP_SECRET || '').update(payload).digest();
    const actual = Buffer.from(sig, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return res.status(400).send('State OAuth tidak valid. Silakan mulai lagi.');
    const state = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (state.exp < Date.now() || !req.query.code) return res.status(400).send('Sesi OAuth kedaluwarsa. Silakan mulai lagi.');
    const tokenData = await graphGet('https://graph.facebook.com/' + graph + '/oauth/access_token', { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, redirect_uri: process.env.META_OAUTH_REDIRECT_URI, code: req.query.code });
    let token = tokenData.access_token;
    let expires = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : null;
    try {
      const long = await graphGet('https://graph.facebook.com/' + graph + '/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, fb_exchange_token: token });
      token = long.access_token;
      expires = long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : expires;
    } catch (error) {}
    const accountData = await graphGet('https://graph.facebook.com/' + graph + '/me/adaccounts', { fields: 'id,name,account_id', limit: 200, access_token: token });
    const accounts = accountData.data || [];
    if (!accounts.length) return res.status(400).send('Tidak ada ad account yang dapat diakses. Pastikan akun Anda diberi akses di Meta Business.');
    await pool.query("INSERT INTO public.meta_oauth_pending (state_id,brand_id,connected_by,encrypted_access_token,token_expires_at,accounts,expires_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,now()+interval '10 minutes')", [state.stateId, state.brandId, state.userId, encrypt(token), expires, JSON.stringify(accounts)]);
    const options = accounts.map(function (account) {
      const id = String(account.id).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
      const name = String(account.name).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
      return '<option value="' + id + '">' + name + ' — ' + (account.account_id || account.id) + '</option>';
    }).join('');
    return res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pilih akun iklan</title><style>body{font:16px system-ui;background:#0b1018;color:#eee;max-width:600px;margin:10vh auto;padding:24px}select,button{padding:12px;width:100%;margin-top:16px;border-radius:8px}</style><h1>Pilih ad account</h1><p>Akun terpilih akan ditautkan ke brand yang dipilih.</p><form method="post" action="/api/meta/select"><input type="hidden" name="state" value="' + state.stateId + '"><select name="accountId" required>' + options + '</select><button>Simpan koneksi</button></form>');
  } catch (error) {
    console.error(error);
    return res.status(500).send('Koneksi Meta gagal. Periksa konfigurasi Meta App dan coba lagi.');
  }
});
app.post('/api/meta/select', async function (req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const query = await client.query('SELECT * FROM public.meta_oauth_pending WHERE state_id=$1 AND expires_at>now() FOR UPDATE', [req.body.state]);
    const pending = query.rows[0];
    if (!pending) { await client.query('ROLLBACK'); return res.status(400).send('Sesi pemilihan akun sudah kedaluwarsa. Hubungkan kembali Meta.'); }
    const account = (pending.accounts || []).find(function (item) { return item.id === req.body.accountId; });
    if (!account) { await client.query('ROLLBACK'); return res.status(400).send('Ad account tidak valid.'); }
    await client.query("INSERT INTO public.meta_connections (brand_id,ad_account_id,ad_account_name,encrypted_access_token,token_expires_at,connected_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (brand_id,ad_account_id) DO UPDATE SET ad_account_name=EXCLUDED.ad_account_name,encrypted_access_token=EXCLUDED.encrypted_access_token,token_expires_at=EXCLUDED.token_expires_at,connected_by=EXCLUDED.connected_by", [pending.brand_id, account.id, account.name || account.id, pending.encrypted_access_token, pending.token_expires_at, pending.connected_by]);
    await client.query('DELETE FROM public.meta_oauth_pending WHERE state_id=$1', [req.body.state]);
    await client.query('COMMIT');
    return res.type('html').send('<!doctype html><meta charset="utf-8"><h2>Akun iklan tersambung</h2><p>Tutup halaman ini, lalu muat ulang dashboard.</p>');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    return res.status(500).send('Gagal menyimpan koneksi Meta.');
  } finally { client.release(); }
});

const staticDir = path.resolve(__dirname, '../dist');
app.use(express.static(staticDir));
app.use(function (req, res) { return res.sendFile(path.join(staticDir, 'index.html')); });
app.use(function (error, req, res, next) {
  console.error(error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: 'Terjadi kesalahan server.' });
});
const port = Number(process.env.PORT || 10000);
const server = app.listen(port, function () { console.log('LeadMarket Ads API listening on ' + port + '; database ' + (pool ? 'configured' : 'missing')); });
async function shutdown() { server.close(async function () { if (pool) await pool.end(); process.exit(0); }); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
