ALTER TABLE public.instagram_daily_metrics
  ADD COLUMN IF NOT EXISTS profile_links_taps bigint NOT NULL DEFAULT 0;
