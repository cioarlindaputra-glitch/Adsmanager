# LeadMarket Meta Ads Insight

Dashboard multi-brand untuk melihat spend, klik, CTR, perbandingan periode, dan koneksi akun Meta. Guest dapat melihat ringkasan; pengelolaan brand dan koneksi Meta memerlukan admin.

## Stack

- Frontend: HTML/CSS/JavaScript dengan Vite.
- Auth: Neon Managed Better Auth, email/password dan Google.
- Database: Neon Postgres.
- Hosting: Render Web Service.

## Neon

1. Aktifkan Neon Auth pada branch yang digunakan aplikasi.
2. Jalankan neon/migrations/001_core.sql pada database yang sama. File ini sudah diterapkan pada project Neon Ads Manager.
3. Buat role aplikasi dengan akses read_write hanya pada schema public.
4. Atur DATABASE_URL, NEON_AUTH_BASE_URL, dan NEON_AUTH_JWKS_URL sebagai environment variables pada server.
5. Set ADMIN_EMAIL ke alamat email yang digunakan pemilik dashboard. Email ini akan mendapat role admin pada login pertama.

Google OAuth shared milik Neon disediakan untuk development. Untuk penggunaan production, daftarkan OAuth client Google sendiri dan atur callback/domain sesuai Neon Auth. Neon Auth saat ini tidak menyediakan login langsung dengan nomor telepon; gunakan email/password atau Google.

## Render

Blueprint hanya membuat Web Service di paket Free. Isi environment variables dari .env.example pada Render. Render memberi URL layanan setelah service dibuat; masukkan URL tersebut sebagai APP_ORIGIN, domain terpercaya Neon Auth, dan callback Meta.

Render Free dapat menghentikan service saat tidak aktif. Untuk data Meta yang selalu baru, jalankan npm run sync terjadwal dari runner lain atau tambahkan Render Cron berbayar. Meta App harus dibuat dan dikonfigurasi terlebih dahulu.

## Meta Ads

1. Buat Meta App dan aktifkan Facebook Login serta Marketing API.
2. Tambahkan callback persis: https://<render-service>.onrender.com/api/meta/callback.
3. Atur META_APP_ID, META_APP_SECRET, META_GRAPH_VERSION, META_TOKEN_ENCRYPTION_KEY (64 digit hex), dan META_OAUTH_REDIRECT_URI di Render.
4. Masuk admin, buat brand, pilih Sambungkan Meta, beri izin ads_read, lalu pilih ad account.

Token iklan disimpan terenkripsi AES-256-GCM di server. Jangan simpan connection string, token Meta, atau app secret di GitHub.

## Lokal

Salin .env.example menjadi .env, jalankan npm install, npm run build, lalu npm start.
