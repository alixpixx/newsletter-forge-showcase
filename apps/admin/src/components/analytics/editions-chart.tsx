import { nomEnvoi, pct, taux, type EnvoiStats } from "@/lib/campaign-stats";

/**
 * Une barre par envoi (Sent), du plus ancien au plus récent, et un point d'Open rate au-dessus des
 * seuls envois où il est MESURÉ — un envoi non suivi n'a pas de point, jamais un point à 0 %.
 * SVG écrit à la main, comme `GrowthChart` : aucune dépendance ajoutée.
 */
export function EditionsChart({ editions }: { editions: EnvoiStats[] }) {
  const serie = [...editions].reverse();
  const max = Math.max(1, ...serie.map((e) => e.sent));
  const W = 720, H = 210, PAD_L = 44, PAD_R = 44, PAD_B = 26, PAD_T = 14;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_B - PAD_T;
  const bw = innerW / Math.max(serie.length, 1);
  const ticks = [0, 0.5, 1];
  // Une étiquette sur `pas` : au-delà de 16 envois, les numéros se chevaucheraient.
  const pas = Math.max(1, Math.ceil(serie.length / 16));
  const ouvertures = serie.map((e) => taux(e).openRate);
  const maxTaux = Math.max(0.01, ...ouvertures.filter((v): v is number => v !== null));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Sent per edition, with open rate where measured">
      {ticks.map((f) => {
        const y = PAD_T + innerH * (1 - f);
        return (
          <g key={f}>
            <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="#eeeef2" strokeWidth="1" />
            <text x={PAD_L - 8} y={y + 3.5} textAnchor="end" fill="#a3a3ad" fontSize="10" fontFamily="var(--font-mono)">
              {Math.round(max * f).toLocaleString("en-US")}
            </text>
            {ouvertures.some((v) => v !== null) && (
              <text x={W - PAD_R + 8} y={y + 3.5} fill="#7c5cf0" fontSize="10" fontFamily="var(--font-mono)">
                {pct(maxTaux * f)}
              </text>
            )}
          </g>
        );
      })}
      {serie.map((e, i) => {
        const h = (e.sent / max) * innerH;
        const x = PAD_L + i * bw + bw * 0.2;
        const w = Math.max(bw * 0.6, 1);
        const y = PAD_T + innerH - h;
        const o = ouvertures[i];
        return (
          <g key={e.occurrenceId ?? `unique-${i}`} className="group">
            <rect x={PAD_L + i * bw} y={PAD_T} width={bw} height={innerH} fill="transparent">
              <title>{`${nomEnvoi(e)}: ${e.sent.toLocaleString("en-US")} sent · open rate ${pct(o ?? null)}`}</title>
            </rect>
            <rect x={x} y={y} width={w} height={Math.max(h, 1)} rx="3" fill="#ff368d" opacity={0.8} className="pointer-events-none group-hover:opacity-100" />
            {o !== null && o !== undefined && (
              <circle cx={x + w / 2} cy={PAD_T + innerH * (1 - o / maxTaux)} r="3.5" fill="#7c5cf0" className="pointer-events-none" />
            )}
            {i % pas === 0 && (
              <text x={x + w / 2} y={H - 8} textAnchor="middle" fill="#a3a3ad" fontSize="10.5" className="pointer-events-none">
                {e.occurrenceId === null ? "Send" : e.seq !== null ? `#${e.seq}` : ""}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
