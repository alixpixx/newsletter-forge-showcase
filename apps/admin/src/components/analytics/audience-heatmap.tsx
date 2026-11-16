import { JOURS_ISO, type CaseCarte } from "@/lib/engagement";
import { grilleCarte, intensite, libelleCreneau, meilleursCreneaux, type Grille } from "@/lib/audience-view";
import { nombre } from "@/lib/campaign-stats";

/*
 * « Best moments to send » (0094) — composant serveur : deux grilles 7 × 24 (ouvertures, puis clics),
 * l'intensité d'une case = l'opacité de son fond, le compte exact en infobulle.
 *
 * ⛔ Aucune ouverture enregistrée n'est pas « personne n'ouvre » : le suivi peut être coupé, ou
 * fraîchement allumé. La carte le DIT au lieu d'afficher une grille vide.
 */

const HEURES = Array.from({ length: 24 }, (_, h) => h);
const COLONNES = { gridTemplateColumns: "2.25rem repeat(24, minmax(18px, 1fr))" };

function Carte({ g, couleur, unite, titre }: { g: Grille; couleur: string; unite: string; titre: string }) {
  const fond = (v: number) =>
    v > 0 ? { backgroundColor: `color-mix(in srgb, ${couleur} ${Math.round(intensite(v, g.max) * 100)}%, transparent)` } : undefined;
  return (
    <div className="-mx-[18px] overflow-x-auto px-[18px]">
      <div role="img" aria-label={titre} className="grid min-w-[560px] gap-[3px]" style={COLONNES}>
        <span />
        {HEURES.map((h) => (
          <span key={h} className="text-center text-[10px] tabular-nums text-muted-foreground">
            {h % 3 === 0 ? h : ""}
          </span>
        ))}
        {g.valeurs.map((ligne, i) => (
          <Ligne key={JOURS_ISO[i]} jour={i + 1} ligne={ligne} fond={fond} unite={unite} />
        ))}
      </div>
    </div>
  );
}

function Ligne({
  jour,
  ligne,
  fond,
  unite,
}: {
  jour: number;
  ligne: number[];
  fond: (v: number) => React.CSSProperties | undefined;
  unite: string;
}) {
  return (
    <>
      <span className="self-center text-[11px] font-medium text-muted-foreground">{JOURS_ISO[jour - 1]}</span>
      {ligne.map((v, h) => (
        <span
          key={h}
          title={`${libelleCreneau(jour, h)}: ${nombre(v)} ${unite}`}
          className={v > 0 ? "h-[22px] rounded-[4px]" : "h-[22px] rounded-[4px] bg-accent/60"}
          style={fond(v)}
        />
      ))}
    </>
  );
}

/** La carte des moments d'une période ; `timezone` = fuseau de l'édition principale de la marque. */
export function AudienceHeatmap({ cases, timezone }: { cases: CaseCarte[]; timezone: string }) {
  const ouvertures = grilleCarte(cases, "opens");
  const clics = grilleCarte(cases, "clicks");
  const meilleurs = meilleursCreneaux(ouvertures, 3);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] text-muted-foreground">
        Times in <span className="font-medium text-foreground">{timezone}</span> (the brand&apos;s primary edition). Each
        cell counts the distinct emails opened — or clicked — in that hour; darker means more. Hover a cell for its
        exact count.
      </p>

      {ouvertures.total === 0 ? (
        <p className="rounded-[10px] border border-border bg-accent/40 px-4 py-3 text-[13px] text-muted-foreground">
          No opens recorded in this period — open tracking may be off or just turned on.
        </p>
      ) : (
        <div>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-[12.5px] font-semibold">Opens</h4>
            <span className="text-[12px] text-muted-foreground">
              Best: {meilleurs.map((m) => `${libelleCreneau(m.dow, m.hour)} (${nombre(m.value)})`).join(" · ")}
            </span>
          </div>
          <Carte g={ouvertures} couleur="var(--brand)" unite="emails opened" titre="Emails opened by day of week and hour" />
        </div>
      )}

      {clics.total === 0 ? (
        ouvertures.total > 0 && <p className="text-[12px] text-muted-foreground">No clicks recorded in this period.</p>
      ) : (
        <div>
          <h4 className="mb-2 text-[12.5px] font-semibold">Clicks</h4>
          <Carte g={clics} couleur="#7c5cf0" unite="emails clicked" titre="Emails clicked by day of week and hour" />
        </div>
      )}
    </div>
  );
}
