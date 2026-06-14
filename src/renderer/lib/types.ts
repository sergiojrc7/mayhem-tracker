export interface GameRecord {
  game_id: number;
  queue_id: number;
  game_mode: string;
  game_creation: number;
  game_duration: number;
  puuid?: string;
  raw_json?: string;
}

export interface PlayerStatsRecord {
  game_id: number;
  champion_id: number;
  win: number;
  kills: number;
  deaths: number;
  assists: number;
  double_kills: number;
  triple_kills: number;
  quadra_kills: number;
  penta_kills: number;
  total_damage_dealt: number;
  total_damage_taken: number;
  gold_earned: number;
  total_heal: number;
  largest_killing_spree: number;
  item0: number | null;
  item1: number | null;
  item2: number | null;
  item3: number | null;
  item4: number | null;
  item5: number | null;
  item6: number | null;
}

export interface GameAugment {
  game_id: number;
  slot: number;
  augment_id: number;
}

export interface MatchListItem {
  game_id: number;
  game_creation: number;
  game_duration: number;
  is_remake: number;
  champion_id: number;
  win: number;
  kills: number;
  deaths: number;
  assists: number;
  double_kills: number;
  triple_kills: number;
  quadra_kills: number;
  penta_kills: number;
  total_damage_dealt: number;
  total_damage_taken: number;
  total_heal: number;
  gold_earned: number;
  score: number | null;
  item0: number | null;
  item1: number | null;
  item2: number | null;
  item3: number | null;
  item4: number | null;
  item5: number | null;
  augment_ids: string | null;
  game_max_dmg: number;
  game_max_taken: number;
  game_max_heal: number;
}

export interface MatchDetail {
  game: GameRecord;
  stats: PlayerStatsRecord;
  augments: GameAugment[];
  raw: any;
  scores: Record<number, number>;
}

export interface ChampionStats {
  champion_id: number;
  games: number;
  wins: number;
  kills: number;
  deaths: number;
  assists: number;
  avg_kills: number;
  avg_deaths: number;
  avg_assists: number;
  avg_damage: number;
  avg_gold: number;
  avg_score: number | null;
  double_kills: number;
  triple_kills: number;
  quadra_kills: number;
  penta_kills: number;
}

export interface AugmentStats {
  augment_id: number;
  picks: number;
  wins: number;
}

export interface ItemStats {
  item_id: number;
  picks: number;
  wins: number;
}

export interface AugmentStatsDetailed {
  augment_id: number;
  picks: number;
  wins: number;
  synergyScore: number | null;
  champions: { champion_id: number; picks: number; wins: number }[];
}

export interface DashboardData {
  totalGames: number;
  wins: number;
  totalKills: number;
  totalDeaths: number;
  totalAssists: number;
  recentForm: { win: number; game_id: number }[];
  topChampions: ChampionStats[];
  multikills: {
    doubles: number;
    triples: number;
    quadras: number;
    pentas: number;
  };
  topAugments: AugmentStats[];
  scoreTrend: number[];
}

export interface ChampionData {
  [id: number]: {
    name: string;
    key: string;
  };
}

export interface AugmentData {
  [id: number]: {
    name: string;
    desc: string;
    iconPath: string;
    rarity: string;
  };
}

export interface TeammateStats {
  name: string;
  puuid: string | null;
  games: number;
  wins: number;
  kills: number;
  deaths: number;
  assists: number;
  champions: { champion_id: number; games: number }[];
  lastPlayed: number;
  avgScore: number | null;
  avgSelfScore: number | null;
}

export interface GlobalStats {
  champions: { champion_id: number; games: number; wins: number }[];
  augments: { augment_id: number; picks: number; wins: number }[];
  totalParticipantSlots: number;
}

export interface ParsedParticipant {
  participantId: number;
  championId: number;
  teamId: number;
  puuid: string | null;
  summonerName: string;
  kills: number;
  deaths: number;
  assists: number;
  doubleKills: number;
  tripleKills: number;
  quadraKills: number;
  pentaKills: number;
  totalDamageDealtToChampions: number;
  totalDamageTaken: number;
  goldEarned: number;
  totalHeal: number;
  largestKillingSpree: number;
  items: number[];
  augments: number[];
  win: boolean;
  isSelf: boolean;
}

export interface ScoreBreakdown {
  role: string | null;
  tierMultiplier: number;
  winApplied: boolean;
  composite: number;
  display: number;
  contributions: {
    kda: number;
    damageShare: number;
    tankCredit: number;
    healShare: number;
    goldEfficiency: number;
    multikill: number;
  };
  ratios: {
    kda: number;
    damageShare: number;
    tankCredit: number;
    healShare: number;
    goldEfficiency: number;
  };
  damageSharePct: number;
}

export interface PlayerScoreContext {
  name: string;
  puuid: string | null;
  championId: number;
  isSelf: boolean;
  thisMatch: ScoreBreakdown;
  selfThisMatch: number | null;
  history: { game_id: number; game_creation: number; score: number; champion_id: number; win: number }[];
  topMatches: { game_id: number; game_creation: number; score: number; champion_id: number; win: number }[];
  championAverages: { champion_id: number; games: number; avgScore: number }[];
  sharedGames: number;
}

export interface MatchFilters {
  championId?: number;
  result?: "win" | "loss";
  days?: number;
  sort?: "recent" | "score";
  withPuuid?: string;
}

export type LcuStatus = "disconnected" | "connecting" | "connected";

export interface ElectronAPI {
  getMatchHistory: (
    limit: number,
    offset: number,
    filters?: MatchFilters,
  ) => Promise<{ matches: MatchListItem[]; total: number }>;
  getMatchDetail: (gameId: number) => Promise<MatchDetail>;
  getPlayerScoreContext: (
    gameId: number,
    participantId: number,
  ) => Promise<PlayerScoreContext | null>;
  getChampionStats: () => Promise<ChampionStats[]>;
  getAugmentStats: (championId?: number) => Promise<AugmentStats[]>;
  getAugmentStatsDetailed: () => Promise<AugmentStatsDetailed[]>;
  getDashboard: () => Promise<DashboardData>;
  getChampionMatchHistory: (
    championId: number,
    limit: number,
    offset: number,
  ) => Promise<{ matches: MatchListItem[]; total: number }>;
  getChampionItemStats: (championId: number) => Promise<ItemStats[]>;
  getTeammateStats: () => Promise<TeammateStats[]>;
  getGlobalStats: () => Promise<GlobalStats>;
  getSummonerPuuid: () => Promise<string | null>;
  getAllSummonerPuuids: () => Promise<string[]>;
  refreshGames: () => Promise<{ newGames: number; totalGames: number }>;
  getLcuStatus: () => Promise<LcuStatus>;
  getChampionData: () => Promise<ChampionData>;
  getAugmentData: () => Promise<AugmentData>;
  onStatusChanged: (callback: (status: LcuStatus) => void) => () => void;
  onGamesUpdated: (callback: () => void) => () => void;
  recomputeScores: () => Promise<number>;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<void>;
  exportData: () => Promise<{ success: boolean; path?: string }>;
  importData: () => Promise<{ success: boolean; imported?: number }>;
  repairPuuids: () => Promise<{ repairedGames: number; discoveredAccounts: number }>;
  getTierList: () => Promise<{ champion_id: number; tier: string; multiplier: number }[]>;
  refreshTiers: () => Promise<number>;
  getVersion: () => Promise<string>;
  checkForUpdate: () => Promise<{
    hasUpdate: boolean;
    latest?: string;
    current?: string;
    url?: string;
    error?: string;
  }>;
  openUrl: (url: string) => Promise<void>;
}

declare global {
  interface Window {
    api: ElectronAPI;
  }
}
