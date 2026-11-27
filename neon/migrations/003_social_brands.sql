CREATE TABLE IF NOT EXISTS public.social_brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  short_name text NOT NULL DEFAULT '',
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Keep any existing Instagram connections while separating social brands from ads brands.
INSERT INTO public.social_brands (id,name,short_name,created_by,created_at,updated_at)
SELECT DISTINCT b.id,b.name,b.short_name,b.created_by,b.created_at,b.updated_at
FROM public.brands b
JOIN public.instagram_connections c ON c.brand_id=b.id
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.instagram_connections
  ADD COLUMN IF NOT EXISTS social_brand_id uuid REFERENCES public.social_brands(id) ON DELETE CASCADE;
UPDATE public.instagram_connections
SET social_brand_id=brand_id
WHERE social_brand_id IS NULL AND brand_id IS NOT NULL;
ALTER TABLE public.instagram_connections ALTER COLUMN brand_id DROP NOT NULL;
ALTER TABLE public.instagram_connections ALTER COLUMN social_brand_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS instagram_connections_social_brand_account_uq
  ON public.instagram_connections(social_brand_id,ig_user_id);

ALTER TABLE public.meta_oauth_pending
  ADD COLUMN IF NOT EXISTS social_brand_id uuid REFERENCES public.social_brands(id) ON DELETE CASCADE;
ALTER TABLE public.meta_oauth_pending ALTER COLUMN brand_id DROP NOT NULL;

ALTER TABLE public.instagram_daily_metrics ALTER COLUMN brand_id DROP NOT NULL;
