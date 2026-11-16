/** Nouveaux abonnés par semaine — barres, données réelles (aucune valeur inventée). */
export function GrowthChart({ weekly }: { weekly: number[] }) {
  const max = Math.max(1, ...weekly);
  const W = 720, H = 200, PAD_L = 40, PAD_B = 26, PAD_T = 10;
  const innerW = W - PAD_L - 15;
  const innerH = H - PAD_B - PAD_T;
  const bw = innerW / Math.max(weekly.length, 1);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const lastIdx = weekly.length - 1;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="New subscribers per week">
      <defs>
        <pattern id="gc-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="#ff368d" opacity="0.16" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="#ff368d" strokeWidth="2.4" opacity="0.9" />
        </pattern>
      </defs>
      {ticks.map((f) => {
        const y = PAD_T + innerH * (1 - f);
        return (
          <g key={f}>
            <line x1={PAD_L} y1={y} x2={W - 15} y2={y} stroke="#eeeef2" strokeWidth="1" />
            <text x={8} y={y + 3.5} fill="#a3a3ad" fontSize="10" fontFamily="var(--font-mono)">
              {Math.round(max * f)}
            </text>
          </g>
        );
      })}
      {weekly.map((v, i) => {
        const h = (v / max) * innerH;
        const x = PAD_L + i * bw + bw * 0.22;
        const w = bw * 0.56;
        const y = PAD_T + innerH - h;
        const inProgress = i === lastIdx;
        return (
          <g key={i} className="group">
            {/* Full-column hover target so the tooltip triggers anywhere over the week. */}
            <rect x={PAD_L + i * bw} y={PAD_T} width={bw} height={innerH} fill="transparent">
              <title>{`Week ${i + 1}${inProgress ? " (in progress)" : ""}: ${v} new subscribers`}</title>
            </rect>
            <rect
              x={x}
              y={y}
              width={w}
              height={Math.max(h, 1)}
              rx="3"
              fill={inProgress ? "url(#gc-hatch)" : "#ff368d"}
              opacity={inProgress ? 1 : 0.25 + (0.75 * (i + 1)) / weekly.length}
              stroke={inProgress ? "#ff368d" : "none"}
              strokeWidth={inProgress ? 1 : 0}
              className="pointer-events-none transition-opacity group-hover:opacity-100"
            />
            <text x={x + w / 2} y={H - 8} textAnchor="middle" fill="#a3a3ad" fontSize="10.5" className="pointer-events-none">
              W{i + 1}
            </text>
            {inProgress && (
              <text
                x={x + w / 2}
                y={Math.max(y - 5, PAD_T + 8)}
                textAnchor="middle"
                fill="#ff368d"
                fontSize="9"
                fontWeight="600"
                className="pointer-events-none"
              >
                in progress
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
