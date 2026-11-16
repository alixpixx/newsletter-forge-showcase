-- ---------------------------------------------------------------------------
-- 0042 — La mémoire de ce qui est DÉJÀ parti : sans elle, `dedupeDays` est décoratif.
-- ---------------------------------------------------------------------------
--
-- CE QUI MANQUAIT ET CE QUE ÇA COÛTAIT. Un bloc `article-feed` porte une fenêtre d'anti-répétition
-- (`dedupeDays`, jusqu'à 60 jours) et un plancher (`minCount`). La fenêtre décrit une EXCLUSION —
-- « ne me redonne pas ce qui est déjà parti » — mais rien en base ne savait ce qui était parti. Le
-- champ vivait donc dans le document sans pouvoir s'appliquer nulle part : une quotidienne qui
-- demande « les 5 derniers de Futebol » renvoie les 5 MÊMES titres tous les soirs tant que la
-- source ne publie rien. Le destinataire, lui, ne lit pas « la source n'a rien sorti » : il lit
-- « ils me renvoient l'email d'hier », et il marque en spam. C'est la réputation d'envoi qui paie.
--
-- ⛔ LA PORTÉE DE LA FENÊTRE EST LA CAMPAGNE, PAS L'OCCURRENCE. `campaign_id` est NOT NULL même
-- quand la ligne vient d'une occurrence de série : la requête d'exclusion demande « ce qui est parti
-- POUR CETTE CAMPAGNE depuis N jours » et balaie forcément plusieurs occurrences — c'est la
-- définition même d'une anti-répétition. Une ligne écrite avec le seul `occurrence_id` serait
-- invisible de cette requête : l'anti-répétition ne ferait plus RIEN, sans jamais lever d'erreur.
-- `occurrence_id` ne sert qu'à la provenance — savoir quelle échéance a consommé quel article.
--
-- ⚠️ L'IDENTITÉ D'UN ARTICLE EST SON URL, PAS SON `postId`. Deux sources qui syndiquent le même
-- papier n'ont pas le même identifiant WordPress, mais bien la même adresse — et c'est l'adresse que
-- le lecteur reconnaît. Dédupliquer sur le `postId` laisserait passer exactement le doublon que le
-- lecteur voit. Le titre et la date sont recopiés pour qu'un écran ou un journal puisse dire QUEL
-- article a été écarté sans réinterroger WordPress, qui aura déjà tourné la page.
--
-- ⚠️ AUCUNE DONNÉE DE DESTINATAIRE ICI, et ça doit le rester : cette table dit quels ARTICLES sont
-- partis pour une campagne, jamais à qui. L'anti-répétition est une propriété de la CAMPAGNE, pas
-- de la personne ; y descendre à l'abonné multiplierait les lignes par la taille de la liste pour
-- une information dont personne n'a besoin, et rouvrirait une surface de PII déjà fermée.
create table if not exists newsletter.feed_article_sent (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references newsletter.campaign(id) on delete cascade,
  occurrence_id uuid references newsletter.campaign_occurrence(id) on delete cascade,
  asset_id      uuid not null references newsletter.asset(id) on delete cascade,
  -- L'id du bloc flux qui a retenu l'article (`Id` du schéma de rendu, 64 caractères max). Deux
  -- blocs d'un même email peuvent viser deux catégories : sans lui on ne sait plus lequel a consommé
  -- quoi, et un diagnostic « pourquoi ce bloc est-il sous son plancher ? » n'a plus de fil à tirer.
  block_id      text not null,
  article_url   text not null,
  article_title text not null,
  -- Nulle quand la source ne date pas ses articles : `FeedItem.publishedAt` est optionnel, et
  -- inventer une date ici ferait mentir tout tri qui s'y fierait plus tard.
  published_at  timestamptz,
  sent_at       timestamptz not null default now()
);

-- ===========================================================================
-- L'IDEMPOTENCE EST GARANTIE ICI, PAS DANS L'APPELANT.
-- ===========================================================================
--
-- ⛔ POURQUOI PAS UN « SELECT PUIS IF » CÔTÉ CODE. Deux passes du planificateur qui se recouvrent
-- lisent toutes les deux « pas encore parti », concluent toutes les deux qu'il faut écrire, et
-- écrivent deux fois : le test et l'écriture ne sont pas atomiques. L'index unique, lui, l'est.
-- L'appelant écrit donc en `on conflict do nothing` et lit le nombre de lignes RÉELLEMENT insérées,
-- plutôt que de se fier à ce qu'il croyait savoir avant d'écrire.
--
-- ⚠️ LE PIÈGE DU NULL — C'EST TOUT L'OBJET DES DEUX INDEX. En Postgres, NULL n'est jamais égal à
-- NULL : un index unique ORDINAIRE sur `(occurrence_id, article_url)` ne contraint plus rien dès que
-- `occurrence_id` est nul — or il est nul pour toute campagne ponctuelle. L'index existerait, se
-- verrait dans le schéma, se laisserait décrire dans une revue, et ne refuserait JAMAIS le doublon
-- qu'il est censé refuser. D'où deux index PARTIELS aux prédicats disjoints : même invariant, deux
-- populations séparées — l'occurrence quand il y en a une, la campagne sinon. Même figure qu'en
-- 0032/0037 sur email_outbox, et pour la même raison.
--
-- ⚠️ Prédicats DISJOINTS, pas redondants. Un index unique sur `(campaign_id, article_url)` SANS
-- prédicat interdirait à une série de resservir un article dans une occurrence ultérieure — donc de
-- faire ce que `dedupeDays = 0` autorise explicitement. La fenêtre se décide à la LECTURE, pas ici :
-- ces index disent « une ligne par article et par échéance », jamais « cet article est brûlé ».
create unique index if not exists uq_feed_article_sent_occurrence
  on newsletter.feed_article_sent (occurrence_id, article_url)
  where occurrence_id is not null;

create unique index if not exists uq_feed_article_sent_campaign
  on newsletter.feed_article_sent (campaign_id, article_url)
  where occurrence_id is null;

-- Le seul accès en lecture qui existera : « ce qui est parti pour cette campagne depuis N jours ».
-- `sent_at desc` parce que la fenêtre se lit du plus récent vers le passé et s'arrête à sa borne ;
-- sans cet ordre, une quotidienne d'un an relit tout son historique à chaque échéance.
create index if not exists ix_feed_article_sent_window
  on newsletter.feed_article_sent (campaign_id, sent_at desc);

comment on table newsletter.feed_article_sent is
  'Articles déjà expédiés par un bloc article-feed, pour que la fenêtre dedupeDays ait quelque chose à exclure. La portée est la CAMPAGNE (campaign_id toujours renseigné, même pour une occurrence) : sans quoi la requête de fenêtre ne verrait rien et l''anti-répétition serait muette. Ne contient aucune donnée de destinataire.';

comment on index newsletter.uq_feed_article_sent_occurrence is
  'Un article ne peut être enregistré qu''une fois par occurrence : rejouer la résolution d''une échéance après un crash n''écrit pas de doublon. Partiel car son pendant campagne couvre les lignes à occurrence_id nul.';

comment on index newsletter.uq_feed_article_sent_campaign is
  'Pendant du précédent pour les campagnes PONCTUELLES, qui n''ont pas d''occurrence. Non redondant : NULL <> NULL en Postgres, donc l''index sur (occurrence_id, article_url) ne contraint rien quand occurrence_id est nul — le doublon passerait sans bruit.';

-- ⛔ RLS ACTIVÉ SANS AUCUNE POLICY — le motif de campaign_occurrence et email_outbox : la table est
-- alors muette pour les clés anon/authenticated, et seul `service_role`, qui contourne RLS, la voit.
-- Les grants ci-dessous suffiraient aujourd'hui ; l'activer ne coûte rien et fait que le jour où
-- quelqu'un élargit un grant, la table reste fermée par défaut au lieu de s'ouvrir au navigateur.
alter table newsletter.feed_article_sent enable row level security;

-- `delete` en plus de ce qu'accorde 0041 : la fenêtre d'anti-répétition est BORNÉE (60 jours au
-- maximum), donc tout ce qui est plus vieux est du poids mort qu'une purge doit pouvoir retirer —
-- sans exiger une migration supplémentaire dont le seul contenu serait ce grant.
grant select, insert, delete on newsletter.feed_article_sent to service_role;

notify pgrst, 'reload schema';
