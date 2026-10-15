-- Eksport av dagens pristabeller (public) som én JSON.
-- Kjør i Supabase → SQL Editor. Kun lesing.
-- Lagre resultatet som data/export/pristabeller.json (mappen er gitignored).
select jsonb_pretty(jsonb_build_object(
  'exported_at', now(),
  'teams',                              (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select id, name from public.teams) x),
  'installer_groups',                   (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.installer_groups x),
  'suppliers',                          (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.suppliers x),
  'product_categories',                 (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.product_categories x),
  'product_subcategories',              (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.product_subcategories x),
  'products',                           (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.products x),
  'supplier_categories',                (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.supplier_categories x),
  'roof_types',                         (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.roof_types x),
  'mount_items',                        (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.mount_items x),
  'mount_volume_reduction',             (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.mount_volume_reduction x),
  'electrical_installation_categories', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.electrical_installation_categories x),
  'electrical_installation_items',      (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.electrical_installation_items x),
  'team_commission',                    (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.team_commission x),
  'work_items',                         (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.work_items x),
  'solarpanels',                        (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.solarpanels x),
  'commissions',                        (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.commissions x)
)) as export;
