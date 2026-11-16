-- ---------------------------------------------------------------------------
-- 0041 — Le flux d'événements d'envoi : ce que le destinataire, lui, a vécu.
-- ---------------------------------------------------------------------------
--
-- CE QUI MANQUAIT ET CE QUE ÇA COÛTAIT. `email_outbox.status` dit ce que NOUS avons fait : la ligne
-- a été remise à Mailgun. Il ne dit rien de ce qui s'est passé ensuite — acceptée par le serveur
-- du destinataire, rejetée définitivement, marquée comme spam. Sans ces événements :
--   — la liste de suppression ne se remplit jamais toute seule, donc on continue d'écrire à des
--     adresses mortes, et la réputation d'envoi se dégrade à chaque passe ;
--   — le constructeur de segments ne peut pas évaluer les prédicats de comportement (`clicked_cta`
--     et consorts), qui sont aujourd'hui renvoyés dans `unsupported` — affichés, jamais tus ;
--   — aucun écran ne peut afficher un taux d'ouverture sans l'inventer.
--
-- ⛔ AUCUNE ADRESSE N'EST STOCKÉE ICI. L'événement se rattache à la ligne d'origine par
-- `outbox_id` ; l'adresse vit déjà sur cette ligne. Dupliquer la PII dans une table qui grossira de
-- plusieurs lignes par envoi et par personne, c'est multiplier la surface d'une fuite et le travail
-- d'un effacement RGPD. Le fournisseur nous renvoie son identifiant de message : c'est lui qui sert
-- de jointure, pas l'e-mail.
--
-- ⛔ IDEMPOTENCE PAR CONSTRUCTION. Un webhook est REJOUÉ : Mailgun réessaie tant qu'il n'a pas reçu
-- de 200, et il lui arrive de doubler un événement même après un succès. `provider_event_id` est
-- unique : le rejeu retombe sur un conflit et ne fabrique pas un second « ouvert » pour la même
-- ouverture. Sans cette unicité, tous les taux du produit seraient faux VERS LE HAUT — et un taux
-- trop flatteur ne se remarque jamais.
create table if not exists newsletter.email_event (
  id                  uuid primary key default gen_random_uuid(),
  outbox_id           uuid references newsletter.email_outbox(id) on delete set null,
  subscription_id     uuid references newsletter.subscription(id) on delete set null,
  asset_id            uuid references newsletter.asset(id) on delete set null,
  campaign_id         uuid references newsletter.campaign(id) on delete set null,
  occurrence_id       uuid references newsletter.campaign_occurrence(id) on delete set null,
  -- Le vocabulaire est FERMÉ : un type inconnu serait invisible dans toutes les requêtes qui
  -- comptent, et personne ne remarquerait qu'on ne compte pas un pan entier des retours.
  type                text not null check (type in (
                        'delivered','opened','clicked','bounced','complained','unsubscribed','failed'
                      )),
  -- Un rebond DUR est définitif (boîte inexistante) ; un rebond MOU est temporaire (boîte pleine,
  -- serveur indisponible). Les confondre, c'est soit supprimer des gens joignables, soit garder des
  -- adresses mortes. Nul hors rebond.
  severity            text check (severity is null or severity in ('permanent','temporary')),
  provider            text not null default 'mailgun',
  provider_event_id   text not null,
  provider_message_id text,
  reason              text,
  occurred_at         timestamptz not null,
  payload             jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create unique index if not exists uq_email_event_provider
  on newsletter.email_event (provider, provider_event_id);

-- Les deux accès qui existeront : « l'histoire de cet envoi » et « ce que cette personne a fait ».
create index if not exists ix_email_event_outbox on newsletter.email_event (outbox_id);
create index if not exists ix_email_event_subscription_type on newsletter.email_event (subscription_id, type);

comment on table newsletter.email_event is
  'Retours du fournisseur d''envoi, un par événement. Ne contient AUCUNE adresse : la jointure se fait par outbox_id / provider_message_id. Unique par (provider, provider_event_id) car un webhook est rejoué — sans cette unicité, tous les taux seraient faux vers le haut.';

grant select, insert on newsletter.email_event to service_role;

notify pgrst, 'reload schema';
