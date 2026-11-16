-- ---------------------------------------------------------------------------
-- 0040 — De quoi CLORE un envoi, et le raconter.
-- ---------------------------------------------------------------------------
--
-- LE TROU QUE 0037/0038 ONT OUVERT. Le fan-out fait passer sa cible en `sending` avant d'écrire la
-- première ligne — c'est ce qui empêche deux passes simultanées de l'enfiler deux fois. Mais rien
-- ne la fait ressortir de cet état : une fois la file drainée, l'occurrence resterait `sending`
-- pour toujours. Un état terminal qui n'arrive jamais, c'est un écran qui affiche « envoi en
-- cours » trois semaines après, et une série dont personne ne peut dire si elle est partie.
--
-- CE QUE LA RÉCONCILIATION A BESOIN DE CONSIGNER, et que `recipients_planned` ne dit pas : combien
-- sont réellement PARTIS, combien ont ÉCHOUÉ, combien ont été ÉCARTÉS par le gate de conformité.
-- Ces trois nombres racontent trois histoires différentes :
--   — `sent` très en dessous de `planned` : l'audience a bougé entre la planification et l'envoi ;
--   — `failed` élevé : un problème de délivrabilité (DKIM, réputation, domaine) ;
--   — `skipped` élevé : un problème de CONSENTEMENT — on a ciblé des gens qui n'avaient rien
--     accordé, et le gate a fait son travail. C'est le plus important des trois, et c'est celui
--     qu'aucun compteur n'exposait.
--
-- ⚠️ POURQUOI DES COLONNES ET PAS UN COMPTAGE À LA VOLÉE. `email_outbox` est une FILE : ses lignes
-- ont vocation à être purgées (rétention, RGPD). Le jour où elles disparaissent, un comptage à la
-- volée rend 0 et efface l'histoire de l'envoi. Les compteurs, eux, restent.
alter table newsletter.campaign_occurrence
  add column if not exists recipients_sent    integer,
  add column if not exists recipients_failed  integer,
  add column if not exists recipients_skipped integer;
alter table newsletter.campaign
  add column if not exists recipients_sent    integer,
  add column if not exists recipients_failed  integer,
  add column if not exists recipients_skipped integer;

comment on column newsletter.campaign_occurrence.recipients_skipped is
  'Lignes écartées par le gate de conformité au moment de l''envoi (finalité non accordée, suppression, statut). Un chiffre élevé n''est PAS une panne technique : c''est un ciblage qui a visé des gens sans consentement.';
comment on column newsletter.campaign.recipients_skipped is
  'Idem pour une campagne sans cadence. Nul pour une campagne de série : c''est alors l''occurrence qui porte les compteurs.';

notify pgrst, 'reload schema';
