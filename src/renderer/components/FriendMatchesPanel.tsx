// Drawer com o histórico de partidas em que VOCÊ jogou junto com um amigo.
// Filtra o Match History por raw_json contendo o puuid do amigo (getMatchHistory
// com withPuuid) e lista a SUA performance (campeão, KDA, score) em cada partida.

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { MatchListItem, ChampionData } from "../lib/types";
import { useIpc } from "../hooks/useIpc";
import { getChampionName } from "../hooks/useChampions";
import ChampionIcon from "./ChampionIcon";
import ScoreBadge from "./ScoreBadge";
import { formatKDA, formatTimeAgo, kdaRatio } from "../lib/format";

export default function FriendMatchesPanel({
  puuid,
  name,
  champData,
  onClose,
}: {
  puuid: string;
  name: string;
  champData: ChampionData;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { data, loading } = useIpc<{ matches: MatchListItem[]; total: number }>(
    () => window.api.getMatchHistory(100, 0, { withPuuid: puuid }),
    [puuid],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const matches = data?.matches ?? [];
  const wins = matches.filter((m) => m.win && !m.is_remake).length;
  const played = matches.filter((m) => !m.is_remake).length;
  const winRate = played > 0 ? Math.round((wins / played) * 100) : 0;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div className="fixed right-0 top-0 z-50 h-full w-[460px] max-w-[92vw] overflow-y-auto glass depth-inset border-l border-glass-border shadow-2xl">
        <div className="p-4 space-y-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-base font-bold text-lol-text-bright truncate">{name}</div>
              <div className="text-xs text-lol-text">
                {played} partidas juntos · {winRate}% WR
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

          {loading && <div className="text-sm text-lol-text">Carregando…</div>}
          {!loading && matches.length === 0 && (
            <div className="text-sm text-lol-text">Nenhuma partida compartilhada encontrada.</div>
          )}

          <div className="space-y-1">
            {matches.map((m) => {
              const isRemake = !!m.is_remake;
              const isWin = !!m.win;
              const kda = kdaRatio(m.kills, m.deaths, m.assists);
              return (
                <div
                  key={m.game_id}
                  onClick={() => navigate("/", { state: { expandGameId: m.game_id } })}
                  title="Abrir partida completa no Match History"
                  className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-l-[3px] cursor-pointer transition-colors ${
                    isRemake
                      ? "bg-white/[0.03] border-white/10 border-l-white/25 hover:bg-white/[0.07]"
                      : isWin
                        ? "bg-lol-win/5 border-lol-win/20 border-l-lol-win hover:bg-lol-win/10"
                        : "bg-lol-loss/5 border-lol-loss/20 border-l-lol-loss hover:bg-lol-loss/10"
                  }`}
                >
                  <span
                    className={`text-[10px] font-bold w-7 shrink-0 ${isRemake ? "text-gray-500" : isWin ? "text-lol-win" : "text-lol-loss"}`}
                  >
                    {isRemake ? "RMK" : isWin ? "WIN" : "LOSS"}
                  </span>
                  <ChampionIcon championId={m.champion_id} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-lol-text-bright truncate">
                      {getChampionName(champData, m.champion_id)}
                    </div>
                    <div className="text-[10px] text-lol-text">
                      {formatKDA(m.kills, m.deaths, m.assists)} · {kda} KDA
                    </div>
                  </div>
                  <ScoreBadge score={m.score} />
                  <span className="text-[10px] text-lol-text w-14 text-right shrink-0">
                    {formatTimeAgo(m.game_creation)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
