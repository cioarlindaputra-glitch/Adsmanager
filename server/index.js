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

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, function (char) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
  });
}

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
async function instagramTokenPost(fields) {
  const body = new URLSearchParams();
  Object.entries(fields).forEach(function (pair) { body.set(pair[0], String(pair[1])); });
  const response = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body });
  const data = await response.json();
  if (!response.ok) throw Error((data && (data.error_message || data.error_description || data.message)) || ('Instagram token exchange gagal (' + response.status + ')'));
  return Array.isArray(data.data) ? data.data[0] : data;
}
async function completeInstagramDirectOAuth(state, code) {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  const redirectUri = process.env.META_OAUTH_REDIRECT_URI;
  const shortToken = await instagramTokenPost({ client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: code });
  if (!shortToken || !shortToken.access_token) throw Error('Instagram tidak mengembalikan access token.');
  const longToken = await graphGet('https://graph.instagram.com/access_token', { grant_type: 'ig_exchange_token', client_secret: appSecret, access_token: shortToken.access_token });
  const accessToken = longToken.access_token || shortToken.access_token;
  const profile = await graphGet('https://graph.instagram.com/' + graph + '/me', { fields: 'id,username,account_type', access_token: accessToken });
  const igUserId = String(profile.id || shortToken.user_id || '');
  if (!igUserId) throw Error('ID akun Instagram tidak ditemukan.');
  const expires = longToken.expires_in ? new Date(Date.now() + Number(longToken.expires_in) * 1000).toISOString() : null;
  await pool.query(
    "INSERT INTO public.instagram_connections (brand_id,social_brand_id,ig_user_id,ig_username,page_id,page_name,encrypted_access_token,token_expires_at,connected_by,auth_provider) VALUES (NULL,$1,$2,$3,'','',$4,$5,$6,'instagram') ON CONFLICT (social_brand_id,ig_user_id) DO UPDATE SET ig_username=EXCLUDED.ig_username,page_id='',page_name='',encrypted_access_token=EXCLUDED.encrypted_access_token,token_expires_at=EXCLUDED.token_expires_at,connected_by=EXCLUDED.connected_by,auth_provider='instagram',last_synced_at=NULL",
    [state.socialBrandId, igUserId, String(profile.username || igUserId), encrypt(accessToken), expires, state.userId]
  );
  const origin = String(process.env.APP_ORIGIN || '/').replace(/&/g, '&amp;').replace(/\"/g, '&quot;');
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Instagram tersambung</title><style>body{font:16px system-ui;background:#0b1018;color:#eee;max-width:600px;margin:10vh auto;padding:24px}a{color:#c4f36b}</style><h2>Akun Instagram @' + htmlEscape(profile.username || igUserId) + ' berhasil tersambung.</h2><p>Tutup halaman ini atau kembali ke dashboard untuk memuat insight.</p><p><a href="' + origin + '">Kembali ke dashboard</a></p>';
}

let nextMetaSyncAt = 0;
function decrypt(value) {
  const parts = String(value || '').split('.');
  if (!tokenKey || parts.length !== 3) throw Error('Meta token encryption data is invalid');
  const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey, Buffer.from(parts[0], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
}
async function syncStaleMetaConnections() {
  if (!pool || !tokenKey || Date.now() < nextMetaSyncAt) return;
  nextMetaSyncAt = Date.now() + 15 * 60 * 1000;
  const result = await pool.query("SELECT id,brand_id,ad_account_id,encrypted_access_token FROM public.meta_connections WHERE last_synced_at IS NULL OR last_synced_at < now()-interval '15 minutes'");
  const until = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10);
  for (const connection of result.rows) {
    try {
      const accessToken = decrypt(connection.encrypted_access_token);
      let url = new URL('https://graph.facebook.com/' + graph + '/' + connection.ad_account_id + '/insights');
      url.searchParams.set('fields', 'date_start,spend,impressions,inline_link_clicks,reach,actions');
      url.searchParams.set('time_range', JSON.stringify({ since: since, until: until }));
      url.searchParams.set('time_increment', '1');
      url.searchParams.set('limit', '500');
      url.searchParams.set('access_token', accessToken);
      while (url) {
        const body = await graphGet(url.toString());
        for (const metric of body.data || []) {
          await pool.query(
            'INSERT INTO public.daily_metrics (brand_id,connection_id,day,spend,impressions,link_clicks,reach,inline_link_clicks,raw_actions,fetched_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,now()) ON CONFLICT (connection_id,day) DO UPDATE SET spend=EXCLUDED.spend,impressions=EXCLUDED.impressions,link_clicks=EXCLUDED.link_clicks,reach=EXCLUDED.reach,inline_link_clicks=EXCLUDED.inline_link_clicks,raw_actions=EXCLUDED.raw_actions,fetched_at=now()',
            [connection.brand_id, connection.id, metric.date_start, Number(metric.spend || 0), Number(metric.impressions || 0), Number(metric.inline_link_clicks || 0), Number(metric.reach || 0), Number(metric.inline_link_clicks || 0), JSON.stringify(metric.actions || [])]
          );
        }
        url = body.paging && body.paging.next ? new URL(body.paging.next) : null;
      }
      await pool.query('UPDATE public.meta_connections SET last_synced_at=now() WHERE id=$1', [connection.id]);
      console.log('Synced Meta insights for ' + connection.ad_account_id);
    } catch (error) {
      console.error('Meta insights sync failed for ' + connection.ad_account_id + ':', error.message);
    }
  }
}


let nextInstagramSyncAt = 0;
async function syncInstagramConnections() {
  if (!pool || !tokenKey || Date.now() < nextInstagramSyncAt) return;
  nextInstagramSyncAt = Date.now() + 15 * 60 * 1000;
  const result = await pool.query("SELECT id,brand_id,ig_user_id,encrypted_access_token,auth_provider,token_expires_at FROM public.instagram_connections WHERE last_synced_at IS NULL OR last_synced_at < now()-interval '15 minutes'");
  const untilDate = new Date().toISOString().slice(0, 10);
  const sinceDate = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const since = Math.floor(Date.parse(sinceDate + 'T00:00:00Z') / 1000);
  const until = Math.floor(Date.parse(untilDate + 'T00:00:00Z') / 1000) + 86400;
  for (const connection of result.rows) {
    try {
      let accessToken = decrypt(connection.encrypted_access_token);
      if (connection.auth_provider === 'instagram' && connection.token_expires_at && new Date(connection.token_expires_at).getTime() < Date.now() + 14 * 86400000) {
        const refreshed = await graphGet('https://graph.instagram.com/refresh_access_token', { grant_type: 'ig_refresh_token', access_token: accessToken });
        accessToken = refreshed.access_token || accessToken;
        const expiry = refreshed.expires_in ? new Date(Date.now() + Number(refreshed.expires_in) * 1000).toISOString() : connection.token_expires_at;
        await pool.query('UPDATE public.instagram_connections SET encrypted_access_token=$1,token_expires_at=$2 WHERE id=$3', [encrypt(accessToken), expiry, connection.id]);
      }
      const host = connection.auth_provider === 'instagram' ? 'https://graph.instagram.com/' : 'https://graph.facebook.com/';
      const byDay = new Map();
      for (const metricName of ['reach', 'total_interactions']) {
        const body = await graphGet(host + graph + '/' + connection.ig_user_id + '/insights', {
          metric: metricName, period: 'day', since: since, until: until, access_token: accessToken
        });
        for (const metric of body.data || []) {
          const column = metric.name === 'reach' ? 'reach' : 'interactions';
          for (const point of metric.values || []) {
            const day = point.end_time ? new Date(point.end_time).toISOString().slice(0, 10) : untilDate;
            if (!byDay.has(day)) byDay.set(day, { reach: 0, interactions: 0 });
            byDay.get(day)[column] = Number(point.value || 0);
          }
        }
      }
      for (const [day, values] of byDay) {
        await pool.query(
          'INSERT INTO public.instagram_daily_metrics (brand_id,connection_id,day,reach,interactions,fetched_at) VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (connection_id,day) DO UPDATE SET reach=EXCLUDED.reach,interactions=EXCLUDED.interactions,fetched_at=now()',
          [connection.brand_id, connection.id, day, values.reach, values.interactions]
        );
      }
      await pool.query('UPDATE public.instagram_connections SET last_synced_at=now() WHERE id=$1', [connection.id]);
      console.log('Synced Instagram insights for ' + connection.ig_user_id);
    } catch (error) {
      console.error('Instagram insights sync failed for ' + connection.ig_user_id + ':', error.message);
    }
  }
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
    try {
      const user = await currentUser(req);
      if (user && (await ensureProfile(user)).role === 'admin') await syncStaleMetaConnections();
    } catch (syncError) { console.error('Dashboard Meta sync check failed:', syncError.message); }
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

app.get('/api/social-brands', async function (req, res) {
  try {
    if (!pool) return json(res, 503, { error: 'Database Neon belum dikonfigurasi' });
    const result = await pool.query('SELECT id,name,short_name,created_at FROM public.social_brands ORDER BY created_at');
    return json(res, 200, { brands: result.rows });
  } catch (error) { console.error(error); return json(res, 500, { error: 'Gagal memuat brand sosial.' }); }
});
app.post('/api/social-brands', admin, async function (req, res) {
  const name = String(req.body.name || '').trim();
  const shortName = String(req.body.short_name || name.slice(0, 3)).trim().slice(0, 3).toUpperCase();
  if (!name) return json(res, 400, { error: 'Nama brand sosial wajib diisi.' });
  try {
    const result = await pool.query('INSERT INTO public.social_brands (name,short_name,created_by) VALUES ($1,$2,$3) RETURNING id,name,short_name', [name, shortName, req.user.id]);
    return json(res, 201, { brand: result.rows[0] });
  } catch (error) { return json(res, 400, { error: 'Brand sosial gagal ditambahkan.' }); }
});
app.patch('/api/social-brands/:id', admin, async function (req, res) {
  const name = String(req.body.name || '').trim();
  const shortName = String(req.body.short_name || name.slice(0, 3)).trim().slice(0, 3).toUpperCase();
  if (!name) return json(res, 400, { error: 'Nama brand sosial wajib diisi.' });
  try {
    const result = await pool.query('UPDATE public.social_brands SET name=$1,short_name=$2,updated_at=now() WHERE id=$3 RETURNING id,name,short_name', [name, shortName, req.params.id]);
    return result.rows[0] ? json(res, 200, { brand: result.rows[0] }) : json(res, 404, { error: 'Brand sosial tidak ditemukan.' });
  } catch (error) { return json(res, 400, { error: 'Brand sosial gagal diperbarui.' }); }
});
app.delete('/api/social-brands/:id', admin, async function (req, res) {
  try {
    const result = await pool.query('DELETE FROM public.social_brands WHERE id=$1', [req.params.id]);
    return result.rowCount ? res.sendStatus(204) : json(res, 404, { error: 'Brand sosial tidak ditemukan.' });
  } catch (error) { return json(res, 400, { error: 'Brand sosial gagal dihapus.' }); }
});
app.get('/api/social', async function (req, res) {
  try {
    if (!pool) return json(res, 503, { error: 'Database Neon belum dikonfigurasi' });
    try {
      const user = await currentUser(req);
      if (user && (await ensureProfile(user)).role === 'admin') await syncInstagramConnections();
    } catch (syncError) { console.error('Instagram sync check failed:', syncError.message); }
    const end = req.query.end;
    const start = req.query.start;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '') || start > end)
      return json(res, 400, { error: 'start dan end harus tanggal YYYY-MM-DD yang valid' });
    const result = await pool.query(
      "SELECT b.id,b.name,b.short_name,COALESCE(bool_or(c.id IS NOT NULL),false) AS connected, " +
      "CASE WHEN COUNT(m.id)>0 THEN SUM(m.reach)::bigint ELSE NULL END AS reach, " +
      "CASE WHEN COUNT(m.id)>0 THEN SUM(m.interactions)::bigint ELSE NULL END AS interactions, " +
      "CASE WHEN COUNT(m.id)>0 AND SUM(m.reach)>0 THEN 100.0*SUM(m.interactions)/SUM(m.reach) ELSE NULL END AS engagement_pct, " +
      "MAX(c.ig_username) AS instagram_username,MAX(c.last_synced_at) AS last_synced_at " +
      "FROM public.social_brands b LEFT JOIN public.instagram_connections c ON c.social_brand_id=b.id " +
      "LEFT JOIN public.instagram_daily_metrics m ON m.connection_id=c.id AND m.day BETWEEN $1::date AND $2::date " +
      "GROUP BY b.id ORDER BY b.created_at",
      [start, end]
    );
    const brands = result.rows.map(function (row) {
      return Object.assign({}, row, {
        reach: row.reach === null ? null : Number(row.reach),
        interactions: row.interactions === null ? null : Number(row.interactions),
        engagement_pct: row.engagement_pct === null ? null : Number(row.engagement_pct)
      });
    });
    return json(res, 200, { start: start, end: end, brands: brands });
  } catch (error) {
    console.error('Instagram social metrics failed:', error);
    return json(res, 500, { error: 'Gagal memuat insight Instagram.' });
  }
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

app.get('/api/instagram/connect/:brandId', admin, async function (req, res) {
  try {
    if (!process.env.META_APP_ID || !process.env.META_APP_SECRET || !process.env.INSTAGRAM_UNIFIED_CONFIG_ID || !graph || !process.env.META_OAUTH_REDIRECT_URI)
      return json(res, 503, { error: 'Instagram Unified Login belum dikonfigurasi. Pastikan INSTAGRAM_UNIFIED_CONFIG_ID tersedia di Render.' });
    const exists = await pool.query('SELECT 1 FROM public.social_brands WHERE id=$1', [req.params.brandId]);
    if (!exists.rowCount) return json(res, 404, { error: 'Brand sosial tidak ditemukan.' });
    const stateId = crypto.randomBytes(20).toString('hex');
    const payload = Buffer.from(JSON.stringify({ socialBrandId: req.params.brandId, userId: req.user.id, stateId: stateId, integration: 'instagram_unified', exp: Date.now() + 600000 })).toString('base64url');
    const sig = crypto.createHmac('sha256', process.env.META_APP_SECRET).update(payload).digest('base64url');
    const redirect = new URL('https://www.facebook.com/' + graph + '/dialog/oauth');
    redirect.searchParams.set('client_id', process.env.META_APP_ID);
    redirect.searchParams.set('redirect_uri', process.env.META_OAUTH_REDIRECT_URI);
    redirect.searchParams.set('state', payload + '.' + sig);
    redirect.searchParams.set('config_id', process.env.INSTAGRAM_UNIFIED_CONFIG_ID);
    redirect.searchParams.set('response_type', 'code');
    return json(res, 200, { url: redirect.toString() });
  } catch (error) {
    console.error('Instagram OAuth start failed:', error);
    return json(res, 500, { error: 'Tidak bisa memulai koneksi Instagram.' });
  }
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
    if (state.integration === 'instagram_unified') {
      try {
        const tokenData = await graphGet('https://graph.facebook.com/' + graph + '/oauth/access_token', {
          client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, code: String(req.query.code)
        });
        if (!tokenData.access_token) throw Error('Meta tidak mengembalikan access token.');
        const token = tokenData.access_token;
        const accountData = await graphGet('https://graph.facebook.com/' + graph + '/me/assigned_instagram_accounts', {
          fields: 'id,username,account_type', access_token: token, limit: 200
        });
        const accounts = (accountData.data || []).map(function (account) {
          return { id: String(account.id), username: String(account.username || account.id), account_type: String(account.account_type || 'PROFESSIONAL'), page_id: '', page_name: '', auth_provider: 'unified' };
        });
        if (!accounts.length) return res.status(400).send('Tidak ada akun Instagram yang diberikan ke konfigurasi ini. Periksa Business Portfolio dan aset Instagram yang dipilih.');
        await pool.query("INSERT INTO public.meta_oauth_pending (state_id,brand_id,social_brand_id,connected_by,encrypted_access_token,token_expires_at,accounts,expires_at) VALUES ($1,NULL,$2,$3,$4,NULL,$5::jsonb,now()+interval '10 minutes')", [state.stateId, state.socialBrandId, state.userId, encrypt(token), JSON.stringify(accounts)]);
        const options = accounts.map(function (account) {
          return '<option value="' + htmlEscape(account.id) + '">' + htmlEscape('@' + account.username) + '</option>';
        }).join('');
        return res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pilih Instagram</title><style>body{font:16px system-ui;background:#0b1018;color:#eee;max-width:600px;margin:10vh auto;padding:24px}select,button{padding:12px;width:100%;margin-top:16px;border-radius:8px}</style><h1>Pilih akun Instagram</h1><p>Akun terpilih akan ditautkan ke brand yang dipilih.</p><form method="post" action="/api/instagram/select"><input type="hidden" name="state" value="' + htmlEscape(state.stateId) + '"><select name="accountId" required>' + options + '</select><button>Simpan koneksi</button></form>');
      } catch (error) {
        console.error('Instagram Unified Login callback failed:', error.message);
        return res.status(400).send('Koneksi Instagram gagal. Pastikan konfigurasi Unified Login, redirect URI, dan izin Instagram sudah sesuai.');
      }
    }
    if (state.integration === 'instagram_direct') {
      try {
        const page = await completeInstagramDirectOAuth(state, String(req.query.code));
        return res.type('html').send(page);
      } catch (error) {
        console.error('Direct Instagram OAuth callback failed:', error.message);
        return res.status(400).send('Koneksi Instagram langsung gagal. Pastikan Instagram API with Instagram Login dan izin insights sudah aktif di Meta App, lalu coba lagi.');
      }
    }
    const tokenData = await graphGet('https://graph.facebook.com/' + graph + '/oauth/access_token', { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, redirect_uri: process.env.META_OAUTH_REDIRECT_URI, code: req.query.code });
    let token = tokenData.access_token;
    let expires = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : null;
    try {
      const long = await graphGet('https://graph.facebook.com/' + graph + '/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, fb_exchange_token: token });
      token = long.access_token;
      expires = long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : expires;
    } catch (error) {}

    if (state.integration === 'instagram') {
      const pageData = await graphGet('https://graph.facebook.com/' + graph + '/me/accounts', {
        fields: 'id,name,instagram_business_account{id,username}',
        limit: 200,
        access_token: token
      });
      const accounts = [];
      for (const page of pageData.data || []) {
        const ig = page.instagram_business_account;
        if (!ig || !ig.id) continue;
        accounts.push({
          id: String(ig.id),
          username: String(ig.username || ig.id),
          page_id: String(page.id),
          page_name: String(page.name || page.id)
        });
      }
      if (!accounts.length) return res.status(400).send('Tidak ada akun Instagram Professional yang terhubung ke Facebook Page yang dapat diakses. Pastikan akun IG terhubung ke Page dan berikan izin yang diminta.');
      await pool.query("INSERT INTO public.meta_oauth_pending (state_id,brand_id,social_brand_id,connected_by,encrypted_access_token,token_expires_at,accounts,expires_at) VALUES ($1,NULL,$2,$3,$4,$5,$6::jsonb,now()+interval '10 minutes')", [state.stateId, state.socialBrandId, state.userId, encrypt(token), expires, JSON.stringify(accounts)]);
      const options = accounts.map(function (account) {
        return '<option value="' + htmlEscape(account.id) + '">' + htmlEscape('@' + account.username + ' — ' + account.page_name) + '</option>';
      }).join('');
      return res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pilih Instagram</title><style>body{font:16px system-ui;background:#0b1018;color:#eee;max-width:600px;margin:10vh auto;padding:24px}select,button{padding:12px;width:100%;margin-top:16px;border-radius:8px}</style><h1>Pilih akun Instagram</h1><p>Akun terpilih akan ditautkan ke brand yang dipilih.</p><form method="post" action="/api/instagram/select"><input type="hidden" name="state" value="' + htmlEscape(state.stateId) + '"><select name="accountId" required>' + options + '</select><button>Simpan koneksi</button></form>');
    }

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


app.post('/api/instagram/select', async function (req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const query = await client.query("SELECT * FROM public.meta_oauth_pending WHERE state_id=$1 AND expires_at>now() FOR UPDATE", [req.body.state]);
    const pending = query.rows[0];
    if (!pending) { await client.query('ROLLBACK'); return res.status(400).send('Sesi pemilihan Instagram sudah kedaluwarsa. Sambungkan kembali.'); }
    const account = (pending.accounts || []).find(function (item) { return item.id === String(req.body.accountId); });
    if (!account) { await client.query('ROLLBACK'); return res.status(400).send('Akun Instagram tidak valid.'); }
    await client.query(
      "INSERT INTO public.instagram_connections (brand_id,social_brand_id,ig_user_id,ig_username,page_id,page_name,encrypted_access_token,token_expires_at,connected_by,auth_provider) VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (social_brand_id,ig_user_id) DO UPDATE SET ig_username=EXCLUDED.ig_username,page_id=EXCLUDED.page_id,page_name=EXCLUDED.page_name,encrypted_access_token=EXCLUDED.encrypted_access_token,token_expires_at=EXCLUDED.token_expires_at,connected_by=EXCLUDED.connected_by,auth_provider=EXCLUDED.auth_provider,last_synced_at=NULL",
      [pending.social_brand_id, account.id, account.username, account.page_id || '', account.page_name || '', pending.encrypted_access_token, pending.token_expires_at, pending.connected_by, account.auth_provider || 'facebook']
    );
    await client.query('DELETE FROM public.meta_oauth_pending WHERE state_id=$1', [req.body.state]);
    await client.query('COMMIT');
    const origin = String(process.env.APP_ORIGIN || '/').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Instagram tersambung</title><style>body{font:16px system-ui;background:#0b1018;color:#eee;max-width:600px;margin:10vh auto;padding:24px}a{color:#c4f36b}</style><h2>Akun Instagram berhasil tersambung.</h2><p>Tutup halaman ini atau kembali ke dashboard untuk memuat insight.</p><p><a href="' + origin + '">Kembali ke dashboard</a></p>');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Instagram connection save failed:', error);
    return res.status(500).send('Gagal menyimpan koneksi Instagram.');
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
