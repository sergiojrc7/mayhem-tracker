// Painel de contexto do score (Fase 2.2 do roadmap). Abre como drawer lateral ao
// clicar num jogador no placar expandido. Mostra o breakdown da nota na partida,
// comparação com o seu score, evolução ao longo do tempo, top partidas e médias
// por campeão. Para jogadores sem puuid (bots/anônimos), só o breakdown da partida.

import { useEffect } from "react";
import type { PlayerScoreContext, ChampionData } from "../lib/types";
import { useIpc } from "../hooks/useIpc";
import { getChampionName } from "../hooks/useChampions";
import ChampionIcon from "./ChampionIcon";
import { formatTimeAgo } from "../lib/format";

function scoreColor(score: number): string {
  if (score >= 70) return "text-lol-gold";
  if (score >= 40) return "text-sky-400";
  return "text-gray-400";
}

function barColor(score: number): string {
  if (score >= 70) return "#c89b3c";
  if (score >= 40) return "#7cb9e8";
  return "#6b7280";
}

const ROLE_LABEL: Record<string, string> = {
  Mage: "Mago",
  Marksman: "Atirador",
  Tank: "Tanque",
  Fighter: "Lutador",
  Support: "Suporte",
  Assassin: "Assassino",
};

export default function ScorePanel({
  gameId,
  participantId,
  champData,
  onClose,
}: {
  gameId: number;
  participantId: number;
  champData: ChampionData;
  onClose: () => void;
}) {
  const { data: ctx, loading } = useIpc<PlayerScoreContext | null>(
    () => window.api.getPlayerScoreContext(gameId, participantId),
    [gameId, participantId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      {/* Drawer */}
      <div className="fixed right-0 top-0 z-50 h-full w-[420px] max-w-[90vw] overflow-y-auto glass depth-inset border-l border-glass-border shadow-2xl">
        {loading && <div className="p-6 text-sm text-lol-text">Carregando…</div>}
        {!loading && !ctx && (
          <div className="p-6 text-sm text-lol-text">
            Sem dados de score para este jogador.
            <button onClick={onClose} className="ml-2 underline">
              Fechar
            </button>
          </div>
        )}
        {ctx && <PanelBody ctx={ctx} champData={champData} onClose={onClose} />}
      </div>
    </>
  );
}

function PanelBody({
  ctx,
  champData,
  onClose,
}: {
  ctx: PlayerScoreContext;
  champData: ChampionData;
  onClose: () => void;
}) {
  const bd = ctx.thisMatch;
  const score = bd.display;
  const diff = ctx.selfThisMatch != null ? score - ctx.selfThisMatch : null;

  return (
    <div className="p-4 space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <ChampionIcon championId={ctx.championId} size={44} />
        <div className="min-w-0 flex-1">
          <div
            className={`text-base font-bold truncate ${ctx.isSelf ? "text-lol-gold" : "text-lol-text-bright"}`}
          >
            {ctx.name}
            {ctx.isSelf && <span className="ml-2 text-[10px] uppercase opacity-70">você</span>}
          </div>
          <div className="text-xs text-lol-text">
            {getChampionName(champData, ctx.championId)}
            {bd.role && <> · {ROLE_LABEL[bd.role] ?? bd.role}</>}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-lol-text hover:text-lol-text-bright text-lg leading-none px-1"
          title="Fechar (Esc)"
        >
          ✕
        </button>
      </div>

      {/* Score + comparação */}
      <div className="flex items-center gap-4">
        <div className={`text-5xl font-bold ${scoreColor(score)}`}>{score}</div>
        <div className="text-xs text-lol-text space-y-0.5">
          <div>score desta partida</div>
          {diff != null && !ctx.isSelf && (
            <div>
              vs você:{" "}
              <span className={diff >= 0 ? "text-emerald-400" : "text-red-400"}>
                {diff >= 0 ? "+" : ""}
                {diff}
              </span>{" "}
              <span className="opacity-60">({ctx.selfThisMatch})</span>
            </div>
          )}
          <div className="opacity-60">tier ×{bd.tierMultiplier.toFixed(2)}</div>
        </div>
      </div>

      {/* Breakdown de componentes */}
      <div>
        <SectionTitle>Breakdown do score</SectionTitle>
        <ContributionBars bd={bd} />
        <div className="mt-2 text-[11px] text-lol-text flex flex-wrap gap-x-3 gap-y-0.5">
          <span>Damage share: {(bd.damageSharePct * 100).toFixed(0)}%</span>
          {bd.winApplied && <span className="text-emerald-400">+ bônus de vitória</span>}
        </div>
      </div>

      {/* Evolução */}
      {ctx.history.length >= 2 && (
        <div>
          <SectionTitle>
            Evolução do score{" "}
            <span className="opacity-60 font-normal">({ctx.sharedGames} partidas)</span>
          </SectionTitle>
          <EvolutionChart history={ctx.history} />
        </div>
      )}

      {/* Top partidas */}
      {ctx.topMatches.length > 0 && (
        <div>
          <SectionTitle>Top partidas</SectionTitle>
          <div className="space-y-1">
            {ctx.topMatches.map((m) => (
              <div
                key={m.game_id}
                className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1.5"
              >
                <ChampionIcon championId={m.champion_id} size={24} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-lol-text-bright truncate">
                    {getChampionName(champData, m.champion_id)}
                  </div>
                  <div className="text-[10px] text-lol-text">{formatTimeAgo(m.game_creation)}</div>
                </div>
                <span className={`text-sm font-bold ${m.win ? "" : "opacity-70"} ${scoreColor(m.score)}`}>
                  {m.score}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Campeões com maior score médio */}
      {ctx.championAverages.length > 0 && (
        <div>
          <SectionTitle>Melhores campeões (score médio)</SectionTitle>
          <div className="space-y-1">
            {ctx.championAverages.slice(0, 5).map((c) => (
              <div key={c.champion_id} className="flex items-center gap-2">
                <ChampionIcon championId={c.champion_id} size={22} />
                <span className="flex-1 text-xs text-lol-text-bright truncate">
                  {getChampionName(champData, c.champion_id)}
                </span>
                <span className="text-[10px] text-lol-text">{c.games}j</span>
                <span className={`w-8 text-right text-xs font-bold ${scoreColor(c.avgScore)}`}>
                  {c.avgScore}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-wider text-lol-text mb-2 font-semibold">
      {children}
    </div>
  );
}

const COMPONENT_META: { key: keyof PlayerScoreContext["thisMatch"]["contributions"]; label: string; color: string }[] = [
  { key: "kda", label: "KDA", color: "bg-amber-400/80" },
  { key: "damageShare", label: "Damage", color: "bg-red-500/80" },
  { key: "tankCredit", label: "Tank", color: "bg-sky-500/80" },
  { key: "healShare", label: "Heal", color: "bg-emerald-500/80" },
  { key: "goldEfficiency", label: "Gold", color: "bg-lol-gold/80" },
  { key: "multikill", label: "Multi", color: "bg-purple-500/80" },
];

function ContributionBars({ bd }: { bd: PlayerScoreContext["thisMatch"] }) {
  const max = Math.max(
    0.001,
    ...COMPONENT_META.map((m) => Math.abs(bd.contributions[m.key])),
  );
  return (
    <div className="space-y-1">
      {COMPONENT_META.map((m) => {
        const v = bd.contributions[m.key];
        const pct = Math.round((Math.abs(v) / max) * 100);
        return (
          <div key={m.key} className="flex items-center gap-2">
            <span className="text-[10px] text-lol-text w-12 shrink-0">{m.label}</span>
            <div className="flex-1 h-3 bg-white/5 rounded-sm overflow-hidden">
              <div className={`h-full rounded-sm ${m.color}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[10px] text-lol-text-bright w-9 text-right shrink-0">
              {(v * 100).toFixed(0)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function EvolutionChart({ history }: { history: PlayerScoreContext["history"] }) {
  const W = 388;
  const H = 110;
  const PAD = 6;
  const n = history.length;
  const xs = (i: number) => PAD + (i / Math.max(1, n - 1)) * (W - 2 * PAD);
  const ys = (s: number) => H - PAD - (s / 100) * (H - 2 * PAD);

  const points = history.map((h, i) => `${xs(i)},${ys(h.score)}`).join(" ");
  const avg = Math.round(history.reduce((a, h) => a + h.score, 0) / n);
  const last = history[n - 1].score;

  return (
    <div className="rounded-lg bg-white/[0.02] border border-lol-border p-2">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="block">
        {/* guias 40/70 */}
        {[40, 70].map((g) => (
          <line
            key={g}
            x1={PAD}
            x2={W - PAD}
            y1={ys(g)}
            y2={ys(g)}
            stroke="rgba(255,255,255,0.06)"
            strokeDasharray="3 3"
          />
        ))}
        {/* média */}
        <line
          x1={PAD}
          x2={W - PAD}
          y1={ys(avg)}
          y2={ys(avg)}
          stroke="rgba(200,155,60,0.4)"
          strokeWidth={1}
        />
        <polyline
          points={points}
          fill="none"
          stroke={barColor(last)}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        {history.map((h, i) => (
          <circle key={i} cx={xs(i)} cy={ys(h.score)} r={1.6} fill={barColor(h.score)} />
        ))}
      </svg>
      <div className="flex justify-between text-[10px] text-lol-text mt-1">
        <span>média {avg}</span>
        <span>último {last}</span>
      </div>
    </div>
  );
}
