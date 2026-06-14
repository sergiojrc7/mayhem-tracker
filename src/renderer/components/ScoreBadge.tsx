// Badge de score na linha do Match History. Escala 0–100 (Fase 1.4):
// ≥70 alto (gold), 40–69 médio (azul), <40 baixo (cinza).
// Fase 3.5: badge com glow sutil + shimmer dourado nas notas altas.

export default function ScoreBadge({ score }: { score: number | null }) {
  if (score == null) return null;

  const high = score >= 70;
  const tone = high
    ? "text-lol-gold border-lol-gold/40 bg-lol-gold/10 shadow-[0_0_14px_-4px_rgba(200,155,60,0.7)]"
    : score >= 40
      ? "text-sky-400 border-sky-400/30 bg-sky-400/10"
      : "text-gray-400 border-gray-500/30 bg-gray-500/10";

  return (
    <div
      className={`relative shrink-0 w-12 text-center rounded-md border px-1 py-1 overflow-hidden ${tone}`}
      title="Score da partida (0–100): base × papel do campeão × tier ARAM Mayhem. Clique num jogador no placar para o breakdown."
    >
      {high && <div className="shimmer-gold pointer-events-none absolute inset-0" />}
      <div className="relative text-sm font-bold leading-none">{score}</div>
      <div className="relative text-[8px] uppercase tracking-wider opacity-70 mt-0.5">score</div>
    </div>
  );
}
