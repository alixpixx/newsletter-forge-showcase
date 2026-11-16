/** Graphe aire envois/ouvertures — SVG statique (v1). À remplacer par Recharts + données live. */
export function EngagementChart() {
  return (
    <svg viewBox="0 0 720 220" className="block h-auto w-full" role="img" aria-label="Sends and opens over 8 weeks">
      <defs>
        <linearGradient id="fillOpens" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff368d" stopOpacity="0.18" />
          <stop offset="1" stopColor="#ff368d" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g stroke="#eeeef2" strokeWidth="1">
        <line x1="40" y1="30" x2="705" y2="30" />
        <line x1="40" y1="80" x2="705" y2="80" />
        <line x1="40" y1="130" x2="705" y2="130" />
        <line x1="40" y1="180" x2="705" y2="180" />
      </g>
      <g fill="#a3a3ad" fontSize="10" fontFamily="var(--font-mono)">
        <text x="8" y="34">40k</text>
        <text x="8" y="84">30k</text>
        <text x="8" y="134">20k</text>
        <text x="8" y="184">10k</text>
      </g>
      <path d="M40,150 L135,142 L230,148 L325,120 L420,112 L515,120 L610,96 L705,88" fill="none" stroke="#c9c9d2" strokeWidth="2" strokeLinecap="round" />
      <path d="M40,158 L135,150 L230,155 L325,128 L420,110 L515,116 L610,82 L705,66 L705,180 L40,180 Z" fill="url(#fillOpens)" />
      <path d="M40,158 L135,150 L230,155 L325,128 L420,110 L515,116 L610,82 L705,66" fill="none" stroke="#ff368d" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="705" cy="66" r="4.5" fill="#ff368d" stroke="#fff" strokeWidth="2" />
      <g fill="#a3a3ad" fontSize="10.5">
        <text x="30" y="200">W1</text><text x="125" y="200">W2</text><text x="220" y="200">W3</text><text x="315" y="200">W4</text>
        <text x="410" y="200">W5</text><text x="505" y="200">W6</text><text x="600" y="200">W7</text><text x="695" y="200">W8</text>
      </g>
    </svg>
  );
}
