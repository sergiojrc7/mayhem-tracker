// Fase 4.7 — Score Tuning. Ajuste dos pesos dos componentes do score (sliders),
// force-refresh da tier list e visualização da tier list atual.
//
// Pesos são persistidos em settings.score_weights (JSON). Após salvar chamamos
// recomputeScores(), que recalcula todas as partidas e emite games-updated → a UI
// (Match History, Champions…) atualiza sozinha.

import { useEffect, useState, useCallback } from "react";
import { useChampionData, getChampionName } from "../hooks/useChampions";

// Espelha DEFAULT_WEIGHTS de src/main/score.ts (componentes ajustáveis).
const DEFAULTS = {
  kda: 0.25,
  damageShare: 0.25,
  tankCredit: 0.15,
  healShare: 0.15,
  goldEfficiency: 0.1,
  winBonus: 0.1,
};

type Weights = typeof DEFAULTS;

const FIELDS: { key: keyof Weights; label: string; hint: string }[] = [
  { key: "kda", label: "KDA", hint: "(K + A×0.7) / mortes" },
  { key: "damageShare", label: "Damage Share", hint: "dano vs. média do time" },
  { key: "tankCredit", label: "Tank Credit", hint: "dano sofrido vs. time" },
  { key: "healShare", label: "Heal Share", hint: "cura vs. time" },
  { key: "goldEfficiency", label: "Gold Efficiency", hint: "ouro vs. média da partida" },
  { key: "winBonus", label: "Win Bonus", hint: "bônus multiplicativo em vitórias" },
];

function tierColor(tier: string): string {
  switch (tier) {
    case "S":
      return "text-lol-gold";
    case "A":
      return "text-emerald-400";
    case "B":
      return "text-sky-400";
    case "C":
      return "text-amber-400";
    default:
      return "text-red-400";
  }
}

export default function ScoreTuning() {
  const champData = useChampionData();
  const [weights, setWeights] = useState<Weights>(DEFAULTS);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [tierStatus, setTierStatus] = useState<string | null>(null);
  const [showTiers, setShowTiers] = useState(false);
  const [tiers, setTiers] = useState<
    { champion_id: number; tier: string; multiplier: number }[] | null
  >(null);

  useEffect(() => {
    window.api.getSetting("score_weights").then((raw) => {
      if (!raw) return;
      try {
        setWeights({ ...DEFAULTS, ...JSON.parse(raw) });
      } catch {
        /* keep defaults */
      }
    });
  }, []);

  const set = (key: keyof Weights, value: number) => {
    setWeights((w) => ({ ...w, [key]: value }));
    setDirty(true);
    setStatus(null);
  };

  const handleSave = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    try {
      await window.api.setSetting("score_weights", JSON.stringify(weights));
      const updated = await window.api.recomputeScores();
      setStatus(`Pesos salvos. ${updated} partidas recalculadas.`);
      setDirty(false);
    } catch (err: any) {
      setStatus(`Erro: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }, [weights]);

  const handleReset = useCallback(() => {
    setWeights(DEFAULTS);
    setDirty(true);
    setStatus(null);
  }, []);

  const loadTiers = useCallback(async () => {
    const list = await window.api.getTierList();
    list.sort((a, b) => a.multiplier - b.multiplier);
    setTiers(list);
  }, []);

  const handleToggleTiers = useCallback(async () => {
    const next = !showTiers;
    setShowTiers(next);
    if (next && !tiers) await loadTiers();
  }, [showTiers, tiers, loadTiers]);

  const handleRefreshTiers = useCallback(async () => {
    setBusy(true);
    setTierStatus(null);
    try {
      const count = await window.api.refreshTiers();
      setTierStatus(`Tier list atualizada: ${count} campeões. Scores recalculados.`);
      await loadTiers();
    } catch (err: any) {
      setTierStatus(`Erro: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }, [loadTiers]);

  return (
    <div className="glass rounded-xl p-5">
      <h2 className="text-sm font-semibold text-lol-text-bright mb-1">Score Tuning</h2>
      <p className="text-xs text-lol-text mb-4">
        Ajuste o peso de cada componente do score. Ao salvar, todas as partidas são recalculadas.
      </p>

      <div className="space-y-3">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-lol-text-bright">
                {f.label} <span className="text-[11px] text-lol-text">· {f.hint}</span>
              </span>
              <span className="text-xs font-mono text-lol-gold w-10 text-right">
                {weights[f.key].toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={f.key === "winBonus" ? 0.5 : 0.6}
              step={0.01}
              value={weights[f.key]}
              onChange={(e) => set(f.key, Number(e.target.value))}
              className="w-full accent-lol-gold"
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 mt-4">
        <button
          onClick={handleSave}
          disabled={busy || !dirty}
          className="px-4 py-1.5 rounded text-sm bg-lol-gold/20 text-lol-gold hover:bg-lol-gold/30 disabled:opacity-40 transition-colors"
        >
          {busy ? "Salvando…" : "Salvar e recalcular"}
        </button>
        <button
          onClick={handleReset}
          disabled={busy}
          className="px-4 py-1.5 rounded text-sm text-lol-text hover:text-lol-text-bright transition-colors"
        >
          Restaurar padrões
        </button>
        {status && <span className="text-xs text-lol-text">{status}</span>}
      </div>

      {/* Tier list */}
      <div className="border-t border-lol-border mt-5 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-lol-text-bright">Tier list (ARAM Mayhem)</p>
            <p className="text-xs text-lol-text mt-0.5">
              Fonte Blitz/iesdev · cache 24h · multiplicador penaliza campeões fortes.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleToggleTiers}
              className="px-3 py-1.5 rounded text-sm text-lol-text hover:text-lol-text-bright transition-colors"
            >
              {showTiers ? "Ocultar" : "Ver tier list"}
            </button>
            <button
              onClick={handleRefreshTiers}
              disabled={busy}
              className="px-4 py-1.5 rounded text-sm bg-lol-gold/20 text-lol-gold hover:bg-lol-gold/30 disabled:opacity-40 transition-colors"
            >
              Forçar refresh
            </button>
          </div>
        </div>
        {tierStatus && <p className="text-xs text-lol-text mt-2">{tierStatus}</p>}

        {showTiers && (
          <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-lol-border">
            {!tiers && <div className="p-3 text-xs text-lol-text">Carregando…</div>}
            {tiers && tiers.length === 0 && (
              <div className="p-3 text-xs text-lol-text">
                Tier list ainda não carregada. Use "Forçar refresh".
              </div>
            )}
            {tiers && tiers.length > 0 && (
              <table className="w-full text-xs">
                <thead className="bg-lol-dark/50 sticky top-0">
                  <tr>
                    <th className="px-3 py-1.5 text-left text-lol-text uppercase tracking-wider">
                      Campeão
                    </th>
                    <th className="px-3 py-1.5 text-center text-lol-text uppercase tracking-wider">
                      Tier
                    </th>
                    <th className="px-3 py-1.5 text-right text-lol-text uppercase tracking-wider">
                      Multiplicador
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((t) => (
                    <tr key={t.champion_id} className="border-t border-lol-border/40">
                      <td className="px-3 py-1.5 text-lol-text-bright">
                        {getChampionName(champData, t.champion_id)}
                      </td>
                      <td className={`px-3 py-1.5 text-center font-bold ${tierColor(t.tier)}`}>
                        {t.tier}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-lol-text">
                        ×{t.multiplier.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
