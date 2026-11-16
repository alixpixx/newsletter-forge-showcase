-- ---------------------------------------------------------------------------
-- 0049 — le mélange « moitié plus lus / moitié plus récents » devient un
--        interrupteur DE CAMPAGNE, pas un réglage de modèle.
-- ---------------------------------------------------------------------------
--
-- ⛔ POURQUOI LA CAMPAGNE ET PAS LE MODÈLE. Un `template_version` sert PLUSIEURS campagnes, et
-- c'est déjà le cas en production : « Friday NL TW » et « Resumo da rodada — domingo » pointent
-- toutes deux la version 509c87c3 du modèle 5e82230d. Un réglage posé dans le document les touche
-- donc ensemble, alors que la demande d'Alix (04/09/2026) est exactement de pouvoir les séparer :
-- le mélange sur l'une, pas sur l'autre.
--
-- ⚠️ CE QUE CETTE COLONNE NE FAIT PAS. Elle ne promeut QUE les blocs déjà classés par vues. Un bloc
-- « les plus récents » forcé en mélange exigerait une propriété d'audience élue sur la marque — et
-- goalpost-weekly n'en a plus depuis le 16/08. Une case qui condamne des blocs qui fonctionnaient
-- serait pire que pas de case du tout. La règle vit dans `modeDeSelection`
-- (`packages/analytics/src/article-views.ts`), en un seul endroit.
--
-- ⚠️ MESURÉ AVANT D'ÉCRIRE CETTE MIGRATION : sur les 40 `template_version`, 17 portent un bloc
-- `article-feed` et **AUCUN** n'est réglé sur `views` ni sur `mixed`. Le défaut `false` n'éteint
-- donc rien qui existe — mais il ne suffira pas non plus à faire quelque chose tant qu'aucun modèle
-- ne demandera de classement. C'est pourquoi l'écran affiche le compte de blocs concernés à côté de
-- la case, au lieu de la laisser muette.
--
-- ⛔ APPLIQUÉE AVANT LE DÉPLOIEMENT, jamais après. PostgREST rejette le LOT ENTIER dès qu'une
-- requête nomme une colonne absente de son cache de schéma : déployer d'abord ferait échouer le gel
-- de TOUTES les occurrences, pas seulement de celles qui utilisent le mélange.

alter table newsletter.campaign
  add column if not exists mix_latest boolean not null default false;

comment on column newsletter.campaign.mix_latest is
  'Complète les blocs classés par vues avec la moitié des articles publiés depuis la coupure de '
  'l''entrepôt (48 h). Sans effet sur les blocs « les plus récents ». Réglé par campagne, parce '
  'qu''un modèle sert plusieurs campagnes.';
