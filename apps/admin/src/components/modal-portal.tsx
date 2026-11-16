"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Monte un calque (modale, tiroir, panneau) directement sous `<body>`.
 *
 * ⛔ POURQUOI CE DÉTOUR EST NÉCESSAIRE, ET PAS UN RAFFINEMENT. `position: fixed` ne se cale sur le
 * viewport que si AUCUN ancêtre ne porte `transform`, `filter`, `backdrop-filter`, `contain` ou
 * `will-change` : le premier qui en porte un devient le repère, et la modale s'ouvre à l'intérieur
 * du bloc de contenu. C'est arrivé deux fois dans cette application — l'écran « Users & access »
 * (voir `users/users-client.tsx`), puis l'assistant de campagne, tous deux enveloppés dans
 * `.animate-fade-up`. Le fill-mode de cette animation est corrigé dans `globals.css`, mais ça ne
 * protège que de CE transform-là : la barre du haut porte un `backdrop-blur` permanent, et rien
 * n'empêche un futur conteneur d'en poser un autre. Sortir du flux est la seule défense qui ne
 * dépend pas de ce que font les ancêtres.
 *
 * `mounted` évite le décalage d'hydratation : `document` n'existe pas au rendu serveur.
 *
 * Volontairement limité au portail : la touche Échap et le verrou de défilement restent la
 * responsabilité de chaque calque, parce que tous n'en veulent pas (un tiroir non modal laisse la
 * page défiler). Poser ces comportements ici les imposerait à des écrans qui ne les ont jamais eus.
 */
export function ModalPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return null;
  return createPortal(children, document.body);
}
