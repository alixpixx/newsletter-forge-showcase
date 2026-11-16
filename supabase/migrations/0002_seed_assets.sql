-- newsletter-forge · seed des 9 marques (registre packages/config/assets.ts)
-- Idempotent (on conflict do nothing). Quartz Tips déjà seedé en 0001.
insert into newsletter.asset (slug, name, market, languages, sending_subdomain) values
  ('atlas-review',      'Atlas Review',      'INT', '{it,fr,pt-BR,es,en}', 'news.atlas-review-shop.example'),
  ('harbor-tech',         'Harbor Tech',         'GB',  '{en,it,es,sv}',       'news.harbor-tech.example'),
  ('copper-kettle',      'Copper Kettle',      'CL',  '{es}',                'news.copper-kettle.example'),
  ('goalpost-weekly', 'Goalpost Weekly', 'GB',  '{en}',                'news.goalpost-weekly-parked.example'),
  ('northwind-sports',            'Northwind Sports',            'BR',  '{pt-BR}',             'news.northwind-sports.example'),
  ('lumen-living',          'Lumen Living',          'BR',  '{pt-BR}',             'news.lumen-living.example'),
  ('pixel-daily',     'Pixel Daily',     'BR',  '{pt-BR}',             'news.pixel-daily.example'),
  ('bluefin-news',                'Bluefin News',                'BR',  '{pt-BR}',             'news.bluefin-news.example')
on conflict (slug) do nothing;
