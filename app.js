(function () {
    // ── Polyfill TextEncoder/TextDecoder para Android 8 WebView ──────────────
    if (typeof TextEncoder === 'undefined') {
        window.TextEncoder = function() {};
        window.TextEncoder.prototype.encode = function(str) {
            var out = [];
            for (var i = 0; i < str.length; i++) {
                var c = str.charCodeAt(i);
                if (c < 128) { out.push(c); }
                else if (c < 2048) { out.push((c >> 6) | 192, (c & 63) | 128); }
                else { out.push((c >> 12) | 224, ((c >> 6) & 63) | 128, (c & 63) | 128); }
            }
            return new Uint8Array(out);
        };
    }

    // ============================================================
    // LICENSE SYSTEM — removido (3.8.0). PSC PRO é vendido diretamente
    // nas lojas (Apple/Android) — sem voucher, trial ou tier gratuito
    // dentro do app. O gerador de Device ID abaixo é mantido: a Análise
    // por IA usa `_deviceId` para o rate-limit no Worker (ver worker.js).
    // ============================================================
    const APP_VERSION = '3.9.5';

    // ---- Device fingerprint (usado só para o rate-limit da IA) ----
    async function sha256hex(str) {
        if (window.crypto && window.crypto.subtle) {
            try {
                const data = new TextEncoder().encode(str);
                const hash = await crypto.subtle.digest('SHA-256', data);
                return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('');
            } catch(e) {}
        }
        // Fallback: simple deterministic hash for older browsers
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        // Extend to 10 hex chars using multiple passes
        let result = '';
        let seed = h;
        while (result.length < 10) {
            seed = (seed * 0x6b43a9b5 + 0x1) >>> 0;
            result += seed.toString(16).padStart(8, '0');
        }
        return result.slice(0, 10);
    }

    async function getCanvasFP() {
        try {
            const c = document.createElement('canvas');
            c.width = 200; c.height = 40;
            const ctx = c.getContext('2d');
            if (!ctx) return 'no-canvas';
            ctx.textBaseline = 'alphabetic';
            ctx.font = '14px Arial';
            ctx.fillStyle = '#c8e030';
            ctx.fillText('PadelCoaching2026', 10, 28); // sem emoji — Android 8 pode falhar
            ctx.fillStyle = 'rgba(11,26,53,0.5)';
            ctx.fillRect(30, 5, 80, 20);
            return c.toDataURL().slice(-32);
        } catch(e) { return 'no-canvas'; }
    }

    async function computeDeviceId() {
        try {
            const canvasFP = await getCanvasFP();
            const fp = [
                navigator.userAgent || '',
                navigator.language || '',
                ((navigator.languages || []).join ? navigator.languages.join(',') : ''),
                navigator.platform || '',
                String(navigator.hardwareConcurrency || 0),
                String(navigator.deviceMemory || 0),
                String(screen.width || 0),
                String(screen.height || 0),
                String(screen.colorDepth || 0),
                String(window.devicePixelRatio || 1),
                (Intl && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().timeZone : '') || '',
                String(navigator.maxTouchPoints || 0),
                canvasFP,
            ].join('|');
            const hash = await sha256hex(fp);
            return hash.slice(0, 10).toUpperCase();
        } catch(e) {
            // Fallback robusto para Android 8 — usar apenas userAgent + screen
            const simple = (navigator.userAgent || '') + '|' + screen.width + 'x' + screen.height;
            return await sha256hex(simple).then(h => h.slice(0, 10).toUpperCase()).catch(() => 'FALLBACK001');
        }
    }

    // Device ID — usado só como chave de rate-limit da Análise por IA
    // (ver worker.js). Sem UI própria: o Coach nunca precisa de o ver.
    let _deviceId = null;
    computeDeviceId().then(function (id) { _deviceId = id; })
        .catch(function () { _deviceId = 'FALLBACK001'; });

    function updateVersionLabels() {
        var cfgVerEl = document.getElementById('config-version-label');
        if (cfgVerEl) cfgVerEl.textContent = 'V ' + APP_VERSION;
    }
    updateVersionLabels();

    // ============================================================
    // SERVE INDICATOR SYSTEM
    // ============================================================
    // Players: 0=t1-p1, 1=t1-p2, 2=t2-p1, 3=t2-p2
    // Teams:   0=dupla1 (players 0,1), 1=dupla2 (players 2,3)
    const SERVE = {
        current: null,
        gamesPlayed: 0,
        gamesThisSet: 0,     // games jogados neste set (reset em cada novo set)
        phase: 'pick-any',
        firstTeam: 0,
        tbPoints: 0,
        tbFirst: null,
        t1FirstServer: null,
        t2FirstServer: null,
        // "Turno-âncora" de cada dupla — em qual turno de saque daquela
        // dupla (0-indexado) o t1FirstServer/t2FirstServer é válido como
        // referência. 0 = referência é o 1º saque do set (caso normal).
        // Uma correcção manual a meio de um game move este valor para o
        // turno actual, em vez de reescrever a história do set inteiro
        // (ver onServeBallTap e calcNextServer).
        t1AnchorTurn: 0,
        t2AnchorTurn: 0,
    };

    const SERVE_IDS = ['t1-p1', 't1-p2', 't2-p1', 't2-p2'];

    function serveBall(playerIdx) {
        return document.getElementById('serve-ball-' + SERVE_IDS[playerIdx]);
    }

    function renderServeBalls() {
        var showWS = (SERVE.phase === 'pick-any' || SERVE.phase === 'pick-t1' || SERVE.phase === 'pick-t2');

        SERVE_IDS.forEach((id, i) => {
            const ball = document.getElementById('serve-ball-' + id);
            const lsBall = document.getElementById('ls-serve-ball-' + id);
            [ball, lsBall].forEach(function(b) {
                if (!b) return;
                b.classList.remove('active', 'pending');
            });

            if (SERVE.phase === 'pick-any') {
                if (ball) ball.classList.add('pending'); // todas piscam
                if (lsBall) lsBall.classList.add('pending');
            } else if (SERVE.phase === 'pick-t2') {
                if (i === 2 || i === 3) {
                    if (ball) ball.classList.add('pending'); // dupla 2 pisca
                    if (lsBall) lsBall.classList.add('pending');
                }
            } else if (SERVE.phase === 'pick-t1') {
                if (i === 0 || i === 1) {
                    if (ball) ball.classList.add('pending'); // dupla 1 pisca
                    if (lsBall) lsBall.classList.add('pending');
                }
            } else if (SERVE.phase === 'auto' || SERVE.phase === 'tb') {
                if (SERVE.current === i) {
                    if (ball) ball.classList.add('active');
                    if (lsBall) lsBall.classList.add('active');
                }
            }
        });

        // Badge WHO'S SERVE? — portrait e landscape
        var wsP  = document.getElementById('whos-serve-p');
        var wsLS = document.getElementById('ls-whos-serve');
        if (wsP)  wsP.classList.toggle('show', showWS);
        if (wsLS) wsLS.classList.toggle('show', showWS);
    }

    function serveTeamOf(playerIdx) {
        return playerIdx < 2 ? 0 : 1;
    }

    // ============================================================
    // POINT LOG — trajetória de pontos do game (spec: pausa técnica)
    // ============================================================
    const SCORE_LABELS = ['0', '15', '30', '40', 'AD'];
    let matchGameLogs = [];        // todos os games da partida (persistido no histórico)
    let currentGamePoints = [];    // pontos do game em curso
    let currentGameServingTeam = null; // 0 = dupla1, 1 = dupla2 (capturado no 1º ponto do game)
    let currentGameServingPlayer = null; // 0..3 = jogador específico que sacou (t1p1,t1p2,t2p1,t2p2)
    let currentGameBreakPoints = [0, 0]; // oportunidades de quebra no game em curso, por dupla
    let gameLogEnabled = false;    // Sempre Off — sem toggle na UI. Popup automático da troca de
                                    // campo desligado; acesso manual (menu/histórico) não depende disto.
    let aiAnalysisLanguage = 'en'; // Config: idioma da Análise por IA — en (padrão), es, pt, fr, it, de

    let currentGameBpPeak = 0;     // maior diferença (recebedora - sacadora) já atingida no game em curso

    // Contabiliza oportunidades de quebra segundo a regra padrão de scout
    // de tênis/padel: a diferença de pontos entre a dupla recebedora e a
    // sacadora representa quantos break points ela já "acumulou" nesse
    // game — ex: 0-40 = 3 break points, 0-30 = 2, 15-40 = 2. O valor é o
    // PICO atingido durante o game (nunca decresce, mesmo que a sacadora
    // recupere pontos depois). Em vantagem tradicional, star point
    // decisivo ou golden point decisivo (40-40), cada ocorrência soma
    // MAIS UM break point, independente do pico já registado antes.
    function trackBreakPointOpportunity() {
        if (state.isSuperTieBreak || state.isTieBreakMode || state.matchOver) return;
        if (!(SERVE.phase === 'auto' || SERVE.phase === 'tb') || SERVE.current === null) return;
        const serverTeam = serveTeamOf(SERVE.current);
        const recvTeam   = 1 - serverTeam;
        const serverPts  = state.pts[serverTeam];
        const recvPts    = state.pts[recvTeam];

        const isAdvantage     = recvPts === 4 && serverPts === 3;
        const isStarDecisive  = state.deuceCount >= 2 && recvPts === 3 && serverPts === 3;
        const isGoldenDecisive = (pointMode === 'golden' || prosetMode) && recvPts === 3 && serverPts === 3;
        if (isAdvantage || isStarDecisive || isGoldenDecisive) {
            currentGameBreakPoints[recvTeam]++;
            return;
        }

        const diff = recvPts - serverPts;
        if (diff > currentGameBpPeak) {
            currentGameBreakPoints[recvTeam] += (diff - currentGameBpPeak);
            currentGameBpPeak = diff;
        }
    }

    // Regista um ponto no gameLog do game em curso. Fora de âmbito na v1:
    // tie-break normal e SuperTie (escala numérica própria, sem 15/30/40).
    function logGamePoint(idx) {
        // SuperTie e tie-break normal (6-6) partilham o mesmo tratamento:
        // escala numérica corrida (0,1,2...), sem teto. O saque roda a
        // CADA PONTO no breaker (ao contrário de um game normal, onde é
        // fixo o game inteiro) — por isso aqui guardamos o servidor em
        // CADA evento de ponto, não só uma vez no cabeçalho do game.
        const isBreaker = state.isSuperTieBreak || state.isTieBreakMode;

        if (currentGameServingTeam === null && SERVE.current !== null) {
            currentGameServingTeam = serveTeamOf(SERVE.current);
            currentGameServingPlayer = SERVE.current;
        }
        const scoreAfter = isBreaker
            ? { team1: String(state.pts[0]), team2: String(state.pts[1]) }
            : {
                team1: SCORE_LABELS[Math.min(state.pts[0], 4)],
                team2: SCORE_LABELS[Math.min(state.pts[1], 4)]
              };
        const pointEvent = {
            point: currentGamePoints.length + 1,
            wonBy: 'team' + (idx + 1),
            scoreAfter: scoreAfter
        };
        if (isBreaker && SERVE.current !== null) {
            pointEvent.server = pointLogPlayerNameByIdx(SERVE.current); // servidor DESSE ponto específico
        }
        currentGamePoints.push(pointEvent);
    }

    // ---- UI do popup Point Log ----
    let pointLogSourceData = [];  // TODOS os games disponíveis (todos os sets da fonte actual)
    let pointLogActiveSet = 0;    // set actualmente selecionado nas tabs
    let pointLogWindow = [];      // games do set activo (mais antigo primeiro)
    let pointLogViewIndex = 0;

    // Monta as tabs "SET 1 / SET 2 / SET 3" com base nos sets presentes em
    // pointLogSourceData. Só aparece quando há mais de 1 set disponível
    // (ex: popup ao vivo no set 1 não precisa de tabs).
    function renderPointLogSetTabs() {
        const wrap = document.getElementById('pointlog-set-tabs');
        if (!wrap) return;
        const sets = [...new Set(pointLogSourceData.map(g => g.set))].sort((a, b) => a - b);
        if (sets.length <= 1) { wrap.innerHTML = ''; wrap.style.display = 'none'; return; }
        wrap.style.display = 'flex';
        wrap.innerHTML = sets.map(s => {
            const isSuperTieSet = pointLogSourceData.some(g => g.set === s && g.isSuperTie);
            const label = isSuperTieSet ? 'SUPERTIE' : ('SET ' + (s + 1));
            return '<button class="pointlog-set-tab' + (s === pointLogActiveSet ? ' active' : '') + '" ' +
                'onclick="setPointLogActiveSet(' + s + ')">' + label + '</button>';
        }).join('');
    }

    // Troca o set exibido dentro do popup já aberto (chamado pelas tabs)
    function setPointLogActiveSet(setNum) {
        pointLogActiveSet = setNum;
        pointLogWindow = pointLogSourceData.filter(g => g.set === setNum);
        pointLogViewIndex = pointLogWindow.length - 1; // game mais recente desse set
        renderPointLogSetTabs();
        renderPointLog();
    }

    // Núcleo de abertura do popup — usado tanto pelo gatilho automático da
    // pausa técnica quanto pela entrada manual no menu hambúrguer.
    // `manual` = true dá feedback (toast) quando não há nada pra mostrar;
    // o gatilho automático fica em silêncio nesse caso.
    // O toggle gameLogEnabled controla APENAS o popup automático na troca
    // de campo (ver maybeShowPointLogPopup) — a gravação de dados e o
    // acesso manual (menu, histórico) nunca dependem dele.
    function openPointLogPopup(manual) {
        if (matchGameLogs.length === 0) {
            if (manual) showToast('No games logged yet this match');
            return;
        }
        pointLogSourceData = matchGameLogs; // todos os sets já jogados nesta partida
        // Por padrão mostra o set em curso; se ainda não tiver games nele
        // (ex: acabou de mudar de set), cai para o set mais recente disponível
        const hasCurrentSet = pointLogSourceData.some(g => g.set === state.currentSet);
        pointLogActiveSet = hasCurrentSet ? state.currentSet : pointLogSourceData[pointLogSourceData.length - 1].set;
        pointLogWindow = pointLogSourceData.filter(g => g.set === pointLogActiveSet);
        pointLogViewIndex = pointLogWindow.length - 1;
        renderPointLogSetTabs();
        initPointLogScrollSync();
        renderPointLog();
        const overlay = document.getElementById('pointlog-overlay');
        if (overlay) overlay.classList.add('show');
    }

    // Gatilho automático (chamado de winGame na troca de lado). Não deve
    // interromper o modo TV/landscape — a tela existe pra ficar visível à
    // distância durante o jogo, sem popups por cima.
    function maybeShowPointLogPopup() {
        if (!gameLogEnabled) return; // toggle só controla o popup automático
        if (window.matchMedia && window.matchMedia('(orientation: landscape)').matches) return;
        openPointLogPopup(false);
    }

    // Entrada manual pelo menu hambúrguer — Coach pode abrir a qualquer momento
    function openGameLogMenu() {
        openPointLogPopup(true);
    }

    // Abre o Game Log de uma partida já salva no histórico (tela "Last 10
    // Games"). Ao contrário da versão ao vivo (que usa o estado da partida
    // em curso), aqui os dados vêm do `pointLog` gravado no histórico —
    // com TODOS os sets da partida disponíveis via tabs.
    function openPointLogFromHistory(idx) {
        const history = loadHistory();
        const entry = history[idx];
        if (!entry) return;
        const pointLog = entry.pointLog || [];
        if (pointLog.length === 0) {
            showToast('No Match Log data for this match');
            return;
        }
        pointLogSourceData = pointLog; // todos os sets dessa partida
        pointLogActiveSet = pointLog[pointLog.length - 1].set; // set mais recente por padrão
        pointLogWindow = pointLogSourceData.filter(g => g.set === pointLogActiveSet);
        pointLogViewIndex = pointLogWindow.length - 1;
        renderPointLogSetTabs();
        initPointLogScrollSync();
        renderPointLog();
        const overlay = document.getElementById('pointlog-overlay');
        if (overlay) overlay.classList.add('show');
    }

    // Wrapper sem parâmetro para o botão do footer do histórico (mesmo
    // padrão de sendGameByEmail/exportHistoryGameToExcel — sempre o game
    // atualmente visível no carousel)
    function openPointLogFromHistoryCurrent() {
        openPointLogFromHistory(carouselIdx);
    }

    function closePointLogPopup() {
        const overlay = document.getElementById('pointlog-overlay');
        if (overlay) overlay.classList.remove('show');
    }

    function pointLogPrev() {
        if (pointLogViewIndex > 0) { pointLogViewIndex--; renderPointLog(); }
    }

    function pointLogNext() {
        if (pointLogViewIndex < pointLogWindow.length - 1) { pointLogViewIndex++; renderPointLog(); }
    }

    function pointLogPlayerNames(teamKey) {
        const ids = teamKey === 'team1' ? ['t1-p1', 't1-p2'] : ['t2-p1', 't2-p2'];
        const names = ids.map(id => {
            const el = document.getElementById(id);
            return el && el.innerText ? el.innerText.trim() : '';
        });
        return names.filter(Boolean).join(' / ') || (teamKey === 'team1' ? 'Team 1' : 'Team 2');
    }

    // Nome do JOGADOR específico que sacou naquele game (não a dupla toda)
    // — ajuda o Coach a identificar exatamente quem teve o serviço quebrado.
    // Cai para o nome da dupla se o dado não existir (ex: histórico antigo).
    // Monta o markup da linha "Break Points opportunities" — a frase na
    // cor da dupla, o número em vermelho e maior (dado relevante em destaque)
    function breakPointsHtml(teamKey, count) {
        const cls = teamKey === 'team1' ? 'pointlog-bp-team1' : 'pointlog-bp-team2';
        return '<span class="' + cls + '">Break Points opportunities: </span>' +
               '<span class="pointlog-bp-number">' + count + '</span>';
    }

    // Resolve o nome do jogador a partir do índice bruto (0-3: t1p1,t1p2,t2p1,t2p2)
    function pointLogPlayerNameByIdx(idx) {
        const ids = ['t1-p1', 't1-p2', 't2-p1', 't2-p2'];
        if (idx === null || idx === undefined || !ids[idx]) return null;
        const el = document.getElementById(ids[idx]);
        const name = el && el.innerText ? el.innerText.trim() : '';
        return name || null;
    }

    function pointLogServingPlayerName(game) {
        return pointLogPlayerNameByIdx(game.servingPlayer) || pointLogPlayerNames(game.servingTeam);
    }

    function renderPointLog() {
        const game = pointLogWindow[pointLogViewIndex];
        if (!game) return;

        // pointLogWindow já É o set completo (ao vivo ou do histórico),
        // então a numeração vem direto dele — nunca de matchGameLogs
        // (que é sempre a partida AO VIVO e ficaria errado ao mostrar
        // dados de uma partida antiga vindos do histórico)
        const gameNumber = pointLogWindow.indexOf(game) + 1;
        const titleEl = document.getElementById('pointlog-title');
        if (titleEl) {
            if (game.isSuperTie) {
                titleEl.textContent = 'SUPERTIE'; // não é um "set" — sem prefixo SET X
            } else if (prosetMode) {
                titleEl.textContent = 'GAME ' + gameNumber; // ProSet é um único set — sem número
            } else {
                titleEl.textContent = 'SET ' + (game.set + 1) + ' — GAME ' + gameNumber;
            }
        }

        // SET LOG — não faz sentido para SuperTie (não é medido em games)
        const setlogBlock = document.getElementById('setlog-block');
        if (setlogBlock) setlogBlock.style.display = game.isSuperTie ? 'none' : '';
        if (!game.isSuperTie) renderSetLogTrail();

        const t1El = document.getElementById('pointlog-team1-name');
        const t2El = document.getElementById('pointlog-team2-name');
        const isBreakerGame = game.isSuperTie || game.isTiebreakGame;
        if (t1El) {
            // Num breaker o saque roda a cada ponto — não faz sentido
            // afirmar "estava sacando" pra um único jogador o game inteiro
            t1El.textContent = (!isBreakerGame && game.servingTeam === 'team1')
                ? (pointLogServingPlayerName(game) + ' was serving 🎾')
                : pointLogPlayerNames('team1');
        }
        if (t2El) {
            t2El.textContent = (!isBreakerGame && game.servingTeam === 'team2')
                ? (pointLogServingPlayerName(game) + ' was serving 🎾')
                : pointLogPlayerNames('team2');
        }

        // Break Points opportunities — não se aplica a SuperTie/tie-break
        // (conceito de quebra de saque não existe da mesma forma ali)
        const bp1El = document.getElementById('pointlog-team1-bp');
        const bp2El = document.getElementById('pointlog-team2-bp');
        const bp = game.breakPoints || { team1: 0, team2: 0 };
        if (bp1El) bp1El.innerHTML = isBreakerGame ? '' : breakPointsHtml('team1', bp.team1);
        if (bp2El) bp2El.innerHTML = isBreakerGame ? '' : breakPointsHtml('team2', bp.team2);

        // SuperTie e tie-break normal já têm dados reais ponto-a-ponto
        // (escala numérica, modo compacto) — só games realmente sem
        // nenhum ponto registado (caso legado/corrompido) caem na mensagem
        const emptyMsgEl = document.getElementById('pointlog-empty-msg');
        const t1TrailEl = document.getElementById('pointlog-trail-team1');
        const t2TrailEl = document.getElementById('pointlog-trail-team2');
        if (!game.points || game.points.length === 0) {
            if (emptyMsgEl) {
                emptyMsgEl.style.display = '';
                emptyMsgEl.textContent = 'No point-by-point data available for this game.';
            }
            if (t1TrailEl) t1TrailEl.style.display = 'none';
            if (t2TrailEl) t2TrailEl.style.display = 'none';
        } else {
            if (emptyMsgEl) emptyMsgEl.style.display = 'none';
            if (t1TrailEl) t1TrailEl.style.display = '';
            if (t2TrailEl) t2TrailEl.style.display = '';
            renderPointLogTrails(game);
        }
    }

    // SET LOG — trajectória de games do set (nível acima do Game Log).
    // Cada coluna é um GAME (não um ponto): mostra o placar de games de
    // ambas as duplas após aquele game, com o game actualmente
    // seleccionado destacado a vermelho — é ele que alimenta o Game Log
    // (ponto-a-ponto) exibido logo abaixo.
    function renderSetLogTrail() {
        const c1 = document.getElementById('setlog-trail-team1');
        const c2 = document.getElementById('setlog-trail-team2');
        if (!c1 || !c2) return;
        let t1 = 0, t2 = 0;
        let html1 = '';
        let html2 = '';
        pointLogWindow.forEach((g, i) => {
            if (g.winner === 'team1') t1++; else t2++;
            const activeClass = i === pointLogViewIndex ? ' active' : '';
            html1 += '<span class="setlog-node' + activeClass + '" onclick="setPointLogViewIndex(' + i + ')">' + t1 + '</span>';
            html2 += '<span class="setlog-node' + activeClass + '" onclick="setPointLogViewIndex(' + i + ')">' + t2 + '</span>';
            if (i < pointLogWindow.length - 1) {
                html1 += '<span class="setlog-connector"></span>';
                html2 += '<span class="setlog-connector"></span>';
            }
        });
        c1.innerHTML = html1;
        c2.innerHTML = html2;

        const t1NameEl = document.getElementById('setlog-team1-name');
        const t2NameEl = document.getElementById('setlog-team2-name');
        if (t1NameEl) t1NameEl.textContent = pointLogPlayerNames('team1');
        if (t2NameEl) t2NameEl.textContent = pointLogPlayerNames('team2');
    }

    // Selecciona directamente um game clicando na coluna do Set Log
    function setPointLogViewIndex(i) {
        if (i < 0 || i >= pointLogWindow.length) return;
        pointLogViewIndex = i;
        renderPointLog();
    }

    // Renderiza as duas linhas (Dupla 1 / Dupla 2) em COLUNAS alinhadas pela
    // ordem cronológica do ponto: coluna 1 = ponto 1, coluna 2 = ponto 2, etc.
    // Cada coluna preenche a linha de quem ganhou aquele ponto específico;
    // a linha da outra dupla fica vazia na mesma coluna. Isso preserva a
    // leitura de sequência (ex: 3 pontos seguidos perdidos aparecem como
    // 3 colunas vazias consecutivas na linha da dupla que perdeu).
    function renderPointLogTrails(game) {
        const c1 = document.getElementById('pointlog-trail-team1');
        const c2 = document.getElementById('pointlog-trail-team2');
        if (!c1 || !c2) return;
        // SuperTie e tie-break normal podem ter mais pontos que um game
        // normal — usa nós menores (modo compacto) pra reduzir scroll
        const useCompact = !!game.isSuperTie || !!game.isTiebreakGame;
        c1.classList.toggle('compact', useCompact);
        c2.classList.toggle('compact', useCompact);
        const total = game.points.length;
        let html1 = '';
        let html2 = '';
        game.points.forEach((pt, i) => {
            const isLastPoint = i === total - 1;
            const isWinningPoint = isLastPoint && pt.gameWinner;
            // Toda coluna mostra o placar das DUAS duplas naquele momento
            // (leitura tipo placar ao vivo), não só de quem ganhou o ponto.
            // Exceção na coluna final: vencedor mostra só ✅; o perdedor
            // SEMPRE mostra o próprio placar, e — se estava sacando (ou
            // seja, teve o serviço quebrado) — o rótulo "BROKEN" aparece
            // logo depois, como um elemento adicional, nunca substituindo
            // o placar.
            const winnerIsTeam1 = isWinningPoint && pt.wonBy === 'team1';
            const winnerIsTeam2 = isWinningPoint && pt.wonBy === 'team2';
            if (winnerIsTeam1) {
                html1 += '<span class="pointlog-node pointlog-node-win">✅</span>';
                html2 += '<span class="pointlog-node">' + pt.scoreAfter.team2 + '</span>';
                if (game.servingTeam === 'team2') {
                    html2 += '<span class="pointlog-node pointlog-node-lose">BROKEN</span>';
                }
            } else if (winnerIsTeam2) {
                html2 += '<span class="pointlog-node pointlog-node-win">✅</span>';
                html1 += '<span class="pointlog-node">' + pt.scoreAfter.team1 + '</span>';
                if (game.servingTeam === 'team1') {
                    html1 += '<span class="pointlog-node pointlog-node-lose">BROKEN</span>';
                }
            } else {
                html1 += '<span class="pointlog-node">' + pt.scoreAfter.team1 + '</span>';
                html2 += '<span class="pointlog-node">' + pt.scoreAfter.team2 + '</span>';
            }
            if (!isLastPoint) {
                html1 += '<span class="pointlog-connector"></span>';
                html2 += '<span class="pointlog-connector"></span>';
            }
        });
        c1.innerHTML = html1 || '<span class="pointlog-node dim">—</span>';
        c2.innerHTML = html2 || '<span class="pointlog-node dim">—</span>';
    }

    // Sincroniza o scroll horizontal de duas linhas irmãs (cada uma com
    // seu próprio contêiner rolável) — rolar uma rola a outra junto,
    // mantendo as colunas sempre alinhadas. Reutilizável para o Game Log
    // (Dupla 1/Dupla 2) e para o Set Log (Dupla 1/Dupla 2).
    function syncScrollPair(el1, el2) {
        if (!el1 || !el2) return;
        let syncing = false;
        el1.addEventListener('scroll', function () {
            if (syncing) return;
            syncing = true; el2.scrollLeft = el1.scrollLeft; syncing = false;
        });
        el2.addEventListener('scroll', function () {
            if (syncing) return;
            syncing = true; el1.scrollLeft = el2.scrollLeft; syncing = false;
        });
    }

    let _pointLogScrollSynced = false;
    function initPointLogScrollSync() {
        if (_pointLogScrollSynced) return;
        syncScrollPair(document.getElementById('pointlog-trail-team1'), document.getElementById('pointlog-trail-team2'));
        syncScrollPair(document.getElementById('setlog-trail-team1'), document.getElementById('setlog-trail-team2'));
        _pointLogScrollSynced = true;
    }

    // Calcular próximo servidor automático após um game
    // Usa gamesThisSet para alternância correcta dentro de cada set
    function calcNextServer(gamesAfterInSet) {
        const ft = SERVE.firstTeam || 0;
        // Alterna a cada game: ft serve games ímpares, 1-ft serve games pares
        const team = ((gamesAfterInSet - 1) % 2 === 0) ? ft : (1 - ft);
        // Quantas vezes esta dupla já serviu antes deste game neste set
        const timesServed = Math.floor((gamesAfterInSet - 1) / 2);

        if (team === 0) {
            const anchor = SERVE.t1FirstServer !== null ? SERVE.t1FirstServer : 0;
            const anchorTurn = SERVE.t1AnchorTurn || 0;
            const flips = timesServed - anchorTurn; // distância (em turnos) até o âncora
            return (flips % 2 === 0) ? anchor : (anchor === 0 ? 1 : 0);
        } else {
            const anchor = SERVE.t2FirstServer !== null ? SERVE.t2FirstServer : 0;
            const anchorTurn = SERVE.t2AnchorTurn || 0;
            const flips = timesServed - anchorTurn;
            return (flips % 2 === 0) ? (2 + anchor) : (2 + (anchor === 0 ? 1 : 0));
        }
    }

    // Chamado quando um game termina (winGame)
    function onGameEnd() {
        if (SERVE.phase === 'off') return;
        SERVE.gamesPlayed++;
        SERVE.gamesThisSet++;
        SERVE.tbPoints = 0;

        if (state.isTieBreakMode || state.isSuperTieBreak) {
            SERVE.phase = 'tb';
            const nextNormal = calcNextServer(SERVE.gamesThisSet);
            SERVE.current = nextNormal;
            SERVE.tbFirst = nextNormal;
            SERVE.tbPoints = 0;
            renderServeBalls();
            return;
        }

        // Game 2 de cada set: dupla adversária escolhe livremente quem serve
        if (SERVE.gamesThisSet === 1) {
            if (SERVE.firstTeam === 0 && SERVE.t2FirstServer === null) {
                SERVE.phase = 'pick-t2';
                renderServeBalls();
                return;
            }
            if (SERVE.firstTeam === 1 && SERVE.t1FirstServer === null) {
                SERVE.phase = 'pick-t1';
                renderServeBalls();
                return;
            }
        }

        SERVE.phase = 'auto';
        SERVE.current = calcNextServer(SERVE.gamesThisSet + 1);
        renderServeBalls();
    }

    // Servidor para o ponto N do tiebreak (0-indexed)
    // Padrão: ponto 0 → tbFirst (1 ponto), depois 2 a 2 alternando duplas
    // seguindo a sequência normal de jogadores
    function tbServerAtPoint(pointIdx) {
        const first = SERVE.tbFirst;
        const firstTeam = first < 2 ? 0 : 1;

        if (pointIdx === 0) return first;

        // A partir do ponto 1: blocos de 2, começando pela dupla adversária
        // ponto 1-2 → adversário, ponto 3-4 → first team, ponto 5-6 → adversário, ...
        const blockIdx = Math.floor((pointIdx - 1) / 2); // 0, 0, 1, 1, 2, 2, ...
        const teamThisBlock = blockIdx % 2 === 0 ? (1 - firstTeam) : firstTeam;

        // Quantas vezes cada equipa já serviu ANTES deste bloco (incluindo o ponto 0)
        // firstTeam: 1 vez (ponto 0) + Math.floor((blockIdx+1)/2) vezes de blocos
        // adversário: Math.ceil(blockIdx/2) + (blockIdx%2===0?1:0) ...
        // Mais simples: contar directamente
        let firstTeamServes = 1; // o ponto 0
        let advTeamServes = 0;
        for (let b = 0; b < blockIdx; b++) {
            if (b % 2 === 0) advTeamServes++;
            else firstTeamServes++;
        }

        if (teamThisBlock === firstTeam) {
            // Quantas vezes o firstTeam serviu antes → determina qual jogador
            const timesServed = firstTeamServes;
            if (firstTeam === 0) {
                const f = SERVE.t1FirstServer !== null ? SERVE.t1FirstServer : 0;
                return timesServed % 2 === 0 ? f : (f === 0 ? 1 : 0);
            } else {
                const f = SERVE.t2FirstServer !== null ? SERVE.t2FirstServer : 0;
                return timesServed % 2 === 0 ? (2 + f) : (2 + (f === 0 ? 1 : 0));
            }
        } else {
            const timesServed = advTeamServes;
            if ((1 - firstTeam) === 0) {
                const f = SERVE.t1FirstServer !== null ? SERVE.t1FirstServer : 0;
                return timesServed % 2 === 0 ? f : (f === 0 ? 1 : 0);
            } else {
                const f = SERVE.t2FirstServer !== null ? SERVE.t2FirstServer : 0;
                return timesServed % 2 === 0 ? (2 + f) : (2 + (f === 0 ? 1 : 0));
            }
        }
    }

    function onTbPoint() {
        if (SERVE.phase !== 'tb') return;
        // tbPoints já foi incrementado antes desta chamada (no addPoint)
        SERVE.current = tbServerAtPoint(SERVE.tbPoints);
        renderServeBalls();
    }

    // Tocar numa bola para seleccionar/corrigir servidor
    function onServeBallTap(playerIdx) {
        if (SERVE.phase === 'off') return;

        if (SERVE.phase === 'pick-any') {
            SERVE.current = playerIdx;
            SERVE.firstTeam = playerIdx < 2 ? 0 : 1;
            if (playerIdx < 2) {
                SERVE.t1FirstServer = playerIdx;
            } else {
                SERVE.t2FirstServer = playerIdx - 2;
            }
            if (state.isSuperTieBreak) {
                SERVE.phase = 'tb';
                SERVE.tbFirst = playerIdx;
            } else {
                SERVE.phase = 'auto';
            }
            renderServeBalls();
            return;
        }

        if (SERVE.phase === 'pick-t2') {
            if (playerIdx < 2) return;
            SERVE.t2FirstServer = playerIdx - 2;
            SERVE.current = playerIdx;
            if (state.isSuperTieBreak) {
                SERVE.phase = 'tb';
                SERVE.tbFirst = playerIdx;
            } else {
                SERVE.phase = 'auto';
            }
            hideSetIntervalCardBtn();
            renderServeBalls();
            return;
        }

        if (SERVE.phase === 'pick-t1') {
            if (playerIdx >= 2) return;
            SERVE.t1FirstServer = playerIdx;
            SERVE.current = playerIdx;
            if (state.isSuperTieBreak) {
                SERVE.phase = 'tb';
                SERVE.tbFirst = playerIdx;
            } else {
                SERVE.phase = 'auto';
            }
            hideSetIntervalCardBtn();
            renderServeBalls();
            return;
        }

        // 'auto' ou 'tb' — correcção manual
        SERVE.current = playerIdx;
        if (SERVE.phase === 'tb') {
            // Tie-break (normal de set OU super tie-break) — reinicia a
            // contagem de pontos a partir do ponto corrigido. Como a
            // contagem toda reinicia (tbPoints=0), não há "história" do
            // set a preservar aqui — ao contrário do game normal abaixo.
            SERVE.tbFirst = playerIdx;
            SERVE.tbPoints = 0;
            if (playerIdx < 2) {
                SERVE.t1FirstServer = playerIdx;
            } else {
                SERVE.t2FirstServer = playerIdx - 2;
            }
        } else {
            // Game normal em curso — a dupla do jogador corrigido já pode
            // ter sacado antes neste set (games anteriores). Em vez de
            // reescrever t1FirstServer/t2FirstServer como se este fosse o
            // 1º saque do set (o que desalinhava toda a alternância dali
            // pra frente — inclusive depois de virar de set), guardamos o
            // jogador corrigido como novo âncora NO TURNO DE SAQUE ACTUAL
            // da dupla. A alternância futura passa a contar a partir daqui,
            // preservando os games já jogados e a dupla adversária intacta.
            const gameNoInSet = SERVE.gamesThisSet + 1;         // game actual, 1-indexado no set
            const timesServedNow = Math.floor((gameNoInSet - 1) / 2); // turno de saque desta dupla, agora
            if (playerIdx < 2) {
                SERVE.t1FirstServer = playerIdx;
                SERVE.t1AnchorTurn = timesServedNow;
            } else {
                SERVE.t2FirstServer = playerIdx - 2;
                SERVE.t2AnchorTurn = timesServedNow;
            }
        }
        renderServeBalls();
    }

    // Iniciar/reiniciar o sistema de serviço (início de jogo ou novo set)
    function initServe() {
        SERVE.phase = 'pick-any';
        SERVE.current = null;
        SERVE.gamesPlayed = 0;
        SERVE.gamesThisSet = 0;
        SERVE.firstTeam = 0;
        SERVE.tbPoints = 0;
        SERVE.tbFirst = null;
        SERVE.t1FirstServer = null;
        SERVE.t2FirstServer = null;
        SERVE.t1AnchorTurn = 0;
        SERVE.t2AnchorTurn = 0;
        _serveStatCounted = false;
        renderServeBalls();
    }

    function initServeNewSet(lastServerBeforeSet) {
        // A dupla que serve o 1º game do novo set é a oposta à que serviu o último game
        const lastTeam = (lastServerBeforeSet !== null && lastServerBeforeSet !== undefined)
            ? serveTeamOf(lastServerBeforeSet)
            : SERVE.firstTeam;
        const nextTeam = 1 - lastTeam;

        SERVE.phase = nextTeam === 0 ? 'pick-t1' : 'pick-t2';
        SERVE.current = null;
        SERVE.gamesThisSet = 0;
        SERVE.firstTeam = nextTeam;
        SERVE.tbPoints = 0;
        SERVE.tbFirst = null;
        SERVE.t1FirstServer = nextTeam === 0 ? null : SERVE.t1FirstServer;
        SERVE.t2FirstServer = nextTeam === 1 ? null : SERVE.t2FirstServer;
        // Turnos-âncora sempre reiniciam a 0 num set novo — mesmo para a
        // dupla que mantém o t1FirstServer/t2FirstServer do set anterior,
        // porque gamesThisSet (e portanto timesServed) reinicia a 0 aqui.
        // Sem isto, um âncora movido a meio do set anterior ficaria
        // desalinhado com a contagem do set novo.
        SERVE.t1AnchorTurn = 0;
        SERVE.t2AnchorTurn = 0;
        _serveStatCounted = false;
        renderServeBalls();
    }

    // Registar listeners de toque nas bolas — portrait e landscape
    SERVE_IDS.forEach((id, i) => {
        const ball = document.getElementById('serve-ball-' + id);
        if (ball) {
            ball.addEventListener('click', () => onServeBallTap(i));
            ball.addEventListener('touchend', (e) => {
                e.preventDefault();
                onServeBallTap(i);
            });
        }
        const lsBall = document.getElementById('ls-serve-ball-' + id);
        if (lsBall) {
            lsBall.addEventListener('click', () => onServeBallTap(i));
            lsBall.addEventListener('touchend', (e) => {
                e.preventDefault();
                onServeBallTap(i);
            });
        }
    });

    // ============================================================
    // LAYOUT — exclusivamente Portrait
    // ============================================================
    document.getElementById('layout-portrait').style.display = 'flex';

    // ============================================================
    // UPLOAD FOTOS + LOGOS
    // Abordagem: cada foto/logo tem o seu próprio <input> dentro de um <label>.
    // O utilizador toca diretamente no label → browser abre o picker nativamente
    // sem nenhum .click() programático — funciona em Chrome Android PWA.
    // ============================================================

    // Toast de feedback visual
    function showToast(msg, color) {
        let t = document.getElementById('_upload_toast');
        if (!t) {
            t = document.createElement('div');
            t.id = '_upload_toast';
            Object.assign(t.style, {
                position:'fixed', bottom:'12vh', left:'50%', transform:'translateX(-50%)',
                background:'#1e3a6e', color:'#fff', padding:'1.2dvh 4vw',
                borderRadius:'8px', fontSize:'1.5dvh', fontWeight:'700',
                zIndex:'99999', pointerEvents:'none', transition:'opacity .4s',
                boxShadow:'0 4px 16px rgba(0,0,0,.5)', whiteSpace:'nowrap'
            });
            document.body.appendChild(t);
        }
        t.style.background = color || '#1e3a6e';
        t.textContent = msg;
        t.style.opacity = '1';
        clearTimeout(t._timer);
        t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2800);
    }

    // ── IndexedDB para fotos e logos (evita quota localStorage com base64 grande) ──
    const IDB_NAME    = 'padel_assets';
    const IDB_STORE   = 'blobs';
    const IDB_VERSION = 1;
    let _idb = null;

    function openIDB() {
        if (_idb) return Promise.resolve(_idb);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
            req.onsuccess = e => { _idb = e.target.result; resolve(_idb); };
            req.onerror   = () => reject(req.error);
        });
    }

    function idbSet(key, value) {
        return openIDB().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        }));
    }

    function idbGet(key) {
        return openIDB().then(db => new Promise((resolve, reject) => {
            const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }));
    }

    // ── Foto placeholder — usada quando o utilizador não escolheu foto ──────
    // Mesma imagem que está no src inicial das <img> no HTML (logo NiceShot)
    const DEFAULT_PHOTO_IDS = ['t1-img1', 't1-img2', 't2-img1', 't2-img2'];

    function applyPhoto(baseId, dataUrl) {
        const isDefault = (dataUrl === null || dataUrl === undefined);
        const p = document.getElementById(baseId);
        if (p) {
            p.src = isDefault
                ? p.dataset.default || p.src  // mantém o src já no HTML
                : dataUrl;
            p.style.objectFit = isDefault ? 'contain' : 'cover';
        }
        if (!isDefault) {
            // Guardar em IndexedDB; fallback para localStorage se IDB indisponível
            idbSet('photo_' + baseId, dataUrl).catch(() => {
                try { localStorage.setItem('padel_photo_' + baseId, dataUrl); } catch(e) {}
            });
        }
    }

    function restorePhotos() {
        DEFAULT_PHOTO_IDS.forEach(id => {
            // Garantir que a foto default tem object-fit: contain
            const imgEl = document.getElementById(id);
            if (imgEl) imgEl.style.objectFit = 'contain';

            idbGet('photo_' + id).then(val => {
                if (val) {
                    const p = document.getElementById(id);
                    if (p) { p.src = val; p.style.objectFit = 'cover'; }
                }
            }).catch(() => {
                try {
                    const saved = localStorage.getItem('padel_photo_' + id);
                    if (saved) applyPhoto(id, saved);
                } catch(e) {}
            });
        });
    }

    function _processImageFile(file, maxSize, onDone) {
        if (!file) return;
        showToast('⏳ Processing...');
        const reader = new FileReader();
        reader.onload = function(ev) {
            const dataUrl = ev.target.result;
            try {
                const img = new Image();
                img.onload = function() {
                    try {
                        const scale = Math.min(1, maxSize / Math.max(img.width || 1, img.height || 1));
                        const w = Math.round((img.width  || maxSize) * scale);
                        const h = Math.round((img.height || maxSize) * scale);
                        const canvas = document.createElement('canvas');
                        canvas.width = w; canvas.height = h;
                        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                        onDone(canvas.toDataURL('image/jpeg', 0.82));
                    } catch(e) { onDone(dataUrl); }
                };
                img.onerror = function() { onDone(dataUrl); };
                img.src = dataUrl;
            } catch(e) { onDone(dataUrl); }
        };
        reader.onerror = function() { showToast('❌ Error reading file', '#991b1b'); };
        reader.readAsDataURL(file);
    }

    // Registar listeners em cada input individual
    ['t1-img1','t1-img2','t2-img1','t2-img2'].forEach(function(id) {
        const input = document.getElementById('fi-' + id);
        if (!input) return;
        input.addEventListener('change', function() {
            const file = this.files && this.files[0];
            if (!file) return;
            _processImageFile(file, 480, function(dataUrl) {
                applyPhoto(id, dataUrl);
                showToast('✅ Photo updated', '#166534');
            });
            try { input.value = ''; } catch(e) {}
        });
    });

    ['left','right'].forEach(function(side) {
        const input = document.getElementById('fi-logo-' + side);
        if (!input) return;
        input.addEventListener('change', function() {
            const file = this.files && this.files[0];
            if (!file) return;
            _processImageFile(file, 300, function(dataUrl) {
                applyLogo(side, dataUrl);
                showToast('✅ Logo updated', '#166534');
            });
            try { input.value = ''; } catch(e) {}
        });
    });

    // Nota: changePhoto / changePhotoById / changeLogo foram removidas.
    // O upload é agora feito exclusivamente via <input type="file"> com listeners
    // registados acima — sem .click() programático, compatível com Android PWA.


    // Normaliza qualquer imagem para 320×106px (proporção do carrossel) antes de exibir
    function normalizeLogoImage(dataUrl, callback) {
        const LOGO_W = 320, LOGO_H = 106;
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            canvas.width = LOGO_W; canvas.height = LOGO_H;
            const ctx = canvas.getContext('2d');
            // Escalar proporcionalmente para caber em 320×106
            const scale = Math.min(LOGO_W / img.width, LOGO_H / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            const x = (LOGO_W - w) / 2;
            const y = (LOGO_H - h) / 2;
            ctx.clearRect(0, 0, LOGO_W, LOGO_H);
            ctx.drawImage(img, x, y, w, h);
            callback(canvas.toDataURL('image/png'));
        };
        img.src = dataUrl;
    }

    function applyLogo(side, dataUrl) {
        // Normalizar para 320×106 antes de exibir (só para o logo esquerdo)
        if (side === 'left') {
            normalizeLogoImage(dataUrl, normalizedUrl => applyLogoRaw(side, normalizedUrl));
        } else {
            applyLogoRaw(side, dataUrl);
        }
    }

    function applyLogoRaw(side, dataUrl) {
        const slot = document.getElementById(`logo-${side}-slot`);
        if (slot) {
            const ph = document.getElementById(`logo-${side}-placeholder`);
            if (ph) ph.style.display = 'none';
            const existing = slot.querySelector('img');
            if (existing) existing.remove();
            const img = document.createElement('img');
            img.src = dataUrl;
            slot.appendChild(img);
        }
        const cfgSlot = document.getElementById(`cfg-logo-${side}`);
        if (cfgSlot) {
            const ph = cfgSlot.querySelector('.cfg-logo-placeholder');
            if (ph) ph.style.display = 'none';
            const existing = cfgSlot.querySelector('img');
            if (existing) existing.remove();
            const img = document.createElement('img');
            img.src = dataUrl;
            cfgSlot.appendChild(img);
        }
        idbSet('logo_' + side, dataUrl).catch(() => {
            try { localStorage.setItem('padel_logo_' + side, dataUrl); } catch(e) {}
        });
    }

    // Recuperar logos guardados ao iniciar
    function restoreLogos() {
        ['left', 'right'].forEach(side => {
            idbGet('logo_' + side).then(val => {
                if (val) applyLogo(side, val);
            }).catch(() => {
                // Fallback: tentar localStorage (dados guardados antes da migração IDB)
                try {
                    const saved = localStorage.getItem('padel_logo_' + side);
                    if (saved) applyLogo(side, saved); // também migra para IDB
                } catch(e) {}
            });
        });
    }

    // Nomes editáveis + sincronização
    const defaultNames = ['Player 1','Player 2','Player 3','Player 4'];
    const defaultMap = {
        't1-p1':'Player 1','t1-p2':'Player 2',
        't2-p1':'Player 3','t2-p2':'Player 4'
    };
    // IDs portrait apenas — são a fonte de verdade
    const playerIds = ['t1-p1','t1-p2','t2-p1','t2-p2'];

    function savePlayerNames() {
        playerIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) try { localStorage.setItem(`padel_name_${id}`, el.innerText.trim()); } catch(e) {}
        });
    }

    function restoreNames() {
        playerIds.forEach(id => {
            try {
                const saved = localStorage.getItem(`padel_name_${id}`);
                if (saved && saved !== '') {
                    const el = document.getElementById(id);
                    if (el) el.innerText = saved;
                }
            } catch(e) {}
        });
    }

    document.querySelectorAll('[contenteditable]').forEach(el => {
        el.addEventListener('focus', function() {
            if (defaultNames.includes(this.innerText.trim())) this.innerText = '';
        });
        el.addEventListener('blur', function() {
            if (this.innerText.trim() === '') this.innerText = defaultMap[this.id] || '';
            savePlayerNames();
        });
        el.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); this.blur(); }
        });
    });

    // ============================================================
    // ESTADO DO JOGO — declarado antes de qualquer função que o use
    // ============================================================
    let state = {
        sets: [[0,0],[0,0],[0,0]], currentSet: 0, pts: [0,0],
        isSuperTieBreak: false, isTieBreakMode: false, matchOver: false,
        tiebreakPts: [null, null, null],
        deuceCount: 0
    };

    // ============================================================
    // MODO DE JOGO
    // ============================================================
    // superTieMode = true → 3º set é Super Tie-Break
    // superTieMode = false → 3º set normal até 6 com tie-break em 6x6
    let superTieMode = true;
    // prosetMode = true → jogo único até 9, sem sets 1 e 2
    let prosetMode = false;

    // pointMode: 'golden' | 'star'
    // FREE TIER: sempre Golden Point
    let pointMode = 'golden';

    function cyclePointMode() {
        pointMode = pointMode === 'golden' ? 'star' : 'golden';
        updateConfig();
        state.deuceCount = 0;
    }

    function updatePointModeButton() { updateConfig(); }

    function updateSet3Labels() {
        const label = prosetMode ? 'PROSET' : (superTieMode ? 'SUPERTIE' : 'SET 3');
        const isRed = superTieMode && !prosetMode;
        const isProset = prosetMode;
        document.querySelectorAll('.s3-label').forEach(el => {
            el.textContent = label;
            el.classList.toggle('supertie-label', isRed);
            el.classList.toggle('proset-label', isProset);
        });
        document.querySelectorAll('.ls3-label').forEach(el => {
            el.textContent = label;
            el.classList.toggle('supertie-label', isRed);
            el.classList.toggle('proset-label', isProset);
        });
    }

    function toggleGameMode() {
        if (state.currentSet < 1) {
            superTieMode = !superTieMode;
            if (superTieMode) prosetMode = false;
            updateSet3Labels();
            updateConfig();
        }
    }

    function updateModeButton() { updateConfig(); }

    let statsEnabled = true;

    function setStatsMode(val) {
        statsEnabled = val;
        applyStatsVisibility();
        updateConfig();
    }

    function applyStatsVisibility() {
        document.querySelectorAll('.p-team-panel').forEach(el => {
            el.classList.toggle('stats-hidden', !statsEnabled);
        });
    }

    function openConfig() {
        updateConfig();
        document.getElementById('config-overlay').classList.add('show');
    }
    function closeConfig() {
        document.getElementById('config-overlay').classList.remove('show');
    }
    function closeConfigOnBg(e) {
        if (e.target === document.getElementById('config-overlay')) closeConfig();
    }

    function setSetMode(val) {
        if (state.currentSet >= 1 || state.matchOver) return;
        prosetMode = false;
        superTieMode = val;
        updateSet3Labels();
        updateConfig();
    }

    function setProsetMode(val) {
        if (state.currentSet >= 1 || state.matchOver) return;
        prosetMode = val;
        if (val) superTieMode = false;
        updateSet3Labels();
        updateConfig();
    }

    function setPointMode(val) {
        if (state.matchOver) return;
        pointMode = val;
        state.deuceCount = 0;
        updateConfig();
        updateScreen();
    }

    function updateConfig() {
        const setLocked = state.currentSet >= 1 || state.matchOver;
        const ptLocked  = state.matchOver;
        // Set mode: superTieMode=true → Supertie active; superTieMode=false → 3 Sets active
        // Set mode buttons
        document.getElementById('cfg-3sets').classList.toggle('active', !superTieMode && !prosetMode);
        document.getElementById('cfg-supertie').classList.toggle('active', superTieMode && !prosetMode);
        document.getElementById('cfg-proset').classList.toggle('active', prosetMode);
        document.getElementById('cfg-set-toggle').classList.toggle('disabled', setLocked);
        document.getElementById('cfg-set-hint').textContent = state.matchOver
            ? 'Match finished — start a new game to change'
            : setLocked ? '1st set has started — set mode locked' : '';
        // Point mode toggle
        document.getElementById('cfg-gp').classList.toggle('active', pointMode === 'golden');
        document.getElementById('cfg-sp').classList.toggle('active', pointMode === 'star');
        document.getElementById('cfg-point-toggle').classList.toggle('disabled', ptLocked);
        // Stats toggle
        document.getElementById('cfg-stats-on').classList.toggle('active', statsEnabled);
        document.getElementById('cfg-stats-off').classList.toggle('active', !statsEnabled);
        // Match Log: sem toggle na UI — fica sempre Off (popup automático
        // desligado). Acesso continua disponível a qualquer momento pelo
        // menu hambúrguer e pelo histórico, que não dependem desta flag.
        // AI Analysis: geração é 100% manual pelo Histórico (sem chamada
        // automática ao fim de partida) — não há mais toggle On/Off aqui.
        // AI Analysis language
        ['en', 'es', 'pt', 'fr', 'it', 'de'].forEach(function (lang) {
            var el = document.getElementById('cfg-ai-lang-' + lang);
            if (el) el.classList.toggle('active', aiAnalysisLanguage === lang);
        });
    }

    // Não chamada por nenhum controlo da UI (removido o toggle do CONFIG —
    // gameLogEnabled fica fixo em false). Mantida no código, não apagada,
    // caso o toggle volte a fazer sentido no futuro.
    function setGameLogMode(val) {
        gameLogEnabled = val;
        updateConfig();
        saveGameState();
    }

    function setAiAnalysisLanguage(lang) {
        aiAnalysisLanguage = lang;
        updateConfig();
        saveGameState();
    }

    // ============================================================
    // JOGO
    // ============================================================
    const PADEL_SCORES = [0, 15, 30, 40];

    // ============================================================
    // TRACKING DE PONTOS POR SET
    // setStats[i] = estatísticas acumuladas do set i (0,1,2)
    // ============================================================
    function emptySetStat() {
        return {
            // pontos ganhos/perdidos por equipa
            ptsWon:   [0, 0],   // pontos marcados (inclui TB/STB)
            ptsLost:  [0, 0],   // pontos sofridos
            // situações especiais (por game normal)
            deuces:   0,        // nº de deuces (40-40) neste set
            goldenPts:[0, 0],   // quem ganhou cada Golden Point
            starPts:  [0, 0],   // quem ganhou cada Star Point (DC2)
            // tie-break / supertie
            tbPtsWon: [0, 0],   // pontos ganhos no TB/STB deste set
        };
    }
    let setStats = [emptySetStat(), emptySetStat(), emptySetStat()];

    // estado do game atual para tracking (reset a cada winGame)
    let gameTrack = {
        inDeuce: false,         // já houve deuce neste game
        deuceCountGame: 0,      // deuces dentro deste game
    };

    function resetSetStats() {
        setStats = [emptySetStat(), emptySetStat(), emptySetStat()];
        gameTrack = { inDeuce: false, deuceCountGame: 0 };
    }

    function updateScreen() {
        saveGameState(); // persistir estado a cada alteração
        for (let i = 0; i < 3; i++) {
            const [s1id, s2id, c1id, c2id, tb1id, tb2id] =
                [`t1-s${i+1}`, `t2-s${i+1}`, `t1-s${i+1}-cell`, `t2-s${i+1}-cell`, `t1-s${i+1}-tb`, `t2-s${i+1}-tb`];
            const s1 = document.getElementById(s1id), s2 = document.getElementById(s2id);
            const c1 = document.getElementById(c1id), c2 = document.getElementById(c2id);
            const tb1 = document.getElementById(tb1id), tb2 = document.getElementById(tb2id);
            if (s1) s1.innerText = (prosetMode && i < 2) ? '-' : state.sets[i][0];
            if (s2) s2.innerText = (prosetMode && i < 2) ? '-' : state.sets[i][1];
            if (c1) c1.className = 'score-cell';
            if (c2) c2.className = 'score-cell';
            if (tb1) tb1.textContent = '';
            if (tb2) tb2.textContent = '';
            if (i < state.currentSet) {
                const w1 = state.sets[i][0] > state.sets[i][1];
                const w2 = state.sets[i][1] > state.sets[i][0];
                if (c1) c1.classList.add(w1 ? 'won' : 'dim');
                if (c2) c2.classList.add(w2 ? 'won' : 'dim');
                const tbPts = state.tiebreakPts[i];
                if (tbPts !== null) {
                    if (!w1 && tb1) tb1.textContent = tbPts;
                    if (!w2 && tb2) tb2.textContent = tbPts;
                }
            } else if (i > state.currentSet) {
                if (c1) c1.classList.add('dim');
                if (c2) c2.classList.add('dim');
            }
        }

        const t = state.isSuperTieBreak || state.isTieBreakMode;
        let p1disp, p2disp;
        if (t) {
            p1disp = state.pts[0];
            p2disp = state.pts[1];
        } else if (pointMode === 'star' && state.pts[0] >= 3 && state.pts[1] >= 3) {
            const isAdv = (state.pts[0] === 4 && state.pts[1] === 3) || (state.pts[0] === 3 && state.pts[1] === 4);
            if (isAdv) {
                // ADV1 após o 40-40 inicial, ADV2 após o DC1
                const advLabel = state.deuceCount === 0 ? 'ADV1' : 'ADV2';
                p1disp = state.pts[0] === 4 ? advLabel : 40;
                p2disp = state.pts[1] === 4 ? advLabel : 40;
            } else {
                // 40-40: mostrar DC1 ou DC2 conforme deuceCount
                const dcLabel = state.deuceCount === 0 ? 40 : (state.deuceCount === 1 ? 'DC1' : 'DC2');
                p1disp = dcLabel;
                p2disp = dcLabel;
            }
        } else {
            p1disp = PADEL_SCORES[state.pts[0]] !== undefined ? PADEL_SCORES[state.pts[0]] : state.pts[0];
            p2disp = PADEL_SCORES[state.pts[1]] !== undefined ? PADEL_SCORES[state.pts[1]] : state.pts[1];
        }
        const t1pts = document.getElementById('t1-pts');
        const t2pts = document.getElementById('t2-pts');
        if (t1pts) { t1pts.innerText = p1disp; t1pts.classList.toggle('label-lg', isNaN(p1disp)); }
        if (t2pts) { t2pts.innerText = p2disp; t2pts.classList.toggle('label-lg', isNaN(p2disp)); }

        updateModeButton();

        // Label do modo de ponto — GP/SP removido do label Points

        // Banner GOLDEN POINT / STAR POINT
        const atDeuce = !state.isSuperTieBreak && !state.isTieBreakMode
            && state.pts[0] === 3 && state.pts[1] === 3 && !state.matchOver;
        const showGP = atDeuce && (
            pointMode === 'golden' ||
            (pointMode === 'star' && state.deuceCount >= 2)
        );
        const gpEl = document.getElementById('golden-point-p');
        if (gpEl) {
            const isStar = pointMode === 'star' && state.deuceCount >= 2;
            gpEl.textContent = isStar ? 'STAR POINT' : 'GOLDEN POINT';
            gpEl.style.background = isStar ? '#f5c518' : '#e03030';
            gpEl.style.color = isStar ? '#0b1a35' : '#fff';
            gpEl.classList.toggle('show', showGP);
        }

        // Banner BREAK POINT
        // Golden Point: recvPts===3 && serverPts<=3 (inclui 40-40)
        // Star Point: recvPts===3 && serverPts<3 (0-40,15-40,30-40)
        //          OU recvPts===4 && serverPts===3 (ADV do adversário)
        let showBP = false;
        let bpRecvTeam = null;
        if (!state.isSuperTieBreak && !state.isTieBreakMode && !state.matchOver
            && (SERVE.phase === 'auto' || SERVE.phase === 'tb') && SERVE.current !== null) {
            const serverTeam = serveTeamOf(SERVE.current);
            const recvTeam   = 1 - serverTeam;
            const serverPts  = state.pts[serverTeam];
            const recvPts    = state.pts[recvTeam];
            if (pointMode === 'golden' || prosetMode) {
                // Golden Point: BP desde 0-40 até 40-40
                showBP = recvPts === 3 && serverPts <= 3;
            } else {
                // Star Point: BP em 0-40, 15-40, 30-40, ADV adversário, ou DC2 (Star Point)
                const isStarPoint = state.deuceCount >= 2 && recvPts === 3 && serverPts === 3;
                showBP = (recvPts === 3 && serverPts < 3)
                      || (recvPts === 4 && serverPts === 3)
                      || isStarPoint;
            }
            if (showBP) bpRecvTeam = recvTeam;
        }
        document.getElementById('break-point-p').classList.toggle('show', showBP);

        // Sincronizar layout landscape
        syncLandscape(showBP, showGP, gpEl ? gpEl.textContent : 'GOLDEN POINT', bpRecvTeam);
    }

    // ── Landscape sync ──────────────────────────────────────────
    function syncLandscape(showBP, showGP, gpLabel, bpRecvTeam) {
        // Sets
        for (var _i = 0; _i < 3; _i++) {
            var s1el = document.getElementById('ls-t1-s' + (_i+1));
            var s2el = document.getElementById('ls-t2-s' + (_i+1));
            var c1el = document.getElementById('ls-t1-s' + (_i+1) + '-cell');
            var c2el = document.getElementById('ls-t2-s' + (_i+1) + '-cell');
            var tb1el = document.getElementById('ls-t1-s' + (_i+1) + '-tb');
            var tb2el = document.getElementById('ls-t2-s' + (_i+1) + '-tb');

            // copiar texto dos elements portrait originais
            var pS1 = document.getElementById('t1-s' + (_i+1));
            var pS2 = document.getElementById('t2-s' + (_i+1));
            var pTb1 = document.getElementById('t1-s' + (_i+1) + '-tb');
            var pTb2 = document.getElementById('t2-s' + (_i+1) + '-tb');
            var pC1 = document.getElementById('t1-s' + (_i+1) + '-cell');
            var pC2 = document.getElementById('t2-s' + (_i+1) + '-cell');

            if (s1el && pS1) s1el.innerText = pS1.innerText;
            if (s2el && pS2) s2el.innerText = pS2.innerText;
            if (tb1el && pTb1) tb1el.textContent = pTb1.textContent;
            if (tb2el && pTb2) tb2el.textContent = pTb2.textContent;

            // copiar classes won/dim
            if (c1el && pC1) {
                c1el.className = 'ls-set-cell';
                if (pC1.classList.contains('won')) c1el.classList.add('won');
                if (pC1.classList.contains('dim')) c1el.classList.add('dim');
            }
            if (c2el && pC2) {
                c2el.className = 'ls-set-cell';
                if (pC2.classList.contains('won')) c2el.classList.add('won');
                if (pC2.classList.contains('dim')) c2el.classList.add('dim');
            }
        }

        // Pontos parciais
        var pPts1 = document.getElementById('t1-pts');
        var pPts2 = document.getElementById('t2-pts');
        var lsPts1 = document.getElementById('ls-t1-pts');
        var lsPts2 = document.getElementById('ls-t2-pts');
        if (lsPts1 && pPts1) {
            lsPts1.innerText = pPts1.innerText;
            lsPts1.className = 'ls-pts-val' + (pPts1.classList.contains('label-lg') ? ' label-lg' : '');
        }
        if (lsPts2 && pPts2) {
            lsPts2.innerText = pPts2.innerText;
            lsPts2.className = 'ls-pts-val' + (pPts2.classList.contains('label-lg') ? ' label-lg' : '');
        }

        // Badges
        var lsBP = document.getElementById('ls-break-point');
        var lsGP = document.getElementById('ls-golden-point');
        var lsEO = document.getElementById('ls-end-of-match');
        var pEO  = document.getElementById('game-over-p');

        if (lsBP) lsBP.classList.toggle('show', showBP);
        if (lsGP) {
            lsGP.classList.toggle('show', showGP);
            lsGP.textContent = gpLabel || 'GOLDEN POINT';
            lsGP.classList.toggle('star', gpLabel === 'STAR POINT');
        }
        if (lsEO && pEO) lsEO.classList.toggle('show', pEO.classList.contains('show'));
        var lsCardBtn = document.getElementById('ls-card-btn');
        var pCardBtn = document.getElementById('gs-card-btn');
        if (lsCardBtn && pCardBtn) lsCardBtn.classList.toggle('show', pCardBtn.classList.contains('show'));

        // Timer
        var pTimerDisp = document.getElementById('timer-display-p');
        var lsTimerDisp = document.getElementById('ls-timer-display');
        if (lsTimerDisp && pTimerDisp) lsTimerDisp.textContent = pTimerDisp.textContent;

        // Nomes
        var nameMap = [
            ['t1-p1','ls-t1-p1'], ['t1-p2','ls-t1-p2'],
            ['t2-p1','ls-t2-p1'], ['t2-p2','ls-t2-p2']
        ];
        for (var _n = 0; _n < nameMap.length; _n++) {
            var pNEl = document.getElementById(nameMap[_n][0]);
            var lsNEl = document.getElementById(nameMap[_n][1]);
            if (pNEl && lsNEl) lsNEl.textContent = pNEl.innerText || pNEl.textContent;
        }

        // Fotos
        var photoMap = [
            ['t1-img1','ls-t1-img1'], ['t1-img2','ls-t1-img2'],
            ['t2-img1','ls-t2-img1'], ['t2-img2','ls-t2-img2']
        ];
        for (var _p = 0; _p < photoMap.length; _p++) {
            var pImgEl = document.getElementById(photoMap[_p][0]);
            var lsImgEl = document.getElementById(photoMap[_p][1]);
            if (pImgEl && lsImgEl && pImgEl.src && lsImgEl.src !== pImgEl.src) {
                lsImgEl.src = pImgEl.src;
            }
        }

        // Logo
        var pLogoImg = document.getElementById('logo-left-slot') && document.getElementById('logo-left-slot').querySelector('img');
        var lsLogoImg = document.getElementById('ls-logo-img');
        var lsLogoPlaceholder = document.getElementById('ls-logo-placeholder');
        if (pLogoImg && lsLogoImg) {
            if (pLogoImg.src && pLogoImg.style.display !== 'none') {
                lsLogoImg.src = pLogoImg.src;
                lsLogoImg.style.display = 'block';
                if (lsLogoPlaceholder) lsLogoPlaceholder.style.display = 'none';
            }
        }

        // Sponsor
        var pSponsor = document.getElementById('sponsor-slide');
        var lsSponsor = document.getElementById('ls-sponsor-img');
        if (pSponsor && lsSponsor && pSponsor.src) {
            if (lsSponsor.src !== pSponsor.src) lsSponsor.src = pSponsor.src;
            lsSponsor.style.display = pSponsor.style.display !== 'none' ? 'block' : 'none';
        }
    }
    // ── Fim Landscape sync ──────────────────────────────────────

    // Timer landscape: actualiza display landscape quando o timer corre
    var _lsTimerInterval = null;
    function _startLsTimerSync() {
        if (_lsTimerInterval) return;
        _lsTimerInterval = setInterval(function() {
            var pDisp = document.getElementById('timer-display-p');
            var lsDisp = document.getElementById('ls-timer-display');
            if (pDisp && lsDisp) lsDisp.textContent = pDisp.textContent;
        }, 500);
    }
    _startLsTimerSync();

    // Logo + Sponsor landscape: sync contínuo independente do updateScreen
    var _lsHeaderInterval = null;
    function _syncLsHeader() {
        // Logo
        var logoSlot = document.getElementById('logo-left-slot');
        var pLogoImg = logoSlot ? logoSlot.querySelector('img') : null;
        var lsLogoImg = document.getElementById('ls-logo-img');
        var lsLogoPlaceholder = document.getElementById('ls-logo-placeholder');
        if (lsLogoImg) {
            if (pLogoImg && pLogoImg.src) {
                if (lsLogoImg.src !== pLogoImg.src) lsLogoImg.src = pLogoImg.src;
                lsLogoImg.style.display = 'block';
                if (lsLogoPlaceholder) lsLogoPlaceholder.style.display = 'none';
            } else {
                lsLogoImg.style.display = 'none';
                if (lsLogoPlaceholder) lsLogoPlaceholder.style.display = 'flex';
            }
        }

        // Sponsor carousel
        var pSponsor = document.getElementById('sponsor-slide');
        var lsSponsor = document.getElementById('ls-sponsor-img');
        if (pSponsor && lsSponsor) {
            if (pSponsor.src && pSponsor.src !== lsSponsor.src) {
                lsSponsor.src = pSponsor.src;
            }
            lsSponsor.style.display = pSponsor.src ? 'block' : 'none';
            lsSponsor.style.opacity = pSponsor.style.opacity || '1';
        }
    }
    function _startLsHeaderSync() {
        if (_lsHeaderInterval) return;
        _syncLsHeader();
        _lsHeaderInterval = setInterval(_syncLsHeader, 500);
    }
    _startLsHeaderSync();

    // Menu hambúrguer — um único menu (FAB, canto inferior direito) serve
    // tanto o modo retrato como o TV Mode. O antigo menu do topo do TV Mode
    // (ls-menu-btn) foi removido — tinha exactamente os mesmos itens.
    (function initLsMenu() {
        // Menu hambúrguer portrait (FAB canto inferior direito)
        var pBtn = document.getElementById('p-fab-btn');
        var pDropdown = document.getElementById('p-fab-dropdown');
        if (pBtn && pDropdown) {
            pBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                pDropdown.classList.toggle('show');
            });
            pDropdown.addEventListener('click', function(e) {
                if (e.target.classList.contains('p-fab-item')) {
                    pDropdown.classList.remove('show');
                }
            });
            document.addEventListener('click', function(e) {
                if (!pDropdown.classList.contains('show')) return;
                if (pDropdown.contains(e.target) || pBtn.contains(e.target)) return;
                pDropdown.classList.remove('show');
            });
        }
    })();

    // Refresh forçado ao rodar o dispositivo: garante que labels, nomes e fotos
    // ficam imediatamente atualizados ao alternar entre portrait e landscape,
    // sem esperar pelo próximo evento de jogo ou pelo intervalo periódico.
    function _forceFullRefresh() {
        updateScreen();
        _syncLsHeader();
    }
    if (window.matchMedia) {
        var _lsOrientationMq = window.matchMedia('(orientation: landscape)');
        var _onOrientationChange = function() {
            // Pequeno atraso para garantir que o layout já trocou de display antes do refresh
            setTimeout(_forceFullRefresh, 50);
        };
        if (_lsOrientationMq.addEventListener) {
            _lsOrientationMq.addEventListener('change', _onOrientationChange);
        } else if (_lsOrientationMq.addListener) {
            // Fallback Android 8 / browsers antigos
            _lsOrientationMq.addListener(_onOrientationChange);
        }
    }
    window.addEventListener('orientationchange', function() {
        setTimeout(_forceFullRefresh, 50);
    });

    function checkGameLogic() {
        let p1 = state.pts[0], p2 = state.pts[1];
        if (state.isSuperTieBreak || state.isTieBreakMode) {
            let target = state.isSuperTieBreak ? 10 : 7;
            if ((p1 >= target || p2 >= target) && Math.abs(p1 - p2) >= 2) winGame(p1 > p2 ? 0 : 1);
        }
        // golden e star resolvem no addPoint, não chegam aqui com pts>3
    }

    function winGame(ti) {
        const _pointLogSet = state.currentSet; // capturado antes de qualquer winSet() mudar o set
        // Esconder banners imediatamente para evitar flash visual
        const gpEl = document.getElementById('golden-point-p');
        const bpEl = document.getElementById('break-point-p');
        if (gpEl) gpEl.classList.remove('show');
        if (bpEl) bpEl.classList.remove('show');
        // Serve Won / Broken Serve — contado quando o game é ganho
        // ti=0 dupla1 ganhou, ti=1 dupla2 ganhou; teamIndex = ti+1
        autoCountServe(ti + 1);
        state.deuceCount = 0;
        gameTrack = { inDeuce: false, deuceCountGame: 0 };
        _serveStatCounted = false;
        let setEnded = false;

        // ---- POINT LOG: finalizar o game em curso ----
        // Precisa correr ANTES de qualquer winSet(), porque winSet() pode
        // chamar endMatch() -> saveMatchHistory() de forma síncrona, e o
        // pointLog salvo no histórico tem de já incluir o game decisivo
        // (o "match point"), não só os anteriores.
        let _pointLogFinalized = false;
        function finalizePointLogGame(willSetEnd, isTiebreakClose) {
            if (_pointLogFinalized) return;
            _pointLogFinalized = true;
            // Rede de segurança: só teoricamente vazio em cenário legado/
            // corrompido — hoje SuperTie e tie-break normal já registam
            // pontos normalmente via logGamePoint.
            if (currentGamePoints.length === 0 && !isTiebreakClose) return;
            if (currentGamePoints.length > 0) {
                currentGamePoints[currentGamePoints.length - 1].gameWinner = true;
            }
            matchGameLogs.push({
                set: _pointLogSet,
                winner: 'team' + (ti + 1),
                servingTeam: currentGameServingTeam !== null ? ('team' + (currentGameServingTeam + 1)) : null,
                servingPlayer: currentGameServingPlayer,
                points: currentGamePoints,
                isSuperTie: state.isSuperTieBreak,
                isTiebreakGame: !!isTiebreakClose,
                breakPoints: { team1: currentGameBreakPoints[0], team2: currentGameBreakPoints[1] }
            });
            const totalGamesInSet = state.sets[_pointLogSet][0] + state.sets[_pointLogSet][1];
            if (!willSetEnd && (totalGamesInSet % 2 === 1)) {
                maybeShowPointLogPopup();
            }
        }

        if (state.isSuperTieBreak) {
            state.sets[2][0] = state.pts[0];
            state.sets[2][1] = state.pts[1];
            state.pts = [0, 0];
            finalizePointLogGame(true);
            winSet();
            setEnded = true;
        } else {
            if (state.isTieBreakMode) {
                const loserPts = Math.min(state.pts[0], state.pts[1]);
                state.tiebreakPts[state.currentSet] = loserPts;
            }
            state.sets[state.currentSet][ti]++;
            state.pts = [0,0];
            const g1 = state.sets[state.currentSet][0], g2 = state.sets[state.currentSet][1];
            if (state.isTieBreakMode) {
                finalizePointLogGame(true, true);
                winSet(); setEnded = true;
            }
            else if (prosetMode) {
                // PROSET: tiebreak a 8-8, vitória a 9 com diferença de 2
                if (g1 === 8 && g2 === 8) { state.isTieBreakMode = true; }
                else if ((g1 >= 9 || g2 >= 9) && Math.abs(g1-g2) >= 2) {
                    finalizePointLogGame(true);
                    winSet(); setEnded = true;
                }
            } else {
                if (g1 === 6 && g2 === 6) { state.isTieBreakMode = true; }
                else if ((g1 >= 6 || g2 >= 6) && Math.abs(g1-g2) >= 2) {
                    finalizePointLogGame(true);
                    winSet(); setEnded = true;
                }
            }
        }
        // Rede de segurança: caminhos que NÃO terminam o set (game comum)
        // ainda não passaram por finalizePointLogGame — chamado aqui.
        finalizePointLogGame(setEnded);

        currentGamePoints = [];
        currentGameServingTeam = null;
        currentGameServingPlayer = null;
        currentGameBreakPoints = [0, 0];
        currentGameBpPeak = 0;

        // onGameEnd só corre se o set NÃO terminou — se terminou, initServeNewSet já tratou o serve
        if (!setEnded) onGameEnd();
    }

    function winSet() {
        state.isTieBreakMode = false;
        const lastServer = SERVE.current;
        state.currentSet++;
        if (prosetMode) {
            // PROSET: o match termina quando o único set (índice 2) termina
            endMatch();
            return;
        }
        if (state.currentSet === 2) {
            const s1won = (state.sets[0][0]>state.sets[0][1]?1:0)+(state.sets[1][0]>state.sets[1][1]?1:0);
            if (s1won === 1) {
                state.isSuperTieBreak = superTieMode;
                initServeNewSet(lastServer);
                showSetIntervalCardBtn();
            } else {
                endMatch();
            }
        } else if (state.currentSet >= 3) {
            endMatch();
        } else {
            initServeNewSet(lastServer);
            showSetIntervalCardBtn();
        }
    }

    // Intervalo entre sets (partida ainda em curso) — mostra o botão
    // dourado "Show Match Card" pra consultar o Card parcial, sem troféu.
    // Continua visível durante o set seguinte também (não é obrigatório
    // fechar só porque o próximo set começou a ser jogado).
    function showSetIntervalCardBtn() {
        var pBtn = document.getElementById('gs-card-btn');
        if (pBtn) pBtn.classList.add('show');
        var lsBtn = document.getElementById('ls-card-btn');
        if (lsBtn) lsBtn.classList.add('show');
    }

    // Fim do intervalo — Coach escolheu quem saca no set seguinte, o jogo
    // está prestes a recomeçar. Não faz sentido o botão continuar ali.
    function hideSetIntervalCardBtn() {
        var pBtn = document.getElementById('gs-card-btn');
        if (pBtn) pBtn.classList.remove('show');
        var lsBtn = document.getElementById('ls-card-btn');
        if (lsBtn) lsBtn.classList.remove('show');
    }

    function endMatch() {
        state.matchOver = true;
        state.isSuperTieBreak = false;
        state.isTieBreakMode = false;
        SERVE.phase = 'off'; // apagar todas as bolas de serviço
        renderServeBalls();
        // Parar o cronómetro automaticamente
        if (timerRunning) {
            clearInterval(timerInterval);
            timerRunning = false;
            updateTimerDisplay();
        }

        // --- Gerar resumo de pontos por set em formato de tabela ---
        const n1a = ((function(){var _e=document.getElementById('t1-p1');return _e&&_e.innerText?_e.innerText.trim():'Player 1'})()).substring(0, 9);
        const n1b = ((function(){var _e=document.getElementById('t1-p2');return _e&&_e.innerText?_e.innerText.trim():'Player 2'})()).substring(0, 9);
        const n2a = ((function(){var _e=document.getElementById('t2-p1');return _e&&_e.innerText?_e.innerText.trim():'Player 3'})()).substring(0, 9);
        const n2b = ((function(){var _e=document.getElementById('t2-p2');return _e&&_e.innerText?_e.innerText.trim():'Player 4'})()).substring(0, 9);
        const hdr1 = `${n1a} | ${n1b}`;
        const hdr2 = `${n2a} | ${n2b}`;
        const COL = Math.max(hdr1.length, hdr2.length, 13) + 2;

        // Duração calculada aqui, guardada em campo próprio (entry.duration)
        // pela saveMatchHistory — já não entra mais dentro do texto de notas
        const dur = formatDuration(timerSeconds);

        // Notas ficam só com o que o Coach (ou a IA, depois) escrever
        currentNotes = currentNotes.trim();

        // Guardar ANTES de alterar pts e currentSet
        saveMatchHistory();
        state.pts = [0, 0];
        state.currentSet = 3;
        document.getElementById('game-over-p').classList.add('show');
        document.getElementById('gs-card-btn').classList.add('show');
        updateScreen();
    }

    // Contagem automática de Serve Won / Broken Serve para o servidor actual
    function autoCountServe(teamIndex) {
        if ((SERVE.phase !== 'auto' && SERVE.phase !== 'tb') || SERVE.current === null) return;
        const pSuffix = ['p1','p2','p3','p4'];
        const suffix = pSuffix[SERVE.current];
        const serverTeam = serveTeamOf(SERVE.current); // 0=dupla1, 1=dupla2
        const winnerTeam = teamIndex - 1;              // 0=dupla1, 1=dupla2
        const key = (winnerTeam === serverTeam) ? `s_1srv_${suffix}` : `s_2srv_${suffix}`;
        if (statsState[key] !== undefined) {
            statsState[key]++;
            const el = document.getElementById(key);
            if (el) el.textContent = statsState[key];
            updateServePct(suffix);
        }
    }

    function addPoint(teamIndex) {
        if (state.matchOver) return;
        // No modo PROSET, saltar directamente para o 3º set (índice 2)
        if (prosetMode && state.currentSet < 2) {
            state.currentSet = 2;
        }
        // Bloquear pontos enquanto o servidor não estiver definido
        if (SERVE.phase === 'pick-any' || SERVE.phase === 'pick-t1' || SERVE.phase === 'pick-t2') {
            showToast('⚠️ Choose who serves first');
            return;
        }
        if (!timerRunning && timerSeconds === 0) toggleTimer();

        // Game Log: contabiliza oportunidade de quebra segundo o modelo
        // de pico acumulativo (ver trackBreakPointOpportunity)
        trackBreakPointOpportunity();

        const idx = teamIndex - 1;
        const opp = 1 - idx;
        const si  = state.currentSet;

        if (state.isSuperTieBreak || state.isTieBreakMode) {
            state.pts[idx]++;
            setStats[si].tbPtsWon[idx]++;
            SERVE.tbPoints++;   // incrementar antes para onTbPoint calcular o servidor correcto
            logGamePoint(idx); // Game Log: SuperTie e tie-break normal, ambos com escala numérica
            onTbPoint();
        } else {
            const p0 = state.pts[0], p1 = state.pts[1];
            const isDeuce = p0 === 3 && p1 === 3;
            const isAdv   = (p0 === 4 && p1 === 3) || (p0 === 3 && p1 === 4);
            const hasAdv  = isAdv && state.pts[idx] === 4;

            if (pointMode === 'golden' || prosetMode) {
                if (isDeuce) {
                    // Golden Point decisivo — registar
                    setStats[si].goldenPts[idx]++;
                    // ponto ganho/perdido contado em winGame via flush
                    trackPointWon(si, idx);
                    winGame(idx);
                } else {
                    state.pts[idx]++;
                    // Verificar se chegou a deuce agora (40-40)
                    if (state.pts[0] === 3 && state.pts[1] === 3) {
                        setStats[si].deuces++;
                        gameTrack.inDeuce = true;
                    }
                    if (state.pts[idx] >= 4 && state.pts[idx] > state.pts[opp]) {
                        trackPointWon(si, idx);
                        winGame(idx);
                    } else {
                        trackPointWon(si, idx);
                    }
                }
            } else {
                // --- Star Point ---
                if (isAdv) {
                    if (hasAdv) {
                        // ADV marca → ganha
                        trackPointWon(si, idx);
                        winGame(idx);
                    } else {
                        // Sem ADV marca → volta a 40-40, conta DC
                        state.pts = [3, 3];
                        state.deuceCount++;
                        setStats[si].deuces++;
                        trackPointWon(si, idx);
                    }
                } else if (isDeuce) {
                    if (state.deuceCount >= 2) {
                        // DC2 → Star Point decisivo
                        setStats[si].starPts[idx]++;
                        trackPointWon(si, idx);
                        winGame(idx);
                    } else {
                        // 40-40 inicial ou DC1 → vantagem
                        state.pts[idx]++;
                        trackPointWon(si, idx);
                    }
                } else {
                    state.pts[idx]++;
                    // Verificar se chegou a deuce
                    if (state.pts[0] === 3 && state.pts[1] === 3) {
                        setStats[si].deuces++;
                        gameTrack.inDeuce = true;
                    }
                    if (state.pts[idx] >= 4 && state.pts[idx] > state.pts[opp]) {
                        trackPointWon(si, idx);
                        winGame(idx);
                    } else {
                        trackPointWon(si, idx);
                    }
                }
            }
        }
        checkGameLogic(); updateScreen();
    }

    // Regista ponto ganho pelo idx e ponto perdido pelo oponente
    function trackPointWon(si, idx) {
        setStats[si].ptsWon[idx]++;
        setStats[si].ptsLost[1 - idx]++;
        logGamePoint(idx);
    }

    function removePoint(event, teamIndex) {
        event.preventDefault();
        const idx = teamIndex - 1;
        const inDC = pointMode === 'star'
            && state.deuceCount > 0
            && state.pts[0] === 3 && state.pts[1] === 3;
        if (inDC) return;
        if (state.pts[idx] > 0) {
            state.pts[idx]--;
        }
        updateScreen();
    }

    function removeSetPoint(teamIndex, setIndex) {
        if (setIndex > state.currentSet) return;
        if (state.matchOver) return;
        if (prosetMode && setIndex < 2) return; // sets 1 e 2 desactivados no PROSET
        const idx = teamIndex - 1;
        if (state.sets[setIndex][idx] > 0) {
            state.sets[setIndex][idx]--;
            updateScreen();
        }
    }

    function addSetPoint(teamIndex, setIndex) {
        if (setIndex > state.currentSet) return;
        if (state.matchOver) return;
        if (prosetMode && setIndex < 2) return; // sets 1 e 2 desactivados no PROSET
        const idx = teamIndex - 1;
        const isThirdSetSuperTie = (setIndex === 2 && superTieMode);
        const limit = isThirdSetSuperTie ? Infinity : 7;
        if (state.sets[setIndex][idx] < limit) {
            state.sets[setIndex][idx]++;
            updateScreen();
        }
    }

    function setupSetLongPress(elId, teamIndex, setIndex) {
        const el = document.getElementById(elId);
        if (!el) return;

        let timer = null, isLong = false, hasTouched = false;

        // ── Touch (mobile) ────────────────────────────────────────────────
        el.addEventListener('touchstart', e => {
            hasTouched = true;
            isLong = false;
            timer = setTimeout(() => {
                isLong = true;
                removeSetPoint(teamIndex, setIndex); // decrementa sempre (set fechado OU em andamento)
            }, 600);
        }, { passive: true });

        el.addEventListener('touchend', () => {
            clearTimeout(timer);
            if (!isLong) {
                // Toque curto: incrementa em qualquer set já jogado, incluindo
                // o que está aberto agora (correcção mesmo com o set em curso)
                if (setIndex <= state.currentSet) addSetPoint(teamIndex, setIndex);
            }
            // Reset após um frame para não bloquear o click sintético do browser
            setTimeout(() => { hasTouched = false; }, 300);
        });

        el.addEventListener('touchmove', () => { clearTimeout(timer); isLong = true; });

        // ── Mouse / desktop (ignorar se veio de touch) ───────────────────
        el.addEventListener('click', e => {
            if (hasTouched) return;
            // Toque curto: incrementa em qualquer set já jogado, incluindo
            // o que está aberto agora
            if (setIndex <= state.currentSet) addSetPoint(teamIndex, setIndex);
        });
        el.addEventListener('contextmenu', e => {
            e.preventDefault();
            if (hasTouched) return;
            removeSetPoint(teamIndex, setIndex); // decrementa sempre (set fechado OU em andamento)
        });
    }

    // Portrait
    setupSetLongPress('t1-s1-cell', 1, 0); setupSetLongPress('t1-s2-cell', 1, 1); setupSetLongPress('t1-s3-cell', 1, 2);
    setupSetLongPress('t2-s1-cell', 2, 0); setupSetLongPress('t2-s2-cell', 2, 1); setupSetLongPress('t2-s3-cell', 2, 2);
    // TV Mode (landscape) — nunca tinha sido ligado
    setupSetLongPress('ls-t1-s1-cell', 1, 0); setupSetLongPress('ls-t1-s2-cell', 1, 1); setupSetLongPress('ls-t1-s3-cell', 1, 2);
    setupSetLongPress('ls-t2-s1-cell', 2, 0); setupSetLongPress('ls-t2-s2-cell', 2, 1); setupSetLongPress('ls-t2-s3-cell', 2, 2);

    // ============================================================
    // PERSISTÊNCIA DO ESTADO DO JOGO EM CURSO
    // ============================================================
    const GAME_STATE_KEY = 'padel_game_state';

    function saveGameState() {
        // Recolher nomes dos jogadores
        const players = ['t1-p1','t1-p2','t2-p1','t2-p2'].map(id => {
            const el = document.getElementById(id);
            return el ? el.innerText.trim() : '';
        });
        const snapshot = {
            state,
            superTieMode,
            prosetMode,
            pointMode,
            statsEnabled,
            gameLogEnabled,
            aiAnalysisLanguage,
            matchGameLogs,
            currentGamePoints,
            currentGameServingTeam,
            currentGameServingPlayer,
            currentGameBreakPoints,
            currentGameBpPeak,
            statsState: { ...statsState },
            setStats,
            gameTrack,
            currentNotes,
            timerSeconds,
            players,
            serve: {
                current:       SERVE.current,
                gamesPlayed:   SERVE.gamesPlayed,
                gamesThisSet:  SERVE.gamesThisSet,
                phase:         SERVE.phase,
                firstTeam:     SERVE.firstTeam,
                tbPoints:      SERVE.tbPoints,
                tbFirst:       SERVE.tbFirst,
                t1FirstServer: SERVE.t1FirstServer,
                t2FirstServer: SERVE.t2FirstServer,
                t1AnchorTurn: SERVE.t1AnchorTurn,
                t2AnchorTurn: SERVE.t2AnchorTurn,
            }
        };
        try { localStorage.setItem(GAME_STATE_KEY, JSON.stringify(snapshot)); } catch(e) {}
    }

    function restoreGameState() {
        let snap;
        try { snap = JSON.parse(localStorage.getItem(GAME_STATE_KEY)); } catch(e) {}
        if (!snap) return false;

        // Restaurar estado do jogo
        state = snap.state;
        superTieMode  = snap.superTieMode;
        prosetMode    = snap.prosetMode || false;
        pointMode     = snap.pointMode;
        statsEnabled  = snap.statsEnabled;
        gameLogEnabled = false; // sempre Off — sem toggle na UI, ignora valor salvo em snapshots antigos
        aiAnalysisLanguage = (snap.aiAnalysisLanguage !== undefined) ? snap.aiAnalysisLanguage : 'en';
        matchGameLogs  = snap.matchGameLogs || [];
        currentGamePoints = snap.currentGamePoints || [];
        currentGameServingTeam = (snap.currentGameServingTeam !== undefined) ? snap.currentGameServingTeam : null;
        currentGameServingPlayer = (snap.currentGameServingPlayer !== undefined) ? snap.currentGameServingPlayer : null;
        currentGameBreakPoints = snap.currentGameBreakPoints || [0, 0];
        currentGameBpPeak = snap.currentGameBpPeak || 0;
        setStats      = snap.setStats;
        gameTrack     = snap.gameTrack;
        currentNotes  = snap.currentNotes || '';
        timerSeconds  = snap.timerSeconds || 0;
        // Retomar o timer se o jogo estava em curso e não tinha terminado
        if (!state.matchOver && timerSeconds > 0) {
            updateTimerDisplay();
            // Reiniciar o intervalo do timer
            setTimeout(() => {
                if (!timerRunning && !state.matchOver) toggleTimer();
            }, 500);
        } else {
            updateTimerDisplay();
        }

        // Restaurar estatísticas
        if (snap.statsState) {
            Object.assign(statsState, snap.statsState);
            statIds.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.textContent = statsState[id] || 0;
            });
            ['p1','p2','p3','p4'].forEach(p => updateServePct(p));
        }

        // Restaurar nomes dos jogadores
        if (snap.players) {
            ['t1-p1','t1-p2','t2-p1','t2-p2'].forEach((id, i) => {
                const el = document.getElementById(id);
                if (el && snap.players[i]) el.innerText = snap.players[i];
            });
        }

        // Restaurar serve indicator
        if (snap.serve) {
            Object.assign(SERVE, snap.serve);
        }

        // O banner END OF MATCH não precisa voltar após um reload, mas o
        // botão do Card do Jogo sim — a partida já está no Histórico e o
        // Coach deve continuar conseguindo abrir o card mesmo depois de
        // sair/reabrir o app sem querer.
        if (state.matchOver) {
            document.getElementById('gs-card-btn').classList.add('show');
        }

        return true;
    }

    function clearGameState() {
        try { localStorage.removeItem(GAME_STATE_KEY); } catch(e) {}
    }

    // ============================================================
    // ESTATÍSTICAS
    // ============================================================
    const statsState = {};
    const statIds = [
        's_1srv_p1','s_2srv_p1','s_df_p1','s_ufe_p1','s_fe_p1','s_win_p1','s_smash_p1',
        's_1srv_p2','s_2srv_p2','s_df_p2','s_ufe_p2','s_fe_p2','s_win_p2','s_smash_p2',
        's_1srv_p3','s_2srv_p3','s_df_p3','s_ufe_p3','s_fe_p3','s_win_p3','s_smash_p3',
        's_1srv_p4','s_2srv_p4','s_df_p4','s_ufe_p4','s_fe_p4','s_win_p4','s_smash_p4'
    ];
    statIds.forEach(id => { statsState[id] = 0; });

    // Percentuais de 1st/2nd Serve removidos da UI (causavam "quebra
    // lateral" no painel — largura variável conforme o valor). Função
    // desabilitada, não removida, para o caso de precisarmos reativar.
    function updateServePct(playerSuffix) {
        return;
        /* eslint-disable no-unreachable */
        const s1 = statsState[`s_1srv_${playerSuffix}`] || 0;
        const s2 = statsState[`s_2srv_${playerSuffix}`] || 0;
        const total = s1 + s2;
        const pct1 = total > 0 ? Math.round(s1 / total * 100) + '%' : '';
        const pct2 = total > 0 ? Math.round(s2 / total * 100) + '%' : '';
        const el1 = document.getElementById(`pct_1srv_${playerSuffix}`);
        const el2 = document.getElementById(`pct_2srv_${playerSuffix}`);
        if (el1) el1.textContent = pct1;
        if (el2) el2.textContent = pct2;
    }

    function incStat(id) {
        if (state.matchOver) return;
        statsState[id]++;
        document.getElementById(id).textContent = statsState[id];
        if (id.startsWith('s_1srv_') || id.startsWith('s_2srv_')) {
            updateServePct(id.slice(-2));
        }
    }

    // Smash: incrementa smash E winner em simultâneo
    function incSmash(smashId) {
        if (state.matchOver) return;
        var suffix = smashId.slice(-2); // 'p1','p2','p3','p4'
        var winId = 's_win_' + suffix;
        statsState[smashId]++;
        statsState[winId]++;
        var elS = document.getElementById(smashId);
        var elW = document.getElementById(winId);
        if (elS) elS.textContent = statsState[smashId];
        if (elW) elW.textContent = statsState[winId];
    }

    // Decrementa smash E winner em simultâneo (só se ambos > 0)
    function decSmash(smashId) {
        if (state.matchOver) return;
        var suffix = smashId.slice(-2);
        var winId = 's_win_' + suffix;
        if (statsState[smashId] > 0 && statsState[winId] > 0) {
            statsState[smashId]--;
            statsState[winId]--;
            var elS = document.getElementById(smashId);
            var elW = document.getElementById(winId);
            if (elS) elS.textContent = statsState[smashId];
            if (elW) elW.textContent = statsState[winId];
        }
    }

    function decStatById(id) {
        if (state.matchOver) return;
        if (statsState[id] > 0) {
            statsState[id]--;
            document.getElementById(id).textContent = statsState[id];
        }
        if (id.startsWith('s_1srv_') || id.startsWith('s_2srv_')) {
            updateServePct(id.slice(-2));
        }
    }
    function resetStats() {
        statIds.forEach(id => {
            statsState[id] = 0;
            const el = document.getElementById(id);
            if (el) el.textContent = 0;
        });
        // Limpar percentuais
        ['p1','p2','p3','p4'].forEach(p => {
            ['pct_1srv_','pct_2srv_'].forEach(prefix => {
                const el = document.getElementById(prefix + p);
                if (el) el.textContent = '';
            });
        });
    }

    // Long-press (600ms) para decrementar; toque curto incrementa
    document.querySelectorAll('.stat-box:not(.stat-box-smash)').forEach(function(box) {
        var id = box.dataset.stat;
        var timer = null, isLong = false, hasTouched = false;

        box.addEventListener('touchstart', function(e) {
            hasTouched = true;
            isLong = false;
            timer = setTimeout(function() {
                isLong = true;
                decStatById(id);
            }, 600);
        }, { passive: true });

        box.addEventListener('touchend', function(e) {
            clearTimeout(timer);
            if (!isLong) incStat(id);
        });

        box.addEventListener('touchmove', function() { clearTimeout(timer); });

        box.addEventListener('click', function(e) {
            if (hasTouched) { hasTouched = false; return; }
            incStat(id);
        });
        box.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            if (hasTouched) { hasTouched = false; return; }
            decStatById(id);
        });
    });

    // Smash boxes: toque curto = +1 smash +1 winner; long press 600ms = -1 smash -1 winner
    document.querySelectorAll('.stat-box-smash').forEach(function(box) {
        var id = box.dataset.stat;
        var timer = null, isLong = false, hasTouched = false;

        box.addEventListener('touchstart', function(e) {
            hasTouched = true;
            isLong = false;
            timer = setTimeout(function() {
                isLong = true;
                decSmash(id);
            }, 600);
        }, { passive: true });

        box.addEventListener('touchend', function(e) {
            clearTimeout(timer);
            if (!isLong) incSmash(id);
        });

        box.addEventListener('touchmove', function() { clearTimeout(timer); });

        box.addEventListener('click', function(e) {
            if (hasTouched) { hasTouched = false; return; }
            incSmash(id);
        });
        box.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            if (hasTouched) { hasTouched = false; return; }
            decSmash(id);
        });
    });

    // ============================================================
    // EXPORTAR EXCEL
    // ============================================================
    // exportToExcel (jogo em curso) removida — export agora é exclusivo do histórico
    // via exportHistoryGameToExcel, acessível pelo botão Email/Export no footer.

    // ============================================================
    // HISTORY — últimos 10 jogos em localStorage
    // ============================================================
    const HISTORY_KEY = 'padel_history';
    const HISTORY_MAX = 10;

    // ============================================================
    // ANÁLISE POR IA — proxy serverless (Cloudflare Worker)
    // Nunca chama a API directamente do cliente (chave nunca fica exposta).
    // IMPORTANTE: troque pela URL real do seu Worker depois do deploy —
    // ver worker.js entregue junto com este pacote.
    // ============================================================
    const AI_WORKER_URL = 'https://psc-ai-analysis.marceloribeiro1711.workers.dev/analyze';
    const AI_TIMEOUT_MS = 30000;  // 30s — recalibrado após MAX_OUTPUT_TOKENS subir de 900 p/ 1600 no worker (5 parágrafos podem levar bem mais que os 8s antigos para gerar)
    const AI_ANALYSIS_MARKER = '\n\n✨ AI Analysis:\n';

    function buildPlayerStatsForAi() {
        const ids = ['t1-p1', 't1-p2', 't2-p1', 't2-p2'];
        const suffixes = ['p1', 'p2', 'p3', 'p4'];
        const teams = ['team1', 'team1', 'team2', 'team2'];
        return suffixes.map(function (suf, i) {
            const el = document.getElementById(ids[i]);
            const name = el && el.innerText ? el.innerText.trim() : ('Player ' + (i + 1));
            return {
                name: name,
                team: teams[i],
                unforcedErrors: statsState['s_ufe_' + suf] || 0,
                forcedErrors: statsState['s_fe_' + suf] || 0,
                doubleFaults: statsState['s_df_' + suf] || 0,
                winners: statsState['s_win_' + suf] || 0,
                smashWinners: statsState['s_smash_' + suf] || 0
            };
        });
    }

    // Variante para partidas já salvas no histórico (usada pelo botão
    // manual "Generate AI Analysis" e pelo retry) — não depende do DOM
    // ao vivo, lê tudo do próprio `entry`.
    function buildPlayerStatsForAiFromEntry(entry) {
        const suffixes = ['p1', 'p2', 'p3', 'p4'];
        const teams = ['team1', 'team1', 'team2', 'team2'];
        const stats = entry.stats || {};
        return suffixes.map(function (suf, i) {
            return {
                name: entry.players[i] || ('Player ' + (i + 1)),
                team: teams[i],
                unforcedErrors: stats['s_ufe_' + suf] || 0,
                forcedErrors: stats['s_fe_' + suf] || 0,
                doubleFaults: stats['s_df_' + suf] || 0,
                winners: stats['s_win_' + suf] || 0,
                smashWinners: stats['s_smash_' + suf] || 0
            };
        });
    }

    function buildMatchLogForAi() {
        return matchGameLogs.map(function (g) {
            const gamesInSet = matchGameLogs.filter(function (x) { return x.set === g.set; });
            const gameNumber = gamesInSet.indexOf(g) + 1;
            return {
                set: g.set,
                gameNumber: gameNumber,
                winner: g.winner,
                servingTeam: g.servingTeam,
                servingPlayer: pointLogServingPlayerName(g), // já resolvido pro nome
                isTiebreakGame: !!g.isTiebreakGame,
                isSuperTie: !!g.isSuperTie,
                breakPoints: g.breakPoints || { team1: 0, team2: 0 },
                points: g.points
            };
        });
    }

    // Variante para partidas já salvas — resolve servingPlayer contra
    // entry.players em vez do DOM ao vivo (que pode já estar noutra partida)
    function buildMatchLogForAiFromEntry(entry) {
        const gameLogs = entry.pointLog || [];
        const players = entry.players || [];
        return gameLogs.map(function (g) {
            const gamesInSet = gameLogs.filter(function (x) { return x.set === g.set; });
            const gameNumber = gamesInSet.indexOf(g) + 1;
            let servingPlayerName;
            if (g.servingPlayer !== null && g.servingPlayer !== undefined && players[g.servingPlayer]) {
                servingPlayerName = players[g.servingPlayer];
            } else if (g.servingTeam === 'team1') {
                servingPlayerName = (players[0] || '') + ' / ' + (players[1] || '');
            } else {
                servingPlayerName = (players[2] || '') + ' / ' + (players[3] || '');
            }
            return {
                set: g.set,
                gameNumber: gameNumber,
                winner: g.winner,
                servingTeam: g.servingTeam,
                servingPlayer: servingPlayerName,
                isTiebreakGame: !!g.isTiebreakGame,
                isSuperTie: !!g.isSuperTie,
                breakPoints: g.breakPoints || { team1: 0, team2: 0 },
                points: g.points
            };
        });
    }

    // Nome de exibição da dupla para a IA (ex: "LEÃO/SALVADOR"), usado no
    // payload em vez dos literais 'team1'/'team2' — evita que a análise
    // se refira às duplas por esses rótulos técnicos.
    function duplaName(p1, p2) {
        const n1 = (p1 || '').trim() || 'Player 1';
        const n2 = (p2 || '').trim() || 'Player 2';
        return n1 + '/' + n2;
    }

    // Variante para regenerar a análise de uma partida já salva (botão
    // manual no histórico, ou retry após falha) — não depende de estado
    // ao vivo nenhum, só do próprio `entry`.
    function buildAiAnalysisPayloadFromEntry(entry) {
        const setsArr = [];
        (entry.sets || []).forEach(function (pair, i) {
            if (pair[0] > 0 || pair[1] > 0) {
                setsArr.push({ set: i + 1, score: pair[0] + '-' + pair[1] });
            }
        });
        return {
            deviceId: _deviceId || 'UNKNOWN',
            matchId: entry.date,
            setMode: entry.setMode,
            pointMode: entry.pointMode,
            language: aiAnalysisLanguage,
            teams: {
                team1: { name: duplaName(entry.players[0], entry.players[1]), players: [entry.players[0], entry.players[1]] },
                team2: { name: duplaName(entry.players[2], entry.players[3]), players: [entry.players[2], entry.players[3]] }
            },
            playerStats: buildPlayerStatsForAiFromEntry(entry),
            sets: setsArr,
            winner: entry.winner === 0 ? 'team1' : 'team2',
            matchDuration: entry.duration || '',
            matchLog: buildMatchLogForAiFromEntry(entry)
        };
    }

    async function callAiWorker(payload) {
        if (!AI_WORKER_URL || AI_WORKER_URL.indexOf('REPLACE') !== -1) return null; // Worker ainda não configurado
        const controller = new AbortController();
        const timeoutId = setTimeout(function () { controller.abort(); }, AI_TIMEOUT_MS);
        try {
            const res = await fetch(AI_WORKER_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!res.ok) return null;
            const data = await res.json();
            return (data && typeof data.analysis === 'string') ? data.analysis : null;
        } catch (e) {
            clearTimeout(timeoutId);
            return null; // sem internet, timeout, Worker fora do ar, etc.
        }
    }

    // `replace`: quando true (regeneração manual/retry), substitui uma
    // análise anterior em vez de recusar por já existir uma.
    function appendAiAnalysisToHistory(entryDate, analysisText, replace) {
        try {
            let history = JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
            const idx = history.findIndex(function (h) { return h.date === entryDate; });
            if (idx === -1) return;
            let existing = history[idx].notes || '';
            const markerPos = existing.indexOf(AI_ANALYSIS_MARKER);
            if (markerPos !== -1) {
                if (!replace) return; // já preenchido, não sobrescreve por padrão
                existing = existing.slice(0, markerPos); // remove análise antiga antes de recolocar
            }
            history[idx].notes = existing + AI_ANALYSIS_MARKER + analysisText;
            // Flag permanente: uma vez gerada, a partida fica marcada como já
            // analisada para sempre — independe do texto continuar no Notes ou
            // não (o Coach pode apagar/editar o texto livremente depois).
            history[idx].aiAnalysisGenerated = true;
            localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
            if (idx === 0) currentNotes = history[idx].notes; // reflecte se ainda for a partida mais recente
        } catch (e) { /* falha silenciosa */ }
    }

    // ---- UI de espera (timer) e de erro/retry ----
    let _aiWaitTimer = null;
    let _aiWaitSeconds = 30;
    let _aiRetryEntryDate = null;

    function showAiWaitOverlay() {
        _aiWaitSeconds = 30;
        const el = document.getElementById('ai-wait-overlay');
        const countEl = document.getElementById('ai-wait-countdown');
        if (!el) return;
        if (countEl) countEl.textContent = String(_aiWaitSeconds);
        el.classList.add('show');
        if (_aiWaitTimer) clearInterval(_aiWaitTimer);
        _aiWaitTimer = setInterval(function () {
            _aiWaitSeconds--;
            if (countEl) countEl.textContent = String(Math.max(_aiWaitSeconds, 0));
            if (_aiWaitSeconds <= 0) {
                // Passados 30s (== AI_TIMEOUT_MS), libera a navegação — a
                // chamada segue em background e, se completar depois, o
                // histórico é actualizado normalmente (appendAiAnalysisToHistory).
                clearInterval(_aiWaitTimer);
                _aiWaitTimer = null;
                el.classList.remove('show');
            }
        }, 1000);
    }

    function hideAiWaitOverlay() {
        const el = document.getElementById('ai-wait-overlay');
        if (_aiWaitTimer) { clearInterval(_aiWaitTimer); _aiWaitTimer = null; }
        if (el) el.classList.remove('show');
    }

    function showAiRetryPopup(entryDate) {
        _aiRetryEntryDate = entryDate;
        const el = document.getElementById('ai-error-overlay');
        if (el) el.classList.add('show');
    }

    function dismissAiErrorPopup() {
        const el = document.getElementById('ai-error-overlay');
        if (el) el.classList.remove('show');
        _aiRetryEntryDate = null;
    }

    function retryAiAnalysis() {
        const date = _aiRetryEntryDate;
        dismissAiErrorPopup();
        if (!date) return;
        const history = loadHistory();
        const idx = history.findIndex(function (h) { return h.date === date; });
        if (idx === -1) return;
        regenerateAiAnalysisForEntry(idx, true);
    }

    // Detecta se uma partida já teve análise de IA gerada com sucesso —
    // pela flag (caso normal) ou, por compatibilidade, pelo marcador ainda
    // presente no notes de partidas antigas geradas antes da flag existir.
    function isAiAnalysisGenerated(entry) {
        return !!(entry && (entry.aiAnalysisGenerated || (entry.notes || '').indexOf(AI_ANALYSIS_MARKER) !== -1));
    }

    // Entrada manual — botão "Generate AI Analysis" no histórico. Cobre
    // três casos: (1) gerar quando não havia internet no fim da partida,
    // (2) retry manual após falha, (3) MAS nunca regenerar uma análise que
    // já foi gerada com sucesso alguma vez — isso é bloqueado permanentemente
    // pela flag aiAnalysisGenerated, mesmo que o texto tenha sido apagado do
    // Notes depois (custo real por chamada — uma vez gerada, é definitiva).
    async function regenerateAiAnalysisForEntry(idx, manual) {
        const history = loadHistory();
        const entry = history[idx];
        if (!entry) return;
        if (isAiAnalysisGenerated(entry)) {
            if (!entry.aiAnalysisGenerated) {
                // Fallback de compatibilidade: corrige a flag agora para
                // partidas antigas geradas antes dela existir.
                history[idx].aiAnalysisGenerated = true;
                localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
            }
            showToast('Analysis already done for this match');
            return;
        }
        if (!entry.pointLog || entry.pointLog.length === 0) {
            showToast('No Match Log data available for AI analysis');
            return;
        }
        showAiWaitOverlay();
        const payload = buildAiAnalysisPayloadFromEntry(entry);
        const analysis = await callAiWorker(payload);
        hideAiWaitOverlay();
        if (analysis) {
            appendAiAnalysisToHistory(entry.date, analysis, true);
            showToast('✨ AI analysis ready — check Notes');
        } else {
            showAiRetryPopup(entry.date);
        }
    }

    // Agregação por dupla pro Card do Jogo — soma jogador1+jogador2 vs
    // jogador3+jogador4 nas 7 estatísticas já existentes, mais o total de
    // pontos vencidos por dupla (contado direto do pointLog: cada ponto do
    // jogo conta 1 pra quem venceu, independente de quem estava a servir).
    function buildGrandSlamAggregates(entry) {
        const pSuffix = ['p1', 'p2', 'p3', 'p4'];
        const s = entry.stats || {};
        function sum(key, off) {
            return (s[`s_${key}_${pSuffix[off]}`] || 0) + (s[`s_${key}_${pSuffix[off + 1]}`] || 0);
        }
        const rows = STAT_LABELS.map(function (label, i) {
            const key = STAT_KEYS[i];
            return { label: label, v1: sum(key, 0), v2: sum(key, 2) };
        });
        let totalPts1 = 0, totalPts2 = 0;
        (entry.pointLog || []).forEach(function (game) {
            (game.points || []).forEach(function (pt) {
                if (pt.wonBy === 'team1') totalPts1++;
                else if (pt.wonBy === 'team2') totalPts2++;
            });
        });
        rows.unshift({ label: 'Total Points Won', v1: totalPts1, v2: totalPts2 });
        return rows;
    }

    // Ícone de silhueta genérica — usado quando não há foto retratada pra
    // aquele jogador (nem no snapshot da partida, nem no slot ao vivo).
    const GS_SILHOUETTE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>';

    // Monta o HTML do Card do Jogo — assíncrono porque as 4 fotos vêm do
    // IndexedDB (retrato próprio da partida, ver saveMatchHistory).
    function buildGrandSlamCardHtml(entry, isLive) {
        const n1 = escHtml(entry.players[0] || 'Player 1');
        const n2 = escHtml(entry.players[1] || 'Player 2');
        const n3 = escHtml(entry.players[2] || 'Player 3');
        const n4 = escHtml(entry.players[3] || 'Player 4');
        const teamName1 = n1 + ' / ' + n2;
        const teamName2 = n3 + ' / ' + n4;

        // Partida ainda em curso (Card parcial) — fotos vêm direto dos
        // slots ao vivo (ainda não existe retrato salvo, a partida só é
        // gravada no Histórico quando termina de verdade).
        const photoKeys = isLive
            ? DEFAULT_PHOTO_IDS.map(function (id) { return 'photo_' + id; })
            : DEFAULT_PHOTO_IDS.map(function (id) { return 'photo_hist_' + entry.date + '_' + id; });
        return Promise.all(photoKeys.map(function (k) {
            return idbGet(k).catch(function () { return null; });
        })).then(function (photos) {
            const rot = ['-7deg', '-2deg', '2deg', '7deg'];
            const teamClass = ['t1', 't1', 't2', 't2'];
            function photoTag(i) {
                const border = teamClass[i] === 't1' ? 'var(--accent-blue)' : 'var(--accent-yellow)';
                const style = 'border-color:' + border + ';transform:rotate(' + rot[i] + ')';
                if (photos[i]) return '<img class="gs-photo" src="' + photos[i] + '" style="' + style + '">';
                return '<div class="gs-photo gs-photo-placeholder" style="' + style + '">' + GS_SILHOUETTE_SVG + '</div>';
            }

            // Placar — Set1/Set2/Supertie viram LINHAS da tabela (não mais
            // colunas como na tela de jogo ao vivo), pra bater com o resto
            // do card, onde a Dupla 1 é sempre a coluna esquerda e a Dupla
            // 2 a direita. PROSET tem apenas uma linha, igual ao formatScore().
            const sets = entry.sets || [[0, 0], [0, 0], [0, 0]];
            let scoreRows;
            if (entry.setMode === 'proset') {
                scoreRows = [{ label: 'PRO SET', red: false, v1: sets[2][0], v2: sets[2][1] }];
            } else {
                scoreRows = [
                    { label: 'SET 1', red: false, v1: sets[0][0], v2: sets[0][1] },
                    { label: 'SET 2', red: false, v1: sets[1][0], v2: sets[1][1] }
                ];
                const played3rd = sets[2][0] > 0 || sets[2][1] > 0;
                if (played3rd) {
                    scoreRows.push({
                        label: entry.setMode === 'supertie' ? 'SUPERTIE' : 'SET 3',
                        red: entry.setMode === 'supertie',
                        v1: sets[2][0], v2: sets[2][1]
                    });
                }
            }
            const scoreRowsHtml = scoreRows.map(function (r) {
                return '<div class="gs-sets-row">'
                    + '<div class="gs-sets-label' + (r.red ? ' gs-red' : '') + '">' + r.label + '</div>'
                    + '<div class="gs-sets-val">' + r.v1 + '</div>'
                    + '<div class="gs-sets-val">' + r.v2 + '</div>'
                    + '</div>';
            }).join('');

            // Estatísticas — barras divergentes a partir do centro, cor fixa
            // por dupla (não indica "quem jogou melhor" naquela linha).
            const rows = buildGrandSlamAggregates(entry);
            const statsHtml = rows.map(function (r) {
                const total = r.v1 + r.v2;
                const pct1 = total > 0 ? (r.v1 / total * 100) : 0;
                const pct2 = total > 0 ? (r.v2 / total * 100) : 0;
                return '<div class="gs-stat-row">'
                    + '<span class="gs-stat-num left">' + r.v1 + '</span>'
                    + '<div class="gs-bar-half left"><div class="gs-bar-fill t1" style="width:' + pct1 + '%"></div></div>'
                    + '<div class="gs-stat-label">' + escHtml(r.label) + '</div>'
                    + '<div class="gs-bar-half right"><div class="gs-bar-fill t2" style="width:' + pct2 + '%"></div></div>'
                    + '<span class="gs-stat-num right">' + r.v2 + '</span>'
                    + '</div>';
            }).join('');

            const trophy1 = entry.winner === 0 ? '<span class="gs-trophy">🏆</span>' : '';
            const trophy2 = entry.winner === 1 ? '<span class="gs-trophy">🏆</span>' : '';

            return '<div class="gs-photo-block t1">'
                + '<div class="gs-photo-pair">' + photoTag(0) + photoTag(1) + '</div>'
                + '<div class="gs-photo-names t1">' + trophy1 + teamName1 + '</div>'
                + '</div>'
                + '<div class="gs-sets-table">' + scoreRowsHtml + '</div>'
                + '<div class="gs-photo-block t2">'
                + '<div class="gs-photo-pair">' + photoTag(2) + photoTag(3) + '</div>'
                + '<div class="gs-photo-names t2">' + trophy2 + teamName2 + '</div>'
                + '</div>'
                + '<div class="gs-stats">' + statsHtml + '</div>'
                + '<div class="gs-footer">'
                + '<div class="gs-footer-side t1">' + trophy1 + teamName1 + '</div>'
                + '<div class="gs-footer-side t2">' + trophy2 + teamName2 + '</div>'
                + '</div>';
        });
    }

    // idx omitido → partida mais recente (fluxo "Mostrar Card do Jogo" ao
    // vivo). idx presente → aberto a partir do Histórico.
    // Card PARCIAL — usado só na tela de jogo, nunca no Histórico. Monta um
    // "entry" a partir do estado ao vivo (sets, stats, pointLog), sem
    // vencedor (a partida ainda não terminou) e sem gravar nada em lado
    // nenhum. Mesmos dados que saveMatchHistory() usaria no final — só que
    // lidos ao vivo, antes do jogo acabar.
    function buildLiveEntrySnapshot() {
        const p1 = (function(){var _e=document.getElementById('t1-p1');return _e&&_e.innerText?_e.innerText.trim():'Player 1'})();
        const p2 = (function(){var _e=document.getElementById('t1-p2');return _e&&_e.innerText?_e.innerText.trim():'Player 2'})();
        const p3 = (function(){var _e=document.getElementById('t2-p1');return _e&&_e.innerText?_e.innerText.trim():'Player 3'})();
        const p4 = (function(){var _e=document.getElementById('t2-p2');return _e&&_e.innerText?_e.innerText.trim():'Player 4'})();
        return {
            date: 'live', // sentinela — nunca usado pra ler fotos (ver isLive)
            players: [p1, p2, p3, p4],
            winner: null, // partida em curso — sem troféu
            sets: JSON.parse(JSON.stringify(state.sets)),
            stats: Object.assign({}, statsState),
            setMode: prosetMode ? 'proset' : (superTieMode ? 'supertie' : '3sets'),
            pointLog: matchGameLogs
        };
    }

    function openGrandSlamCard(idx) {
        // Partida ainda em curso — Card parcial ao vivo, nunca lê/grava no
        // Histórico. Só entra no fluxo de Histórico depois de terminada.
        if (!state.matchOver && (idx === undefined || idx === null)) {
            const liveEntry = buildLiveEntrySnapshot();
            const container = document.getElementById('gs-card-content');
            container.innerHTML = '<div style="text-align:center;padding:4vh;color:var(--text-dim)">Loading…</div>';
            document.getElementById('gs-card-overlay').classList.add('show');
            buildGrandSlamCardHtml(liveEntry, true).then(function (html) {
                container.innerHTML = html;
            });
            return;
        }
        const history = loadHistory();
        const entry = (idx === undefined || idx === null) ? history[0] : history[idx];
        if (!entry) { showToast('No match found'); return; }
        const container = document.getElementById('gs-card-content');
        container.innerHTML = '<div style="text-align:center;padding:4vh;color:var(--text-dim)">Loading…</div>';
        document.getElementById('gs-card-overlay').classList.add('show');
        buildGrandSlamCardHtml(entry).then(function (html) {
            container.innerHTML = html;
        });
    }

    function closeGrandSlamCardOnBg(event) {
        if (event.target === document.getElementById('gs-card-overlay')) closeGrandSlamCard();
    }

    function closeGrandSlamCard() {
        document.getElementById('gs-card-overlay').classList.remove('show');
    }

    function saveMatchHistory() {
        const p1 = (function(){var _e=document.getElementById('t1-p1');return _e&&_e.innerText?_e.innerText.trim():'Player 1'})();
        const p2 = (function(){var _e=document.getElementById('t1-p2');return _e&&_e.innerText?_e.innerText.trim():'Player 2'})();
        const p3 = (function(){var _e=document.getElementById('t2-p1');return _e&&_e.innerText?_e.innerText.trim():'Player 3'})();
        const p4 = (function(){var _e=document.getElementById('t2-p2');return _e&&_e.innerText?_e.innerText.trim():'Player 4'})();

        // Determinar dupla vencedora
        const s = state.sets;
        const w1 = (s[0][0]>s[0][1]?1:0)+(s[1][0]>s[1][1]?1:0)+(s[2][0]>s[2][1]?1:0);
        const winner = w1 >= 2 ? 0 : 1; // 0 = pair1, 1 = pair2

        const entry = {
            date: new Date().toISOString(),
            players: [p1, p2, p3, p4],
            winner,
            sets: JSON.parse(JSON.stringify(state.sets)),
            stats: Object.assign({}, statsState),
            setMode: prosetMode ? 'proset' : (superTieMode ? 'supertie' : '3sets'),
            pointMode: pointMode,
            duration: formatDuration(timerSeconds),
            notes: currentNotes,
            pointLog: matchGameLogs
        };

        // Retrato das 4 fotos atuais, preso a esta partida específica — os
        // slots t1-img1..t2-img2 são reaproveitados entre partidas, então
        // sem isto o Card do Jogo (ao vivo ou visto depois no Histórico)
        // podia mostrar fotos erradas de uma partida futura. Best-effort,
        // não bloqueia o salvamento da partida (fotos são secundárias).
        DEFAULT_PHOTO_IDS.forEach(function (slotId) {
            idbGet('photo_' + slotId).then(function (dataUrl) {
                if (!dataUrl) return; // sem foto neste slot — Card mostra silhueta
                idbSet('photo_hist_' + entry.date + '_' + slotId, dataUrl).catch(function () {});
            }).catch(function () {});
        });

        let history = [];
        try { history = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch(e) {}
        history.unshift(entry);
        if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
        try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        } catch(e) {
            // Quota excedida — tentar sem stats (mais leve)
            try {
                history[0] = { ...entry, stats: {} };
                localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
            } catch(e2) {
                console.warn('localStorage quota exceeded — history not saved:', e2);
            }
        }

    }

    function loadHistory() {
        try {
            const history = JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
            // Migração: corrigir entradas antigas com setMode invertido
            let needsSave = false;
            history.forEach(entry => {
                if (!entry._migrated && entry.setMode) {
                    const notes = entry.notes || '';
                    const hasSupertieLabel = notes.includes('Supertie');
                    const has3setLabel = notes.includes('Set 3');
                    if (hasSupertieLabel && entry.setMode === '3sets') entry.setMode = 'supertie';
                    if (has3setLabel && entry.setMode === 'supertie') entry.setMode = '3sets';
                    entry._migrated = true;
                    needsSave = true;
                }
            });
            // Persistir apenas se houve migração efectiva
            if (needsSave) {
                try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch(e) {}
            }
            return history;
        } catch(e) { return []; }
    }

    function formatDate(iso) {
        const d = new Date(iso);
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const yy = String(d.getFullYear()).slice(-2);
        return `${mm}/${dd}/${yy}`;
    }

    function formatScore(entry) {
        const s = entry.sets;
        if (entry.setMode === 'proset') {
            // PROSET: só mostra o 3º set, sets 1 e 2 ficam a —
            const tb = entry.tiebreakPts && entry.tiebreakPts[2] !== null ? `(${entry.tiebreakPts[2]})` : '';
            return `— / — / ${s[2][0]}-${s[2][1]}${tb}`;
        }
        const parts = [];
        for (let i = 0; i < 3; i++) {
            if (s[i][0] > 0 || s[i][1] > 0) parts.push(`${s[i][0]}-${s[i][1]}`);
        }
        return parts.join('  ·  ');
    }

    const STAT_LABELS = ['Serve Won','Broken Serve','Unforced Errors','Forced Errors','Double Fault','Winners','x3 / x4 / Smash'];
    const STAT_KEYS   = ['1srv','2srv','ufe','fe','df','win','smash'];

    function formatServeStat(value, total) {
        if (total <= 0) return `${value}`; // sem base para % — não calcula nem mostra 0%
        const pct = Math.round((value / total) * 100);
        return `${value} (${pct}%)`;
    }

    function buildPairBlock(entry, pairIdx, isWinner) {
        const offset = pairIdx * 2;
        const pSuffix = ['p1','p2','p3','p4'];
        const n1 = escHtml(entry.players[offset] || '');
        const n2 = escHtml(entry.players[offset + 1] || '');

        const winnerRight = isWinner ? `
            <div class="h-winner-right">
                <span class="h-winner-badge">Winners</span>
                <span class="h-winner-score">${formatScore(entry)}</span>
            </div>` : '';

        // Totais de serviço (1st + 2nd) por jogador — base individual para os percentuais
        const tot1 = ((entry.stats ? entry.stats[`s_1srv_${pSuffix[offset]}`] : undefined) || 0) + ((entry.stats ? entry.stats[`s_2srv_${pSuffix[offset]}`] : undefined) || 0);
        const tot2 = ((entry.stats ? entry.stats[`s_1srv_${pSuffix[offset+1]}`] : undefined) || 0) + ((entry.stats ? entry.stats[`s_2srv_${pSuffix[offset+1]}`] : undefined) || 0);

        const rows = STAT_LABELS.map((label, i) => {
            const key = STAT_KEYS[i];
            const v1 = (entry.stats ? entry.stats[`s_${key}_${pSuffix[offset]}`] : undefined) || 0;
            const v2 = (entry.stats ? entry.stats[`s_${key}_${pSuffix[offset+1]}`] : undefined) || 0;
            const isServe = (key === '1srv' || key === '2srv');
            const c1 = isServe ? formatServeStat(v1, tot1) : v1;
            const c2 = isServe ? formatServeStat(v2, tot2) : v2;
            return `<tr><td>${label}</td><td>${c1}</td><td>${c2}</td></tr>`;
        }).join('');

        return `
            <div class="h-pair${isWinner ? ' winner' : ''}">
                <div class="h-pair-header">
                    <div class="h-pair-names">
                        <div class="h-pair-name-row">${n1}<span class="h-pair-name-sep">/</span>${n2}</div>
                    </div>
                    ${winnerRight}
                </div>
                <table class="h-stats-table">
                    <thead>
                        <tr>
                            <th>Statistic</th>
                            <th>${n1}</th>
                            <th>${n2}</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    // ============================================================
    // CAROUSEL STATE
    // ============================================================
    let carouselIdx = 0;
    let carouselTotal = 0;
    let touchStartX = 0;

    function formatDuration(secs) {
        if (!secs) return null;
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        if (m >= 60) {
            const h = Math.floor(m / 60);
            const rm = m % 60;
            return `${h}h ${String(rm).padStart(2,'0')}m`;
        }
        return `${m}m ${String(s).padStart(2,'0')}s`;
    }

    function escHtml(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // Separa as notas geradas automaticamente das notas do utilizador
    // As notas geradas começam com "⏱" ou "📊"
    function getUserNotes(notes) {
        if (!notes) return '';
        // Encontrar início das notas do utilizador (após o bloco de stats)
        const lines = notes.split('\n');
        // Procurar última linha divisória após TOTAL
        let afterStats = false;
        let userStart = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('TOTAL')) afterStats = true;
            if (afterStats && lines[i].startsWith('─') && i > 0) { userStart = i + 1; }
        }
        if (userStart >= 0) {
            return lines.slice(userStart).join('\n').trim();
        }
        // Fallback: se não tem stats, mostrar tudo
        if (!notes.includes('📊')) return notes.trim();
        return '';
    }

    function buildMatchStatsTable(entry) {
        const notes = entry.notes || '';
        if (!notes.includes('📊')) return ''; // jogo antigo sem stats

        const p = entry.players || ['P1','P2','P3','P4'];
        const hdr1 = `${p[0]} | ${p[1]}`;
        const hdr2 = `${p[2]} | ${p[3]}`;

        // Parse das linhas de stats geradas
        const lines = notes.split('\n');
        let sections = [];
        let cur = null;
        let inStats = false;

        for (const line of lines) {
            if (line.startsWith('📊')) { inStats = true; continue; }
            if (!inStats) continue;
            if (line.startsWith('▸')) {
                if (cur) sections.push(cur);
                cur = { label: line.replace('▸','').trim(), rows: [] };
                continue;
            }
            if (line.startsWith('TOTAL')) {
                if (cur) sections.push(cur);
                cur = { label: 'TOTAL', rows: [], isTotal: true };
                continue;
            }
            if (!cur) continue;
            if (line.startsWith('─') || line.trim() === '') continue;
            // Parse "Label    val1    val2"
            const m = line.match(/^(.+?)\s{2,}(\S+)\s+(\S+)\s*$/);
            const m1 = line.match(/^(.+?)\s{2,}(\S+)\s*$/); // linha com 1 valor (deuces)
            if (m) {
                cur.rows.push({ label: m[1].trim(), v1: m[2], v2: m[3] });
            } else if (m1 && !line.startsWith('─')) {
                cur.rows.push({ label: m1[1].trim(), v1: m1[2], v2: m1[2] });
            }
        }
        if (cur) sections.push(cur);
        if (!sections.length) return '';

        const valClass = (label) => {
            if (label.includes('Golden')) return 'val-gp';
            if (label.includes('Star'))   return 'val-sp';
            if (label.includes('Won'))    return 'val-win';
            return '';
        };

        let html = `
        <div class="h-match-stats-wrap">
            <div class="h-match-stats-header">
                <span class="h-match-stats-title">📊 Match Stats</span>
            </div>
            <table class="h-stats-html-table">
                <thead>
                    <tr>
                        <th></th>
                        <th>${escHtml(hdr1)}</th>
                        <th>${escHtml(hdr2)}</th>
                    </tr>
                </thead>
                <tbody>`;

        for (const sec of sections) {
            const headClass = sec.isTotal ? 'total-head' : 'section-head';
            html += `<tr class="${headClass}"><td colspan="3">${escHtml(sec.label)}</td></tr>`;
            for (const r of sec.rows) {
                const vc = valClass(r.label);
                html += `<tr>
                    <td>${escHtml(r.label)}</td>
                    <td class="${vc}">${escHtml(r.v1)}</td>
                    <td class="${vc}">${escHtml(r.v2)}</td>
                </tr>`;
            }
        }

        html += `</tbody></table></div>`;
        return html;
    }

    // ============================================================
    // FULLSCREEN NOTES EDITOR
    // ============================================================
    let _notesFsIdx = null; // null = partida ao vivo (currentNotes); número = índice no histórico

    function openNotesFs(idx) {
        _notesFsIdx = idx;
        const ta = document.getElementById('notes-fs-textarea');
        if (idx === null) {
            // Modo ao vivo — edita currentNotes directamente (ainda sem
            // Análise por IA, que só existe depois do fim da partida)
            ta.value = currentNotes || '';
        } else {
            const history = loadHistory();
            const entry = history[idx];
            if (!entry) return;
            ta.value = getUserNotes(entry.notes || '');
        }
        updateNotesFsCounter();
        document.getElementById('notes-fs-overlay').classList.add('show');
        setTimeout(() => ta.focus(), 120);
    }

    function closeNotesFsOnBg(event) {
        if (event.target === document.getElementById('notes-fs-overlay')) closeNotesFs();
    }

    function closeNotesFs() {
        document.getElementById('notes-fs-overlay').classList.remove('show');
        _notesFsIdx = null;
    }

    function updateNotesFsCounter() {
        const len = document.getElementById('notes-fs-textarea').value.length;
        document.getElementById('notes-fs-counter').textContent = `${len} / 5120`;
    }

    function saveNotesFs() {
        const newUserNotes = document.getElementById('notes-fs-textarea').value.trim();

        if (_notesFsIdx === null) {
            // Modo ao vivo — grava directo em currentNotes (persistido no
            // histórico só quando a partida terminar, via saveMatchHistory)
            currentNotes = newUserNotes;
            saveGameState();
            closeNotesFs();
            return;
        }

        const history = loadHistory();
        if (!history[_notesFsIdx]) { closeNotesFs(); return; }

        const entry = history[_notesFsIdx];
        const existingNotes = entry.notes || '';

        // Reconstruir: manter bloco ⏱ + 📊 (partidas antigas), substituir
        // parte editável (Análise por IA + notas pessoais do Coach)
        let statsBlock = '';
        if (existingNotes.includes('📊')) {
            const lines = existingNotes.split('\n');
            let capturing = false;
            let statLines = [];
            let afterLastDivider = false;
            // Capturar tudo até ao fim da última linha divisória após TOTAL
            let lastDividerIdx = -1;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('⏱') || lines[i].startsWith('📊')) capturing = true;
                if (capturing) {
                    statLines.push(lines[i]);
                    if (lines[i].startsWith('TOTAL')) afterLastDivider = true;
                    if (afterLastDivider && lines[i].startsWith('─')) lastDividerIdx = statLines.length - 1;
                }
            }
            statsBlock = statLines.slice(0, lastDividerIdx + 1).join('\n');
        } else if (existingNotes.startsWith('⏱')) {
            statsBlock = existingNotes.split('\n\n')[0];
        }

        const newFull = newUserNotes
            ? (statsBlock ? statsBlock + '\n\n' + newUserNotes : newUserNotes)
            : statsBlock;

        history[_notesFsIdx].notes = newFull;
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch(e) {}

        closeNotesFs();
    }

    // Botão único de IA no Histórico — se a análise já existe, abre as
    // Notes pra ler; se não existe, chama o Worker pra gerar. Substitui os
    // dois botões separados que existiam antes.
    function handleAiButtonForEntry(idx) {
        const history = loadHistory();
        const entry = history[idx];
        if (!entry) return;
        if (isAiAnalysisGenerated(entry)) {
            openNotesFs(idx);
        } else {
            regenerateAiAnalysisForEntry(idx, true);
        }
    }

    // Wrappers "Current" — os botões fixos do rodapé agem sempre sobre a
    // partida actualmente visível no carrossel (carouselIdx), mesmo padrão
    // já usado por openPointLogFromHistoryCurrent().
    function handleAiButtonForEntryCurrent() { handleAiButtonForEntry(carouselIdx); }
    function toggleIndividualDetailsCurrent() { toggleIndividualDetails(carouselIdx); }
    function openNotesFsCurrent() { openNotesFs(carouselIdx); }

    function toggleIndividualDetails(idx) {
        const el = document.getElementById('h-individual-' + idx);
        if (!el) return;
        el.style.display = (el.style.display === 'none') ? 'block' : 'none';
    }

    function buildGameSlide(entry, idx) {
        const sMode = entry.setMode === 'proset' ? 'ProSet'
            : entry.setMode === 'supertie' ? 'Supertie' : '3 Sets';
        const pMode = entry.pointMode === 'star' ? 'SP' : 'GP';
        const modeLabel = `${sMode} · ${pMode}`;
        // duration vem de um campo próprio (entry.duration) — partidas
        // antigas (salvas antes desta mudança) ainda podem ter a duração
        // embutida na 1ª linha das notas, mantido como fallback
        const legacyTimeLine = (entry.notes || '').split('\n').find(l => l.startsWith('⏱'));
        const duration = entry.duration || (legacyTimeLine ? legacyTimeLine.replace('⏱ Match Time:', '').trim() : null);
        return `
            <div class="h-game">
                <div class="h-game-meta">
                    <div class="h-game-meta-left">
                        <span class="h-game-date">${formatDate(entry.date)}</span>
                        <span class="h-game-modebadge">${modeLabel}</span>
                        ${duration ? `<span class="h-game-duration">MATCH TIME: ${duration}</span>` : ''}
                    </div>
                    <button class="h-delete-btn" onclick="deleteMatch(${idx})" title="Delete">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                            <path d="M10 11v6M14 11v6"/>
                            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                        </svg>
                    </button>
                </div>
                <div class="gs-embed gs-card" id="gs-embed-${idx}">
                    <div class="gs-embed-loading">Loading…</div>
                </div>
                <div class="h-individual-details" id="h-individual-${idx}" style="display:none">
                    ${buildPairBlock(entry, 0, entry.winner === 0)}
                    ${buildPairBlock(entry, 1, entry.winner === 1)}
                    ${buildMatchStatsTable(entry)}
                </div>
            </div>`;
    }

    // ============================================================
    // EXPORT POR JOGO DO HISTÓRICO — Email (mailto) + Excel
    // Botões diretos no footer do histórico; usam sempre o jogo
    // actualmente visível no carousel (carouselIdx).
    // ============================================================
    const EMAIL_LAST_KEY = 'padel_last_email';

    // Alinha texto à direita dentro de uma largura fixa (para colunas monoespaçadas)
    function padLeft(str, width) {
        str = String(str);
        return str.length >= width ? str : ' '.repeat(width - str.length) + str;
    }
    function padRight(str, width) {
        str = String(str);
        return str.length >= width ? str : str + ' '.repeat(width - str.length);
    }

    function buildPairEmailBlock(entry, pairIdx) {
        const offset = pairIdx * 2;
        const pSuffix = ['p1','p2','p3','p4'];
        const n1 = entry.players[offset] || '';
        const n2 = entry.players[offset + 1] || '';
        const tot1 = ((entry.stats ? entry.stats[`s_1srv_${pSuffix[offset]}`] : undefined) || 0) + ((entry.stats ? entry.stats[`s_2srv_${pSuffix[offset]}`] : undefined) || 0);
        const tot2 = ((entry.stats ? entry.stats[`s_1srv_${pSuffix[offset+1]}`] : undefined) || 0) + ((entry.stats ? entry.stats[`s_2srv_${pSuffix[offset+1]}`] : undefined) || 0);

        // Largura das colunas — baseada no maior valor entre label/nomes/dados
        const labelW = Math.max(...STAT_LABELS.map(l => l.length)) + 2;
        const rows = STAT_LABELS.map((label, i) => {
            const key = STAT_KEYS[i];
            const v1 = (entry.stats ? entry.stats[`s_${key}_${pSuffix[offset]}`] : undefined) || 0;
            const v2 = (entry.stats ? entry.stats[`s_${key}_${pSuffix[offset+1]}`] : undefined) || 0;
            const isServe = (key === '1srv' || key === '2srv');
            const c1 = isServe ? formatServeStat(v1, tot1) : String(v1);
            const c2 = isServe ? formatServeStat(v2, tot2) : String(v2);
            return { label, c1, c2 };
        });
        const colW = Math.max(n1.length, n2.length, ...rows.map(r => r.c1.length), ...rows.map(r => r.c2.length)) + 2;

        const lines = [];
        lines.push(`${n1} / ${n2}`);
        lines.push('-'.repeat(Math.max(n1.length + n2.length + 3, 24)));
        lines.push(`${padRight('', labelW)}${padLeft(n1, colW)}${padLeft(n2, colW)}`);
        rows.forEach(r => {
            lines.push(`${padRight(r.label, labelW)}${padLeft(r.c1, colW)}${padLeft(r.c2, colW)}`);
        });
        return lines.join('\n');
    }

    // Versão em texto plano do Match Stats (duração, deuces, golden point, etc.)
    // — reaproveita o mesmo parsing de buildMatchStatsTable, mas devolve texto alinhado
    function buildMatchStatsEmailText(entry) {
        const notes = entry.notes || '';
        if (!notes.includes('📊')) return '';

        const p = entry.players || ['P1','P2','P3','P4'];
        const hdr1 = `${p[0]} | ${p[1]}`;
        const hdr2 = `${p[2]} | ${p[3]}`;

        const lines = notes.split('\n');
        let sections = [];
        let cur = null;
        let inStats = false;

        for (const line of lines) {
            if (line.startsWith('📊')) { inStats = true; continue; }
            if (!inStats) continue;
            if (line.startsWith('▸')) {
                if (cur) sections.push(cur);
                cur = { label: line.replace('▸','').trim(), rows: [] };
                continue;
            }
            if (line.startsWith('TOTAL')) {
                if (cur) sections.push(cur);
                cur = { label: 'TOTAL', rows: [], isTotal: true };
                continue;
            }
            if (!cur) continue;
            if (line.startsWith('─') || line.trim() === '') continue;
            const m = line.match(/^(.+?)\s{2,}(\S+)\s+(\S+)\s*$/);
            const m1 = line.match(/^(.+?)\s{2,}(\S+)\s*$/);
            if (m) {
                cur.rows.push({ label: m[1].trim(), v1: m[2], v2: m[3] });
            } else if (m1 && !line.startsWith('─')) {
                cur.rows.push({ label: m1[1].trim(), v1: m1[2], v2: m1[2] });
            }
        }
        if (cur) sections.push(cur);
        if (!sections.length) return '';

        var allLabels = sections.reduce(function(acc, s) { return acc.concat(s.rows.map(function(r) { return r.label; })); }, []);
        const labelW = Math.max(hdr1.length === 0 ? 0 : 0, ...allLabels.map(l => l.length), 0) + 2;
        var allVals = sections.reduce(function(acc, s) { return acc.concat(s.rows.reduce(function(a2, r) { return a2.concat([r.v1, r.v2]); }, [])); }, []);
        const colW = Math.max(hdr1.length, hdr2.length, ...allVals.map(v => String(v).length), 0) + 2;

        const out = [];
        out.push('MATCH STATS');
        out.push('-'.repeat(24));
        out.push(`${padRight('', labelW)}${padLeft(hdr1, colW)}${padLeft(hdr2, colW)}`);
        for (const sec of sections) {
            out.push(sec.label + ':');
            for (const r of sec.rows) {
                out.push(`${padRight('  ' + r.label, labelW)}${padLeft(r.v1, colW)}${padLeft(r.v2, colW)}`);
            }
        }
        return out.join('\n');
    }

    function buildGameEmailText(entry) {
        const sMode = entry.setMode === 'proset' ? 'ProSet'
            : entry.setMode === 'supertie' ? 'Supertie' : '3 Sets';
        const pMode = entry.pointMode === 'star' ? 'Star Point' : 'Golden Point';
        const [p1, p2, p3, p4] = entry.players;
        const winnerNames = entry.winner === 0 ? `${p1} / ${p2}` : `${p3} / ${p4}`;
        const lines = [];
        lines.push(`PADEL COACHING — MATCH REPORT`);
        lines.push('='.repeat(32));
        lines.push(`Date: ${formatDate(entry.date)}`);
        lines.push(`Mode: ${sMode} · ${pMode}`);
        lines.push('');
        lines.push(`${p1} / ${p2}  vs  ${p3} / ${p4}`);
        lines.push(`Score: ${formatScore(entry)}`);
        lines.push(`Winners: ${winnerNames}`);
        lines.push('');
        lines.push(buildPairEmailBlock(entry, 0));
        lines.push('');
        lines.push(buildPairEmailBlock(entry, 1));
        const matchStatsText = buildMatchStatsEmailText(entry);
        if (matchStatsText) {
            lines.push('');
            lines.push(matchStatsText);
        }
        const userNotes = getUserNotes(entry.notes || '');
        if (userNotes) {
            lines.push('');
            lines.push('Notes:');
            lines.push(userNotes);
        }
        return lines.join('\n');
    }

    function sendGameByEmail() {
        const input = document.getElementById('email-recipient-input');
        let lastEmail = '';
        try { lastEmail = localStorage.getItem(EMAIL_LAST_KEY) || ''; } catch(e) {}
        input.value = lastEmail;
        document.getElementById('email-prompt-overlay').classList.add('show');
        setTimeout(() => input.focus(), 100);
    }

    function closeEmailPrompt(e) {
        if (e && e.target.id !== 'email-prompt-overlay') return;
        document.getElementById('email-prompt-overlay').classList.remove('show');
    }

    function confirmSendEmail() {
        const input = document.getElementById('email-recipient-input');
        const email = input.value.trim();
        if (!email || !email.includes('@')) {
            showToast('⚠️ Enter a valid email', '#b45309');
            return;
        }
        try { localStorage.setItem(EMAIL_LAST_KEY, email); } catch(e) {}

        const history = loadHistory();
        const entry = history[carouselIdx];
        if (!entry) { closeEmailPrompt(); return; }

        const subject = `Padel Match Report — ${formatDate(entry.date)}`;
        const body = buildGameEmailText(entry);
        const mailtoUrl = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

        document.getElementById('email-prompt-overlay').classList.remove('show');
        window.location.href = mailtoUrl;
    }

    async function exportHistoryGameToExcel() {
        const history = loadHistory();
        const entry = history[carouselIdx];
        if (!entry) return;

        const [p1, p2, p3, p4] = entry.players;
        const isProset = entry.setMode === 'proset';

        // Cores por dupla — mesmas do resto do app (azul dupla 1 / amarelo dupla 2)
        const PAIR1_FILL = 'FFDCEEFB'; // azul bem claro
        const PAIR2_FILL = 'FFFCF3D6'; // amarelo bem claro
        const HEADER_FILL = 'FF1E3A6E';
        const HEADER_FONT = 'FFFFFFFF';

        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Match');
        ws.columns = [
            { width: 24 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }
        ];

        function styleHeaderRow(row) {
            row.eachCell(cell => {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
                cell.font = { bold: true, color: { argb: HEADER_FONT } };
            });
        }

        // ---- 1. RESULTADO (igual ao que já existia) ----
        const setHeaders = [
            '',
            isProset ? '—' : 'Set 1',
            isProset ? '—' : 'Set 2',
            isProset ? 'ProSet' : (entry.setMode === 'supertie' ? 'Supertie' : 'Set 3')
        ];
        const resultHeaderRow = ws.addRow(setHeaders);
        styleHeaderRow(resultHeaderRow);
        ws.addRow([
            p1 + ' / ' + p2,
            isProset ? '—' : entry.sets[0][0],
            isProset ? '—' : entry.sets[1][0],
            entry.sets[2][0]
        ]);
        ws.addRow([
            p3 + ' / ' + p4,
            isProset ? '—' : entry.sets[0][1],
            isProset ? '—' : entry.sets[1][1],
            entry.sets[2][1]
        ]);

        // ---- 2 linhas em branco ----
        ws.addRow([]);
        ws.addRow([]);

        // ---- 2. SCOUT — Coluna A: estatística, B/C: dupla 1, D/E: dupla 2 ----
        const scoutHeaderRow = ws.addRow(['SCOUT', p1, p2, p3, p4]);
        styleHeaderRow(scoutHeaderRow);
        STAT_LABELS.forEach((label, i) => {
            const key = STAT_KEYS[i];
            const v1 = (entry.stats ? entry.stats[`s_${key}_p1`] : undefined) || 0;
            const v2 = (entry.stats ? entry.stats[`s_${key}_p2`] : undefined) || 0;
            const v3 = (entry.stats ? entry.stats[`s_${key}_p3`] : undefined) || 0;
            const v4 = (entry.stats ? entry.stats[`s_${key}_p4`] : undefined) || 0;
            const row = ws.addRow([label, v1, v2, v3, v4]);
            row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAIR1_FILL } };
            row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAIR1_FILL } };
            row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAIR2_FILL } };
            row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAIR2_FILL } };
        });

        // ---- 2 linhas em branco ----
        ws.addRow([]);
        ws.addRow([]);

        // ---- 3. ANÁLISE POR IA — texto simples ----
        const aiHeaderRow = ws.addRow(['AI ANALYSIS & NOTES']);
        styleHeaderRow(aiHeaderRow);
        const notesText = getUserNotes(entry.notes || '') || '(no notes for this match)';
        notesText.split('\n').forEach(line => {
            ws.addRow([line]);
        });
        // Mesclar as células de texto pra não ficarem cortadas por A:E
        const notesStartRow = aiHeaderRow.number + 1;
        const notesEndRow = notesStartRow + notesText.split('\n').length - 1;
        for (let r = notesStartRow; r <= notesEndRow; r++) {
            ws.mergeCells(`A${r}:E${r}`);
            ws.getRow(r).alignment = { wrapText: true, vertical: 'top' };
        }

        // ---- Download ----
        const d = new Date(entry.date);
        const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
        const buffer = await wb.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `padel_${stamp}.xlsx`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function renderCarousel() {
        const history = loadHistory();
        const track = document.getElementById('h-track');
        const counter = document.getElementById('h-counter');
        track.innerHTML = '';
        carouselTotal = history.length;

        if (carouselTotal === 0) {
            const slide = document.createElement('div');
            slide.className = 'history-carousel-slide';
            slide.innerHTML = '<div class="history-empty">No games recorded yet.</div>';
            track.appendChild(slide);
            counter.textContent = '';
            updateNavBtns();
        } else {
            history.forEach((entry, idx) => {
                const slide = document.createElement('div');
                slide.className = 'history-carousel-slide';
                slide.innerHTML = buildGameSlide(entry, idx);
                track.appendChild(slide);
            });
            counter.textContent = `${carouselIdx + 1} / ${carouselTotal}`;
            updateNavBtns();
            // Preenche o Card embutido de cada slide — assíncrono (fotos
            // vêm do IndexedDB), não bloqueia a renderização do carrossel.
            history.forEach((entry, idx) => {
                buildGrandSlamCardHtml(entry).then(function (html) {
                    const c = document.getElementById('gs-embed-' + idx);
                    if (c) c.innerHTML = html;
                });
            });
        }
        updateCarouselPos(false);
        updateNavBtns();
    }

    function updateCarouselPos(animate) {
        const track = document.getElementById('h-track');
        if (!animate) track.style.transition = 'none';
        else track.style.transition = 'transform 0.35s cubic-bezier(0.4,0,0.2,1)';
        track.style.transform = `translateX(-${carouselIdx * 100}vw)`;
        if (!animate) track.offsetHeight; // force reflow
    }

    function updateNavBtns() {
        // Navegação por swipe mantida; setas são só indicador visual (sem
        // acção de navegação), acesas conforme houver mais jogos pro lado.
        const leftArrow = document.getElementById('h-nav-arrow-left');
        const rightArrow = document.getElementById('h-nav-arrow-right');
        if (leftArrow) leftArrow.classList.toggle('lit', carouselIdx > 0);
        if (rightArrow) rightArrow.classList.toggle('lit', carouselIdx < carouselTotal - 1);
        const counter = document.getElementById('h-counter');
        if (carouselTotal > 0) counter.textContent = `${carouselIdx + 1} / ${carouselTotal}`;
        // Botão de IA no rodapé fixo — reflecte a partida actualmente visível
        const history = loadHistory();
        const entry = history[carouselIdx];
        const aiBtn = document.getElementById('h-ai-footer-btn');
        if (aiBtn && entry) {
            const done = isAiAnalysisGenerated(entry);
            aiBtn.querySelector('.h-ai-footer-icon').textContent = done ? '✨' : '🔄';
            aiBtn.title = done ? 'View the AI analysis for this match' : 'Generate the AI analysis for this match';
        }
    }

    function goToSlide(idx) {
        carouselIdx = Math.max(0, Math.min(idx, carouselTotal - 1));
        updateCarouselPos(true);
        updateNavBtns();
    }

    function carouselNav(dir) { goToSlide(carouselIdx + dir); }

    function openHistory() {
        // Histórico é só pra leitura vertical — nunca abre em TV Mode.
        if (window.matchMedia('(orientation: landscape)').matches) {
            showToast('History is only available in portrait mode');
            return;
        }
        carouselIdx = 0;
        renderCarousel();
        document.getElementById('history-overlay').classList.add('show');

        // Swipe support
        const wrap = document.getElementById('h-track-wrap');
        wrap.ontouchstart = e => { touchStartX = e.touches[0].clientX; };
        wrap.ontouchend = e => {
            const dx = e.changedTouches[0].clientX - touchStartX;
            if (Math.abs(dx) > 40) carouselNav(dx < 0 ? 1 : -1);
        };
    }

    function closeHistory() {
        document.getElementById('history-overlay').classList.remove('show');
    }

    function deleteMatch(idx) {
        if (!confirm('Delete this game from history?')) return;
        let history = loadHistory();
        history.splice(idx, 1);
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch(e) {}
        carouselIdx = Math.max(0, Math.min(carouselIdx, history.length - 1));
        renderCarousel();
    }

    // ============================================================
    // NOTES
    // ============================================================
    let currentNotes = '';

    // Bloco abaixo (openNotes/closeNotes/closeNotesOnBg/updateNotesCounter/
    // saveNotes) não é mais chamado por nenhum controlo da UI — o modal
    // "notes-overlay" foi removido do HTML e substituído pelo modal
    // unificado "AI Analysis & Personal Notes" (openNotesFs/saveNotesFs,
    // aceita idx=null pra modo ao vivo). Mantido no código, não apagado.
    function openNotes() {
        document.getElementById('notes-textarea').value = currentNotes;
        updateNotesCounter();
        document.getElementById('notes-overlay').classList.add('show');
        setTimeout(() => document.getElementById('notes-textarea').focus(), 100);
    }
    function closeNotes() {
        document.getElementById('notes-overlay').classList.remove('show');
    }
    function closeNotesOnBg(e) {
        if (e.target === document.getElementById('notes-overlay')) closeNotes();
    }
    function updateNotesCounter() {
        const len = document.getElementById('notes-textarea').value.length;
        document.getElementById('notes-counter').textContent = `${len} / 500`;
    }
    function saveNotes() {
        currentNotes = document.getElementById('notes-textarea').value.trim();
        closeNotes();
    }

    // saveHistoryNote substituída por openNotesFs / saveNotesFs

    // ============================================================
    // MATCH TIMER
    // ============================================================
    let timerSeconds = 0;
    let timerRunning = false;
    let timerInterval = null;

    function toggleTimer() {
        if (timerRunning) {
            clearInterval(timerInterval);
            timerRunning = false;
        } else {
            timerInterval = setInterval(() => {
                timerSeconds++;
                updateTimerDisplay();
            }, 1000);
            timerRunning = true;
        }
        updateTimerDisplay();
    }

    function updateTimerDisplay() {
        const m = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
        const s = String(timerSeconds % 60).padStart(2, '0');
        const el = document.getElementById('timer-display-p');
        if (el) el.textContent = `${m}:${s}`;
        const timer = document.getElementById('timer-p');
        if (timer) timer.classList.toggle('running', timerRunning);
    }

    function resetTimer() {
        clearInterval(timerInterval);
        timerRunning = false;
        timerSeconds = 0;
        updateTimerDisplay();
    }

    function forceClear() {
        clearGameState();
        state = { sets:[[0,0],[0,0],[0,0]], currentSet:0, pts:[0,0], isSuperTieBreak:false, isTieBreakMode:false, matchOver:false, tiebreakPts:[null,null,null], deuceCount:0 };
        currentNotes = '';
        matchGameLogs = [];
        currentGamePoints = [];
        currentGameServingTeam = null;
        currentGameServingPlayer = null;
        currentGameBreakPoints = [0, 0];
        currentGameBpPeak = 0;
        resetSetStats();
        resetTimer();
        document.getElementById('game-over-p').classList.remove('show');
        document.getElementById('gs-card-btn').classList.remove('show');
        document.getElementById('golden-point-p').classList.remove('show');
        document.getElementById('break-point-p').classList.remove('show');
        resetStats();
        _serveStatCounted = false;
        updateSet3Labels();
        updateConfig();
        updateScreen();
        initServe(); // reiniciar indicador de serviço
    }

    function checkForUpdates() {
        if (!('serviceWorker' in navigator)) {
            showToast('Service Worker not available');
            return;
        }
        showToast('🔄 Checking for updates...');
        navigator.serviceWorker.getRegistration().then(reg => {
            if (!reg) { showToast('No SW registered'); return; }
            reg.update().then(() => {
                if (reg.waiting) {
                    // Novo SW já está à espera — activar e recarregar
                    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                    // controllerchange vai disparar o reload automático
                } else if (reg.installing) {
                    // A instalar agora — esperar
                    reg.installing.addEventListener('statechange', e => {
                        if (e.target.state === 'installed') {
                            e.target.postMessage({ type: 'SKIP_WAITING' });
                        }
                    });
                } else {
                    // Já está na versão mais recente
                    showToast('✅ Already up to date');
                }
            });
        });
    }

    function askResetMatch() {
        document.getElementById('ng-overlay').classList.add('show');
    }

    function ngConfirm() {
        document.getElementById('ng-overlay').classList.remove('show');
        forceClear();
    }

    function ngCancel() {
        document.getElementById('ng-overlay').classList.remove('show');
    }



    // ============================================================
    // SPLASH SCREEN — 2s ao arrancar
    // ============================================================
    const APP_ICON_B64 = 'data:image/png;base64,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';

    function initSplash() {
        const splash = document.getElementById('splash-screen');
        const icon   = document.getElementById('splash-icon');
        if (!splash || !icon) return;
        icon.src = APP_ICON_B64;
        var verEl = document.getElementById('splash-version');
        if (verEl) verEl.textContent = 'V ' + APP_VERSION;
        // Fechar após 2s com fade de 0.5s
        setTimeout(function() {
            splash.classList.add('fade-out');
            setTimeout(function() {
                splash.classList.add('hidden');
            }, 500);
        }, 2000);
    }

    // ============================================================
    // SPONSOR CAROUSEL
    // ============================================================
    const SPONSOR_IMAGES = [
        'data:image/png;base64,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'
    ];
    let _sponsorIdx = 0;
    let _sponsorTimer = null;

    function initSponsorCarousel() {
        const img = document.getElementById('sponsor-slide');
        if (!img) return;
        img.src = SPONSOR_IMAGES[0];
        img.style.opacity = '1';
        _sponsorIdx = 0;
        if (_sponsorTimer) clearInterval(_sponsorTimer);
        _sponsorTimer = setInterval(advanceSponsor, 5000);
    }

    function advanceSponsor() {
        const img = document.getElementById('sponsor-slide');
        if (!img) return;
        img.style.opacity = '0';
        setTimeout(() => {
            _sponsorIdx = (_sponsorIdx + 1) % SPONSOR_IMAGES.length;
            img.src = SPONSOR_IMAGES[_sponsorIdx];
            img.style.opacity = '1';
        }, 600);
    }

    // ============================================================
    // TUTORIAL — onboarding guiado (balões sequenciais)
    // ============================================================
    const TUTORIAL_DONE_KEY = 'padel_tutorial_done';
    let tutActive = false;
    let tutIdx = 0;
    let tutActionHandlers = [];

    // Cada passo: text, anchor (seletor|null, null = centralizado),
    // tip (true = estilo "tip solta", sem seta/indicador),
    // advance: 'next' (botão Next) | 'action' (aguarda ação real do usuário),
    // actionTargets/actionEvent: usados quando advance === 'action'
    const TUTORIAL_STEPS = [
        { text: "Padel Score and Coaching helps your athlete's development — turning match data into insights that support your coaching.", anchor: null, advance: 'next' },
        { text: "It generates stats that highlight where more training focus is needed.", anchor: null, advance: 'next' },
        { text: "Plus insights on mental performance and game strategy to improve.", anchor: null, advance: 'next' },
        { text: "Tap here to pick a tournament or federation logo from your gallery.", anchor: '#logo-left-slot', advance: 'action', actionTargets: ['#fi-logo-left'], actionEvent: 'change' },
        { text: "Tap each photo to add a picture for that player.", anchor: '#t1-img1', advance: 'action', actionTargets: ['#fi-t1-img1', '#fi-t1-img2', '#fi-t2-img1', '#fi-t2-img2'], actionEvent: 'change' },
        { text: "Standing behind the baseline, place each player on their real side — left or right.", anchor: null, tip: true, advance: 'next' },
        { text: "Tap a name to rename each player.", anchor: '#t1-p1', advance: 'action', actionTargets: ['#t1-p1', '#t1-p2', '#t2-p1', '#t2-p2'], actionEvent: 'blur' },
    ];

    // Replay manual (botão no CONFIG): ignora a flag e o estado salvo
    function startTutorialFromConfig() {
        closeConfig();
        if (tutActive) tutEnd();
        setTimeout(tutStart, 350);
    }

    function tutMaybeStart() {
        try {
            if (localStorage.getItem(TUTORIAL_DONE_KEY)) return;
        } catch(e) { return; }
        tutStart();
    }

    function tutStart() {
        tutActive = true;
        tutIdx = 0;
        tutShowStep();
    }

    function tutEnd() {
        tutActive = false;
        tutClearActionListeners();
        const ov = document.getElementById('tut-overlay');
        if (ov) ov.remove();
        try { localStorage.setItem(TUTORIAL_DONE_KEY, '1'); } catch(e) {}
    }

    function tutRenderShell() {
        if (document.getElementById('tut-overlay')) return;
        const ov = document.createElement('div');
        ov.id = 'tut-overlay';
        ov.innerHTML =
            '<div class="tut-highlight" id="tut-highlight"></div>' +
            '<div class="tut-bubble" id="tut-bubble">' +
                '<div class="tut-bubble-label">💡 Tip</div>' +
                '<div class="tut-bubble-text" id="tut-bubble-text"></div>' +
                '<div class="tut-bubble-footer">' +
                    '<span class="tut-progress" id="tut-progress"></span>' +
                    '<button class="tut-next-btn" id="tut-next-btn">Next</button>' +
                '</div>' +
            '</div>' +
            '<button class="tut-skip" id="tut-skip">Skip tutorial</button>';
        document.body.appendChild(ov);
        document.getElementById('tut-next-btn').addEventListener('click', tutNext);
        document.getElementById('tut-skip').addEventListener('click', tutEnd);
        window.addEventListener('resize', tutReposition);
    }

    function tutReposition() {
        if (tutActive) tutShowStep(/* reposition */ true);
    }

    function tutNext() {
        tutIdx++;
        if (tutIdx >= TUTORIAL_STEPS.length) { tutEnd(); return; }
        tutShowStep();
    }

    function tutClearActionListeners() {
        tutActionHandlers.forEach(function(h) { h.el.removeEventListener(h.event, h.fn); });
        tutActionHandlers = [];
    }

    function tutAttachActionListeners(step) {
        (step.actionTargets || []).forEach(function(sel) {
            const el = document.querySelector(sel);
            if (!el) return;
            const fn = function() { tutClearActionListeners(); tutNext(); };
            el.addEventListener(step.actionEvent, fn, { once: true });
            tutActionHandlers.push({ el: el, event: step.actionEvent, fn: fn });
        });
    }

    function tutPositionBubble(bubble, r) {
        bubble.style.transform = 'none';
        bubble.style.left = Math.max(12, Math.min(r.left, window.innerWidth - 12 - bubble.offsetWidth)) + 'px';
        const spaceBelow = window.innerHeight - r.bottom;
        if (spaceBelow > 140) {
            bubble.style.top = (r.bottom + 14) + 'px';
        } else {
            bubble.style.top = Math.max(12, r.top - 14 - bubble.offsetHeight) + 'px';
        }
    }

    function tutPositionBubbleCenter(bubble) {
        bubble.style.transform = 'translate(-50%, -50%)';
        bubble.style.left = '50%';
        bubble.style.top = '50%';
    }

    function tutShowStep() {
        tutRenderShell();
        const step = TUTORIAL_STEPS[tutIdx];
        const bubble = document.getElementById('tut-bubble');
        const highlight = document.getElementById('tut-highlight');

        document.getElementById('tut-bubble-text').textContent = step.text;
        document.getElementById('tut-progress').textContent = (tutIdx + 1) + ' / ' + TUTORIAL_STEPS.length;
        bubble.classList.toggle('tut-tip', !!step.tip);
        document.getElementById('tut-next-btn').style.display = (step.advance === 'next') ? 'inline-block' : 'none';

        tutClearActionListeners();

        const anchorEl = step.anchor ? document.querySelector(step.anchor) : null;
        if (anchorEl) {
            const r = anchorEl.getBoundingClientRect();
            highlight.style.display = 'block';
            highlight.style.top = (r.top - 6) + 'px';
            highlight.style.left = (r.left - 6) + 'px';
            highlight.style.width = (r.width + 12) + 'px';
            highlight.style.height = (r.height + 12) + 'px';
            tutPositionBubble(bubble, r);
        } else {
            highlight.style.display = 'none';
            tutPositionBubbleCenter(bubble);
        }

        if (step.advance === 'action') {
            tutAttachActionListeners(step);
        }
    }

    updateSet3Labels();
    updateConfig();

    // Restaurar jogo em curso se existir, caso contrário arrancar do zero
    const hadSavedGame = restoreGameState();

    updateScreen();
    applyStatsVisibility();
    restoreLogos();
    restorePhotos();
    if (!hadSavedGame) restoreNames();
    if (!hadSavedGame) initServe();
    else renderServeBalls();
    initSplash();
    initSponsorCarousel();
    if (!hadSavedGame) setTimeout(tutMaybeStart, 2600);

    // ── Expor funções públicas no window (chamadas por onclick no HTML) ──────
    Object.assign(window, {
        addPoint, removePoint,
        askResetMatch, carouselNav,
        checkForUpdates,
        ngConfirm, ngCancel,
        closeConfig, closeConfigOnBg,
        closeHistory, closeNotes, closeNotesFs, closeNotesOnBg, closeNotesFsOnBg,
        openConfig, openHistory, openNotes, startTutorialFromConfig,
        saveNotes, saveNotesFs,
        setPointMode, setSetMode, setStatsMode, setProsetMode,
        toggleTimer,
        updateNotesCounter, updateNotesFsCounter,
        // Histórico (chamadas dinâmicas em buildGameSlide)
        deleteMatch, openNotesFs, openPointLogFromHistory, openPointLogFromHistoryCurrent,
        sendGameByEmail, closeEmailPrompt, confirmSendEmail,
        exportHistoryGameToExcel,
        // Estatísticas — não têm onclick mas expostas por segurança
        incStat, decStatById,
        // Point Log — popup de pausa técnica
        closePointLogPopup, pointLogPrev, pointLogNext,
        setGameLogMode, openGameLogMenu, setPointLogActiveSet, setPointLogViewIndex, setAiAnalysisLanguage,
        regenerateAiAnalysisForEntry, dismissAiErrorPopup, retryAiAnalysis,
        openGrandSlamCard, closeGrandSlamCard, closeGrandSlamCardOnBg,
        handleAiButtonForEntry, toggleIndividualDetails,
        handleAiButtonForEntryCurrent, toggleIndividualDetailsCurrent, openNotesFsCurrent,
    });

})();
