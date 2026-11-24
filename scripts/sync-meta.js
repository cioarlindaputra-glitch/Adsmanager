import crypto from 'node:crypto';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
function decrypt(value) {
  const parts = value.split('.');
  const key = Buffer.from(process.env.META_TOKEN_ENCRYPTION_KEY || '', 'hex');
  if (key.length !== 32) throw Error('META_TOKEN_ENCRYPTION_KEY harus berupa 64 karakter hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
}
async function main() {
  for (const name of ['DATABASE_URL', 'META_GRAPH_VERSION', 'META_TOKEN_ENCRYPTION_KEY']) {
    if (!process.env[name]) throw Error(name + ' belum diatur');
  }
  const { rows: connections } = await pool.query('SELECT id,brand_id,ad_account_id,encrypted_access_token FROM public.meta_connections');
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const until = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  for (const connection of connections) {
    const token = decrypt(connection.encrypted_access_token);
    let url = new URL('https://graph.facebook.com/' + process.env.META_GRAPH_VERSION + '/' + connection.ad_account_id + '/insights');
    url.searchParams.set('fields', 'date_start,spend,impressions,inline_link_clicks,reach,actions');
    url.searchParams.set('time_range', JSON.stringify({ since: since, until: until }));
    url.searchParams.set('time_increment', '1');
    url.searchParams.set('limit', '500');
    url.searchParams.set('access_token', token);
    while (url) {
      const response = await fetch(url);
      const body = await response.json();
      if (!response.ok) throw Error('Meta ' + connection.ad_account_id + ': ' + (body.error && body.error.message || response.status));
      for (const metric of body.data || []) {
        await pool.query(
          'INSERT INTO public.daily_metrics (brand_id,connection_id,day,spend,impressions,link_clicks,reach,inline_link_clicks,raw_actions,fetched_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,now()) ON CONFLICT (connection_id,day) DO UPDATE SET spend=EXCLUDED.spend,impressions=EXCLUDED.impressions,link_clicks=EXCLUDED.link_clicks,reach=EXCLUDED.reach,inline_link_clicks=EXCLUDED.inline_link_clicks,raw_actions=EXCLUDED.raw_actions,fetched_at=now()',
          [connection.brand_id, connection.id, metric.date_start, Number(metric.spend || 0), Number(metric.impressions || 0), Number(metric.inline_link_clicks || 0), Number(metric.reach || 0), Number(metric.inline_link_clicks || 0), JSON.stringify(metric.actions || [])]
        );
      }
      url = body.paging && body.paging.next ? new URL(body.paging.next) : null;
    }
    await pool.query('UPDATE public.meta_connections SET last_synced_at=now() WHERE id=$1', [connection.id]);
    console.log('Synced ' + connection.ad_account_id);
  }
}
main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
}).finally(async function () {
  await pool.end();
});
