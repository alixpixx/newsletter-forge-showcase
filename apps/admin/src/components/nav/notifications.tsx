"use client";

/**
 * Panneau de notifications. Les 3 alertes d'exemple et la pastille "non lu"
 * permanente ont été retirées : il n'existe aucune source de notifications
 * côté serveur, donc le panneau affiche un état vide honnête. La cloche reste
 * fonctionnelle (ouvre/ferme) et le lien Deliverability reste utile.
 *
 * ⛔ LE PANNEAU VIT SOUS `<body>`, PAS DANS LA BARRE DU HAUT. La barre porte `backdrop-blur` et
 * `z-20` : tout ce qu'elle contient est peint dans SA pile, donc un `z-40` à l'intérieur reste un
 * `z-20` pour le reste de la page (la barre d'actions groupées des abonnés passait par-dessus), et
 * l'ancien capteur de clic `fixed inset-0` ne couvrait que les 60 px de la barre (cliquer dans la
 * page ne refermait rien). D'où : panneau porté dans `document.body` et placé en `fixed` sous la
 * cloche, et plus de capteur du tout — un écouteur `pointerdown` sur le document, comme le
 * sélecteur de marque. Porter le seul capteur n'aurait pas suffi : sorti de la pile de la barre, il
 * aurait recouvert le panneau resté dedans et avalé le clic sur son lien.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { ModalPortal } from "@/components/modal-portal";

/** Écart entre la cloche et le panneau, en px (l'ancien `mt-2`). */
const GAP = 8;

export function Notifications() {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const measure = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    // `clientWidth` et non `innerWidth` : le repère d'un `fixed` exclut la barre de défilement.
    setPlace({ top: r.bottom + GAP, right: document.documentElement.clientWidth - r.right });
  }, []);

  // Mesuré AVANT la peinture : sinon le panneau apparaît une image en haut à gauche.
  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      // La cloche est exclue : son propre clic referme déjà par bascule.
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, measure]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="relative flex h-9 w-9 items-center justify-center rounded-[9px] border border-border bg-card transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <Bell className="h-[17px] w-[17px] text-foreground/70" strokeWidth={1.9} />
      </button>

      {open && place && (
        <ModalPortal>
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label="Notifications"
            style={{ top: place.top, right: place.right }}
            className="fixed z-50 w-[320px] max-w-[calc(100vw-16px)] overflow-hidden rounded-xl border border-border bg-card shadow-xl"
          >
            <div className="border-b border-border px-4 py-2.5 text-[12.5px] font-semibold">Notifications</div>

            <div className="flex flex-col items-center justify-center gap-2 px-4 py-9 text-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent">
                <BellOff className="h-[17px] w-[17px] text-muted-foreground" strokeWidth={1.9} />
              </span>
              <div className="text-[12.5px] font-semibold">No notifications</div>
              <p className="max-w-[30ch] text-[11.5px] text-muted-foreground">
                Alerts will appear here once notification delivery is connected.
              </p>
            </div>

            <div className="border-t border-border px-4 py-2 text-center text-[11.5px]">
              <a
                href="/deliverability"
                onClick={() => setOpen(false)}
                className="font-medium text-brand hover:underline"
              >
                Deliverability alerts →
              </a>
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
}
