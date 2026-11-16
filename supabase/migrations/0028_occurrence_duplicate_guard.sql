-- ---------------------------------------------------------------------------
-- 0028 — S-5 : la garde anti-doublon, et la décision humaine qui la lève.
-- ---------------------------------------------------------------------------
--
-- LE DÉFAUT QUE CETTE MIGRATION EXISTE POUR RENDRE VISIBLE.
--
-- Une série hebdomadaire gèle son contenu 90 minutes avant chaque envoi, en COPIANT la version
-- publiée du modèle. Si personne n'a republié entre deux occurrences, la copie est identique à la
-- précédente : les mêmes 1 200 personnes reçoivent deux fois le même e-mail, à une semaine
-- d'intervalle. Techniquement tout a fonctionné. Éditorialement c'est un incident, et c'est le
-- genre d'incident qu'on découvre par une plainte, pas par un journal.
--
-- L'empreinte `content_sha256` (posée par S-4 au gel) rend ce cas DÉTECTABLE. Reste à décider ce
-- qu'on en fait — et la réponse n'est pas « annuler » : parfois renvoyer le même contenu est
-- délibéré (une relance, un rattrapage d'audience). Donc : on RETIENT, on ALERTE, et on laisse un
-- humain trancher. Ces colonnes sont la trace de ce qu'il a tranché.
--
-- ⛔ POURQUOI UNE COLONNE ET PAS UN SIMPLE RETOUR À `planned`. Sans mémoire de la décision, la
-- passe suivante du matérialiseur — cinq minutes plus tard — retrouverait la même empreinte et
-- re-bloquerait l'occurrence. L'opérateur cliquerait « envoyer quand même » indéfiniment sans que
-- rien n'avance : un bouton qui n'a pas d'effet durable est pire qu'un bouton absent.
--
-- ⚠️ ADDITIVE ET SANS EFFET tant qu'aucune série n'est armée : ces colonnes naissent nulles, et
-- une occurrence dont `duplicate_ack_at` est nul se comporte exactement comme avant.

alter table newsletter.campaign_occurrence
  -- L'occurrence dont celle-ci reprend le contenu. Renseignée AU MOMENT du blocage : la retrouver
  -- après coup obligerait à rejouer la comparaison sur des lignes qui ont pu bouger.
  add column if not exists duplicate_of uuid references newsletter.campaign_occurrence(id) on delete set null,
  -- Quand un humain a dit « envoie quand même ». Nul = personne n'a rien dit.
  add column if not exists duplicate_ack_at timestamptz,
  -- QUI l'a dit. Une décision d'envoyer deux fois le même e-mail à 1 200 personnes doit porter un
  -- nom : c'est la première question posée quand quelqu'un demande pourquoi il l'a reçu deux fois.
  add column if not exists duplicate_ack_by text;

-- Un accord sans auteur ne vaut rien comme trace ; un auteur sans accord n'a pas de sens.
alter table newsletter.campaign_occurrence drop constraint if exists occurrence_dup_ack_complete;
alter table newsletter.campaign_occurrence
  add constraint occurrence_dup_ack_complete check (
    (duplicate_ack_at is null and duplicate_ack_by is null)
    or (duplicate_ack_at is not null and duplicate_ack_by is not null)
  );

comment on column newsletter.campaign_occurrence.duplicate_of is
  'Occurrence dont celle-ci reprend le contenu à l''octet près (empreinte content_sha256 identique). Posée au moment du blocage par le matérialiseur.';
comment on column newsletter.campaign_occurrence.duplicate_ack_at is
  'Instant où un humain a autorisé l''envoi malgré le doublon. Sans cette mémoire, la passe suivante re-bloquerait l''occurrence et le bouton « envoyer quand même » n''aurait aucun effet durable.';
comment on column newsletter.campaign_occurrence.duplicate_ack_by is
  'Auteur de cette autorisation. Une décision d''envoyer deux fois le même e-mail doit porter un nom.';

-- Recherche du dernier contenu ARRÊTÉ d'un plan (gelé, en vol ou envoyé) : c'est à lui que le gel
-- suivant compare son empreinte. `idx_occurrence_sent` (0027) ne couvre que les envoyées, ce qui
-- laissait passer le cas des occurrences rapprochées — une quotidienne dont la veille n'est pas
-- encore partie au moment où le lendemain gèle.
create index if not exists idx_occurrence_settled
  on newsletter.campaign_occurrence (campaign_id, frozen_at desc)
  where content_sha256 is not null and status in ('frozen', 'sending', 'sent');

notify pgrst, 'reload schema';
