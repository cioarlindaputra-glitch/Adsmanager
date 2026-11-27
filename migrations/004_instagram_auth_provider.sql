ALTER TABLE public.instagram_connections ADD COLUMN IF NOT EXISTS auth_provider text NOT NULL DEFAULT 'facebook';
