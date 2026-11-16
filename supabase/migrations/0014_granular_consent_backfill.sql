-- Backfill : les souscriptions existantes avaient un consentement énuméré unique couvrant
-- content/offers/events ; partners n'a JAMAIS été capturé → false (fail-closed). Pas de fausses
-- lignes consent_event (l'optin_confirm existant reste la preuve légale).
update newsletter.subscription
   set granted_purposes = jsonb_build_object('content',true,'offers',true,'events',true,'partners',false)
 where consent_state = true and granted_purposes = '{}'::jsonb;

-- Mode granulaire pour les marchés qui l'exigent (kit : 1 case par finalité).
update newsletter.asset_edition set consent_mode = 'granular'
 where market in ('DE','FR','IT','ES','CL','CO','IN');

-- Rétention de preuve (par marché ; le régime ne distingue pas IN vs JP).
update newsletter.asset_edition set proof_retention_years = 7 where market = 'IN';
update newsletter.asset_edition set proof_retention_years = 3 where market = 'JP';
