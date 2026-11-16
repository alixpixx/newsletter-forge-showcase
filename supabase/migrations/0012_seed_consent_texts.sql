-- C6 : seed des VRAIS textes de consentement (kit legal Example Media par pays) dans consent_version.
-- Texte primaire (autorisation unique énumérée) par régime/langue de la marque. Placeholder
-- [Example Media Ltd] rempli. Case partenaires (opt-in séparé) et consentement granulaire = différés.
-- Idempotent : ne réinsère pas si un consent_version 'example-2026-07' existe déjà pour la marque.

insert into newsletter.consent_version (regime, asset_id, version_label, legal_text, text_hash)
select 'lgpd', a.id, 'example-2026-07', $ct$Autorizo a Example Media Ltd a me enviar comunicações por e-mail nas seguintes categorias: (i) newsletter e conteúdos; (ii) ofertas e promoções; (iii) eventos e convites. Autorizo o tratamento do meu e-mail para essas finalidades, conforme a Política de Privacidade, e posso revogar a qualquer momento pelo link de descadastro em cada mensagem.$ct$, encode(extensions.digest($ct$Autorizo a Example Media Ltd a me enviar comunicações por e-mail nas seguintes categorias: (i) newsletter e conteúdos; (ii) ofertas e promoções; (iii) eventos e convites. Autorizo o tratamento do meu e-mail para essas finalidades, conforme a Política de Privacidade, e posso revogar a qualquer momento pelo link de descadastro em cada mensagem.$ct$,'sha256'),'hex')
from newsletter.asset a where a.slug='quartz-tips'
  and not exists (select 1 from newsletter.consent_version cv where cv.asset_id=a.id and cv.version_label='example-2026-07');

insert into newsletter.consent_version (regime, asset_id, version_label, legal_text, text_hash)
select 'lgpd', a.id, 'example-2026-07', $ct$Autorizo a Example Media Ltd a me enviar comunicações por e-mail nas seguintes categorias: (i) newsletter e conteúdos; (ii) ofertas e promoções; (iii) eventos e convites. Autorizo o tratamento do meu e-mail para essas finalidades, conforme a Política de Privacidade, e posso revogar a qualquer momento pelo link de descadastro em cada mensagem.$ct$, encode(extensions.digest($ct$Autorizo a Example Media Ltd a me enviar comunicações por e-mail nas seguintes categorias: (i) newsletter e conteúdos; (ii) ofertas e promoções; (iii) eventos e convites. Autorizo o tratamento do meu e-mail para essas finalidades, conforme a Política de Privacidade, e posso revogar a qualquer momento pelo link de descadastro em cada mensagem.$ct$,'sha256'),'hex')
from newsletter.asset a where a.slug='northwind-sports'
  and not exists (select 1 from newsletter.consent_version cv where cv.asset_id=a.id and cv.version_label='example-2026-07');

insert into newsletter.consent_version (regime, asset_id, version_label, legal_text, text_hash)
select 'lgpd', a.id, 'example-2026-07', $ct$Autorizo a Example Media Ltd a me enviar comunicações por e-mail nas seguintes categorias: (i) newsletter e conteúdos; (ii) ofertas e promoções; (iii) eventos e convites. Autorizo o tratamento do meu e-mail para essas finalidades, conforme a Política de Privacidade, e posso revogar a qualquer momento pelo link de descadastro em cada mensagem.$ct$, encode(extensions.digest($ct$Autorizo a Example Media Ltd a me enviar comunicações por e-mail nas seguintes categorias: (i) newsletter e conteúdos; (ii) ofertas e promoções; (iii) eventos e convites. Autorizo o tratamento do meu e-mail para essas finalidades, conforme a Política de Privacidade, e posso revogar a qualquer momento pelo link de descadastro em cada mensagem.$ct$,'sha256'),'hex')
from newsletter.asset a where a.slug='lumen-living'
  and not exists (select 1 from newsletter.consent_version cv where cv.asset_id=a.id and cv.version_label='example-2026-07');

insert into newsletter.consent_version (regime, asset_id, version_label, legal_text, text_hash)
select 'lgpd', a.id, 'example-2026-07', $ct$Autorizo a Example Media Ltd a me enviar comunicações por e-mail nas seguintes categorias: (i) newsletter e conteúdos; (ii) ofertas e promoções; (iii) eventos e convites. Autorizo o tratamento do meu e-mail para essas finalidades, conforme a Política de Privacidade, e posso revogar a qualquer momento pelo link de descadastro em cada mensagem.$ct$, encode(extensions.digest($ct$Autorizo a Example Media Ltd a me enviar comunicações por e-mail nas seguintes categorias: (i) newsletter e conteúdos; (ii) ofertas e promoções; (iii) eventos e convites. Autorizo o tratamento do meu e-mail para essas finalidades, conforme a Política de Privacidade, e posso revogar a qualquer momento pelo link de descadastro em cada mensagem.$ct$,'sha256'),'hex')
from newsletter.asset a where a.slug='pixel-daily'
  and not exists (select 1 from newsletter.consent_version cv where cv.asset_id=a.id and cv.version_label='example-2026-07');

insert into newsletter.consent_version (regime, asset_id, version_label, legal_text, text_hash)
select 'lgpd', a.id, 'example-2026-07', $ct$Autorizo a Example Media Ltd a me enviar comunicações por e-mail nas seguintes categorias: (i) newsletter e conteúdos; (ii) ofertas e promoções; (iii) eventos e convites. Autorizo o tratamento do meu e-mail para essas finalidades, conforme a Política de Privacidade, e posso revogar a qualquer momento pelo link de descadastro em cada mensagem.$ct$, encode(extensions.digest($ct$Autorizo a Example Media Ltd a me enviar comunicações por e-mail nas seguintes categorias: (i) newsletter e conteúdos; (ii) ofertas e promoções; (iii) eventos e convites. Autorizo o tratamento do meu e-mail para essas finalidades, conforme a Política de Privacidade, e posso revogar a qualquer momento pelo link de descadastro em cada mensagem.$ct$,'sha256'),'hex')
from newsletter.asset a where a.slug='bluefin-news'
  and not exists (select 1 from newsletter.consent_version cv where cv.asset_id=a.id and cv.version_label='example-2026-07');

insert into newsletter.consent_version (regime, asset_id, version_label, legal_text, text_hash)
select 'gdpr', a.id, 'example-2026-07', $ct$I authorize Example Media Ltd to send me email communications in the following categories: (i) newsletter and content; (ii) offers and promotions; (iii) events and invitations. I authorize processing my email for these purposes, per the Privacy Policy, and may withdraw at any time via the unsubscribe link in every message.$ct$, encode(extensions.digest($ct$I authorize Example Media Ltd to send me email communications in the following categories: (i) newsletter and content; (ii) offers and promotions; (iii) events and invitations. I authorize processing my email for these purposes, per the Privacy Policy, and may withdraw at any time via the unsubscribe link in every message.$ct$,'sha256'),'hex')
from newsletter.asset a where a.slug='harbor-tech'
  and not exists (select 1 from newsletter.consent_version cv where cv.asset_id=a.id and cv.version_label='example-2026-07');

insert into newsletter.consent_version (regime, asset_id, version_label, legal_text, text_hash)
select 'gdpr', a.id, 'example-2026-07', $ct$I authorize Example Media Ltd to send me email communications in the following categories: (i) newsletter and content; (ii) offers and promotions; (iii) events and invitations. I authorize processing my email for these purposes, per the Privacy Policy, and may withdraw at any time via the unsubscribe link in every message.$ct$, encode(extensions.digest($ct$I authorize Example Media Ltd to send me email communications in the following categories: (i) newsletter and content; (ii) offers and promotions; (iii) events and invitations. I authorize processing my email for these purposes, per the Privacy Policy, and may withdraw at any time via the unsubscribe link in every message.$ct$,'sha256'),'hex')
from newsletter.asset a where a.slug='goalpost-weekly'
  and not exists (select 1 from newsletter.consent_version cv where cv.asset_id=a.id and cv.version_label='example-2026-07');

insert into newsletter.consent_version (regime, asset_id, version_label, legal_text, text_hash)
select 'gdpr', a.id, 'example-2026-07', $ct$I authorize Example Media Ltd to send me email communications in the following categories: (i) newsletter and content; (ii) offers and promotions; (iii) events and invitations. I authorize processing my email for these purposes, per the Privacy Policy, and may withdraw at any time via the unsubscribe link in every message.$ct$, encode(extensions.digest($ct$I authorize Example Media Ltd to send me email communications in the following categories: (i) newsletter and content; (ii) offers and promotions; (iii) events and invitations. I authorize processing my email for these purposes, per the Privacy Policy, and may withdraw at any time via the unsubscribe link in every message.$ct$,'sha256'),'hex')
from newsletter.asset a where a.slug='atlas-review'
  and not exists (select 1 from newsletter.consent_version cv where cv.asset_id=a.id and cv.version_label='example-2026-07');

insert into newsletter.consent_version (regime, asset_id, version_label, legal_text, text_hash)
select 'gdpr', a.id, 'example-2026-07', $ct$Autorizo a Example Media Ltd a enviarme comunicaciones por correo electrónico en las siguientes categorías: (i) boletín y contenidos; (ii) ofertas y promociones; (iii) eventos e invitaciones. Autorizo el tratamiento de mi correo para estas finalidades, conforme a la Política de Privacidad, y puedo revocarlo en cualquier momento mediante el enlace para darme de baja.$ct$, encode(extensions.digest($ct$Autorizo a Example Media Ltd a enviarme comunicaciones por correo electrónico en las siguientes categorías: (i) boletín y contenidos; (ii) ofertas y promociones; (iii) eventos e invitaciones. Autorizo el tratamiento de mi correo para estas finalidades, conforme a la Política de Privacidad, y puedo revocarlo en cualquier momento mediante el enlace para darme de baja.$ct$,'sha256'),'hex')
from newsletter.asset a where a.slug='copper-kettle'
  and not exists (select 1 from newsletter.consent_version cv where cv.asset_id=a.id and cv.version_label='example-2026-07');

select a.slug, cv.regime, cv.version_label, left(cv.legal_text,45) as preview
from newsletter.consent_version cv join newsletter.asset a on a.id=cv.asset_id
where cv.version_label='example-2026-07' order by a.slug;
