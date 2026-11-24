CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES neon_auth."user"(id) ON DELETE CASCADE,
  display_name text,
  role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  short_name text NOT NULL DEFAULT '',
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.meta_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  ad_account_id text NOT NULL,
  ad_account_name text NOT NULL,
  encrypted_access_token text NOT NULL,
  token_expires_at timestamptz,
  connected_by uuid REFERENCES public.profiles(id),
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, ad_account_id)
);

CREATE TABLE public.meta_oauth_pending (
  state_id text PRIMARY KEY,
  brand_id uuid NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  connected_by uuid NOT NULL REFERENCES public.profiles(id),
  encrypted_access_token text NOT NULL,
  token_expires_at timestamptz,
  accounts jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE public.daily_metrics (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_id uuid NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.meta_connections(id) ON DELETE CASCADE,
  day date NOT NULL,
  spend numeric(14,2) NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  link_clicks bigint NOT NULL DEFAULT 0,
  reach bigint NOT NULL DEFAULT 0,
  inline_link_clicks bigint NOT NULL DEFAULT 0,
  raw_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, day)
);

CREATE INDEX daily_metrics_brand_day_idx ON public.daily_metrics(brand_id, day DESC);
