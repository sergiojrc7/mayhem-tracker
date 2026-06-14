import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { app } from "electron";
import {
  computeBaseScore,
  computeAllParticipantScores,
  explainScore,
  toDisplayScore,
  DEFAULT_WEIGHTS,
  type ScoreWeights,
  type ScoreBreakdown,
} from "./score";
import { getChampionRole } from "./dragon";

let db: Database.Database;

function getDbPath() {
  // In development, use the project's data directory
  // In production, use app.getPath('userData')
  const isDev = !app.isPackaged;
  const dataDir = isDev
    ? path.join(__dirname, "..", "..", "data")
    : path.join(app.getPath("userData"), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, "matches.db");
}

export function initDatabase() {
  const dbPath = getDbPath();
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  createTables();
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      game_id       INTEGER PRIMARY KEY,
      queue_id      INTEGER NOT NULL,
      game_mode     TEXT NOT NULL,
      game_creation INTEGER NOT NULL,
      game_duration INTEGER NOT NULL,
      is_remake     INTEGER NOT NULL DEFAULT 0,
      puuid         TEXT NOT NULL DEFAULT '',
      raw_json      TEXT
    );

    CREATE TABLE IF NOT EXISTS player_stats (
      game_id              INTEGER PRIMARY KEY REFERENCES games(game_id),
      champion_id          INTEGER NOT NULL,
      win                  INTEGER NOT NULL,
      kills                INTEGER NOT NULL DEFAULT 0,
      deaths               INTEGER NOT NULL DEFAULT 0,
      assists              INTEGER NOT NULL DEFAULT 0,
      double_kills         INTEGER NOT NULL DEFAULT 0,
      triple_kills         INTEGER NOT NULL DEFAULT 0,
      quadra_kills         INTEGER NOT NULL DEFAULT 0,
      penta_kills          INTEGER NOT NULL DEFAULT 0,
      total_damage_dealt   INTEGER NOT NULL DEFAULT 0,
      total_damage_taken   INTEGER NOT NULL DEFAULT 0,
      gold_earned          INTEGER NOT NULL DEFAULT 0,
      total_heal           INTEGER NOT NULL DEFAULT 0,
      largest_killing_spree INTEGER NOT NULL DEFAULT 0,
      item0 INTEGER, item1 INTEGER, item2 INTEGER,
      item3 INTEGER, item4 INTEGER, item5 INTEGER, item6 INTEGER
    );

    CREATE TABLE IF NOT EXISTS game_augments (
      game_id    INTEGER NOT NULL REFERENCES games(game_id),
      slot       INTEGER NOT NULL,
      augment_id INTEGER NOT NULL,
      PRIMARY KEY (game_id, slot)
    );

    CREATE TABLE IF NOT EXISTS summoner (
      puuid       TEXT PRIMARY KEY,
      game_name   TEXT,
      tag_line    TEXT,
      summoner_id INTEGER,
      account_id  INTEGER,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS champion_tiers (
      champion_id INTEGER PRIMARY KEY,
      tier        TEXT NOT NULL,
      multiplier  REAL NOT NULL,
      fetched_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_games_creation ON games(game_creation DESC);
    CREATE INDEX IF NOT EXISTS idx_player_stats_champion ON player_stats(champion_id);
    CREATE INDEX IF NOT EXISTS idx_game_augments_augment ON game_augments(augment_id);
  `);

  // Migration: add is_remake column to existing databases
  try {
    db.exec("ALTER TABLE games ADD COLUMN is_remake INTEGER NOT NULL DEFAULT 0");
    // Retroactively detect remakes for existing games
    const games = db.prepare("SELECT game_id, game_duration, raw_json FROM games").all() as {
      game_id: number;
      game_duration: number;
      raw_json: string | null;
    }[];
    const updateStmt = db.prepare("UPDATE games SET is_remake = 1 WHERE game_id = ?");
    for (const game of games) {
      if (detectRemake(game.game_duration, game.raw_json)) {
        updateStmt.run(game.game_id);
      }
    }
  } catch {
    // Column already exists
  }

  // Migration: add puuid column to games for multi-account support
  try {
    db.exec("ALTER TABLE games ADD COLUMN puuid TEXT NOT NULL DEFAULT ''");
    db.exec("CREATE INDEX IF NOT EXISTS idx_games_puuid ON games(puuid)");
    // Backfill puuid by matching stored player_stats against raw_json participants
    const gamesToBackfill = db
      .prepare(`
        SELECT g.game_id, g.raw_json,
               ps.champion_id, ps.kills, ps.deaths, ps.assists
        FROM games g
        JOIN player_stats ps ON g.game_id = ps.game_id
        WHERE g.puuid = '' AND g.raw_json IS NOT NULL
      `)
      .all() as {
      game_id: number;
      raw_json: string;
      champion_id: number;
      kills: number;
      deaths: number;
      assists: number;
    }[];

    const updateStmt = db.prepare("UPDATE games SET puuid = ? WHERE game_id = ?");
    const upsertStmt = db.prepare(`
      INSERT OR IGNORE INTO summoner (puuid, game_name, tag_line, summoner_id, account_id, updated_at)
      VALUES (?, ?, ?, NULL, NULL, ?)
    `);

    for (const game of gamesToBackfill) {
      try {
        const raw = JSON.parse(game.raw_json);
        const participants = raw.participants || [];
        const identities = raw.participantIdentities || [];

        for (let i = 0; i < participants.length; i++) {
          const p = participants[i];
          const identity = identities[i];
          const s = p.stats || p;
          const championId = p.championId ?? s.championId ?? 0;

          if (
            championId === game.champion_id &&
            (s.kills ?? 0) === game.kills &&
            (s.deaths ?? 0) === game.deaths &&
            (s.assists ?? 0) === game.assists
          ) {
            const pPuuid = p.puuid || identity?.player?.puuid;
            if (pPuuid) {
              updateStmt.run(pPuuid, game.game_id);
              const gameName =
                identity?.player?.gameName ||
                identity?.player?.summonerName ||
                p.summonerName ||
                p.riotIdGameName ||
                null;
              const tagLine = identity?.player?.tagLine || p.riotIdTagline || null;
              upsertStmt.run(pPuuid, gameName, tagLine, Date.now());
            }
            break;
          }
        }
      } catch {
        /* ignore parse errors */
      }
    }
  } catch {
    // Column already exists
  }

  // Migration: add score column to player_stats and backfill from raw_json
  try {
    db.exec("ALTER TABLE player_stats ADD COLUMN score REAL");
    recomputeAllScores();
  } catch {
    // Column already exists
  }

  // Migration: estatísticas estendidas (Fase 4.2). Colunas opcionais já presentes
  // no raw_json. Adiciona cada coluna isoladamente (ignora se já existe) e faz um
  // backfill único a partir do raw_json quando alguma coluna foi recém-criada.
  migrateExtendedStats();
}

const EXTENDED_STAT_COLUMNS = [
  "total_time_cc_dealt",
  "physical_damage",
  "magic_damage",
  "true_damage",
  "vision_score",
  "time_played",
  "killing_sprees",
] as const;

function migrateExtendedStats(): void {
  let anyAdded = false;
  for (const col of EXTENDED_STAT_COLUMNS) {
    try {
      db.exec(`ALTER TABLE player_stats ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
      anyAdded = true;
    } catch {
      // Column already exists
    }
  }
  if (!anyAdded) return;

  const rows = db
    .prepare(`
      SELECT g.game_id, g.puuid, g.raw_json
      FROM games g WHERE g.raw_json IS NOT NULL
    `)
    .all() as { game_id: number; puuid: string; raw_json: string }[];

  const update = db.prepare(`
    UPDATE player_stats SET
      total_time_cc_dealt = ?, physical_damage = ?, magic_damage = ?,
      true_damage = ?, vision_score = ?, time_played = ?, killing_sprees = ?
    WHERE game_id = ?
  `);

  const tx = db.transaction(() => {
    for (const row of rows) {
      if (!row.puuid) continue;
      try {
        const raw = JSON.parse(row.raw_json);
        const participants = raw.participants || [];
        const identities = raw.participantIdentities || [];
        let s: any = null;
        for (let i = 0; i < participants.length; i++) {
          const p = participants[i];
          const pPuuid = p.puuid || identities[i]?.player?.puuid;
          if (pPuuid === row.puuid) {
            s = p.stats || p;
            break;
          }
        }
        if (!s) continue;
        const e = extractExtendedStats(s);
        update.run(
          e.total_time_cc_dealt,
          e.physical_damage,
          e.magic_damage,
          e.true_damage,
          e.vision_score,
          e.time_played,
          e.killing_sprees,
          row.game_id,
        );
      } catch {
        /* ignore parse errors */
      }
    }
  });
  tx();
}

// Extrai as estatísticas estendidas (Fase 4.2) do bloco de stats de um participante.
function extractExtendedStats(s: any): {
  total_time_cc_dealt: number;
  physical_damage: number;
  magic_damage: number;
  true_damage: number;
  vision_score: number;
  time_played: number;
  killing_sprees: number;
} {
  return {
    total_time_cc_dealt: s.totalTimeCCDealt ?? s.timeCCingOthers ?? 0,
    physical_damage: s.physicalDamageDealtToChampions ?? 0,
    magic_damage: s.magicDamageDealtToChampions ?? 0,
    true_damage: s.trueDamageDealtToChampions ?? 0,
    vision_score: s.visionScore ?? 0,
    time_played: s.timePlayed ?? 0,
    killing_sprees: s.killingSprees ?? 0,
  };
}

function detectRemake(gameDuration: number, rawJson: string | null): boolean {
  // Very short games are always remakes
  if (gameDuration < 300) return true;
  // Check for early surrender flag in participant data
  if (rawJson) {
    try {
      const raw = JSON.parse(rawJson);
      if (raw.participants) {
        for (const p of raw.participants) {
          const s = p.stats || p;
          if (s.gameEndedInEarlySurrender && gameDuration < 600) return true;
        }
      }
    } catch {
      /* ignore parse errors */
    }
  }
  return false;
}

// ---- Helpers ----

function extractGameMaxStats(rawJson: string | null): {
  game_max_dmg: number;
  game_max_taken: number;
  game_max_heal: number;
} {
  const fallback = { game_max_dmg: 1, game_max_taken: 1, game_max_heal: 1 };
  if (!rawJson) return fallback;
  try {
    const raw = JSON.parse(rawJson);
    if (!raw?.participants) return fallback;
    let dmg = 0,
      taken = 0,
      heal = 0;
    for (const p of raw.participants) {
      const s = p.stats || p;
      const d = s.totalDamageDealtToChampions ?? s.totalDamageDealt ?? 0;
      const t = s.totalDamageTaken ?? 0;
      const h = s.totalHeal ?? 0;
      if (d > dmg) dmg = d;
      if (t > taken) taken = t;
      if (h > heal) heal = h;
    }
    return { game_max_dmg: dmg || 1, game_max_taken: taken || 1, game_max_heal: heal || 1 };
  } catch {
    return fallback;
  }
}

// ---- Query functions ----

// Filtros do Match History (Fase 4.1). Todos opcionais; combinam via AND.
export interface MatchFilters {
  championId?: number;
  result?: "win" | "loss";
  /** Janela em dias a partir de agora (ex.: 7, 30). */
  days?: number;
  /** Ordenação: "recent" (padrão) ou "score" (maior nota primeiro). */
  sort?: "recent" | "score";
  /** Apenas partidas em que este puuid participou (histórico com amigo). */
  withPuuid?: string;
}

export function getMatchHistory(
  limit: number,
  offset: number,
  filters: MatchFilters = {},
): { matches: any[]; total: number } {
  const where: string[] = [];
  const params: any[] = [];

  if (filters.championId !== undefined) {
    where.push("ps.champion_id = ?");
    params.push(filters.championId);
  }
  if (filters.result === "win") {
    where.push("ps.win = 1");
  } else if (filters.result === "loss") {
    where.push("ps.win = 0 AND g.is_remake = 0");
  }
  if (filters.days !== undefined) {
    where.push("g.game_creation >= ?");
    params.push(Date.now() - filters.days * 86_400_000);
  }
  if (filters.withPuuid) {
    // puuid é uma string única de 78 chars → LIKE no raw_json é seguro o bastante.
    where.push("g.raw_json LIKE ?");
    params.push(`%${filters.withPuuid}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // score é transformação monotônica do raw → ordenar pelo raw equivale ao display.
  const orderSql =
    filters.sort === "score"
      ? "ORDER BY ps.score DESC NULLS LAST, g.game_creation DESC"
      : "ORDER BY g.game_creation DESC";

  const total = db
    .prepare(`SELECT COUNT(*) as count FROM games g JOIN player_stats ps ON g.game_id = ps.game_id ${whereSql}`)
    .get(...params) as any;

  const rows = db
    .prepare(`
    SELECT g.game_id, g.game_creation, g.game_duration, g.is_remake, g.puuid, g.raw_json,
           ps.champion_id, ps.win, ps.kills, ps.deaths, ps.assists,
           ps.double_kills, ps.triple_kills, ps.quadra_kills, ps.penta_kills,
           ps.total_damage_dealt, ps.total_damage_taken, ps.total_heal, ps.gold_earned, ps.score,
           ps.item0, ps.item1, ps.item2, ps.item3, ps.item4, ps.item5,
           (SELECT GROUP_CONCAT(ga.augment_id) FROM game_augments ga WHERE ga.game_id = g.game_id ORDER BY ga.slot) as augment_ids
    FROM games g
    JOIN player_stats ps ON g.game_id = ps.game_id
    ${whereSql}
    ${orderSql}
    LIMIT ? OFFSET ?
  `)
    .all(...params, limit, offset);
  const matches = rows.map((row: any) => {
    const maxStats = extractGameMaxStats(row.raw_json);
    const { raw_json, ...match } = row;
    return {
      ...match,
      score: match.score != null ? toDisplayScore(match.score) : null,
      ...maxStats,
    };
  });
  return { matches, total: total.count };
}

export function getMatchDetail(gameId: number): any {
  const game = db.prepare("SELECT * FROM games WHERE game_id = ?").get(gameId) as any;
  if (!game) return null;
  const stats = db.prepare("SELECT * FROM player_stats WHERE game_id = ?").get(gameId);
  const augments = db
    .prepare("SELECT * FROM game_augments WHERE game_id = ? ORDER BY slot")
    .all(gameId);
  const raw = game.raw_json ? JSON.parse(game.raw_json) : null;
  const rawScores = raw ? computeAllParticipantScores(raw, getWeights(), scoreResolvers()) : {};
  const scores: Record<number, number> = {};
  for (const [pid, s] of Object.entries(rawScores)) scores[Number(pid)] = toDisplayScore(s);
  return { game, stats, augments, raw, scores };
}

// Painel de contexto do score (Fase 2.2). Recebe a partida + o participantId
// clicado e devolve: o breakdown da nota nessa partida, comparação com o seu
// score na mesma partida e — quando o jogador tem puuid — a evolução do score
// ao longo das partidas compartilhadas, top 3 partidas e médias por campeão.
// Tudo derivado do raw_json (não persiste).
export interface PlayerScoreContext {
  name: string;
  puuid: string | null;
  championId: number;
  isSelf: boolean;
  thisMatch: ScoreBreakdown;
  /** Seu score (do dono do tracker) na MESMA partida, para comparação. */
  selfThisMatch: number | null;
  /** Evolução: pontos (creation asc) das partidas compartilhadas com o jogador. */
  history: { game_id: number; game_creation: number; score: number; champion_id: number; win: number }[];
  /** Top 3 partidas por score. */
  topMatches: { game_id: number; game_creation: number; score: number; champion_id: number; win: number }[];
  /** Médias por campeão (>=1 jogo), ordenadas por score médio desc. */
  championAverages: { champion_id: number; games: number; avgScore: number }[];
  sharedGames: number;
}

function participantNameFromRaw(raw: any, participantId: number): string {
  const participants = raw.participants || [];
  const identities = raw.participantIdentities || [];
  const idx = participants.findIndex((p: any) => (p.participantId ?? 0) === participantId);
  if (idx < 0) return `Player ${participantId}`;
  const p = participants[idx];
  const identity = identities[idx];
  const gameName =
    identity?.player?.gameName || identity?.player?.summonerName || p.summonerName || p.riotIdGameName;
  const tagLine = identity?.player?.tagLine || p.riotIdTagline;
  if (!gameName) return `Player ${participantId}`;
  return tagLine ? `${gameName}#${tagLine}` : gameName;
}

function participantPuuidFromRaw(raw: any, participantId: number): string | null {
  const participants = raw.participants || [];
  const identities = raw.participantIdentities || [];
  const idx = participants.findIndex((p: any) => (p.participantId ?? 0) === participantId);
  if (idx < 0) return null;
  const pp = participants[idx]?.puuid || identities[idx]?.player?.puuid || null;
  return pp && !/^0+(-0+)*$/.test(pp) ? pp : null;
}

export function getPlayerScoreContext(
  gameId: number,
  participantId: number,
): PlayerScoreContext | null {
  const game = db.prepare("SELECT raw_json FROM games WHERE game_id = ?").get(gameId) as
    | { raw_json: string | null }
    | undefined;
  if (!game?.raw_json) return null;

  let raw: any;
  try {
    raw = JSON.parse(game.raw_json);
  } catch {
    return null;
  }

  const weights = getWeights();
  const resolvers = scoreResolvers();

  const thisMatch = explainScore(raw, { participantId }, weights, resolvers);
  if (!thisMatch) return null;

  const puuid = participantPuuidFromRaw(raw, participantId);
  const name = participantNameFromRaw(raw, participantId);
  const userPuuids = new Set(getAllPuuids());
  const isSelf = puuid != null && userPuuids.has(puuid);

  // Seu score na mesma partida: dono do tracker presente neste jogo.
  let selfThisMatch: number | null = null;
  for (const up of userPuuids) {
    const b = explainScore(raw, { puuid: up }, weights, resolvers);
    if (b) {
      selfThisMatch = b.display;
      break;
    }
  }

  const history: PlayerScoreContext["history"] = [];
  const champAgg = new Map<number, { sum: number; games: number }>();

  if (puuid) {
    // Varre todas as partidas que contêm esse puuid e calcula o score dele em cada.
    const games = db
      .prepare(
        "SELECT game_id, game_creation, raw_json FROM games WHERE raw_json IS NOT NULL AND is_remake = 0 ORDER BY game_creation ASC",
      )
      .all() as { game_id: number; game_creation: number; raw_json: string }[];

    for (const g of games) {
      let r: any;
      try {
        r = JSON.parse(g.raw_json);
      } catch {
        continue;
      }
      const b = explainScore(r, { puuid }, weights, resolvers);
      if (!b) continue;
      // championId + win do jogador nesta partida (puuid pode vir do participant
      // ou de participantIdentities, conforme o formato da partida).
      const parts = r.participants || [];
      const idents = r.participantIdentities || [];
      let pIdx = parts.findIndex((p: any) => p.puuid === puuid);
      if (pIdx < 0) pIdx = idents.findIndex((pi: any) => pi?.player?.puuid === puuid);
      const part = pIdx >= 0 ? parts[pIdx] : null;
      const s = part?.stats || part || {};
      const champion_id = part?.championId ?? s.championId ?? 0;
      const win = s.win ? 1 : 0;
      history.push({ game_id: g.game_id, game_creation: g.game_creation, score: b.display, champion_id, win });
      const agg = champAgg.get(champion_id) ?? { sum: 0, games: 0 };
      agg.sum += b.display;
      agg.games += 1;
      champAgg.set(champion_id, agg);
    }
  } else {
    // Sem puuid: só temos esta partida.
    const part = (raw.participants || []).find((p: any) => (p.participantId ?? 0) === participantId);
    const s = part?.stats || part || {};
    const champion_id = part?.championId ?? s.championId ?? 0;
    history.push({
      game_id: gameId,
      game_creation: (raw.gameCreation as number) ?? Date.now(),
      score: thisMatch.display,
      champion_id,
      win: s.win ? 1 : 0,
    });
  }

  const topMatches = [...history].sort((a, b) => b.score - a.score).slice(0, 3);
  const championAverages = Array.from(champAgg.entries())
    .map(([champion_id, v]) => ({ champion_id, games: v.games, avgScore: Math.round(v.sum / v.games) }))
    .sort((a, b) => b.avgScore - a.avgScore);

  return {
    name,
    puuid,
    championId: thisMatch ? participantChampionFromRaw(raw, participantId) : 0,
    isSelf,
    thisMatch,
    selfThisMatch,
    history,
    topMatches,
    championAverages,
    sharedGames: history.length,
  };
}

function participantChampionFromRaw(raw: any, participantId: number): number {
  const part = (raw.participants || []).find((p: any) => (p.participantId ?? 0) === participantId);
  const s = part?.stats || part || {};
  return part?.championId ?? s.championId ?? 0;
}

export function getChampionStatsAll(): any[] {
  const rows = db
    .prepare(`
    SELECT
      ps.champion_id,
      COUNT(*) as games,
      SUM(ps.win) as wins,
      SUM(ps.kills) as kills,
      SUM(ps.deaths) as deaths,
      SUM(ps.assists) as assists,
      ROUND(AVG(ps.kills), 1) as avg_kills,
      ROUND(AVG(ps.deaths), 1) as avg_deaths,
      ROUND(AVG(ps.assists), 1) as avg_assists,
      ROUND(AVG(ps.total_damage_dealt)) as avg_damage,
      ROUND(AVG(ps.gold_earned)) as avg_gold,
      SUM(ps.double_kills) as double_kills,
      SUM(ps.triple_kills) as triple_kills,
      SUM(ps.quadra_kills) as quadra_kills,
      SUM(ps.penta_kills) as penta_kills
    FROM player_stats ps
    JOIN games g ON ps.game_id = g.game_id
    WHERE g.is_remake = 0
    GROUP BY ps.champion_id
    ORDER BY games DESC
  `)
    .all() as any[];

  // Score médio por campeão (Fase 4.4). O display é transformação não-linear do
  // raw, então a média precisa ser feita sobre o display em JS (não AVG no SQL).
  const scoreRows = db
    .prepare(`
    SELECT ps.champion_id, ps.score
    FROM player_stats ps
    JOIN games g ON ps.game_id = g.game_id
    WHERE g.is_remake = 0 AND ps.score IS NOT NULL
  `)
    .all() as { champion_id: number; score: number }[];

  const scoreAgg = new Map<number, { sum: number; n: number }>();
  for (const r of scoreRows) {
    const a = scoreAgg.get(r.champion_id) ?? { sum: 0, n: 0 };
    a.sum += toDisplayScore(r.score);
    a.n += 1;
    scoreAgg.set(r.champion_id, a);
  }

  return rows.map((row) => {
    const a = scoreAgg.get(row.champion_id);
    return { ...row, avg_score: a && a.n > 0 ? Math.round(a.sum / a.n) : null };
  });
}

export function getAugmentStatsAll(championId?: number): any[] {
  if (championId !== undefined) {
    return db
      .prepare(`
      SELECT ga.augment_id, COUNT(*) as picks, SUM(ps.win) as wins
      FROM game_augments ga
      JOIN player_stats ps ON ga.game_id = ps.game_id
      JOIN games g ON ga.game_id = g.game_id
      WHERE ps.champion_id = ? AND g.is_remake = 0
      GROUP BY ga.augment_id
      ORDER BY picks DESC
    `)
      .all(championId);
  }
  return db
    .prepare(`
    SELECT ga.augment_id, COUNT(*) as picks, SUM(ps.win) as wins
    FROM game_augments ga
    JOIN player_stats ps ON ga.game_id = ps.game_id
    JOIN games g ON ga.game_id = g.game_id
    WHERE g.is_remake = 0
    GROUP BY ga.augment_id
    ORDER BY picks DESC
  `)
    .all();
}

export function getDashboardData(): any {
  const totals = db
    .prepare(`
    SELECT COUNT(*) as totalGames,
           SUM(ps.win) as wins,
           SUM(ps.kills) as totalKills,
           SUM(ps.deaths) as totalDeaths,
           SUM(ps.assists) as totalAssists,
           SUM(ps.double_kills) as doubles,
           SUM(ps.triple_kills) as triples,
           SUM(ps.quadra_kills) as quadras,
           SUM(ps.penta_kills) as pentas
    FROM player_stats ps
    JOIN games g ON ps.game_id = g.game_id
    WHERE g.is_remake = 0
  `)
    .get() as any;

  const recentForm = db
    .prepare(`
    SELECT ps.win, g.game_id
    FROM games g
    JOIN player_stats ps ON g.game_id = ps.game_id
    WHERE g.is_remake = 0
    ORDER BY g.game_creation DESC
    LIMIT 10
  `)
    .all();

  const topChampions = db
    .prepare(`
    SELECT
      ps.champion_id,
      COUNT(*) as games,
      SUM(ps.win) as wins,
      ROUND(AVG(ps.kills), 1) as avg_kills,
      ROUND(AVG(ps.deaths), 1) as avg_deaths,
      ROUND(AVG(ps.assists), 1) as avg_assists
    FROM player_stats ps
    JOIN games g ON ps.game_id = g.game_id
    WHERE g.is_remake = 0
    GROUP BY ps.champion_id
    ORDER BY games DESC
    LIMIT 5
  `)
    .all();

  const topAugments = db
    .prepare(`
    SELECT ga.augment_id, COUNT(*) as picks, SUM(ps.win) as wins
    FROM game_augments ga
    JOIN player_stats ps ON ga.game_id = ps.game_id
    JOIN games g ON ga.game_id = g.game_id
    WHERE g.is_remake = 0
    GROUP BY ga.augment_id
    ORDER BY picks DESC
    LIMIT 5
  `)
    .all();

  // Trend do score (Fase 4.6): últimas 20 partidas em ordem cronológica (display).
  const trendRows = db
    .prepare(`
    SELECT ps.score
    FROM games g
    JOIN player_stats ps ON g.game_id = ps.game_id
    WHERE g.is_remake = 0 AND ps.score IS NOT NULL
    ORDER BY g.game_creation DESC
    LIMIT 20
  `)
    .all() as { score: number }[];
  const scoreTrend = trendRows.map((r) => toDisplayScore(r.score)).reverse();

  return {
    totalGames: totals.totalGames ?? 0,
    wins: totals.wins ?? 0,
    totalKills: totals.totalKills ?? 0,
    totalDeaths: totals.totalDeaths ?? 0,
    totalAssists: totals.totalAssists ?? 0,
    recentForm,
    topChampions,
    multikills: {
      doubles: totals.doubles ?? 0,
      triples: totals.triples ?? 0,
      quadras: totals.quadras ?? 0,
      pentas: totals.pentas ?? 0,
    },
    topAugments,
    scoreTrend,
  };
}

export function getAugmentStatsWithChampions(): {
  augment_id: number;
  picks: number;
  wins: number;
  synergyScore: number | null;
  champions: { champion_id: number; picks: number; wins: number }[];
}[] {
  const augments = db
    .prepare(`
    SELECT ga.augment_id, COUNT(*) as picks, SUM(ps.win) as wins
    FROM game_augments ga
    JOIN player_stats ps ON ga.game_id = ps.game_id
    JOIN games g ON ga.game_id = g.game_id
    WHERE g.is_remake = 0
    GROUP BY ga.augment_id
    ORDER BY picks DESC
  `)
    .all() as { augment_id: number; picks: number; wins: number }[];

  const champBreakdown = db
    .prepare(`
    SELECT ga.augment_id, ps.champion_id, COUNT(*) as picks, SUM(ps.win) as wins
    FROM game_augments ga
    JOIN player_stats ps ON ga.game_id = ps.game_id
    JOIN games g ON ga.game_id = g.game_id
    WHERE g.is_remake = 0
    GROUP BY ga.augment_id, ps.champion_id
    ORDER BY picks DESC
  `)
    .all() as { augment_id: number; champion_id: number; picks: number; wins: number }[];

  const champMap = new Map<number, { champion_id: number; picks: number; wins: number }[]>();
  for (const row of champBreakdown) {
    if (!champMap.has(row.augment_id)) champMap.set(row.augment_id, []);
    champMap
      .get(row.augment_id)!
      .push({ champion_id: row.champion_id, picks: row.picks, wins: row.wins });
  }

  // Synergy score (Fase 4.3): score médio das partidas em que o augment foi pego.
  // Display é não-linear → média feita em JS sobre o display.
  const scoreRows = db
    .prepare(`
    SELECT ga.augment_id, ps.score
    FROM game_augments ga
    JOIN player_stats ps ON ga.game_id = ps.game_id
    JOIN games g ON ga.game_id = g.game_id
    WHERE g.is_remake = 0 AND ps.score IS NOT NULL
  `)
    .all() as { augment_id: number; score: number }[];

  const scoreAgg = new Map<number, { sum: number; n: number }>();
  for (const r of scoreRows) {
    const a = scoreAgg.get(r.augment_id) ?? { sum: 0, n: 0 };
    a.sum += toDisplayScore(r.score);
    a.n += 1;
    scoreAgg.set(r.augment_id, a);
  }

  return augments.map((a) => {
    const sc = scoreAgg.get(a.augment_id);
    return {
      ...a,
      synergyScore: sc && sc.n > 0 ? Math.round(sc.sum / sc.n) : null,
      champions: champMap.get(a.augment_id) ?? [],
    };
  });
}

export function getChampionMatchHistory(
  championId: number,
  limit: number,
  offset: number,
): { matches: any[]; total: number } {
  const total = db
    .prepare("SELECT COUNT(*) as count FROM player_stats WHERE champion_id = ?")
    .get(championId) as any;
  const rows = db
    .prepare(`
    SELECT g.game_id, g.game_creation, g.game_duration, g.is_remake, g.puuid, g.raw_json,
           ps.champion_id, ps.win, ps.kills, ps.deaths, ps.assists,
           ps.double_kills, ps.triple_kills, ps.quadra_kills, ps.penta_kills,
           ps.total_damage_dealt, ps.total_damage_taken, ps.total_heal, ps.gold_earned, ps.score,
           ps.item0, ps.item1, ps.item2, ps.item3, ps.item4, ps.item5,
           (SELECT GROUP_CONCAT(ga.augment_id) FROM game_augments ga WHERE ga.game_id = g.game_id ORDER BY ga.slot) as augment_ids
    FROM games g
    JOIN player_stats ps ON g.game_id = ps.game_id
    WHERE ps.champion_id = ?
    ORDER BY g.game_creation DESC
    LIMIT ? OFFSET ?
  `)
    .all(championId, limit, offset);
  const matches = rows.map((row: any) => {
    const maxStats = extractGameMaxStats(row.raw_json);
    const { raw_json, ...match } = row;
    return {
      ...match,
      score: match.score != null ? toDisplayScore(match.score) : null,
      ...maxStats,
    };
  });
  return { matches, total: total.count };
}

export function gameExists(gameId: number): boolean {
  const row = db.prepare("SELECT 1 FROM games WHERE game_id = ?").get(gameId);
  return !!row;
}

export function insertGameFull(gameData: any, puuid: string): boolean {
  // Find participant
  let participant: any = null;
  if (gameData.participants) {
    participant = gameData.participants.find((p: any) => p.puuid === puuid);
    if (!participant && gameData.participantIdentities) {
      const identity = gameData.participantIdentities.find((pi: any) => pi.player?.puuid === puuid);
      if (identity) {
        participant = gameData.participants.find(
          (p: any) => p.participantId === identity.participantId,
        );
      }
    }
  }

  if (!participant) return false;

  const s = participant.stats || participant;

  const isRemake = detectRemake(gameData.gameDuration, JSON.stringify(gameData)) ? 1 : 0;

  const insertGameStmt = db.prepare(`
    INSERT OR IGNORE INTO games (game_id, queue_id, game_mode, game_creation, game_duration, is_remake, puuid, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertStatsStmt = db.prepare(`
    INSERT OR IGNORE INTO player_stats (
      game_id, champion_id, win, kills, deaths, assists,
      double_kills, triple_kills, quadra_kills, penta_kills,
      total_damage_dealt, total_damage_taken, gold_earned, total_heal,
      largest_killing_spree, item0, item1, item2, item3, item4, item5, item6, score,
      total_time_cc_dealt, physical_damage, magic_damage, true_damage,
      vision_score, time_played, killing_sprees
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const ext = extractExtendedStats(s);

  const score = computeBaseScore(gameData, puuid, getWeights(), scoreResolvers());

  const insertAugmentStmt = db.prepare(`
    INSERT OR IGNORE INTO game_augments (game_id, slot, augment_id) VALUES (?, ?, ?)
  `);

  const tx = db.transaction(() => {
    const result = insertGameStmt.run(
      gameData.gameId,
      gameData.queueId,
      gameData.gameMode,
      gameData.gameCreation,
      gameData.gameDuration,
      isRemake,
      puuid,
      JSON.stringify(gameData),
    );

    if (result.changes === 0) return false; // duplicate

    insertStatsStmt.run(
      gameData.gameId,
      participant.championId ?? s.championId ?? 0,
      s.win ? 1 : 0,
      s.kills ?? 0,
      s.deaths ?? 0,
      s.assists ?? 0,
      s.doubleKills ?? 0,
      s.tripleKills ?? 0,
      s.quadraKills ?? 0,
      s.pentaKills ?? 0,
      s.totalDamageDealtToChampions ?? s.totalDamageDealt ?? 0,
      s.totalDamageTaken ?? 0,
      s.goldEarned ?? 0,
      s.totalHeal ?? 0,
      s.largestKillingSpree ?? 0,
      s.item0 ?? null,
      s.item1 ?? null,
      s.item2 ?? null,
      s.item3 ?? null,
      s.item4 ?? null,
      s.item5 ?? null,
      s.item6 ?? null,
      score,
      ext.total_time_cc_dealt,
      ext.physical_damage,
      ext.magic_damage,
      ext.true_damage,
      ext.vision_score,
      ext.time_played,
      ext.killing_sprees,
    );

    // Augments
    for (let i = 1; i <= 4; i++) {
      const augId = s[`playerAugment${i}`];
      if (augId && augId > 0) {
        insertAugmentStmt.run(gameData.gameId, i, augId);
      }
    }

    return true;
  });

  return tx() as boolean;
}

export function upsertSummoner(summoner: any): void {
  db.prepare(`
    INSERT OR REPLACE INTO summoner (puuid, game_name, tag_line, summoner_id, account_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    summoner.puuid,
    summoner.displayName || summoner.gameName || summoner.internalName || summoner.game_name,
    summoner.tagLine || summoner.tag_line || null,
    summoner.summonerId ?? summoner.summoner_id,
    summoner.accountId ?? summoner.account_id,
    Date.now(),
  );
}

export function getSummoner(): any {
  return db.prepare("SELECT * FROM summoner ORDER BY updated_at DESC LIMIT 1").get();
}

export function getAllPuuids(): string[] {
  const rows = db.prepare("SELECT puuid FROM summoner").all() as { puuid: string }[];
  return rows.map((r) => r.puuid);
}

export function getTeammateStats(): any[] {
  const puuids = new Set(getAllPuuids());
  if (puuids.size === 0) return [];

  const games = db
    .prepare(
      "SELECT game_id, raw_json, game_creation FROM games WHERE raw_json IS NOT NULL AND is_remake = 0",
    )
    .all() as any[];

  const weights = getWeights();
  const resolvers = scoreResolvers();

  const playerMap = new Map<
    string,
    {
      name: string;
      puuid: string | null;
      games: number;
      wins: number;
      kills: number;
      deaths: number;
      assists: number;
      champions: Map<number, number>;
      lastPlayed: number;
      // Fase 4.5: score médio do amigo + seu score nas mesmas partidas.
      scoreSum: number;
      scoreN: number;
      selfScoreSum: number;
      selfScoreN: number;
    }
  >();

  for (const game of games) {
    let raw: any;
    try {
      raw = JSON.parse(game.raw_json);
    } catch {
      continue;
    }

    const participants = raw.participants || [];
    const identities = raw.participantIdentities || [];

    // Find our participant to get teamId
    let myTeamId: number | null = null;
    let myParticipantId: number | null = null;

    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      const identity = identities[i];
      const pPuuid = p.puuid || identity?.player?.puuid;
      if (pPuuid && puuids.has(pPuuid)) {
        myTeamId = p.teamId || 100;
        myParticipantId = p.participantId;
        break;
      }
    }

    if (myTeamId === null) continue;

    // Score de cada participante nesta partida (Fase 4.5) + seu próprio score.
    const rawScores = computeAllParticipantScores(raw, weights, resolvers);
    const scoreMap: Record<number, number> = {};
    for (const [pid, s] of Object.entries(rawScores)) scoreMap[Number(pid)] = toDisplayScore(s);
    const userScore = myParticipantId != null ? scoreMap[myParticipantId] : undefined;

    // Collect teammates (same team, not self)
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      const identity = identities[i];
      const teamId = p.teamId || 100;

      if (teamId !== myTeamId) continue;
      const pPuuid2 = p.puuid || identity?.player?.puuid;
      if (pPuuid2 && puuids.has(pPuuid2)) continue;
      if (p.participantId === myParticipantId) continue;

      const rawPuuid = p.puuid || identity?.player?.puuid || null;
      // Filter out placeholder/bot puuids
      const playerPuuid = rawPuuid && !/^0+(-0+)*$/.test(rawPuuid) ? rawPuuid : null;
      const gameName =
        identity?.player?.gameName || identity?.player?.summonerName || p.summonerName || null;
      const tagLine = identity?.player?.tagLine || null;
      const name = gameName ? (tagLine ? `${gameName}#${tagLine}` : gameName) : `Player ${i + 1}`;

      // Always prefer puuid as key
      const key = playerPuuid || name;
      const s = p.stats || p;

      // If we now have a puuid but previously tracked this player by name, merge
      if (playerPuuid && !playerMap.has(playerPuuid) && playerMap.has(name)) {
        const old = playerMap.get(name)!;
        if (!old.puuid) {
          playerMap.set(playerPuuid, old);
          old.puuid = playerPuuid;
          playerMap.delete(name);
        }
      }

      if (!playerMap.has(key)) {
        playerMap.set(key, {
          name,
          puuid: playerPuuid,
          games: 0,
          wins: 0,
          kills: 0,
          deaths: 0,
          assists: 0,
          champions: new Map(),
          lastPlayed: 0,
          scoreSum: 0,
          scoreN: 0,
          selfScoreSum: 0,
          selfScoreN: 0,
        });
      }

      const entry = playerMap.get(key)!;
      // Update name to most recent version
      if (game.game_creation > entry.lastPlayed) {
        entry.name = name;
      }
      entry.games++;
      if (s.win) entry.wins++;
      entry.kills += s.kills ?? 0;
      entry.deaths += s.deaths ?? 0;
      entry.assists += s.assists ?? 0;
      entry.lastPlayed = Math.max(entry.lastPlayed, game.game_creation);

      // Scores (Fase 4.5): nota do amigo nesta partida + sua nota na mesma partida.
      const friendScore = scoreMap[p.participantId];
      if (friendScore != null) {
        entry.scoreSum += friendScore;
        entry.scoreN++;
        if (userScore != null) {
          entry.selfScoreSum += userScore;
          entry.selfScoreN++;
        }
      }

      const champId = p.championId ?? s.championId ?? 0;
      entry.champions.set(champId, (entry.champions.get(champId) || 0) + 1);
    }
  }

  return Array.from(playerMap.values())
    .map((p) => ({
      name: p.name,
      puuid: p.puuid,
      games: p.games,
      wins: p.wins,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      champions: Array.from(p.champions.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([champion_id, games]) => ({ champion_id, games })),
      lastPlayed: p.lastPlayed,
      avgScore: p.scoreN > 0 ? Math.round(p.scoreSum / p.scoreN) : null,
      avgSelfScore: p.selfScoreN > 0 ? Math.round(p.selfScoreSum / p.selfScoreN) : null,
    }))
    .sort((a, b) => b.games - a.games);
}

export function getChampionItemStats(
  championId: number,
): { item_id: number; picks: number; wins: number }[] {
  return db
    .prepare(`
    SELECT item_id, COUNT(*) as picks, SUM(win) as wins
    FROM (
      SELECT ps.item0 as item_id, ps.win FROM player_stats ps JOIN games g ON ps.game_id = g.game_id WHERE ps.champion_id = ? AND ps.item0 IS NOT NULL AND ps.item0 > 0 AND g.is_remake = 0
      UNION ALL
      SELECT ps.item1, ps.win FROM player_stats ps JOIN games g ON ps.game_id = g.game_id WHERE ps.champion_id = ? AND ps.item1 IS NOT NULL AND ps.item1 > 0 AND g.is_remake = 0
      UNION ALL
      SELECT ps.item2, ps.win FROM player_stats ps JOIN games g ON ps.game_id = g.game_id WHERE ps.champion_id = ? AND ps.item2 IS NOT NULL AND ps.item2 > 0 AND g.is_remake = 0
      UNION ALL
      SELECT ps.item3, ps.win FROM player_stats ps JOIN games g ON ps.game_id = g.game_id WHERE ps.champion_id = ? AND ps.item3 IS NOT NULL AND ps.item3 > 0 AND g.is_remake = 0
      UNION ALL
      SELECT ps.item4, ps.win FROM player_stats ps JOIN games g ON ps.game_id = g.game_id WHERE ps.champion_id = ? AND ps.item4 IS NOT NULL AND ps.item4 > 0 AND g.is_remake = 0
      UNION ALL
      SELECT ps.item5, ps.win FROM player_stats ps JOIN games g ON ps.game_id = g.game_id WHERE ps.champion_id = ? AND ps.item5 IS NOT NULL AND ps.item5 > 0 AND g.is_remake = 0
      UNION ALL
      SELECT ps.item6, ps.win FROM player_stats ps JOIN games g ON ps.game_id = g.game_id WHERE ps.champion_id = ? AND ps.item6 IS NOT NULL AND ps.item6 > 0 AND g.is_remake = 0
    )
    GROUP BY item_id
    ORDER BY picks DESC
  `)
    .all(
      championId,
      championId,
      championId,
      championId,
      championId,
      championId,
      championId,
    ) as any[];
}

export function getGlobalStats(): {
  champions: { champion_id: number; games: number; wins: number }[];
  augments: { augment_id: number; picks: number; wins: number }[];
  totalParticipantSlots: number;
} {
  const games = db
    .prepare("SELECT raw_json FROM games WHERE raw_json IS NOT NULL AND is_remake = 0")
    .all() as any[];

  const championMap = new Map<number, { games: number; wins: number }>();
  const augmentMap = new Map<number, { picks: number; wins: number }>();
  let totalParticipantSlots = 0;

  for (const game of games) {
    let raw: any;
    try {
      raw = JSON.parse(game.raw_json);
    } catch {
      continue;
    }

    const participants = raw.participants || [];

    for (const p of participants) {
      const s = p.stats || p;
      const champId = p.championId ?? s.championId ?? 0;
      const win = !!s.win;

      if (champId <= 0) continue;
      totalParticipantSlots++;

      if (!championMap.has(champId)) {
        championMap.set(champId, { games: 0, wins: 0 });
      }
      const champ = championMap.get(champId)!;
      champ.games++;
      if (win) champ.wins++;

      for (let i = 1; i <= 4; i++) {
        const augId = s[`playerAugment${i}`];
        if (augId && augId > 0) {
          if (!augmentMap.has(augId)) {
            augmentMap.set(augId, { picks: 0, wins: 0 });
          }
          const aug = augmentMap.get(augId)!;
          aug.picks++;
          if (win) aug.wins++;
        }
      }
    }
  }

  return {
    champions: Array.from(championMap.entries())
      .map(([champion_id, stats]) => ({ champion_id, ...stats }))
      .sort((a, b) => b.games - a.games),
    augments: Array.from(augmentMap.entries())
      .map(([augment_id, stats]) => ({ augment_id, ...stats }))
      .sort((a, b) => b.picks - a.picks),
    totalParticipantSlots,
  };
}

export function getDatabase(): Database.Database {
  return db;
}

// ---- Settings ----

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

// ---- Scoring ----

// Pesos do score são tunáveis (Fase 4.7). Persistidos como JSON em settings;
// na ausência ou em caso de parse inválido, caímos nos defaults.
export function getWeights(): ScoreWeights {
  const raw = getSetting("score_weights");
  if (!raw) return DEFAULT_WEIGHTS;
  try {
    return { ...DEFAULT_WEIGHTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_WEIGHTS;
  }
}

// Tier Multiplier (Fase 1.3) é injetado por tiers.ts via setTierResolver. Usa-se
// injeção (em vez de import direto) para evitar ciclo db <-> tiers, já que tiers.ts
// importa db para persistir o cache em champion_tiers. Default 1.0 até carregar.
let tierResolver: (championId: number) => number = () => 1.0;
export function setTierResolver(fn: (championId: number) => number): void {
  tierResolver = fn;
}

function scoreResolvers() {
  return { roleOf: getChampionRole, tierOf: tierResolver };
}

// ---- champion_tiers cache (lido/escrito por tiers.ts) ----

export function getTiersAge(): number | null {
  const row = db.prepare("SELECT MAX(fetched_at) as t FROM champion_tiers").get() as {
    t: number | null;
  };
  return row?.t ?? null;
}

export function getCachedTiers(): { champion_id: number; tier: string; multiplier: number }[] {
  return db
    .prepare("SELECT champion_id, tier, multiplier FROM champion_tiers")
    .all() as { champion_id: number; tier: string; multiplier: number }[];
}

export function replaceTiers(
  rows: { champion_id: number; tier: string; multiplier: number }[],
): void {
  const now = Date.now();
  const del = db.prepare("DELETE FROM champion_tiers");
  const ins = db.prepare(
    "INSERT OR REPLACE INTO champion_tiers (champion_id, tier, multiplier, fetched_at) VALUES (?, ?, ?, ?)",
  );
  const tx = db.transaction(() => {
    del.run();
    for (const r of rows) ins.run(r.champion_id, r.tier, r.multiplier, now);
  });
  tx();
}

// Recalcula o score de todas as partidas a partir do raw_json. Usado no backfill
// da migração e, futuramente, ao re-tunar pesos ou atualizar a tier list.
export function recomputeAllScores(): number {
  const weights = getWeights();
  const rows = db
    .prepare("SELECT game_id, puuid, raw_json FROM games WHERE raw_json IS NOT NULL")
    .all() as { game_id: number; puuid: string; raw_json: string }[];

  const update = db.prepare("UPDATE player_stats SET score = ? WHERE game_id = ?");
  let updated = 0;

  const tx = db.transaction(() => {
    for (const row of rows) {
      if (!row.puuid) continue;
      try {
        const score = computeBaseScore(JSON.parse(row.raw_json), row.puuid, weights, scoreResolvers());
        if (score !== null) {
          update.run(score, row.game_id);
          updated++;
        }
      } catch {
        /* ignore parse errors */
      }
    }
  });
  tx();

  return updated;
}

// ---- Export / Import ----

export function exportAllData(): {
  version: number;
  summoner?: any | null;
  summoners?: any[];
  games: any[];
} {
  const summoners = db.prepare("SELECT * FROM summoner").all();
  const rows = db.prepare("SELECT raw_json, puuid FROM games WHERE raw_json IS NOT NULL").all() as {
    raw_json: string;
    puuid: string;
  }[];
  const games = rows.map((r) => {
    const game = JSON.parse(r.raw_json);
    game._ownerPuuid = r.puuid;
    return game;
  });
  return { version: 3, summoners, games };
}

export function importData(data: any): number {
  if (data.version >= 3) {
    for (const s of data.summoners ?? []) {
      upsertSummoner(s);
    }
    let imported = 0;
    for (const game of data.games ?? []) {
      const puuid = game._ownerPuuid || data.summoners?.[0]?.puuid;
      if (!puuid) continue;
      if (insertGameFull(game, puuid)) imported++;
    }
    return imported;
  }
  // v2 fallback: single summoner
  const puuid = data.summoner?.puuid;
  if (!puuid) return 0;
  upsertSummoner(data.summoner);
  let imported = 0;
  for (const game of data.games ?? []) {
    if (insertGameFull(game, puuid)) imported++;
  }
  return imported;
}

// ---- Repair ----

export function repairPuuids(): { repairedGames: number; discoveredAccounts: number } {
  // Step 1: Parse all games and collect participant puuids per game
  const games = db
    .prepare("SELECT game_id, raw_json FROM games WHERE raw_json IS NOT NULL")
    .all() as { game_id: number; raw_json: string }[];

  const puuidToGames = new Map<string, Set<number>>();
  const gameToPuuids = new Map<number, Set<string>>();

  for (const game of games) {
    try {
      const raw = JSON.parse(game.raw_json);
      const participants = raw.participants || [];
      const identities = raw.participantIdentities || [];
      const puuidsInGame = new Set<string>();

      for (let i = 0; i < participants.length; i++) {
        const p = participants[i];
        const identity = identities[i];
        const pPuuid = p.puuid || identity?.player?.puuid;
        if (pPuuid && !/^0+(-0+)*$/.test(pPuuid)) {
          puuidsInGame.add(pPuuid);
          if (!puuidToGames.has(pPuuid)) {
            puuidToGames.set(pPuuid, new Set());
          }
          puuidToGames.get(pPuuid)!.add(game.game_id);
        }
      }

      gameToPuuids.set(game.game_id, puuidsInGame);
    } catch {
      continue;
    }
  }

  // Step 2: Sort puuids by frequency (most games first)
  const sortedPuuids = Array.from(puuidToGames.entries()).sort((a, b) => b[1].size - a[1].size);

  // Step 3: Greedily identify user accounts — a puuid is a user account if it
  // never co-occurs in the same game as an already-identified user account.
  // This filters out friends (who always appear alongside a user account)
  // while correctly identifying alt accounts (which never share a game).
  const userPuuids = new Set<string>();

  for (const [puuid, gameIds] of sortedPuuids) {
    let coOccurs = false;
    for (const gameId of gameIds) {
      const puuidsInGame = gameToPuuids.get(gameId)!;
      for (const userPuuid of userPuuids) {
        if (puuidsInGame.has(userPuuid)) {
          coOccurs = true;
          break;
        }
      }
      if (coOccurs) break;
    }

    if (!coOccurs) {
      userPuuids.add(puuid);
    }
  }

  // Step 4: For each game, find which user account is present and update puuid
  const updateStmt = db.prepare("UPDATE games SET puuid = ? WHERE game_id = ?");
  let repairedGames = 0;

  for (const game of games) {
    try {
      const raw = JSON.parse(game.raw_json);
      const participants = raw.participants || [];
      const identities = raw.participantIdentities || [];

      for (let i = 0; i < participants.length; i++) {
        const p = participants[i];
        const identity = identities[i];
        const pPuuid = p.puuid || identity?.player?.puuid;
        if (pPuuid && userPuuids.has(pPuuid)) {
          updateStmt.run(pPuuid, game.game_id);
          repairedGames++;
          break;
        }
      }
    } catch {
      continue;
    }
  }

  // Step 5: Upsert discovered summoners using the most recent name from raw_json
  const upsertStmt = db.prepare(`
    INSERT OR IGNORE INTO summoner (puuid, game_name, tag_line, summoner_id, account_id, updated_at)
    VALUES (?, ?, ?, NULL, NULL, ?)
  `);

  for (const puuid of userPuuids) {
    const gameIds = puuidToGames.get(puuid)!;
    let latestName: string | null = null;
    let latestTagLine: string | null = null;
    let latestCreation = 0;

    for (const game of games) {
      if (!gameIds.has(game.game_id)) continue;
      try {
        const raw = JSON.parse(game.raw_json);
        const creation = raw.gameCreation || 0;
        if (creation <= latestCreation) continue;

        const participants = raw.participants || [];
        const identities = raw.participantIdentities || [];
        for (let i = 0; i < participants.length; i++) {
          const p = participants[i];
          const identity = identities[i];
          const pPuuid = p.puuid || identity?.player?.puuid;
          if (pPuuid === puuid) {
            const name =
              identity?.player?.gameName ||
              identity?.player?.summonerName ||
              p.summonerName ||
              p.riotIdGameName ||
              null;
            if (name) {
              latestName = name;
              latestTagLine = identity?.player?.tagLine || p.riotIdTagline || null;
              latestCreation = creation;
            }
            break;
          }
        }
      } catch {
        continue;
      }
    }

    upsertStmt.run(puuid, latestName, latestTagLine, Date.now());
  }

  return { repairedGames, discoveredAccounts: userPuuids.size };
}
