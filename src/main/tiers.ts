// Tier Multiplier da ARAM Mayhem (Fase 1.3).
//
// Fonte: endpoint JSON interno da Blitz (iesdev) — público, sem auth. Descoberto
// a partir do HTML da página de tier list. Estrutura:
//   { data: [ { champion_id: "800", stats: { tier: 4, win_rate, ... } }, ... ] }
//
// A Blitz usa 5 tiers numéricos (1 = mais forte … 5 = mais fraco). Mapeamos para a
// curva do roadmap: campeão forte -> multiplicador < 1.0 (penaliza um bom resultado
// com campeão "fácil"); campeão fraco -> > 1.0 (premia). Cache de 24h em
// champion_tiers. Fallback: multiplicador 1.0 para todos se o fetch falhar.
import https from "https";
import * as db from "./db";

const ENDPOINT =
  "https://data.v2.iesdev.com/api/v1/query_objects/prod/lol/aram_mayhem_champions";
const TTL_MS = 24 * 60 * 60 * 1000;

const TIER_LABEL: Record<number, string> = { 1: "S", 2: "A", 3: "B", 4: "C", 5: "D" };
const TIER_MULTIPLIER: Record<number, number> = { 1: 0.84, 2: 0.92, 3: 1.0, 4: 1.08, 5: 1.16 };

let tierCache: Record<number, number> = {};
let tierReady: Promise<void> | null = null;

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "MayhemTracker/1.0" } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchJson(res.headers.location).then(resolve).catch(reject);
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function loadFromDb(): void {
  tierCache = {};
  try {
    for (const r of db.getCachedTiers()) tierCache[r.champion_id] = r.multiplier;
  } catch {
    /* table not ready */
  }
}

async function refresh(): Promise<void> {
  try {
    const data = await fetchJson(ENDPOINT);
    const arr = Array.isArray(data?.data) ? data.data : [];
    const rows: { champion_id: number; tier: string; multiplier: number }[] = [];
    for (const item of arr) {
      const champ = parseInt(item.champion_id);
      const tier = item?.stats?.tier;
      if (!champ || tier == null) continue;
      rows.push({
        champion_id: champ,
        tier: TIER_LABEL[tier] ?? String(tier),
        multiplier: TIER_MULTIPLIER[tier] ?? 1.0,
      });
    }
    if (rows.length > 0) {
      db.replaceTiers(rows);
      loadFromDb();
      console.log(`Loaded ${rows.length} champion tiers from Blitz (iesdev)`);
    } else {
      loadFromDb();
      console.warn("Tier list response was empty; using cached/empty tiers");
    }
  } catch (err) {
    console.error("Failed to load tier list:", err);
    loadFromDb(); // cai no cache existente (mesmo que velho); se vazio -> tudo 1.0
  }
}

export function loadTierData(): Promise<void> {
  tierReady = (async () => {
    try {
      const age = db.getTiersAge();
      if (age !== null && Date.now() - age < TTL_MS) {
        loadFromDb();
        console.log(`Loaded ${Object.keys(tierCache).length} champion tiers from cache`);
        return;
      }
    } catch {
      /* fall through to fetch */
    }
    await refresh();
  })();
  return tierReady;
}

export async function waitForTierData(): Promise<void> {
  if (tierReady) await tierReady;
}

export function getTierMultiplier(championId: number): number {
  return tierCache[championId] ?? 1.0;
}

// Força refresh (ignora TTL) — usado pelo "force refresh" das Settings (Fase 4.7).
export async function refreshTiers(): Promise<number> {
  await refresh();
  return Object.keys(tierCache).length;
}

export function getTierTable(): { champion_id: number; tier: string; multiplier: number }[] {
  try {
    return db.getCachedTiers();
  } catch {
    return [];
  }
}
