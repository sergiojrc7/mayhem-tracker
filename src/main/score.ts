// Scoring engine — Fase 1 do roadmap.
//
// Funções PURAS e sem efeitos colaterais (sem DB, sem rede): recebem o raw_json
// de uma partida + o puuid do jogador e devolvem um número. Isso mantém a lógica
// testável e reutilizável tanto no insert quanto no backfill/recompute.
//
// O valor produzido aqui é o "score composto BRUTO" (pré-normalização). A escala
// final 0–100 é um percentil calculado em tempo de leitura sobre todas as partidas
// do usuário (Fase 1.4) — por isso não vive aqui nem é persistida.
//
// Inc 1 cobre apenas o Base Score (1.1). Role Weight (1.2) e Tier Multiplier (1.3)
// entram como multiplicadores identidade (1.0) e serão preenchidos nos próximos
// incrementos sem alterar os call sites.

export interface ScoreWeights {
  kda: number;
  damageShare: number;
  tankCredit: number;
  healShare: number;
  goldEfficiency: number;
  /** Bônus multiplicativo aplicado em vitórias (0.10 => +10%). */
  winBonus: number;
  /** Adições flat ao composto por multikill. */
  multikill: {
    double: number;
    triple: number;
    quadra: number;
    penta: number;
  };
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  kda: 0.25,
  damageShare: 0.25,
  tankCredit: 0.15,
  healShare: 0.15,
  goldEfficiency: 0.1,
  winBonus: 0.1,
  multikill: { double: 0.02, triple: 0.05, quadra: 0.1, penta: 0.2 },
};

// Converte o score composto BRUTO (centrado em ~1.0 = desempenho médio) para a
// escala 0–100 (Fase 1.4). Usamos uma logística ABSOLUTA centrada em 1.0 → 50:
// régua única para TODOS os jogadores (comparável dentro e entre partidas), sem
// clamp artificial nos extremos. k controla a dispersão (~0.5→27, 1.5→73, 2.0→88).
export function toDisplayScore(raw: number): number {
  const k = 2.0;
  const v = 100 / (1 + Math.exp(-k * (raw - 1.0)));
  return Math.round(Math.max(0, Math.min(100, v)));
}

interface NormalizedParticipant {
  participantId: number;
  championId: number;
  puuid: string | null;
  teamId: number;
  kills: number;
  deaths: number;
  assists: number;
  doubleKills: number;
  tripleKills: number;
  quadraKills: number;
  pentaKills: number;
  damage: number;
  taken: number;
  heal: number;
  gold: number;
  win: boolean;
}

/** KDA ponderado do roadmap: (K + A×0.7) / max(D, 1). */
function weightedKda(p: NormalizedParticipant): number {
  return (p.kills + p.assists * 0.7) / Math.max(p.deaths, 1);
}

// Resolve o papel principal de um campeão (Fase 1.2). Injetado de fora (dragon.ts)
// para manter este módulo puro/testável. Null => sem ajuste de papel.
export type RoleResolver = (championId: number) => string | null;

// Resolvers externos injetados no motor (mantém este módulo puro/testável):
// - roleOf: papel do campeão (Fase 1.2, de dragon.ts)
// - tierOf: multiplicador de tier ARAM Mayhem (Fase 1.3, de tiers.ts) — campeão
//   forte multiplica < 1.0 (penaliza), fraco > 1.0 (premia). Default 1.0.
export interface ScoreResolvers {
  roleOf?: RoleResolver;
  tierOf?: (championId: number) => number;
}

// Multiplicadores por papel aplicados sobre os pesos base. As 5 componentes
// principais são renormalizadas depois (preservam a soma original), então o papel
// REDISTRIBUI a ênfase sem inflar/deflacionar o score. `multikill` escala o bônus.
const ROLE_MULTIPLIERS: Record<
  string,
  { kda: number; damageShare: number; tankCredit: number; healShare: number; goldEfficiency: number; multikill: number }
> = {
  Mage: { kda: 0.8, damageShare: 1.6, tankCredit: 0.6, healShare: 0.7, goldEfficiency: 1.1, multikill: 1.0 },
  Marksman: { kda: 0.8, damageShare: 1.6, tankCredit: 0.6, healShare: 0.7, goldEfficiency: 1.1, multikill: 1.0 },
  Tank: { kda: 0.8, damageShare: 0.7, tankCredit: 1.9, healShare: 0.8, goldEfficiency: 1.0, multikill: 0.9 },
  Fighter: { kda: 0.9, damageShare: 0.9, tankCredit: 1.6, healShare: 0.7, goldEfficiency: 1.0, multikill: 1.0 },
  Support: { kda: 0.7, damageShare: 0.5, tankCredit: 1.0, healShare: 2.0, goldEfficiency: 1.0, multikill: 0.9 },
  Assassin: { kda: 1.6, damageShare: 1.1, tankCredit: 0.5, healShare: 0.5, goldEfficiency: 1.0, multikill: 1.5 },
};

function applyRole(weights: ScoreWeights, role: string | null): ScoreWeights {
  const m = role ? ROLE_MULTIPLIERS[role] : undefined;
  if (!m) return weights;

  const adj = {
    kda: weights.kda * m.kda,
    damageShare: weights.damageShare * m.damageShare,
    tankCredit: weights.tankCredit * m.tankCredit,
    healShare: weights.healShare * m.healShare,
    goldEfficiency: weights.goldEfficiency * m.goldEfficiency,
  };
  const origSum =
    weights.kda + weights.damageShare + weights.tankCredit + weights.healShare + weights.goldEfficiency;
  const newSum = adj.kda + adj.damageShare + adj.tankCredit + adj.healShare + adj.goldEfficiency;
  const k = newSum > 0 ? origSum / newSum : 1;

  return {
    kda: adj.kda * k,
    damageShare: adj.damageShare * k,
    tankCredit: adj.tankCredit * k,
    healShare: adj.healShare * k,
    goldEfficiency: adj.goldEfficiency * k,
    winBonus: weights.winBonus,
    multikill: {
      double: weights.multikill.double * m.multikill,
      triple: weights.multikill.triple * m.multikill,
      quadra: weights.multikill.quadra * m.multikill,
      penta: weights.multikill.penta * m.multikill,
    },
  };
}

function normalizeParticipants(raw: any): NormalizedParticipant[] {
  if (!raw?.participants) return [];
  const participants = raw.participants;
  const identities = raw.participantIdentities || [];

  return participants.map((p: any, i: number): NormalizedParticipant => {
    const s = p.stats || p;
    const identity = identities[i];
    return {
      participantId: p.participantId ?? i + 1,
      championId: p.championId ?? s.championId ?? 0,
      puuid: p.puuid || identity?.player?.puuid || null,
      teamId: p.teamId ?? 100,
      kills: s.kills ?? 0,
      deaths: s.deaths ?? 0,
      assists: s.assists ?? 0,
      doubleKills: s.doubleKills ?? 0,
      tripleKills: s.tripleKills ?? 0,
      quadraKills: s.quadraKills ?? 0,
      pentaKills: s.pentaKills ?? 0,
      damage: s.totalDamageDealtToChampions ?? s.totalDamageDealt ?? 0,
      taken: s.totalDamageTaken ?? 0,
      heal: s.totalHeal ?? 0,
      gold: s.goldEarned ?? 0,
      win: !!s.win,
    };
  });
}

/**
 * Cada componente é centrado em ~1.0 = "contribuição média", dividindo pelo
 * valor médio do grupo de referência (time, para as shares; partida, para KDA e
 * gold). Assim os componentes de escalas diferentes ficam comparáveis e o peso
 * percentual do roadmap se aplica diretamente. A magnitude absoluta do composto
 * não importa para correção — apenas a ordenação relativa, já que a Fase 1.4
 * normaliza por percentil na leitura.
 */
export function computeBaseScore(
  raw: any,
  puuid: string,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  resolvers?: ScoreResolvers,
): number | null {
  const all = normalizeParticipants(raw);
  if (all.length === 0) return null;

  const self = all.find((p) => p.puuid === puuid);
  if (!self) return null;

  return scoreParticipant(self, all, weights, resolvers);
}

/**
 * Score de TODOS os participantes de uma partida, keyed por participantId.
 * Usado no placar expandido (mostrar nota de cada jogador) e, na Fase 2, no
 * leaderboard de amigos. Deriva do raw_json — não persiste.
 */
export function computeAllParticipantScores(
  raw: any,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  resolvers?: ScoreResolvers,
): Record<number, number> {
  const all = normalizeParticipants(raw);
  const out: Record<number, number> = {};
  for (const p of all) {
    out[p.participantId] = scoreParticipant(p, all, weights, resolvers);
  }
  return out;
}

// Detalhamento do score de um participante (Fase 2.2). Expõe a contribuição de
// cada componente para explicar a nota — usado no Painel de contexto do score.
export interface ScoreBreakdown {
  /** Papel resolvido do campeão (ou null se desconhecido). */
  role: string | null;
  /** Multiplicador de tier ARAM Mayhem aplicado (1.0 = neutro). */
  tierMultiplier: number;
  /** Bônus de vitória aplicado? */
  winApplied: boolean;
  /** Composto bruto final (pós win + tier). */
  composite: number;
  /** Score 0–100 derivado. */
  display: number;
  /**
   * Contribuição de cada componente em "pontos" do composto bruto, JÁ na mesma
   * proporção do composite final (inclui win bonus + tier rateados). Somam ~composite.
   */
  contributions: {
    kda: number;
    damageShare: number;
    tankCredit: number;
    healShare: number;
    goldEfficiency: number;
    multikill: number;
  };
  /** Razões cruas (1.0 = média do grupo de referência) para exibição. */
  ratios: {
    kda: number;
    damageShare: number;
    tankCredit: number;
    healShare: number;
    goldEfficiency: number;
  };
  /** Damage share real do jogador no time (0–1), para exibição direta. */
  damageSharePct: number;
}

function breakdownParticipant(
  self: NormalizedParticipant,
  all: NormalizedParticipant[],
  baseWeights: ScoreWeights,
  resolvers?: ScoreResolvers,
): ScoreBreakdown {
  const role = resolvers?.roleOf ? resolvers.roleOf(self.championId) : null;
  const weights = applyRole(baseWeights, role);
  const team = all.filter((p) => p.teamId === self.teamId);
  const teamCount = team.length || 1;

  const teamTotalDamage = team.reduce((sum, p) => sum + p.damage, 0);
  const teamAvgDamage = teamTotalDamage / teamCount;
  const teamAvgTaken = team.reduce((sum, p) => sum + p.taken, 0) / teamCount;
  const teamAvgHeal = team.reduce((sum, p) => sum + p.heal, 0) / teamCount;
  const matchAvgGold = all.reduce((sum, p) => sum + p.gold, 0) / all.length;
  const matchAvgKda = all.reduce((sum, p) => sum + weightedKda(p), 0) / all.length;

  const kdaComp = matchAvgKda > 0 ? weightedKda(self) / matchAvgKda : 0;
  const damageComp = teamAvgDamage > 0 ? self.damage / teamAvgDamage : 0;
  const tankComp = teamAvgTaken > 0 ? self.taken / teamAvgTaken : 0;
  const healComp = teamAvgHeal > 0 ? self.heal / teamAvgHeal : 0;
  const goldComp = matchAvgGold > 0 ? self.gold / matchAvgGold : 0;

  // Contribuições brutas (pré win/tier) por componente.
  const cKda = weights.kda * kdaComp;
  const cDamage = weights.damageShare * damageComp;
  const cTank = weights.tankCredit * tankComp;
  const cHeal = weights.healShare * healComp;
  const cGold = weights.goldEfficiency * goldComp;
  const cMulti =
    self.doubleKills * weights.multikill.double +
    self.tripleKills * weights.multikill.triple +
    self.quadraKills * weights.multikill.quadra +
    self.pentaKills * weights.multikill.penta;

  const baseComposite = cKda + cDamage + cTank + cHeal + cGold + cMulti;

  const winApplied = self.win;
  const winMult = winApplied ? 1 + weights.winBonus : 1;
  const tierMult = resolvers?.tierOf ? resolvers.tierOf(self.championId) : 1;
  const scale = winMult * tierMult;
  const composite = baseComposite * scale;

  return {
    role,
    tierMultiplier: tierMult,
    winApplied,
    composite,
    display: toDisplayScore(composite),
    // Rateia win + tier em cada contribuição para que somem o composite final.
    contributions: {
      kda: cKda * scale,
      damageShare: cDamage * scale,
      tankCredit: cTank * scale,
      healShare: cHeal * scale,
      goldEfficiency: cGold * scale,
      multikill: cMulti * scale,
    },
    ratios: {
      kda: kdaComp,
      damageShare: damageComp,
      tankCredit: tankComp,
      healShare: healComp,
      goldEfficiency: goldComp,
    },
    damageSharePct: teamTotalDamage > 0 ? self.damage / teamTotalDamage : 0,
  };
}

function scoreParticipant(
  self: NormalizedParticipant,
  all: NormalizedParticipant[],
  baseWeights: ScoreWeights,
  resolvers?: ScoreResolvers,
): number {
  return breakdownParticipant(self, all, baseWeights, resolvers).composite;
}

/**
 * Detalhamento do score de um participante específico de uma partida (Fase 2.2).
 * Resolve por `puuid` (preferido) ou `participantId`. Retorna null se não achar.
 */
export function explainScore(
  raw: any,
  ref: { puuid?: string | null; participantId?: number },
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  resolvers?: ScoreResolvers,
): ScoreBreakdown | null {
  const all = normalizeParticipants(raw);
  if (all.length === 0) return null;
  const self =
    (ref.puuid ? all.find((p) => p.puuid === ref.puuid) : undefined) ??
    (ref.participantId != null
      ? all.find((p) => p.participantId === ref.participantId)
      : undefined);
  if (!self) return null;
  return breakdownParticipant(self, all, weights, resolvers);
}
