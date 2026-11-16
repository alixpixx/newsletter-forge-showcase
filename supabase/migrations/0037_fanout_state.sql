-- ---------------------------------------------------------------------------
-- 0037 — Ce qui manquait pour que le fan-out soit REJOUABLE et RACONTABLE.
-- ---------------------------------------------------------------------------
--
-- 0032 a rendu le fan-out d'une OCCURRENCE rejouable : `uq_outbox_occurrence_subscription`
-- garantit une ligne par (occurrence, abonnement), donc une reprise après crash au lot 7 sur 12 ne
-- réexpédie pas les six premiers lots. Mais une campagne SIMPLE — celle qu'on planifie pour une
-- date unique, sans cadence — n'a pas d'occurrence : `occurrence_id` y est nul, l'index partiel ne
-- la couvre pas, et la même reprise la doublerait. Le trou était nommé dans 0032 ; on le ferme ici
-- avant d'écrire la ligne de code qui l'ouvrirait.
--
-- ⛔ POURQUOI CE N'EST PAS UNE DUPLICATION DE 0032. Les deux index protègent le même invariant sur
-- deux populations disjointes, et leurs prédicats le disent : `occurrence_id is not null` d'un
-- côté, `occurrence_id is null` de l'autre. Un seul index sur `(campaign_id, subscription_id)`
-- aurait interdit à une SÉRIE d'envoyer deux semaines de suite au même abonné — c'est-à-dire
-- exactement ce qu'une série est censée faire.
--
-- ⚠️ CE QUE ÇA INTERDIT, ET C'EST VOULU : ré-expédier une campagne simple au même abonné. Une
-- campagne envoyée est terminale (`status = 'sent'`) ; la renvoyer se fait en la dupliquant, ce qui
-- crée une NOUVELLE campagne avec son propre identifiant. Si cette contrainte refuse une écriture,
-- le geste est de dupliquer la campagne — pas de retirer l'index.
create unique index if not exists uq_outbox_campaign_subscription
  on newsletter.email_outbox (campaign_id, subscription_id)
  where kind = 'campaign' and occurrence_id is null
    and campaign_id is not null and subscription_id is not null;

comment on index newsletter.uq_outbox_campaign_subscription is
  'Pendant de uq_outbox_occurrence_subscription pour les campagnes SANS cadence : une campagne simple ne peut produire qu''une ligne par abonnement, ce qui rend sa mise en file rejouable après un crash. Prédicats disjoints : celui-ci ne voit que occurrence_id IS NULL, sans quoi il interdirait à une série d''écrire deux semaines de suite au même abonné.';


-- ===========================================================================
-- QUAND la file a été remplie — l'information qui manque à tous les écrans.
-- ===========================================================================
--
-- LE DÉFAUT SANS CETTE COLONNE. `sent_at` dit quand le dernier message est parti, `scheduled_at`
-- quand il devait partir. Entre les deux, il y a l'instant où l'audience a été FIGÉE en lignes de
-- file — et c'est le seul qui permette de répondre à « pourquoi 4 190 messages pour 4 210
-- destinataires annoncés ? ». Sans lui, l'écart entre le compte planifié et le compte réel n'est
-- rattachable à rien : on ne sait pas si l'audience a bougé entre la planification et la mise en
-- file, ou entre la mise en file et l'envoi. Deux causes très différentes, un seul symptôme.
--
-- Posée sur les DEUX porteurs, parce que les deux se mettent en file : l'occurrence pour une série,
-- la campagne pour un envoi unique.
alter table newsletter.campaign_occurrence
  add column if not exists enqueued_at timestamptz;
alter table newsletter.campaign
  add column if not exists enqueued_at timestamptz;

comment on column newsletter.campaign_occurrence.enqueued_at is
  'Instant où l''audience a été matérialisée en lignes d''email_outbox. Entre scheduled_at (quand ça devait partir) et sent_at (quand c''est parti) : c''est lui qui permet d''attribuer un écart planifié/envoyé à la bonne étape.';
comment on column newsletter.campaign.enqueued_at is
  'Instant où l''audience d''une campagne SIMPLE a été matérialisée en lignes d''email_outbox. Nul pour une campagne de série : c''est alors l''occurrence qui porte l''information.';

notify pgrst, 'reload schema';
