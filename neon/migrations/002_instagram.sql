CREATE TABLE public.instagram_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  ig_user_id text NOT NULL,
  ig_username text NOT NULL DEFAULT '',
  page_id text NOT NULL DEFAULT '',
  page_name text NOT NULL DEFAULT '',
  encrypted_access_token text NOT NULL,
  token_expires_at timestamptz,
  connected_by uuid REFERENCES public.profiles(id),
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, ig_user_id)
);

CREATE TABLE public.instagram_daily_metrics (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_id uuid NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.instagram_connections(id) ON DELETE CASCADE,
  day date NOT NULL,
  reach bigint NOT NULL DEFAULT 0,
  profile_views bigint NOT NULL DEFAULT 0,
  interactions bigint NOT NULL DEFAULT 0,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, day)
);

CREATE INDEX instagram_daily_metrics_brand_day_idx
  ON public.instagram_daily_metrics(brand_id, day DESC);
