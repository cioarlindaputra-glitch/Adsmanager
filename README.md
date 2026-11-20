# LeadMarket Meta Ads Insight

Backend starter untuk dashboard multi-brand dengan Supabase Auth/Postgres, Meta Marketing API read-only, dan Render web + scheduled sync. Dashboard publik hanya membaca ringkasan yang sudah disanitasi; manajemen brand dan koneksi memerlukan admin.

## Sebelum deploy

1. Buat project Supabase dan jalankan `supabase/migrations/001_core.sql` di SQL Editor.
2. Daftarkan akun pemilik melalui Supabase Auth (Google OAuth dan email/password diaktifkan dari Supabase). Akun baru menjadi `viewer`; setelah itu ubah akun pemilik menjadi admin dengan query komentar di bagian bawah migrasi.
3. Di Meta for Developers, buat app dan aktifkan Facebook Login serta Marketing API. Tambahkan URL callback persis sebagai OAuth redirect URI: `https://YOUR-RENDER-SERVICE.onrender.com/api/meta/callback`. Minta izin `ads_read`; izin/akses produk dan review Meta dapat diperlukan sebelum akun klien di luar developer app dapat dipakai.
4. Letakkan isi folder aplikasi ini di root repository GitHub yang dipilih (termasuk `render.yaml`), lalu hubungkan repository itu ke Render dan pilih deploy Blueprint.
5. Isi environment variables di Render dari `.env.example`. Jangan commit file `.env`, service-role key, Meta App Secret, atau token. `META_TOKEN_ENCRYPTION_KEY` harus 64 karakter hex (32 byte), `META_GRAPH_VERSION` harus versi Graph API yang aktif dan tersedia untuk Meta App Anda.
6. Setelah layanan hidup, buat/ubah brand lewat panel admin dan sambungkan tiap ad account. Scheduled sync harian berjalan dari Render Cron. Endpoint `/api/dashboard?start=YYYY-MM-DD&end=YYYY-MM-DD` dapat dilihat guest.

## Auth dan data

- Google login, email/password, dan nomor telepon/password ditangani Supabase Auth. Provider/OTP dan redirect domain diatur di Supabase Dashboard.
- Setiap user baru bukan admin sampai dipromosikan secara manual.
- Token Meta dienkripsi AES-256-GCM sebelum disimpan. Hak baca laporan memakai `ads_read`; app tidak mengubah campaign.
- CTR = link clicks ÷ impressions. Website visitors dikirim `null` dengan catatan sampai GA4 dipasang; clicks Meta tidak dianggap sama dengan pengunjung website.
- Instagram organic insights belum diambil oleh sync ini. Diperlukan akun Instagram Professional dan izin/endpoint tambahan.

## Lokal

```sh
cp .env.example .env
npm install
npm start
```
