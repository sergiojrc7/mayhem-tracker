# Mayhem Tracker — Roadmap

> Fork do projeto original [Yhprum/mayhem-tracker](https://github.com/Yhprum/mayhem-tracker).
> Todas as features abaixo são extensões sobre a base existente (Electron + React + SQLite + Tailwind v4).

## Status (atualizado 2026-06-14)

- ✅ **Fase 1 — Sistema de Pontuação:** concluída (Inc 1.1 → 1.4).
- 🔸 **Fase 2 — Leaderboard de Amigos:** **fora do MVP**, adiada como feature futura.
- ✅ **Fase 2.2 (especial) — Painel de contexto do score:** concluída.
- ✅ **Fase 3 — Redesign de UI:** concluída (Jost + glassmorphism + profundidade + paleta + badge).
- ✅ **Fase 4 — Melhorias de Produto:** concluída (4.1 → 4.7).
- ✅ **Fase 5 — Extras:** aba Tier List + histórico de partidas com amigos.
- 🏁 **v2.0** publicada — MVP do fork completo.

---

## Fase 1 — Sistema de Pontuação por Partida ✅ CONCLUÍDA

**Objetivo:** Atribuir um score numérico a cada partida que reflita o desempenho real do jogador, considerando o papel do campeão e a força relativa dele no meta.

> **Implementado.** Motor puro em `src/main/score.ts` (`Score = Base × Role × Tier` → 0–100).
> O score é calculado para **todos os 10 participantes** (visível no placar expandido),
> não só o jogador. Pontuação derivada do `raw_json`; coluna `player_stats.score` guarda
> o valor bruto e a escala 0–100 é derivada na leitura.

### 1.1 — Base Score (normalizado por partida)

Calculado a partir dos dados já disponíveis no `raw_json`, comparando o jogador contra os 10 participantes da partida:

| Componente | Fonte | Peso base |
|---|---|---|
| KDA ponderado `(K + A×0.7) / max(D, 1)` | `kills, deaths, assists` | 25% |
| Damage Share `dmg / team_total_dmg` | `totalDamageDealtToChampions` | 25% |
| Tank Credit `taken / team_total_taken` | `totalDamageTaken` | 15% |
| Heal Share `heal / team_total_heal` | `totalHeal` | 15% |
| Gold Efficiency `gold / avg_gold_match` | `goldEarned` | 10% |
| Multikill Bonus | `doubleKills..pentaKills` | +bônus flat |
| Win Bonus | `win` | +10% sobre total |

> Os pesos serão ajustáveis via Settings para permitir tuning futuro.

### 1.2 — Role Weight (pesos por papel do campeão)

Fonte: **Riot Data Dragon** (API pública, sem autenticação, atualizada por patch).

Campeões têm tags como `Fighter`, `Mage`, `Tank`, `Support`, `Assassin`, `Marksman`. Os pesos do Base Score são redistribuídos conforme o papel:

| Role | Prioridade |
|---|---|
| Mage / Marksman | Damage Share ↑ |
| Tank / Fighter | Tank Credit ↑ |
| Support | Heal Share ↑, KDA leve |
| Assassin | KDA ↑, Multikill ↑ |

### 1.3 — Champion Tier Multiplier

Fonte: **Blitz.gg ARAM Mayhem tier list** (fetch ao iniciar o app + cache local de 24h).

> **Implementado:** a página da Blitz é um SPA (HTML não scrapável direto), mas ela
> consome um endpoint JSON público (iesdev), que usamos diretamente:
> `https://data.v2.iesdev.com/api/v1/query_objects/prod/lol/aram_mayhem_champions`
> Estrutura: `{ data: [ { champion_id, stats: { tier, win_rate, ... } } ] }`.
> A Blitz usa **5 tiers numéricos** (1 = mais forte … 5 = mais fraco), não as 6 letras
> abaixo. Mapeamento aplicado: 1→0.84, 2→0.92, 3→1.00, 4→1.08, 5→1.16 (mesma curva/
> justificativa da tabela abaixo). Cache 24h em `champion_tiers`; fallback 1.0.

Endpoint original investigado: `https://blitz.gg/lol/tierlist/aram-mayhem`

Mapeamento de tier → multiplicador:

| Tier | Multiplicador |
|---|---|
| S+ | 0.80 |
| S | 0.87 |
| A | 0.94 |
| B | 1.00 |
| C | 1.08 |
| D | 1.16 |

> Justificativa: campeões de tier alto são mais fáceis de vencer e portanto "merecem" menos multiplicação. Um bom desempenho com um campeão D-tier é mais valorizado.

Fallback: se o fetch falhar, multiplier = 1.0 para todos.

### 1.4 — Fórmula Final

```
Score = Base Score × Role Weight × Tier Multiplier
```

Score normalizado para escala 0–100.

> **Decisão de implementação:** trocamos o *percentil dentro das partidas do usuário*
> por uma **escala absoluta** (logística centrada em ~1.0 → 50). Motivo: como o score
> é calculado para todos os participantes (não só o usuário), uma régua relativa ao
> histórico de UM jogador não compara jogadores entre si. A escala absoluta é a mesma
> para todos → comparável dentro e entre partidas. Cores: ≥70 alto, 40–69 médio, <40 baixo.

### 1.5 — Armazenamento

Nova coluna `score REAL` na tabela `player_stats`.
Nova tabela `champion_tiers` para cache da tier list:
```sql
CREATE TABLE champion_tiers (
  champion_id  INTEGER PRIMARY KEY,
  tier         TEXT NOT NULL,
  multiplier   REAL NOT NULL,
  fetched_at   INTEGER NOT NULL
);
```

---

## Fase 2 — Leaderboard de Amigos 🔸 FORA DO MVP (adiada)

> **Decisão (2026-06-14):** removida do MVP, mantida como possível feature futura.
> Um ranking misturando o histórico longo do usuário com jogadores vistos poucas vezes
> não traz valor claro o suficiente. Se for revisitada, considerar: limiar mínimo de
> partidas juntas (≥3) para entrar no ranking, e aproveitar que a escala 0–100 já é
> absoluta (comparável entre jogadores). A pontuação dos 10 participantes (Fase 1) já
> deixa a base pronta caso decidamos retomar.

**Objetivo:** Página de ranking entre todos os jogadores encontrados nas partidas, ordenados pelo score acumulado.

### 2.1 — Ranking geral

Nova página `/leaderboard` na sidebar.

Colunas:
- Rank (#)
- Jogador (nome + tag)
- Partidas jogadas juntos
- Score médio
- Melhor score (partida)
- Win rate juntos
- Campeão mais jogado

### 2.2 — Painel de contexto do score ✅ CONCLUÍDA

> **Implementado** (sem depender da Fase 2.1/leaderboard, que está fora do MVP).
> O painel abre ao **clicar em qualquer jogador no placar expandido** do Match
> History (`ScorePanel.tsx`, drawer lateral). Engine de breakdown em
> `score.ts → explainScore()` (contribuição por componente, já rateando win bonus +
> tier); dados agregados em `db.ts → getPlayerScoreContext()` varrendo o `raw_json`
> de todas as partidas que contêm o `puuid` do jogador. Para bots/anônimos (sem
> puuid) mostra só o breakdown da partida.

Ao clicar em qualquer jogador (incluindo você mesmo), abre um painel lateral com:

- ✅ Gráfico de evolução do score ao longo do tempo (SVG nativo, com linha de média e guias 40/70)
- ✅ Breakdown do score: contribuição de KDA, Damage, Tank, Heal, Gold e Multikill + Damage Share % + tier multiplier
- ✅ Top 3 partidas com maior score
- ✅ Campeões com maior score médio
- ✅ Comparativo: score do jogador vs seu score na mesma partida

### 2.3 — Seu próprio ranking (FORA MVP)

Cartão fixo no topo da página mostrando sua posição entre todos, seu score médio e evolução recente (últimas 10 partidas).

---

## Fase 3 — Redesign de UI ✅ CONCLUÍDA

**Objetivo:** Interface moderna, premium e temática de ARAM Mayhem — sem perder a legibilidade dos dados.

> **Implementado:** Jost via Google Fonts (`global.css`, `--font-sans`), classes
> utilitárias `.glass` / `.depth-hover` / `.depth-inset` / `.shimmer-gold`, tokens
> de paleta (`--color-glass*`, `--color-score-*`) e gradiente de fundo `#050508→#0d0d1a`.
> Sidebar e cards em glass com profundidade; linhas de match com borda lateral
> win/loss espessa + glow no hover; badge de score com glow + shimmer dourado nas
> notas altas.

### 3.1 — Tipografia

Substituir `system-ui / Segoe UI` pela fonte **Jost** (Google Fonts):
- Jost 400 para corpo
- Jost 600 para labels e valores
- Jost 700 para títulos e scores

### 3.2 — Glassmorphism

Aplicar glass effect nos cards principais:

```css
background: rgba(255, 255, 255, 0.04);
backdrop-filter: blur(12px);
border: 1px solid rgba(255, 255, 255, 0.08);
box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
```

Sidebar com glass sobre fundo com partículas/gradiente sutil.

### 3.3 — Perspectiva e profundidade

- Cards de stat com leve `transform: perspective(800px) rotateX(1deg)` no hover
- Badges de score com brilho animado (`shimmer` em gold)
- Linha de match history com bordas laterais coloridas (win/loss) mais espessas e com glow
- Efeito de `depth` na sidebar: sombra interna suave

### 3.4 — Paleta de cores atualizada

Manter o DNA gold do LoL mas adicionar:
- `--color-glass`: `rgba(255,255,255,0.04)`
- `--color-glass-border`: `rgba(255,255,255,0.08)`
- `--color-score-high`: `#c89b3c` (gold — score ≥ 70)
- `--color-score-mid`: `#7cb9e8` (blue — score 40–69)
- `--color-score-low`: `#6b7280` (gray — score < 40)
- Gradiente de fundo: `#050508` → `#0d0d1a`

### 3.5 — Score badge no Match History

Cada card de partida ganha um badge de score no canto direito:

```
[ 78 ]  ← número com cor baseada na faixa + glow sutil
```

Tooltip ao hover: breakdown dos componentes (KDA: 22pts, DMG: 18pts, etc.)

---

## Fase 4 — Melhorias de Produto ✅ CONCLUÍDA

### 4.1 — Filtros no Match History ✅

- ✅ Filtrar por campeão · resultado (W/L) · período (7/30 dias) · ordenar por score
- Filtros server-side em `db.getMatchHistory(limit, offset, filters)`; barra `FilterBar` no topo do Match History.

### 4.2 — Estatísticas estendidas ✅

Persistidas em `player_stats` via migration `migrateExtendedStats()` (colunas
`total_time_cc_dealt`, `physical_damage`, `magic_damage`, `true_damage`,
`vision_score`, `time_played`, `killing_sprees`), com backfill do `raw_json` e
captura em `insertGameFull`. (Exibição na UI fica como follow-up.)

### 4.3 — Augment Synergy Score ✅

Coluna **Synergy** na página de Augments = score médio das partidas em que o
augment foi pego (`getAugmentStatsWithChampions().synergyScore`). Sortável.

### 4.4 — Champions Page — Performance Rating ✅

Coluna **Score** (score médio por campeão) na tabela de campeões, sortável.
Média feita sobre o display em JS (transform não-linear).

### 4.5 — Friends Page — Score Comparison ✅

Coluna **Score (vs você)**: score médio do amigo nas partidas compartilhadas +
delta vs. o seu score nessas mesmas partidas (`getTeammateStats`).

### 4.6 — Trend Chart ✅

Card **Score Trend** na página principal — SVG nativo (`ScoreTrendChart`) com as
últimas 20 partidas, área preenchida, linha de média e guias 40/70.

### 4.7 — Settings — Score Tuning ✅

Seção **Score Tuning** (`ScoreTuning`): sliders dos pesos (persistidos em
`settings.score_weights`) + recompute automático, força-refresh da tier list e
visualização da tier list atual (campeão + tier + multiplier).

---

## Fase 5 — Extras ✅ CONCLUÍDA

### 5.1 — Aba Tier List ✅

Nova aba **Tier List** (`/tierlist`, `TierList.tsx`) — cópia da ARAM Mayhem tier
list da Blitz dentro do tracker. Campeões agrupados por tier (S→D) com thumbnail +
multiplicador de tier por grupo, código de cor por tier e botão "Atualizar"
(força-refresh). Dados de `getTierList()` (cache `champion_tiers`, fonte iesdev).

### 5.2 — Friends — Histórico de partidas com o amigo ✅

Clicar num amigo (com puuid) abre um drawer (`FriendMatchesPanel`) com todas as
partidas em que vocês jogaram juntos — sua performance (campeão, KDA, score) por
partida + WR conjunto. Filtro server-side `getMatchHistory({ withPuuid })`
(LIKE no `raw_json`). **Clicar numa partida do drawer** leva ao Match History e
abre o placar completo dela (5×5, vitória, stats): navegação via router state
(`expandGameId`), que carrega páginas até a partida, expande e rola até ela.

---

> **🏁 v2.0** — MVP do fork concluído (Fases 1 → 5). Próximas ideias entram em
> versões futuras.

## Ordem de Implementação Sugerida

```
Fase 1.5 → 1.1 → 1.2 → 1.3 → 1.4        ✅ CONCLUÍDA
     ↓
Fase 2.2 (painel de contexto)            ✅ CONCLUÍDA
     ↓
Fase 3.1 → 3.2 → 3.3 → 3.4 → 3.5         ✅ CONCLUÍDA
     ↓
Fase 4.1 → 4.4 → 4.5 → 4.2 → 4.3 → 4.6 → 4.7   ✅ CONCLUÍDA

Fase 2 (Leaderboard) — adiada, fora do MVP
```

---

## Dependências Externas

| Dependência | Uso | Risco |
|---|---|---|
| Blitz.gg scraping | Tier list de ARAM Mayhem | Médio — pode quebrar a cada redesign do site |
| Riot Data Dragon | Tags/roles de campeões | Baixo — API estável e versionada |
| Google Fonts (Jost) | Tipografia | Baixo — ou bundle local para uso offline |

---

*Documento vivo — atualizar conforme decisões de implementação.*
