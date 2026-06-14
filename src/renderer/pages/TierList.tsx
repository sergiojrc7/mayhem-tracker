// Aba Tier List (cópia da ARAM Mayhem tier list da Blitz). Mostra os campeões
// agrupados por tier (S→D) com thumbnail + o multiplicador de tier aplicado no
// score. Dados de window.api.getTierList() (cache em champion_tiers, fonte iesdev).

import { useState, useCallback, useEffect } from "react";
import { useIpc } from "../hooks/useIpc";
import { useChampionData, getChampionName } from "../hooks/useChampions";
import ChampionIcon from "../components/ChampionIcon";

interface TierRow {
  champion_id: number;
  tier: string;
  multiplier: number;
}

// Ordem e estilo por tier. Multiplicador < 1 penaliza campeão forte (Fase 1.3).
const TIER_ORDER = ["S", "A", "B", "C", "D"];
const TIER_STYLE: Record<string, { label: string; ring: string; text: string; bg: string }> = {
  S: { label: "S", ring: "border-lol-gold", text: "text-lol-gold", bg: "bg-lol-gold/10" },
  A: { label: "A", ring: "border-emerald-400", text: "text-emerald-400", bg: "bg-emerald-400/10" },
  B: { label: "B", ring: "border-sky-400", text: "text-sky-400", bg: "bg-sky-400/10" },
  C: { label: "C", ring: "border-amber-400", text: "text-amber-400", bg: "bg-amber-400/10" },
  D: { label: "D", ring: "border-red-400", text: "text-red-400", bg: "bg-red-400/10" },
};

export default function TierList() {
  const champData = useChampionData();
  const { data, loading, refetch } = useIpc<TierRow[]>(() => window.api.getTierList());
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const unsub = window.api.onGamesUpdated(() => refetch());
    return unsub;
  }, [refetch]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setStatus(null);
    try {
      const count = await window.api.refreshTiers();
      setStatus(`Atualizada: ${count} campeões.`);
      await refetch();
    } catch (err: any) {
      setStatus(`Erro: ${err.message}`);
    } finally {
      setRefreshing(false);
    }
  }, [refetch]);

  const byTier = new Map<string, TierRow[]>();
  for (const row of data ?? []) {
    if (!byTier.has(row.tier)) byTier.set(row.tier, []);
    byTier.get(row.tier)!.push(row);
  }
  for (const list of byTier.values()) {
    list.sort((a, b) =>
      getChampionName(champData, a.champion_id).localeCompare(
        getChampionName(champData, b.champion_id),
      ),
    );
  }

  const tiers = TIER_ORDER.filter((t) => byTier.has(t));

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-lol-text-bright">Tier List</h1>
          <span className="text-sm text-lol-text">ARAM Mayhem · {data?.length ?? 0} campeões</span>
        </div>
        <div className="flex items-center gap-2">
          {status && <span className="text-xs text-lol-text">{status}</span>}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="text-xs px-3 py-1.5 rounded bg-lol-gold/20 text-lol-gold hover:bg-lol-gold/30 disabled:opacity-50 transition-colors"
          >
            {refreshing ? "Atualizando…" : "Atualizar"}
          </button>
        </div>
      </div>

      <p className="text-xs text-lol-text">
        O multiplicador de tier penaliza campeões fortes (×&lt;1) e premia os fracos (×&gt;1) no
        cálculo do score. Fonte: Blitz/iesdev (cache 24h).
      </p>

      {loading && <div className="text-lol-text text-center mt-20">Loading...</div>}

      {!loading && tiers.length === 0 && (
        <div className="glass rounded-xl p-8 text-center text-lol-text">
          Tier list ainda não carregada. Clique em "Atualizar".
        </div>
      )}

      {tiers.map((tier) => {
        const st = TIER_STYLE[tier] ?? TIER_STYLE.B;
        const list = byTier.get(tier)!;
        return (
          <div key={tier} className="glass rounded-xl overflow-hidden">
            <div className={`flex items-center gap-3 px-4 py-2 border-b border-glass-border ${st.bg}`}>
              <span
                className={`flex items-center justify-center w-8 h-8 rounded-lg border-2 ${st.ring} ${st.text} font-bold text-lg`}
              >
                {st.label}
              </span>
              <span className="text-sm text-lol-text-bright font-semibold">Tier {tier}</span>
              <span className="text-xs text-lol-text">×{list[0].multiplier.toFixed(2)}</span>
              <span className="text-xs text-lol-text ml-auto">{list.length}</span>
            </div>
            <div className="flex flex-wrap gap-2 p-3">
              {list.map((c) => (
                <div
                  key={c.champion_id}
                  className="group relative flex flex-col items-center w-14"
                  title={`${getChampionName(champData, c.champion_id)} · Tier ${tier} · ×${c.multiplier.toFixed(2)}`}
                >
                  <ChampionIcon championId={c.champion_id} size={44} className={`border-2 ${st.ring}`} />
                  <span className="mt-1 text-[10px] text-lol-text truncate w-full text-center">
                    {getChampionName(champData, c.champion_id)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
