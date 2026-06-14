// Mini gráfico de evolução do score (Fase 4.6). SVG nativo, sem dependências.
// Mostra as últimas N partidas em ordem cronológica com área preenchida + linha.

function color(score: number): string {
  if (score >= 70) return "#c89b3c";
  if (score >= 40) return "#7cb9e8";
  return "#6b7280";
}

export default function ScoreTrendChart({ scores }: { scores: number[] }) {
  const W = 640;
  const H = 96;
  const PAD = 8;
  const n = scores.length;

  if (n < 2) {
    return (
      <div className="text-xs text-lol-text">Sem partidas suficientes para o gráfico de evolução.</div>
    );
  }

  const xs = (i: number) => PAD + (i / (n - 1)) * (W - 2 * PAD);
  const ys = (s: number) => H - PAD - (s / 100) * (H - 2 * PAD);

  const line = scores.map((s, i) => `${xs(i)},${ys(s)}`).join(" ");
  const area = `${PAD},${H - PAD} ${line} ${W - PAD},${H - PAD}`;
  const avg = Math.round(scores.reduce((a, s) => a + s, 0) / n);
  const last = scores[n - 1];
  const stroke = color(last);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="block" preserveAspectRatio="none">
      <defs>
        <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* guias 40/70 */}
      {[40, 70].map((g) => (
        <line
          key={g}
          x1={PAD}
          x2={W - PAD}
          y1={ys(g)}
          y2={ys(g)}
          stroke="rgba(255,255,255,0.06)"
          strokeDasharray="4 4"
        />
      ))}
      {/* média */}
      <line
        x1={PAD}
        x2={W - PAD}
        y1={ys(avg)}
        y2={ys(avg)}
        stroke="rgba(200,155,60,0.35)"
        strokeWidth={1}
      />
      <polygon points={area} fill="url(#trendFill)" />
      <polyline points={line} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
      {scores.map((s, i) => (
        <circle key={i} cx={xs(i)} cy={ys(s)} r={1.8} fill={color(s)} />
      ))}
    </svg>
  );
}
