/**
 * PSC Pro — Worker de Análise por IA (Scout)
 * ============================================================
 * Proxy serverless entre o app (PWA) e a API da Anthropic.
 * A API key NUNCA fica no cliente — só existe aqui, como Secret
 * do Cloudflare Worker.
 *
 * DEPLOY (resumo — via dashboard do Cloudflare):
 * 1. Cloudflare Dashboard → Workers & Pages → Create → Worker
 * 2. Cole este arquivo inteiro no editor, publique
 * 3. Settings → Variables → Secrets → adicione ANTHROPIC_API_KEY
 *    (sua chave da API da Anthropic — console.anthropic.com)
 * 4. Settings → Bindings → KV Namespace → crie um namespace (ex:
 *    "PSC_RATE_LIMIT") e associe à variável RATE_LIMIT_KV
 * 5. Copie a URL final (algo como
 *    https://psc-ai-analysis.SEU-SUBDOMINIO.workers.dev) e cole na
 *    constante AI_WORKER_URL dentro de app.js, substituindo o
 *    placeholder 'https://REPLACE-WITH-YOUR-WORKER.workers.dev/analyze'
 * 6. Rebuild/republique o pacote do app com essa URL já configurada
 *
 * Alternativa via CLI (wrangler): "wrangler deploy" depois de
 * configurar wrangler.toml com o KV namespace e o secret via
 * "wrangler secret put ANTHROPIC_API_KEY".
 * ============================================================
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

const MAX_REQUESTS_PER_DAY = 10;     // por deviceId
const NOTES_CHAR_LIMIT = 4096;       // rede de segurança — trunca antes de devolver
const MAX_OUTPUT_TOKENS = 1600;      // 5 parágrafos em PT/ES podem passar de ~1200 tokens antes de chegar a 4096 chars; folga de ~30%

// CORS — ajuste ALLOWED_ORIGIN para o domínio real do seu app em produção
// (ex: 'https://marceloribeiro1711.github.io'). '*' funciona mas é mais
// permissivo do que o necessário.
const ALLOWED_ORIGIN = '*';

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}

function jsonResponse(body, status) {
    return new Response(JSON.stringify(body), {
        status: status || 200,
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders()),
    });
}

// ---- Rate limiting por deviceId, usando Cloudflare KV ----
// Chave: rl:{deviceId}:{YYYY-MM-DD} — TTL de 26h (folga sobre 24h)
// Retorno: true (permitido) | false (limite diário do utilizador atingido)
// | 'error' (falha do KV em si — ex: cota de writes do plano Free excedida —
// nunca deixamos essa exceção subir crua e derrubar o Worker inteiro).
async function checkAndIncrementRateLimit(env, deviceId) {
    if (!env.RATE_LIMIT_KV) return true; // sem KV configurado, não bloqueia (falha aberta)
    try {
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
        const key = 'rl:' + deviceId + ':' + today;
        const current = parseInt((await env.RATE_LIMIT_KV.get(key)) || '0', 10);
        if (current >= MAX_REQUESTS_PER_DAY) return false;
        await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 26 * 3600 });
        return true;
    } catch (e) {
        console.error('[RATE_LIMIT] KV falhou:', e && e.message ? e.message : e);
        return 'error';
    }
}

// ---- Construção do prompt (5 parágrafos — ver spec-ai-scout-analysis-v3) ----
const LANGUAGE_NAMES = {
    en: 'English',
    es: 'Spanish (Español)',
    pt: 'Portuguese (Português)',
    fr: 'French (Français)',
    it: 'Italian (Italiano)',
    de: 'German (Deutsch)',
};

// Palavra "dupla/equipa" no idioma da análise — antepor ao nome (ex:
// "a dupla MARCELO/THIAGO") resolve naturalmente a concordância verbal em
// línguas que exigem singular para um nome com "/" que parece plural (PT,
// ES, FR, IT). Não tratamos a concordância em si — só damos à IA um nome
// que já a resolve sozinho ao ser usado como sujeito da frase.
const TEAM_WORD = {
    en: 'team',
    es: 'la pareja',
    pt: 'a dupla',
    fr: "l'équipe",
    it: 'la coppia',
    de: 'das Team',
};

// Soma os stats individuais por dupla (team1/team2) — pré-calculado aqui
// para não depender da IA somar números corretamente (mesma filosofia de
// fidelidade de dados usada na regra de scoring abaixo).
function computeTeamStats(payload) {
    const fields = ['unforcedErrors', 'forcedErrors', 'doubleFaults', 'winners', 'smashWinners'];
    const stats = { team1: {}, team2: {} };
    fields.forEach(function (f) { stats.team1[f] = 0; stats.team2[f] = 0; });
    (payload.playerStats || []).forEach(function (p) {
        const bucket = stats[p.team];
        if (!bucket) return;
        fields.forEach(function (f) { bucket[f] += (p[f] || 0); });
    });
    return stats;
}

function buildPrompt(payload) {
    const langName = LANGUAGE_NAMES[payload.language] || 'English';
    const teamWord = TEAM_WORD[payload.language] || TEAM_WORD.en;
    const team1RawName = (payload.teams && payload.teams.team1 && payload.teams.team1.name) || 'Team 1';
    const team2RawName = (payload.teams && payload.teams.team2 && payload.teams.team2.name) || 'Team 2';
    const team1Name = teamWord + ' ' + team1RawName;
    const team2Name = teamWord + ' ' + team2RawName;
    const teamStats = computeTeamStats(payload);

    // Regra crítica de fidelidade de dados: o formato de pontuação
    // (payload.pointMode) determina se "vantagem"/"AD" sequer EXISTE nesta
    // partida. Golden Point e Star Point (após 2 deuces) NÃO têm vantagem
    // tradicional — o game é decidido num único ponto em 40-40. Se a IA
    // mencionar "AD"/"advantage" numa partida de Golden Point, é uma
    // alucinação: esse estado nunca aparece nos dados (scoreAfter nunca
    // chega a 'AD' nesse modo).
    let scoringRule;
    if (payload.pointMode === 'golden') {
        scoringRule = `SCORING FORMAT — GOLDEN POINT (critical, read carefully): this match uses Golden Point scoring. There is NO advantage/deuce state in this format — a game tied at 40-40 is decided by a single sudden-death point, called the "Golden Point". The scoreAfter values in the data NEVER include "AD" for this match. You MUST NOT mention "advantage", "AD", or a score progression like "30-AD" or "40-AD" anywhere in the analysis — that state does not exist in Golden Point scoring and doing so is a factual error. When describing a game that reached 40-40, refer to the deciding point as "the Golden Point", not as an advantage situation.`;
    } else if (payload.pointMode === 'star') {
        scoringRule = `SCORING FORMAT — STAR POINT: this match uses Star Point scoring. Traditional advantage exists for the first two deuces of a game (scoreAfter may show "AD" then), but after the second deuce in the same game, the next 40-40 is decided by a single sudden-death point (the "Star Point") — no further "AD" state exists in that specific game from that point on. Only mention "advantage"/"AD" when the data's scoreAfter values actually show it; refer to a sudden-death 40-40 as "the Star Point", not as an advantage situation.`;
    } else {
        scoringRule = `SCORING FORMAT — TRADITIONAL ADVANTAGE: this match uses traditional advantage scoring. "Advantage"/"AD" is a valid state and may appear in the data's scoreAfter values — only reference it when the data actually shows it.`;
    }

    return `You are a professional padel scout. Based on the result, the game-by-game trajectory per set, the point-by-point detail, and the individual player stats below, write the analysis in FIVE short, separate paragraphs, in ${langName}. Write the ENTIRE analysis in ${langName}, including surrounding text around names (keep player and dupla names themselves as given in the data):

TEAM NAMES — critical, read carefully: refer to each dupla using EXACTLY these two display names, word-for-word, including the leading designator word already translated into ${langName} — "${team1Name}" and "${team2Name}". That designator word keeps the sentence grammatically singular even though the name itself looks like two names joined by "/" (this matters especially in ${langName}). Do NOT drop the designator word and do NOT add your own extra one before it. NEVER write the literal strings "team1", "team2", "Team 1" or "Team 2" anywhere in the output — those are internal data keys, not display names, and using them is a factual/presentation error.

${scoringRule}

PRE-COMPUTED TEAM TOTALS (dupla vs dupla, already summed from playerStats — use these exact numbers, do not recompute or estimate them yourself):
${team1Name}: ${JSON.stringify(teamStats.team1)}
${team2Name}: ${JSON.stringify(teamStats.team2)}

PARAGRAPH 1 (dupla vs dupla — team-level scout opener, 3-4 sentences): using ONLY the PRE-COMPUTED TEAM TOTALS above, compare "${team1Name}" and "${team2Name}" as units — which dupla played cleaner or more aggressive padel (unforcedErrors relative to winners/smashWinners), which dupla was tested more by the opponents (forcedErrors), and how doubleFaults compare between them. Write this the way a doubles scout report opens with the pair's combined numbers before going player-by-player. Stay at the dupla level in this paragraph — do not single out individual players here.

PARAGRAPH 2 (general reading, 2-3 sentences): the decisive factor in the result, one strength for each dupla, a training focus suggestion for the losing dupla. You may cite break point conversion (breakPoints field) as an objective metric.

PARAGRAPH 3 (set trajectory, 1-2 sentences): if any set had a meaningful turnaround — e.g. a dupla that was down by a significant margin and recovered — mention it using the sets field and the order of games won. If no set had a notable turnaround, this can be a shorter paragraph acknowledging a close or dominant set.

PARAGRAPH 4 (point-by-point tactical reading, 2-3 sentences): using the points array of a specific game from matchLog, identify a pattern only visible at this level — a run of consecutive lost points, an unconverted advantage (ONLY if the scoring format above actually allows advantage AND the data shows it), etc. Cite the set/game AND the servingPlayer name when relevant (e.g. "Pablo dropped serve twice in a row in set 2" — translate the surrounding sentence to ${langName}, keep the player name as-is). Follow the SCORING FORMAT rule above strictly when describing any 40-40 moment. NEVER narrate point-by-point a game with isTiebreakGame=true — only cite its result if needed.

PARAGRAPH 5 (individual player reading — keep this the shortest paragraph, 1-2 sentences, may be left empty): using the playerStats array, check if any player had unforcedErrors clearly above their partner AND above 4-5 total errors (below that, do not comment — normal match noise). If you identify that player, compare their OWN forcedErrors and unforcedErrors to decide the reading:
  - If forcedErrors is also high → that player was likely targeted by the opponents; suggest working on resilience/defense under pressure.
  - If forcedErrors is low → the errors come from their own initiative (premature or unnecessary attacking); suggest more patience, building longer points, waiting for the right moment to close instead of resolving too early.
This is a single sharp observation, not a full breakdown — noticeably shorter than paragraphs 1-4. Use hedging language tied to a single-match sample (an equivalent of "in this match", in ${langName}), never claim a permanent trait from a single match. If no player shows a material pattern, leave this paragraph empty — do not force a reading.

Rules:
- Do not invent numbers or situations outside the provided data.
- Always use the real dupla names ("${team1Name}" / "${team2Name}") and real player names — never the literal data keys "team1"/"team2".
- Do not repeat the raw final score (the coach already sees that on screen) — focus on interpretation.
- If a paragraph lacks enough data for a specific, reliable claim, prefer a more generic sentence over inventing one (or, for paragraph 5, leave it empty).
- Keep the combined output well under ${NOTES_CHAR_LIMIT} characters.
- The ENTIRE output must be in ${langName} — do not mix languages, do not default to English unless ${langName} is English.
- Strictly follow the SCORING FORMAT rule above — do not describe a scoring state (advantage/AD, deuce) that doesn't exist in this match's format.

Match data:
${JSON.stringify(payload)}`;
}

async function callAnthropic(env, prompt) {
    const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: MAX_OUTPUT_TOKENS,
            messages: [{ role: 'user', content: prompt }],
        }),
    });

    if (!res.ok) {
        const errText = await res.text().catch(function () { return ''; });
        throw new Error('Anthropic API error ' + res.status + ': ' + errText.slice(0, 300));
    }

    const data = await res.json();
    const block = (data.content || []).find(function (b) { return b.type === 'text'; });
    if (!block || !block.text) throw new Error('Empty response from Anthropic API');
    return block.text.trim();
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders() });
        }
        if (request.method !== 'POST') {
            return jsonResponse({ error: 'Method not allowed' }, 405);
        }

        let payload;
        try {
            payload = await request.json();
        } catch (e) {
            return jsonResponse({ error: 'Invalid JSON body' }, 400);
        }

        const deviceId = (payload && payload.deviceId) ? String(payload.deviceId).slice(0, 64) : null;
        if (!deviceId) {
            return jsonResponse({ error: 'Missing deviceId' }, 400);
        }
        if (!payload.matchLog || !Array.isArray(payload.matchLog) || payload.matchLog.length === 0) {
            return jsonResponse({ error: 'Missing or empty matchLog' }, 400);
        }

        const rateLimitResult = await checkAndIncrementRateLimit(env, deviceId);
        if (rateLimitResult === 'error') {
            // KV falhou (ex: cota de writes do plano Free excedida) — nunca deixa
            // isto virar exceção não tratada. Resposta limpa, o app.js já trata
            // qualquer !res.ok como "análise indisponível" e oferece retry.
            return jsonResponse({ error: 'AI analysis temporarily unavailable, please try again shortly' }, 503);
        }
        if (rateLimitResult === false) {
            return jsonResponse({ error: 'Daily analysis limit reached' }, 429);
        }

        if (!env.ANTHROPIC_API_KEY) {
            return jsonResponse({ error: 'Server misconfigured: missing ANTHROPIC_API_KEY' }, 500);
        }

        try {
            const prompt = buildPrompt(payload);
            let analysis = await callAnthropic(env, prompt);
            if (analysis.length > NOTES_CHAR_LIMIT) {
                analysis = analysis.slice(0, NOTES_CHAR_LIMIT - 1) + '…';
            }
            return jsonResponse({ analysis: analysis }, 200);
        } catch (e) {
            return jsonResponse({ error: String(e && e.message ? e.message : e) }, 502);
        }
    },
};
