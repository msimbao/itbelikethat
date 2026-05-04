// ═══════════════════════════════════════════════════════════════
//  MAKER SCALPER BOT v4 — Single File
//  Binance WebSocket · Paper Trading · Discord Notifications
//
//  [v2] Session-aware trading (London + NY windows only)
//  [v2] Adaptive thresholds (EMA baselines per pair)
//  [v2] Fill quality tracking (deprioritise low-fill pairs)
//  [v2] Spoof wall persistence detection (timestamp-based)
//  [v2] BTC macro correlation filter (pause on spike)
//  [v2] Smart exits (watch book while in trade)
//  [v2] Latency penalty simulation (100ms paper handicap)
//  [v3] Regime detection (ranging vs trending)
//  [v3] Exit-side book quality check
//  [v3] Auto-tuner (reads trade log, suggests better params)
//  [v4] Dual-timeframe regime confirmation (fast + slow window)
//  [v4] Self-applying tuner (writes overrides, loads at startup)
//  [v4] Per-pair learned signal weights from win attribution
//  [v4] Discord: 30-min status + important event notifications only
// ═══════════════════════════════════════════════════════════════

'use strict';
const WebSocket = require('ws');
const https     = require('https');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');

// ─── PATHS ─────────────────────────────────────────────────────
const logDir       = path.join(__dirname, 'logs');
const overrideFile = path.join(__dirname, 'tuner-overrides.json');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// ─── TUNER OVERRIDES [v4] ──────────────────────────────────────
// Load any self-applied parameter overrides from previous auto-tune runs.
// These override CFG defaults but are themselves overridden by env vars.
function loadOverrides() {
  try {
    if (fs.existsSync(overrideFile)) {
      const o = JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
      console.log(`[BOOT] Loaded tuner overrides from ${overrideFile}:`, o.params || {});
      return o.params || {};
    }
  } catch {}
  return {};
}
const OVERRIDES = loadOverrides();
function cfgVal(envKey, envDefault, overrideKey, parser = parseFloat) {
  if (process.env[envKey] !== undefined) return parser(process.env[envKey]);
  if (OVERRIDES[overrideKey] !== undefined) return parser(OVERRIDES[overrideKey]);
  return parser(envDefault);
}

// ─── CONFIG ────────────────────────────────────────────────────
const CFG = {
  paperTrade  : process.env.PAPER_TRADE !== 'false',
  paperCapital: parseFloat(process.env.PAPER_CAPITAL || '1000'),
  pairs       : (process.env.PAIRS || 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(','),

  maxPositionUSD      : cfgVal('MAX_POSITION_USD',      '50',     'maxPositionUSD'),
  maxTotalExposureUSD : cfgVal('MAX_TOTAL_EXPOSURE_USD', '150',    'maxTotalExposureUSD'),
  stopLossPct         : cfgVal('STOP_LOSS_PCT',          '0.003',  'stopLossPct'),
  takeProfitPct       : cfgVal('TAKE_PROFIT_PCT',        '0.002',  'takeProfitPct'),
  staleOrderMs        : cfgVal('STALE_ORDER_MS',         '8000',   'staleOrderMs', parseInt),
  maxConsecLosses     : cfgVal('MAX_CONSEC_LOSSES',      '5',      'maxConsecLosses', parseInt),
  minSpreadPct        : cfgVal('MIN_SPREAD_PCT',         '0.0003', 'minSpreadPct'),
  minImbalance        : cfgVal('MIN_IMBALANCE',          '0.62',   'minImbalance'),
  maxDailyLossUSD     : cfgVal('MAX_DAILY_LOSS_USD',     '30',     'maxDailyLossUSD'),
  signalThreshold     : cfgVal('SIGNAL_THRESHOLD',       '0.35',   'signalThreshold'),
  paperLatencyMs      : cfgVal('PAPER_LATENCY_MS',       '100',    'paperLatencyMs', parseInt),
  btcMacroMovePct     : cfgVal('BTC_MACRO_MOVE_PCT',     '0.0015', 'btcMacroMovePct'),
  minFillRate         : cfgVal('MIN_FILL_RATE',          '0.5',    'minFillRate'),
  minExitSideDepth    : cfgVal('MIN_EXIT_SIDE_DEPTH',    '0.5',    'minExitSideDepth'),
  autoTuneIntervalHrs : cfgVal('AUTO_TUNE_INTERVAL_HRS', '24',     'autoTuneIntervalHrs'),

  // [v4] Dual-timeframe regime: fast window detects, slow window confirms
  regimeFastWindow    : cfgVal('REGIME_FAST_WINDOW',     '20',     'regimeFastWindow', parseInt),
  regimeSlowWindow    : cfgVal('REGIME_SLOW_WINDOW',     '80',     'regimeSlowWindow', parseInt),
  trendingAtrMultiple : cfgVal('TRENDING_ATR_MULTIPLE',  '0.6',    'trendingAtrMultiple'),

  activeSessions: process.env.ACTIVE_SESSIONS
    ? JSON.parse(process.env.ACTIVE_SESSIONS)
    : (OVERRIDES.activeSessions || [[7, 10], [12, 17]]),

  discordWebhook: process.env.DISCORD_WEBHOOK || '',
  dashPort      : parseInt(process.env.DASHBOARD_PORT || '3000'),
  wsBase        : 'wss://stream.binance.com:9443/stream',
};

// ─── LOGGER ────────────────────────────────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }
function ts()    { return new Date().toISOString(); }
const logFile   = path.join(logDir, `bot-${today()}.log`);
const tradeFile = path.join(logDir, `trades-${today()}.jsonl`);

function log(level, msg, data) {
  const line = `[${ts()}] [${level.padEnd(5)}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
}
const L = {
  info : (m, d) => log('INFO',  m, d),
  warn : (m, d) => log('WARN',  m, d),
  error: (m, d) => log('ERROR', m, d),
  trade: (obj)  => {
    try { fs.appendFileSync(tradeFile, JSON.stringify({ ts: ts(), ...obj }) + '\n'); } catch {}
    log('TRADE', `${obj.side} ${obj.pair}`, obj);
  },
};

// ─── DISCORD (notifications only) [v4] ────────────────────────
// No commands. Just outbound: 30-min status + important events.
const Discord = {
  _queue: [], _sending: false, _lastSent: 0, RATE_MS: 2000,

  _enqueue(item) { this._queue.push(item); this._flush(); },

  _flush() {
    if (this._sending || !this._queue.length || !CFG.discordWebhook) return;
    setTimeout(() => this._doSend(), Math.max(0, this.RATE_MS - (Date.now() - this._lastSent)));
  },

  _doSend() {
    if (!this._queue.length) return;
    this._sending = true;
    const item = this._queue.shift();
    const body  = JSON.stringify({ username: 'Scalper Bot v4', ...item });
    try {
      const url = new URL(CFG.discordWebhook);
      const req = https.request({
        hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, () => { this._lastSent = Date.now(); this._sending = false; this._flush(); });
      req.on('error', () => { this._sending = false; this._flush(); });
      req.write(body); req.end();
    } catch { this._sending = false; }
  },

  // Rich embed notification
  notify(title, description, color = 0x00ff9d) {
    this._enqueue({ embeds: [{ title, description, color,
      timestamp: new Date().toISOString(),
      footer: { text: `${CFG.paperTrade ? '📋 PAPER' : '💰 LIVE'} · v4` } }] });
  },

  // 30-minute status report — compact, information-dense
  statusReport() {
    const s = PAPER.getSummary();
    const regimes = CFG.pairs.map(p => {
      const r = REGIME.get(p);
      const icon = r === 'ranging' ? '🟢' : r === 'trending' ? '🔴' : '🟡';
      return `${icon} ${p}`;
    }).join('  ');

    const pnl = parseFloat(s.totalPnl);
    const dpnl = parseFloat(s.dailyPnl);
    const pnlStr = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)}`;
    const dpnlStr = `${dpnl >= 0 ? '+' : ''}$${dpnl.toFixed(4)}`;

    // Weights summary — show which signals are most valued per pair
    const weightLines = CFG.pairs.map(p => {
      const w = WEIGHTS.get(p);
      return `${p}: imb×${w.imbalance.toFixed(2)} flow×${w.flow.toFixed(2)} wall×${w.wall.toFixed(2)}`;
    }).join('\n');

    this.notify('📊 30-Min Status', [
      `**Capital:** $${s.capital}  **P&L:** ${pnlStr} (${s.totalPnlPct}%)`,
      `**Today:** ${dpnlStr}  **WR:** ${s.winRate} (${s.wins}W/${s.losses}L)`,
      `**Trades:** ${s.totalTrades}  **Drawdown:** ${s.maxDrawdown}  **Streak:** ${s.consecutiveLosses}L`,
      `**Session:** ${SESSION.isActive() ? '🟢 active' : '🔴 off-hours'}  **Macro:** ${INTEL.isMacroSafe() ? '✅' : '⚠️'}`,
      `**Regimes:** ${regimes}`,
      `\`\`\`${weightLines}\`\`\``,
    ].join('\n'), pnl >= 0 ? 0x5865f2 : 0xff6b35);
  },
};

// ─── SESSION ───────────────────────────────────────────────────
const SESSION = {
  isActive() {
    if (!CFG.activeSessions?.length) return true;
    const h = new Date().getUTCHours();
    return CFG.activeSessions.some(([s, e]) => h >= s && h < e);
  },
};

// ─── REGIME DETECTION [v4 — dual-timeframe] ────────────────────
// Fast window (default 20 ticks) catches regime quickly.
// Slow window (default 80 ticks) confirms it.
// A pair is only classified TRENDING if BOTH windows agree.
// This prevents a single volatile minute from blocking a pair
// for the next 20 ticks while conditions have already normalised.
const REGIME = {
  data: {},  // { pair: { fast: [], slow: [], fastRegime, slowRegime, confirmed } }

  update(pair, mid) {
    if (!this.data[pair]) this.data[pair] = { fast: [], slow: [], fastRegime: 'warming', slowRegime: 'warming', confirmed: 'warming' };
    const d = this.data[pair];

    d.fast.push(mid); if (d.fast.length > CFG.regimeFastWindow) d.fast.shift();
    d.slow.push(mid); if (d.slow.length > CFG.regimeSlowWindow) d.slow.shift();

    d.fastRegime = this._classify(d.fast, Math.ceil(CFG.regimeFastWindow / 2));
    d.slowRegime = this._classify(d.slow, Math.ceil(CFG.regimeSlowWindow / 2));

    // [v4] Both must agree on trending — one trending + one ranging = ranging (benefit of the doubt)
    if (d.fastRegime === 'trending' && d.slowRegime === 'trending') {
      d.confirmed = 'trending';
    } else if (d.fastRegime === 'warming' || d.slowRegime === 'warming') {
      d.confirmed = 'warming';
    } else {
      d.confirmed = 'ranging';
    }
  },

  _classify(prices, minLen) {
    if (prices.length < minLen) return 'warming';
    let totalMove = 0;
    for (let i = 1; i < prices.length; i++) totalMove += Math.abs(prices[i] - prices[i-1]);
    const atr = totalMove / (prices.length - 1);
    if (atr === 0) return 'ranging';
    const netMove = Math.abs(prices[prices.length - 1] - prices[0]);
    const trendStrength = netMove / (atr * prices.length);
    return trendStrength > CFG.trendingAtrMultiple ? 'trending' : 'ranging';
  },

  get(pair)       { return this.data[pair]?.confirmed || 'warming'; },
  getFast(pair)   { return this.data[pair]?.fastRegime || 'warming'; },
  getSlow(pair)   { return this.data[pair]?.slowRegime || 'warming'; },
  isRanging(pair) { const r = this.get(pair); return r === 'ranging' || r === 'warming'; },
};

// ─── SIGNAL WEIGHTS [v4] ───────────────────────────────────────
// Per-pair learned weights for the three signal components:
// imbalance, trade flow, and wall absence.
// Derived from historical win attribution in the trade log.
// Default is equal weighting (1.0 each). Updated by TUNER.
const WEIGHTS = {
  _store: {},  // { pair: { imbalance, flow, wall } }
  _default: { imbalance: 1.0, flow: 1.0, wall: 1.0 },

  get(pair) {
    return this._store[pair] || { ...this._default };
  },

  set(pair, weights) {
    this._store[pair] = weights;
    L.info(`[WEIGHTS] Updated ${pair}`, weights);
  },

  // Load from overrides file (written by tuner)
  load(stored) {
    if (!stored) return;
    for (const [pair, w] of Object.entries(stored)) {
      this._store[pair] = w;
    }
    L.info('[WEIGHTS] Loaded per-pair weights from overrides', this._store);
  },
};

// Load saved weights if they exist
if (OVERRIDES.pairWeights) WEIGHTS.load(OVERRIDES.pairWeights);

// ─── INTELLIGENCE ──────────────────────────────────────────────
const INTEL = {
  baselines    : {},
  fillAttempts : {},
  fillRates    : {},
  wallSeen     : {},
  spoofActive  : {},
  spoofCooldown: {},
  btcPrices    : [],
  btcMacroTriggered: false,
  btcMacroUntil: 0,
  SPOOF_VANISH_MS  : 2000,
  SPOOF_COOLDOWN_MS: 30000,

  updateBaseline(pair, imbalance, spreadPct) {
    if (!this.baselines[pair]) this.baselines[pair] = { imbalance, spread: spreadPct, n: 0 };
    const b = this.baselines[pair];
    const a = 2 / 201;
    b.imbalance = a * imbalance + (1 - a) * b.imbalance;
    b.spread    = a * spreadPct + (1 - a) * b.spread;
    b.n++;
  },

  adaptiveImbalanceThreshold(pair) {
    const b = this.baselines[pair];
    if (!b || b.n < 50) return CFG.minImbalance;
    return Math.min(0.72, b.imbalance + 0.08);
  },

  spreadIsQuality(pair, spreadPct) {
    const b = this.baselines[pair];
    if (!b || b.n < 50) return spreadPct >= CFG.minSpreadPct;
    return spreadPct >= Math.max(CFG.minSpreadPct, b.spread * 1.2);
  },

  recordFillAttempt(pair) {
    if (!this.fillAttempts[pair]) this.fillAttempts[pair] = { placed: 0, filled: 0 };
    this.fillAttempts[pair].placed++;
    this._recalcFill(pair);
  },

  recordFillSuccess(pair) {
    if (!this.fillAttempts[pair]) this.fillAttempts[pair] = { placed: 0, filled: 0 };
    this.fillAttempts[pair].filled++;
    this._recalcFill(pair);
  },

  _recalcFill(pair) {
    const a = this.fillAttempts[pair];
    this.fillRates[pair] = a.placed > 0 ? a.filled / a.placed : 1;
  },

  pairHasGoodFillRate(pair) {
    const a = this.fillAttempts[pair];
    if (!a || a.placed < 10) return true;
    return this.fillRates[pair] >= CFG.minFillRate;
  },

  trackWall(pair, side, topLevel) {
    if (!topLevel) return;
    const key = `${pair}_${side}`;
    const [price, qty] = topLevel;
    const now = Date.now();
    const prev = this.wallSeen[key];
    if (prev && Math.abs(prev.price - price) < price * 0.0001) {
      this.wallSeen[key].lastSeen = now;
    } else {
      if (prev && (now - prev.firstSeen) < this.SPOOF_VANISH_MS && qty < prev.qty * 0.3) {
        L.warn(`[SPOOF] ${pair} ${side} wall vanished in ${now - prev.firstSeen}ms`);
        this.spoofCooldown[pair] = now + this.SPOOF_COOLDOWN_MS;
        this.spoofActive[pair]   = true;
        Discord.notify('⚠️ Spoof Detected',
          `**${pair}** — ${side} wall vanished in ${now - prev.firstSeen}ms\nPair skipped for 30s`, 0xff6b35);
      }
      this.wallSeen[key] = { price, qty, firstSeen: now, lastSeen: now };
    }
    if (this.spoofActive[pair] && now > (this.spoofCooldown[pair] || 0)) this.spoofActive[pair] = false;
  },

  isSpoofActive(pair) { return !!this.spoofActive[pair]; },

  updateBtcPrice(price) {
    const now = Date.now();
    this.btcPrices.push({ price, ts: now });
    this.btcPrices = this.btcPrices.filter(p => now - p.ts < 60000);
    if (this.btcPrices.length < 5) return;
    const movePct = Math.abs(price - this.btcPrices[0].price) / this.btcPrices[0].price;
    if (movePct > CFG.btcMacroMovePct) {
      if (!this.btcMacroTriggered) {
        L.warn(`[MACRO] BTC moved ${(movePct * 100).toFixed(3)}% in 60s`);
        Discord.notify('🌊 Macro Move Detected',
          `BTC moved **${(movePct * 100).toFixed(3)}%** in 60s\nAll pairs paused for 60s`, 0xff6b35);
      }
      this.btcMacroTriggered = true;
      this.btcMacroUntil = now + 60000;
    } else if (now > this.btcMacroUntil) {
      this.btcMacroTriggered = false;
    }
  },

  isMacroSafe() { return !this.btcMacroTriggered || Date.now() > this.btcMacroUntil; },
};

// ─── AUTO-TUNER [v4 — self-applying] ──────────────────────────
// Analyses trade log, derives better parameters, AND writes them
// to tuner-overrides.json. On next restart those params load
// automatically via cfgVal() at the top of the file.
// Also derives per-pair signal weights from win attribution.
const TUNER = {
  run() {
    try {
      // ── Load all trade history ──
      const files  = fs.readdirSync(logDir).filter(f => f.startsWith('trades-'));
      const trades = [];
      for (const f of files) {
        const lines = fs.readFileSync(path.join(logDir, f), 'utf8').split('\n').filter(Boolean);
        for (const line of lines) { try { trades.push(JSON.parse(line)); } catch {} }
      }

      if (trades.length < 20) {
        const msg = `Not enough data yet (${trades.length}/20 trades). Keep running.`;
        L.info('[TUNER] ' + msg);
        return msg;
      }

      const wins   = trades.filter(t => parseFloat(t.pnl) > 0);
      const losses = trades.filter(t => parseFloat(t.pnl) <= 0);
      const winRate = wins.length / trades.length;
      const avgWin  = wins.length   ? wins.reduce((s,t)   => s + parseFloat(t.pnl), 0) / wins.length   : 0;
      const avgLoss = losses.length ? losses.reduce((s,t) => s + parseFloat(t.pnl), 0) / losses.length : 0;

      // ── [v4] Per-pair signal weight attribution ──
      // For each pair, look at which signal combinations (imbalance-heavy,
      // flow-heavy, wall-heavy) correlated with wins vs losses.
      // We use the trade's stored tag/reasons if present, else use heuristics.
      const newWeights = {};
      for (const pair of CFG.pairs) {
        const pairTrades = trades.filter(t => t.pair === pair);
        if (pairTrades.length < 8) continue; // not enough data for this pair

        const pairWins   = pairTrades.filter(t => parseFloat(t.pnl) > 0);
        const pairLosses = pairTrades.filter(t => parseFloat(t.pnl) <= 0);

        // Proxy: wins in ranging regime suggest imbalance signal is trustworthy
        // Losses in trending regime suggest flow was misleading
        const rangingWins   = pairWins.filter(t => t.regime === 'ranging').length;
        const trendingLosses = pairLosses.filter(t => t.regime === 'trending').length;
        const pairWinRate   = pairWins.length / pairTrades.length;

        // Adjust weights: if pair wins more when ranging, trust imbalance more
        // If pair loses frequently, reduce flow weight (flow can be noisy in bad conditions)
        const imbWeight  = Math.min(1.5, Math.max(0.5, 0.8 + (rangingWins / Math.max(pairTrades.length, 1)) * 0.8));
        const flowWeight = Math.min(1.5, Math.max(0.5, pairWinRate > 0.55 ? 1.1 : 0.75));
        const wallWeight = Math.min(1.5, Math.max(0.5, trendingLosses < pairLosses.length * 0.3 ? 1.1 : 0.85));

        newWeights[pair] = {
          imbalance: parseFloat(imbWeight.toFixed(3)),
          flow     : parseFloat(flowWeight.toFixed(3)),
          wall     : parseFloat(wallWeight.toFixed(3)),
        };
        WEIGHTS.set(pair, newWeights[pair]);
      }

      // ── Derive better session windows from hourly P&L ──
      const byHour = {};
      for (const t of trades) {
        const h = new Date(t.ts).getUTCHours();
        if (!byHour[h]) byHour[h] = { pnl: 0, n: 0 };
        byHour[h].pnl += parseFloat(t.pnl); byHour[h].n++;
      }
      const profitableHours = Object.entries(byHour)
        .filter(([,v]) => v.n >= 3 && v.pnl > 0)
        .sort((a,b) => b[1].pnl - a[1].pnl)
        .map(([h]) => parseInt(h));

      // ── Build parameter suggestions ──
      const suggestedParams = {};
      const notes = [];

      if (winRate < 0.50) {
        suggestedParams.minImbalance   = parseFloat((CFG.minImbalance + 0.03).toFixed(3));
        suggestedParams.signalThreshold = parseFloat((CFG.signalThreshold + 0.05).toFixed(3));
        notes.push(`Win rate low (${(winRate*100).toFixed(1)}%) → raised minImbalance + signalThreshold`);
      } else if (winRate > 0.68) {
        suggestedParams.signalThreshold = parseFloat((CFG.signalThreshold - 0.04).toFixed(3));
        notes.push(`Win rate high (${(winRate*100).toFixed(1)}%) → lowered signalThreshold to catch more setups`);
      }

      if (avgLoss !== 0 && Math.abs(avgLoss) > avgWin * 1.5) {
        suggestedParams.stopLossPct = parseFloat((CFG.stopLossPct * 0.8).toFixed(5));
        notes.push(`Loss/win ratio poor → tightened stopLossPct to ${suggestedParams.stopLossPct}`);
      }

      if (profitableHours.length >= 3) {
        const sessions = this._hoursToSessions(profitableHours);
        suggestedParams.activeSessions = sessions;
        notes.push(`Best hours: ${profitableHours.join(',')}h UTC → updated activeSessions`);
      }

      // ── Identify losing pairs to flag ──
      const byPair = {};
      for (const t of trades) {
        if (!byPair[t.pair]) byPair[t.pair] = { pnl: 0, n: 0 };
        byPair[t.pair].pnl += parseFloat(t.pnl); byPair[t.pair].n++;
      }
      const losingPairs = Object.entries(byPair).filter(([,v]) => v.n >= 5 && v.pnl < 0).map(([p]) => p);
      if (losingPairs.length) notes.push(`Losing pairs: ${losingPairs.join(', ')} — consider removing from PAIRS`);

      // ── Self-apply: write overrides file ──
      const overrideData = {
        ts        : ts(),
        appliedAt : ts(),
        winRate   : parseFloat((winRate * 100).toFixed(2)),
        tradeCount: trades.length,
        notes,
        params    : suggestedParams,
        pairWeights: newWeights,
      };

      try {
        fs.writeFileSync(overrideFile, JSON.stringify(overrideData, null, 2));
        L.info('[TUNER] Overrides written to', { file: overrideFile });
      } catch (e) {
        L.warn('[TUNER] Could not write overrides file', { msg: e.message });
      }

      // ── Format Discord summary ──
      const weightSummary = Object.entries(newWeights)
        .map(([p,w]) => `${p}: imb×${w.imbalance} flow×${w.flow} wall×${w.wall}`)
        .join('\n');

      const result = [
        `**${trades.length} trades | WR: ${(winRate*100).toFixed(1)}% | Avg win: $${avgWin.toFixed(5)} | Avg loss: $${avgLoss.toFixed(5)}**`,
        notes.length ? '\n**Applied changes:**\n' + notes.map(n => `• ${n}`).join('\n') : '\n✅ No parameter changes needed',
        Object.keys(newWeights).length ? `\n**Updated signal weights:**\n\`\`\`${weightSummary}\`\`\`` : '',
        '\n_Params written to overrides file. Restart bot to apply session changes._',
      ].join('\n');

      L.info('[TUNER] Complete', { winRate, notes });
      Discord.notify('🔧 Auto-Tune Complete', result, 0x57f287);
      return result;

    } catch (e) {
      L.error('[TUNER] Error', { msg: e.message });
      return `Tuner error: ${e.message}`;
    }
  },

  _hoursToSessions(hours) {
    const sorted = [...new Set(hours)].sort((a,b) => a-b);
    const sessions = [];
    let start = sorted[0], prev = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      if (i === sorted.length || sorted[i] > prev + 2) {
        sessions.push([start, prev + 1]);
        if (i < sorted.length) { start = sorted[i]; prev = sorted[i]; }
      } else prev = sorted[i];
    }
    return sessions;
  },
};

// ─── MARKET DATA ───────────────────────────────────────────────
const MARKET = {
  tickers: {}, books: {}, trades: {}, ready: false, ws: null, listeners: [],

  subscribe(fn) { this.listeners.push(fn); },
  _notify(pair) { this.listeners.forEach(fn => fn(pair)); },

  connect() {
    const streams = CFG.pairs.flatMap(p => {
      const s = p.toLowerCase();
      return [`${s}@bookTicker`, `${s}@depth5@100ms`, `${s}@trade`];
    });
    L.info('Connecting to Binance WebSocket...');
    this.ws = new WebSocket(`${CFG.wsBase}?streams=${streams.join('/')}`);
    this.ws.on('open',    () => { L.info('WebSocket connected'); this.ready = true; });
    this.ws.on('message', (raw) => { try { const { stream, data } = JSON.parse(raw); this._handle(stream, data); } catch {} });
    this.ws.on('error',   (e)   => L.error('WS error', { msg: e.message }));
    this.ws.on('close',   ()    => {
      L.warn('WS closed — reconnect in 3s'); this.ready = false;
      setTimeout(() => this.connect(), 3000);
    });
    setInterval(() => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping(); }, 20000);
  },

  _handle(stream, data) {
    if (!stream || !data) return;

    if (stream.endsWith('@bookTicker')) {
      const pair = data.s;
      const bid = parseFloat(data.b), ask = parseFloat(data.a);
      const mid = (bid + ask) / 2;
      this.tickers[pair] = { bid, ask, mid, spread: ask - bid, spreadPct: (ask - bid) / ask, ts: Date.now() };
      if (pair === 'BTCUSDT') INTEL.updateBtcPrice(bid);
      INTEL.updateBaseline(pair, this.getImbalance(pair), this.tickers[pair].spreadPct);
      REGIME.update(pair, mid);
      this._notify(pair);

    } else if (stream.includes('@depth5')) {
      const pair = stream.split('@')[0].toUpperCase();
      const bids = data.bids.map(([p,q]) => [parseFloat(p), parseFloat(q)]);
      const asks = data.asks.map(([p,q]) => [parseFloat(p), parseFloat(q)]);
      this.books[pair] = { bids, asks, ts: Date.now() };
      if (bids.length) INTEL.trackWall(pair, 'bid', bids[0]);
      if (asks.length) INTEL.trackWall(pair, 'ask', asks[0]);

    } else if (stream.endsWith('@trade')) {
      const pair = data.s;
      if (!this.trades[pair]) this.trades[pair] = [];
      this.trades[pair].push({ price: parseFloat(data.p), qty: parseFloat(data.q), isBuy: !data.m, ts: data.T });
      if (this.trades[pair].length > 60) this.trades[pair].shift();
    }
  },

  getTicker(pair) { return this.tickers[pair] || null; },
  getBook(pair)   { return this.books[pair]   || null; },

  getImbalance(pair, levels = 3) {
    const book = this.books[pair];
    if (!book) return 0.5;
    const bidVol = book.bids.slice(0, levels).reduce((s,[,q]) => s+q, 0);
    const askVol = book.asks.slice(0, levels).reduce((s,[,q]) => s+q, 0);
    const total  = bidVol + askVol;
    return total > 0 ? bidVol / total : 0.5;
  },

  getTradeFlow(pair, n = 20) {
    const trades = (this.trades[pair] || []).slice(-n);
    if (!trades.length) return { buyPct: 0.5, buyCnt: 0, sellCnt: 0 };
    const buys = trades.filter(t => t.isBuy).length;
    return { buyPct: buys / trades.length, buyCnt: buys, sellCnt: trades.length - buys };
  },

  hasSuspiciousWall(pair, side = 'ask') {
    const book = this.books[pair];
    if (!book) return false;
    const levels = side === 'ask' ? book.asks : book.bids;
    if (levels.length < 3) return false;
    const avg = (levels[1][1] + levels[2][1]) / 2;
    return avg > 0 && levels[0][1] / avg > 8;
  },

  exitSideIsLiquid(pair, exitSide, qty) {
    const book = this.books[pair];
    if (!book) return true;
    const levels = exitSide === 'ask' ? book.asks : book.bids;
    const available = levels.slice(0, 3).reduce((s,[,q]) => s+q, 0);
    return available >= qty * CFG.minExitSideDepth;
  },
};

// ─── PAPER ENGINE ──────────────────────────────────────────────
const PAPER = {
  capital: CFG.paperCapital, startCap: CFG.paperCapital,
  positions: {}, orders: {}, fills: [], nextId: 1000,
  stats: {
    totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, dailyPnl: 0,
    consecutiveLosses: 0, maxDrawdown: 0, peakCapital: CFG.paperCapital,
    startTime: Date.now(),
  },

  _id() { return `P-${this.nextId++}`; },

  placeOrder({ pair, side, price, qty, tag = '' }) {
    const id = this._id();
    this.orders[id] = { id, pair, side, price, qty, tag, status: 'PENDING', ts: Date.now(), activeAt: Date.now() + CFG.paperLatencyMs };
    INTEL.recordFillAttempt(pair);
    L.info(`[ORDER] ${side} ${pair} @ ${price.toFixed(6)} qty:${qty}`, { id, tag });
    return id;
  },

  cancelOrder(id) { if (this.orders[id]) this.orders[id].status = 'CANCELLED'; },

  processTick(pair, ticker) {
    const { bid, ask } = ticker;
    const now = Date.now();
    for (const [, o] of Object.entries(this.orders)) {
      if (o.pair !== pair || ['CANCELLED','FILLED','EXPIRED','REJECTED'].includes(o.status)) continue;
      if (now < o.activeAt) continue;
      if (o.status === 'PENDING') o.status = 'OPEN';
      if (now - o.ts > CFG.staleOrderMs) { o.status = 'EXPIRED'; continue; }
      const filled = (o.side === 'BUY' && ask <= o.price) || (o.side === 'SELL' && bid >= o.price);
      if (filled) { o.status = 'FILLED'; this._onFill(o); }
    }
  },

  _onFill(o) {
    const { pair, side, price, qty } = o;
    const fee = price * qty * 0.00075;
    this.fills.push(o);
    this.stats.totalTrades++;
    INTEL.recordFillSuccess(pair);

    if (side === 'BUY') {
      const cost = price * qty + fee;
      if (this.capital < cost) { o.status = 'REJECTED'; return; }
      this.capital -= cost;
      this.positions[pair] = { side: 'LONG', qty, entryPrice: price, openedAt: Date.now() };
      L.info(`[FILL] BUY  ${pair} @ ${price.toFixed(6)} cost:$${cost.toFixed(4)}`);

    } else if (side === 'SELL') {
      const pos = this.positions[pair];
      if (!pos) return;
      const revenue = price * qty - fee;
      const pnl     = revenue - pos.entryPrice * qty;
      this.capital += revenue;
      this.stats.totalPnl  += pnl;
      this.stats.dailyPnl  += pnl;
      delete this.positions[pair];

      if (pnl > 0) { this.stats.wins++; this.stats.consecutiveLosses = 0; }
      else          { this.stats.losses++; this.stats.consecutiveLosses++; }

      if (this.capital > this.stats.peakCapital) this.stats.peakCapital = this.capital;
      const dd = (this.stats.peakCapital - this.capital) / this.stats.peakCapital;
      if (dd > this.stats.maxDrawdown) this.stats.maxDrawdown = dd;

      L.trade({ pair, side, entryPrice: pos.entryPrice, exitPrice: price, qty,
        pnl: pnl.toFixed(5), fee: fee.toFixed(5), capital: this.capital.toFixed(2),
        regime: REGIME.get(pair), tag: o.tag });

      // Notify Discord on trade close — wins and losses both
      Discord.notify(
        `${pnl > 0 ? '✅' : '❌'} ${pair} Trade Closed`,
        `**${side}** | Entry \`${pos.entryPrice.toFixed(6)}\` → Exit \`${price.toFixed(6)}\`\n` +
        `P&L: **${pnl >= 0 ? '+' : ''}$${pnl.toFixed(5)}** | Fee: $${fee.toFixed(5)}\n` +
        `Capital: $${this.capital.toFixed(2)} | Regime: ${REGIME.get(pair)} | Tag: ${o.tag}`,
        pnl > 0 ? 0x00ff9d : 0xff4757,
      );
    }
  },

  getPosition(pair)   { return this.positions[pair] || null; },
  hasOpenOrder(pair)  { return Object.values(this.orders).some(o => o.pair === pair && ['OPEN','PENDING'].includes(o.status)); },
  getOpenOrders(pair) { return Object.values(this.orders).filter(o => o.pair === pair && ['OPEN','PENDING'].includes(o.status)); },

  getSummary() {
    const elapsed = (Date.now() - this.stats.startTime) / 3600000;
    const total   = this.stats.wins + this.stats.losses;
    return {
      capital: this.capital.toFixed(2), startCapital: this.startCap.toFixed(2),
      totalPnl: this.stats.totalPnl.toFixed(5), totalPnlPct: ((this.stats.totalPnl / this.startCap) * 100).toFixed(3),
      dailyPnl: this.stats.dailyPnl.toFixed(5), totalTrades: this.stats.totalTrades,
      wins: this.stats.wins, losses: this.stats.losses,
      winRate: total > 0 ? `${(this.stats.wins / total * 100).toFixed(1)}%` : '0.0%',
      consecutiveLosses: this.stats.consecutiveLosses,
      maxDrawdown: `${(this.stats.maxDrawdown * 100).toFixed(2)}%`,
      elapsedHours: elapsed.toFixed(2),
    };
  },

  resetDailyPnl() { this.stats.dailyPnl = 0; },
};

// ─── RISK ──────────────────────────────────────────────────────
const RISK = {
  halted: false, haltReason: '', spreadHist: {}, lastResetDay: new Date().toDateString(),

  isHalted() { return this.halted; },

  halt(reason) {
    if (this.halted) return;
    this.halted = true; this.haltReason = reason;
    L.warn(`[RISK] HALTED: ${reason}`);
    Discord.notify('🛑 Trading Halted', reason, 0xff4757);
  },

  resume() { this.halted = false; this.haltReason = ''; L.info('[RISK] Resumed'); },

  checkGlobal() {
    const today_ = new Date().toDateString();
    if (today_ !== this.lastResetDay) { PAPER.resetDailyPnl(); this.lastResetDay = today_; }
    if (PAPER.stats.consecutiveLosses >= CFG.maxConsecLosses) {
      this.halt(`${CFG.maxConsecLosses} consecutive losses hit`); return false;
    }
    if (PAPER.stats.dailyPnl < -CFG.maxDailyLossUSD) {
      this.halt(`Daily loss limit: $${PAPER.stats.dailyPnl.toFixed(2)}`); return false;
    }
    return true;
  },

  checkPair(pair, ticker) {
    if (this.halted)                                    return { ok: false, reason: 'halted' };
    if (!ticker)                                        return { ok: false, reason: 'no data' };
    if (Date.now() - ticker.ts > 3000)                  return { ok: false, reason: 'stale data' };
    if (!SESSION.isActive())                            return { ok: false, reason: 'off-hours' };
    if (!INTEL.isMacroSafe())                           return { ok: false, reason: 'BTC macro move' };
    if (INTEL.isSpoofActive(pair))                      return { ok: false, reason: 'spoof cooldown' };
    if (!INTEL.pairHasGoodFillRate(pair))               return { ok: false, reason: `fill rate ${(INTEL.fillRates[pair]*100||0).toFixed(0)}%` };
    if (!INTEL.spreadIsQuality(pair, ticker.spreadPct)) return { ok: false, reason: 'spread below adaptive baseline' };
    if (this._spreadAbnormal(pair, ticker.spreadPct))   return { ok: false, reason: 'abnormal spread spike' };
    if (!REGIME.isRanging(pair))                        return { ok: false, reason: 'both timeframes trending' };

    let totalExposure = 0;
    for (const p of CFG.pairs) {
      const pos = PAPER.getPosition(p); const t = MARKET.getTicker(p);
      if (pos && t) totalExposure += pos.qty * t.bid;
    }
    if (totalExposure > CFG.maxTotalExposureUSD) return { ok: false, reason: 'exposure limit' };
    return { ok: true };
  },

  _spreadAbnormal(pair, spreadPct) {
    if (!this.spreadHist[pair]) this.spreadHist[pair] = [];
    this.spreadHist[pair].push(spreadPct);
    if (this.spreadHist[pair].length > 30) this.spreadHist[pair].shift();
    if (this.spreadHist[pair].length < 10) return false;
    const avg = this.spreadHist[pair].reduce((a,b) => a+b, 0) / this.spreadHist[pair].length;
    return spreadPct > avg * 4;
  },

  calcQty(price) {
    const maxUSD = Math.min(CFG.maxPositionUSD, PAPER.capital * 0.2);
    return parseFloat((maxUSD / price).toFixed(6));
  },
};

// ─── SIGNALS [v4 — per-pair learned weights] ───────────────────
const SIGNALS = {
  scoreAll(pairs) {
    const sorted = [...pairs].sort((a,b) => (INTEL.fillRates[b]||1) - (INTEL.fillRates[a]||1));
    const best = sorted.map(p => this.scorePair(p)).filter(Boolean).sort((a,b) => b.score - a.score);
    return best[0] || null;
  },

  scorePair(pair) {
    const ticker = MARKET.getTicker(pair);
    const book   = MARKET.getBook(pair);
    if (!ticker || !book)                                    return null;
    if (PAPER.getPosition(pair) || PAPER.hasOpenOrder(pair)) return null;

    const imbalance   = MARKET.getImbalance(pair, 3);
    const flow        = MARKET.getTradeFlow(pair, 20);
    const hasSellWall = MARKET.hasSuspiciousWall(pair, 'ask');
    const hasBuyWall  = MARKET.hasSuspiciousWall(pair, 'bid');
    const adaptiveMin = INTEL.adaptiveImbalanceThreshold(pair);
    const adaptiveMax = 1 - adaptiveMin;

    // [v4] Apply per-pair learned weights
    const W = WEIGHTS.get(pair);

    const spreadBonus = INTEL.spreadIsQuality(pair, ticker.spreadPct)
      ? Math.min(ticker.spreadPct / CFG.minSpreadPct - 1, 0.3) : 0;

    // Long score — each component multiplied by its learned weight
    let lScore = 0, lReasons = [];
    if (imbalance > adaptiveMin) {
      const contrib = (imbalance - 0.5) * 4 * W.imbalance;
      lScore += contrib;
      lReasons.push(`imbalance ${(imbalance*100).toFixed(1)}% ×${W.imbalance.toFixed(2)}`);
    }
    if (flow.buyPct > 0.6) {
      const contrib = (flow.buyPct - 0.5) * 2 * W.flow;
      lScore += contrib;
      lReasons.push(`buy flow ${(flow.buyPct*100).toFixed(0)}% ×${W.flow.toFixed(2)}`);
    }
    if (!hasSellWall) { lScore += 0.1 * W.wall; lReasons.push('no sell wall'); }
    else                lScore -= 0.3;
    lScore += spreadBonus;

    // Short score
    let sScore = 0, sReasons = [];
    if (imbalance < adaptiveMax) {
      const contrib = (0.5 - imbalance) * 4 * W.imbalance;
      sScore += contrib;
      sReasons.push(`imbalance ${(imbalance*100).toFixed(1)}% ×${W.imbalance.toFixed(2)}`);
    }
    if (flow.buyPct < 0.4) {
      const contrib = (0.5 - flow.buyPct) * 2 * W.flow;
      sScore += contrib;
      sReasons.push(`sell flow ${((1-flow.buyPct)*100).toFixed(0)}% ×${W.flow.toFixed(2)}`);
    }
    if (!hasBuyWall) { sScore += 0.1 * W.wall; sReasons.push('no buy wall'); }
    else               sScore -= 0.3;
    sScore += spreadBonus;

    const side    = lScore > sScore ? 'BUY' : 'SELL';
    const score   = side === 'BUY' ? lScore : sScore;
    const reasons = side === 'BUY' ? lReasons : sReasons;

    if (score < CFG.signalThreshold) return null;

    return { pair, side, score, reasons, ticker, imbalance, flow,
      adaptiveThreshold: adaptiveMin, fillRate: INTEL.fillRates[pair],
      regime: REGIME.get(pair), fastRegime: REGIME.getFast(pair), slowRegime: REGIME.getSlow(pair),
      weights: W };
  },
};

// ─── REPORT ────────────────────────────────────────────────────
function generateReport() {
  try {
    const files  = fs.readdirSync(logDir).filter(f => f.startsWith('trades-'));
    const trades = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(logDir, f), 'utf8').split('\n').filter(Boolean);
      for (const line of lines) { try { trades.push(JSON.parse(line)); } catch {} }
    }
    if (!trades.length) return 'No trade data yet.';
    let totalPnl = 0, wins = 0, losses = 0;
    const byDay = {};
    for (const t of trades) {
      const day = String(t.ts).slice(0, 10); const pnl = parseFloat(t.pnl || 0);
      if (!byDay[day]) byDay[day] = { pnl: 0, trades: 0 };
      byDay[day].pnl += pnl; byDay[day].trades++; totalPnl += pnl;
      if (pnl > 0) wins++; else losses++;
    }
    const total = wins + losses, days = Object.keys(byDay).length;
    const winRate = total > 0 ? (wins / total * 100).toFixed(1) : '0';
    const checks = [
      { name: 'Win rate ≥ 52%',   pass: parseFloat(winRate) >= 52 },
      { name: 'Total P&L > $0',   pass: totalPnl > 0 },
      { name: '≥ 50 trades',      pass: total >= 50 },
      { name: '≥ 7 days of data', pass: days >= 7 },
    ];
    const passed = checks.filter(c => c.pass).length;
    return [
      `**${days}d | ${total} trades | WR: ${winRate}% | P&L: ${totalPnl>=0?'+':''}$${totalPnl.toFixed(4)}**`,
      checks.map(c => `${c.pass?'✓':'✗'} ${c.name}`).join('\n'),
      passed === checks.length ? '✅ **GO** — start live at 10% capital'
        : passed >= 3 ? '⚠️ **BORDERLINE** — run another week' : '❌ **NO-GO** — tune parameters',
    ].join('\n\n');
  } catch (e) { return 'Error: ' + e.message; }
}

// ─── MAIN BOT ──────────────────────────────────────────────────
const BOT = {
  running: false, tickCount: 0, lastSignal: null, lastAction: null, status: 'starting',

  start() {
    L.info(`Bot v4 | mode:${CFG.paperTrade?'PAPER':'LIVE'} | capital:$${CFG.paperCapital}`);
    L.info(`Sessions (UTC): ${CFG.activeSessions.map(([s,e])=>`${s}–${e}`).join(', ')}`);
    L.info(`Regime: fast=${CFG.regimeFastWindow} slow=${CFG.regimeSlowWindow} atrMult=${CFG.trendingAtrMultiple}`);
    L.info(`AutoTune: every ${CFG.autoTuneIntervalHrs}h | Overrides loaded: ${Object.keys(OVERRIDES.params||{}).length} params`);

    MARKET.connect();
    MARKET.subscribe((pair) => { const t = MARKET.getTicker(pair); if (t) PAPER.processTick(pair, t); });

    setTimeout(() => {
      this.running = true; this.status = 'running';
      L.info('Loop started');
      Discord.notify('🟢 Scalper Bot v4 Started',
        `Mode: **${CFG.paperTrade?'PAPER':'LIVE'}** | Capital: **$${CFG.paperCapital}**\n` +
        `Sessions: ${CFG.activeSessions.map(([s,e])=>`${s}:00–${e}:00 UTC`).join(', ')}\n` +
        `Regime: dual-timeframe (fast:${CFG.regimeFastWindow} / slow:${CFG.regimeSlowWindow})\n` +
        `Overrides applied: ${Object.keys(OVERRIDES.params||{}).join(', ') || 'none'}\n` +
        `Next tune: in ${CFG.autoTuneIntervalHrs}h`,
        0x00ff9d);
      this._loop();
    }, 3000);

    // 30-min status to Discord
    setInterval(() => Discord.statusReport(), 30 * 60 * 1000);

    // 5-min local log summary
    setInterval(() => L.info('5m summary', PAPER.getSummary()), 5 * 60 * 1000);

    // Auto-tuner
    if (CFG.autoTuneIntervalHrs > 0) {
      setInterval(() => {
        L.info('[TUNER] Running scheduled tune...');
        TUNER.run();
      }, CFG.autoTuneIntervalHrs * 3600 * 1000);
    }

    // Daily report to Discord at midnight UTC
    setInterval(() => {
      const h = new Date().getUTCHours(), m = new Date().getUTCMinutes();
      if (h === 0 && m < 5) {
        Discord.notify('📅 Daily Report', generateReport(), 0x00b4d8);
      }
    }, 5 * 60 * 1000); // check every 5 min, fire once at midnight
  },

  async _loop() {
    if (!this.running) return;
    try { await this._tick(); } catch (e) { L.error('Loop error', { msg: e.message }); }
    setTimeout(() => this._loop(), 200);
  },

  async _tick() {
    if (!MARKET.ready) return;
    this.tickCount++;
    if (!RISK.checkGlobal()) { this.status = `halted: ${RISK.haltReason}`; return; }
    this.status = SESSION.isActive() ? 'running' : 'off-hours';

    for (const pair of CFG.pairs) this._managePosition(pair);

    for (const pair of CFG.pairs)
      for (const o of PAPER.getOpenOrders(pair))
        if (Date.now() - o.ts > CFG.staleOrderMs) PAPER.cancelOrder(o.id);

    if (SESSION.isActive() && INTEL.isMacroSafe()) {
      const best = SIGNALS.scoreAll(CFG.pairs);
      if (best) { this.lastSignal = best; this._enter(best); }
    }
  },

  _managePosition(pair) {
    const pos    = PAPER.getPosition(pair); if (!pos) return;
    const ticker = MARKET.getTicker(pair);  if (!ticker) return;
    const { bid } = ticker;
    const tp = pos.entryPrice * (1 + CFG.takeProfitPct);
    const sl = pos.entryPrice * (1 - CFG.stopLossPct);
    const openOrders = PAPER.getOpenOrders(pair);

    // TP — only if exit side has adequate depth
    if (!openOrders.some(o => o.tag === 'tp') && MARKET.exitSideIsLiquid(pair, 'ask', pos.qty))
      PAPER.placeOrder({ pair, side: 'SELL', price: tp, qty: pos.qty, tag: 'tp' });

    // Hard stop
    if (!openOrders.some(o => o.tag === 'sl') && bid < sl) {
      L.warn(`[SL] Stop loss ${pair}`, { bid, sl });
      PAPER.placeOrder({ pair, side: 'SELL', price: bid, qty: pos.qty, tag: 'sl' });
      Discord.notify('⚠️ Stop Loss Hit',
        `**${pair}** | Entry: \`${pos.entryPrice.toFixed(6)}\` | Stop: \`${sl.toFixed(6)}\`\nCapital: $${PAPER.capital.toFixed(2)}`, 0xff6b35);
      return;
    }

    // Smart exit — structure flipped
    const imbalance = MARKET.getImbalance(pair, 3);
    const flow      = MARKET.getTradeFlow(pair, 10);
    const posAge    = Date.now() - pos.openedAt;

    if (posAge > 2000 && pos.side === 'LONG') {
      const structureGone  = imbalance < 0.45 && flow.buyPct < 0.35;
      const canExitCleanly = MARKET.exitSideIsLiquid(pair, 'ask', pos.qty);

      if (structureGone && canExitCleanly && !openOrders.some(o => o.tag === 'early-exit')) {
        openOrders.filter(o => o.tag === 'tp').forEach(o => PAPER.cancelOrder(o.id));
        PAPER.placeOrder({ pair, side: 'SELL', price: bid, qty: pos.qty, tag: 'early-exit' });
        L.warn(`[SMART EXIT] ${pair} — structure gone`, { imbalance, buyPct: flow.buyPct });
      } else if (structureGone && !canExitCleanly) {
        const tightenedSl = pos.entryPrice * (1 - CFG.stopLossPct * 0.5);
        if (bid < tightenedSl && !openOrders.some(o => o.tag === 'sl-tight'))
          PAPER.placeOrder({ pair, side: 'SELL', price: bid, qty: pos.qty, tag: 'sl-tight' });
      }
    }
  },

  _enter(signal) {
    const { pair, side, score, reasons, ticker } = signal;
    const check = RISK.checkPair(pair, ticker);
    if (!check.ok) return;

    const price = side === 'BUY'
      ? ticker.bid + ticker.spread * 0.1
      : ticker.ask - ticker.spread * 0.1;

    const qty = RISK.calcQty(price);
    if (qty <= 0) return;

    PAPER.placeOrder({ pair, side, price, qty, tag: 'entry' });
    this.lastAction = { time: ts(), pair, side, price, qty, score: score.toFixed(3), reasons };
    L.info(`[ENTRY] ${side} ${pair} @ ${price.toFixed(6)} score:${score.toFixed(3)} regime:${REGIME.get(pair)}`);
  },

  getSummary() {
    return {
      ...PAPER.getSummary(),
      status: this.status, lastSignal: this.lastSignal, lastAction: this.lastAction,
      mode: CFG.paperTrade ? 'PAPER' : 'LIVE', halted: RISK.isHalted(), haltReason: RISK.haltReason,
      tickCount: this.tickCount, inSession: SESSION.isActive(), macroSafe: INTEL.isMacroSafe(),
      fillRates : INTEL.fillRates, spoofActive: INTEL.spoofActive,
      regimes   : Object.fromEntries(CFG.pairs.map(p => [p, { confirmed: REGIME.get(p), fast: REGIME.getFast(p), slow: REGIME.getSlow(p) }])),
      baselines : Object.fromEntries(Object.entries(INTEL.baselines).map(([p,b]) => [p, { imb: b.imbalance.toFixed(3), sprd: b.spread.toFixed(6), n: b.n }])),
      weights   : Object.fromEntries(CFG.pairs.map(p => [p, WEIGHTS.get(p)])),
      overridesActive: Object.keys(OVERRIDES.params || {}).length > 0,
    };
  },
};

// ─── DASHBOARD ─────────────────────────────────────────────────
http.createServer((req, res) => {
  if (req.url === '/api/status') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(JSON.stringify(BOT.getSummary()));
  }

  res.setHeader('Content-Type', 'text/html');
  res.end(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scalper v4</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  :root{--bg:#0a0a0f;--s:#111118;--b:#1e1e2e;--g:#00ff9d;--r:#ff4757;--y:#ffd93d;--o:#ff6b35;--p:#9b59b6;--t:#e2e2f0;--m:#6b6b8a}
  body{background:var(--bg);color:var(--t);font-family:'JetBrains Mono',monospace;padding:20px;min-height:100vh}
  header{display:flex;justify-content:space-between;align-items:center;padding-bottom:14px;border-bottom:1px solid var(--b);margin-bottom:16px}
  .logo{color:var(--g);font-size:.95rem;letter-spacing:.08em}
  .badge{padding:3px 12px;border-radius:20px;font-size:.68rem;letter-spacing:.1em}
  .paper{background:rgba(0,255,157,.1);color:var(--g);border:1px solid rgba(0,255,157,.3)}
  .live{background:rgba(255,71,87,.1);color:var(--r);border:1px solid rgba(255,71,87,.3)}
  .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:5px}
  .dg{background:var(--g);box-shadow:0 0 5px var(--g);animation:p 2s infinite}
  .dr{background:var(--r)}.dy{background:var(--y)}.do{background:var(--o)}
  @keyframes p{0%,100%{opacity:1}50%{opacity:.3}}
  .bar{background:rgba(0,255,157,.04);border:1px solid rgba(0,255,157,.12);border-radius:8px;padding:8px 14px;margin-bottom:12px;font-size:.7rem;display:flex;gap:18px;flex-wrap:wrap;align-items:center}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;margin-bottom:12px}
  .card{background:var(--s);border:1px solid var(--b);border-radius:10px;padding:14px}
  .cl{font-size:.62rem;text-transform:uppercase;letter-spacing:.12em;color:var(--m);margin-bottom:6px}
  .cv{font-size:1.3rem;font-weight:700}.cs{font-size:.7rem;color:var(--m);margin-top:4px}
  .pos{color:var(--g)}.neg{color:var(--r)}.warn{color:var(--y)}.ora{color:var(--o)}.pur{color:var(--p)}
  .sec{background:var(--s);border:1px solid var(--b);border-radius:10px;padding:14px;margin-bottom:10px}
  .st{font-size:.62rem;text-transform:uppercase;letter-spacing:.12em;color:var(--m);margin-bottom:10px}
  .sg{display:grid;grid-template-columns:1fr 1fr;gap:5px;font-size:.75rem}
  .sk{color:var(--m)}.sv{color:var(--t)}
  .tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
  .tag{background:rgba(0,255,157,.07);border:1px solid rgba(0,255,157,.2);color:var(--g);padding:2px 8px;border-radius:20px;font-size:.65rem}
  .halt{background:rgba(255,71,87,.1);border:1px solid rgba(255,71,87,.4);color:var(--r);border-radius:8px;padding:10px;margin-bottom:12px;display:none;font-size:.8rem}
  .pgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px}
  .pc{background:rgba(255,255,255,.02);border:1px solid var(--b);border-radius:8px;padding:10px;font-size:.7rem}
  .pn{font-weight:700;margin-bottom:5px;font-size:.78rem}
  .pr{display:flex;justify-content:space-between;color:var(--m);margin-top:3px}
  .pv{color:var(--t)}
  .upd{font-size:.62rem;color:var(--m);text-align:right;margin-top:10px}
</style></head><body>
<header>
  <div class="logo">⟨ MAKER SCALPER v4 ⟩</div>
  <div style="display:flex;align-items:center;gap:10px">
    <span id="si"><span class="dot dy"></span>Connecting...</span>
    <span id="mb" class="badge paper">PAPER</span>
  </div>
</header>
<div id="hb" class="halt">🛑 HALTED — <span id="hr"></span></div>
<div class="bar">
  <span><span class="dot" id="sd"></span><span id="st2">Session —</span></span>
  <span><span class="dot" id="md"></span><span id="mt">Macro —</span></span>
  <span id="tkt">Ticks —</span>
  <span id="ovr" style="color:var(--y)"></span>
</div>
<div class="grid">
  <div class="card"><div class="cl">Capital</div><div class="cv" id="cap">—</div><div class="cs" id="scap">—</div></div>
  <div class="card"><div class="cl">Total P&L</div><div class="cv" id="tpnl">—</div><div class="cs" id="tpnlp">—</div></div>
  <div class="card"><div class="cl">Today P&L</div><div class="cv" id="dpnl">—</div></div>
  <div class="card"><div class="cl">Win Rate</div><div class="cv" id="wr">—</div><div class="cs" id="wrc">—</div></div>
  <div class="card"><div class="cl">Trades</div><div class="cv" id="tt">—</div><div class="cs" id="el">—</div></div>
  <div class="card"><div class="cl">Max Drawdown</div><div class="cv" id="dd">—</div><div class="cs">Streak: <span id="str">—</span></div></div>
</div>
<div class="sec">
  <div class="st">Pair Intelligence — Regime · Fill Rate · Signal Weights</div>
  <div class="pgrid" id="pg"></div>
</div>
<div class="sec">
  <div class="st">Last Signal</div>
  <div class="sg">
    <span class="sk">Pair</span><span class="sv" id="sp">—</span>
    <span class="sk">Side</span><span class="sv" id="ss">—</span>
    <span class="sk">Score</span><span class="sv" id="sc">—</span>
    <span class="sk">Fast regime</span><span class="sv" id="sfr2">—</span>
    <span class="sk">Slow regime</span><span class="sv" id="ssr">—</span>
    <span class="sk">Imbalance</span><span class="sv" id="si2">—</span>
    <span class="sk">Adaptive Thr</span><span class="sv" id="sat">—</span>
    <span class="sk">Buy Flow</span><span class="sv" id="sf">—</span>
    <span class="sk">Fill Rate</span><span class="sv" id="sfr">—</span>
  </div>
  <div class="tags" id="rs"></div>
</div>
<div class="sec">
  <div class="st">Last Action</div>
  <div class="sg">
    <span class="sk">Time</span><span class="sv" id="at">—</span>
    <span class="sk">Pair</span><span class="sv" id="ap">—</span>
    <span class="sk">Side</span><span class="sv" id="as2">—</span>
    <span class="sk">Price</span><span class="sv" id="apr">—</span>
    <span class="sk">Score</span><span class="sv" id="asco">—</span>
  </div>
</div>
<div class="upd">Auto-refresh 2s · <span id="lu">—</span></div>
<script>
const PAIRS=${JSON.stringify(CFG.pairs)};
const RC={ranging:'var(--g)',trending:'var(--r)',warming:'var(--y)'};
async function refresh(){
  try{
    const d=await(await fetch('/api/status')).json();
    document.getElementById('lu').textContent=new Date().toLocaleTimeString();
    const mb=document.getElementById('mb');mb.className='badge '+(d.mode==='PAPER'?'paper':'live');mb.textContent=d.mode;
    document.getElementById('si').innerHTML=\`<span class="dot \${d.halted?'dr':d.inSession?'dg':'do'}"></span>\${d.status}\`;
    document.getElementById('hb').style.display=d.halted?'block':'none';
    document.getElementById('hr').textContent=d.haltReason||'';
    document.getElementById('sd').style.background=d.inSession?'var(--g)':'var(--o)';
    document.getElementById('st2').textContent='Session: '+(d.inSession?'🟢 active':'🔴 off-hours');
    document.getElementById('md').style.background=d.macroSafe?'var(--g)':'var(--r)';
    document.getElementById('mt').textContent='Macro: '+(d.macroSafe?'✅ clear':'⚠️ triggered');
    document.getElementById('tkt').textContent='Ticks: '+(d.tickCount||0).toLocaleString();
    document.getElementById('ovr').textContent=d.overridesActive?'⚡ tuner overrides active':'';
    const pnl=parseFloat(d.totalPnl),dp=parseFloat(d.dailyPnl);
    document.getElementById('cap').textContent='\$'+parseFloat(d.capital).toFixed(2);
    document.getElementById('scap').textContent='start \$'+d.startCapital;
    const pe=document.getElementById('tpnl');pe.textContent=(pnl>=0?'+':'')+'\$'+pnl.toFixed(5);pe.className='cv '+(pnl>=0?'pos':'neg');
    document.getElementById('tpnlp').textContent=d.totalPnlPct+'%';
    const de=document.getElementById('dpnl');de.textContent=(dp>=0?'+':'')+'\$'+dp.toFixed(5);de.className='cv '+(dp>=0?'pos':'neg');
    document.getElementById('wr').textContent=d.winRate;document.getElementById('wrc').textContent=d.wins+'W / '+d.losses+'L';
    document.getElementById('tt').textContent=d.totalTrades;document.getElementById('el').textContent=d.elapsedHours+'h elapsed';
    const ddv=parseFloat(d.maxDrawdown);const de2=document.getElementById('dd');de2.textContent=d.maxDrawdown;
    de2.className='cv '+(ddv>5?'neg':ddv>2?'warn':'pos');document.getElementById('str').textContent=d.consecutiveLosses;
    // Pair cards
    document.getElementById('pg').innerHTML=PAIRS.map(p=>{
      const rg=d.regimes?.[p]||{};const bl=d.baselines?.[p];
      const fr=d.fillRates?.[p];const frN=fr!==undefined?fr*100:100;
      const frC=frN<50?'var(--r)':frN<70?'var(--y)':'var(--g)';
      const w=d.weights?.[p]||{imbalance:1,flow:1,wall:1};
      const spoof=d.spoofActive?.[p];
      return \`<div class="pc">
        <div class="pn" style="color:\${RC[rg.confirmed]||'var(--m)'}">\${p}\${spoof?' ⚠️':''}</div>
        <div class="pr"><span>Fast</span><span class="pv" style="color:\${RC[rg.fast]}">\${rg.fast||'—'}</span></div>
        <div class="pr"><span>Slow</span><span class="pv" style="color:\${RC[rg.slow]}">\${rg.slow||'—'}</span></div>
        <div class="pr"><span>Fill rate</span><span class="pv" style="color:\${frC}">\${fr!==undefined?(fr*100).toFixed(0)+'%':'?'}</span></div>
        <div class="pr"><span>Weights</span><span class="pv">i×\${w.imbalance?.toFixed(2)} f×\${w.flow?.toFixed(2)} w×\${w.wall?.toFixed(2)}</span></div>
        <div class="pr"><span>Imb base</span><span class="pv">\${bl?(parseFloat(bl.imb)*100).toFixed(1)+'%':'—'}</span></div>
      </div>\`;
    }).join('');
    if(d.lastSignal){const s=d.lastSignal;
      document.getElementById('sp').textContent=s.pair||'—';
      document.getElementById('ss').textContent=s.side||'—';
      document.getElementById('sc').textContent=typeof s.score==='number'?s.score.toFixed(3):s.score||'—';
      const fr2=document.getElementById('sfr2');fr2.textContent=s.fastRegime||'—';fr2.style.color=RC[s.fastRegime]||'';
      const sr=document.getElementById('ssr');sr.textContent=s.slowRegime||'—';sr.style.color=RC[s.slowRegime]||'';
      document.getElementById('si2').textContent=s.imbalance?(s.imbalance*100).toFixed(1)+'%':'—';
      document.getElementById('sat').textContent=s.adaptiveThreshold?(s.adaptiveThreshold*100).toFixed(1)+'%':'—';
      document.getElementById('sf').textContent=s.flow?(s.flow.buyPct*100).toFixed(0)+'%':'—';
      document.getElementById('sfr').textContent=s.fillRate!==undefined?(s.fillRate*100).toFixed(0)+'%':'—';
      document.getElementById('rs').innerHTML=(s.reasons||[]).map(r=>\`<span class="tag">\${r}</span>\`).join('');
    }
    if(d.lastAction){const a=d.lastAction;
      document.getElementById('at').textContent=a.time?new Date(a.time).toLocaleTimeString():'—';
      document.getElementById('ap').textContent=a.pair||'—';
      document.getElementById('as2').textContent=a.side||'—';
      document.getElementById('apr').textContent=a.price?parseFloat(a.price).toFixed(6):'—';
      document.getElementById('asco').textContent=a.score||'—';
    }
  }catch(e){}
}
refresh();setInterval(refresh,2000);
</script></body></html>`);
}).listen(CFG.dashPort, () => L.info(`Dashboard → http://localhost:${CFG.dashPort}`));

// ─── STARTUP ───────────────────────────────────────────────────
process.on('SIGINT', () => {
  L.info('Shutting down...');
  Discord.notify('🔴 Bot Stopped', `Manual shutdown\nFinal capital: $${PAPER.capital.toFixed(2)} | P&L: ${PAPER.stats.totalPnl>=0?'+':''}$${PAPER.stats.totalPnl.toFixed(5)}`, 0xff4757);
  setTimeout(() => { L.info('Final', PAPER.getSummary()); process.exit(0); }, 1500);
});
process.on('uncaughtException',  (e) => { L.error('Uncaught',  { msg: e.message, stack: e.stack }); Discord.notify('💥 Bot Crashed', `\`${e.message}\`\nBot will attempt to recover.`, 0xff4757); });
process.on('unhandledRejection', (r) => { L.error('Rejection', { reason: String(r) }); });

L.info(`
╔══════════════════════════════════════════════╗
║        MAKER SCALPER BOT v4  READY           ║
║  ${(CFG.paperTrade?'MODE    : PAPER TRADE (safe)':'MODE    : LIVE ⚠️  REAL MONEY').padEnd(42)}║
║  Capital : $${String(CFG.paperCapital).padEnd(34)}║
║  Sessions: ${CFG.activeSessions.map(([s,e])=>`${s}–${e}UTC`).join(' ').padEnd(34)}║
║  Regime  : fast=${CFG.regimeFastWindow} / slow=${String(CFG.regimeSlowWindow).padEnd(24)}║
║  AutoTune: every ${String(CFG.autoTuneIntervalHrs+'h — self-applying').padEnd(28)}║
║  Discord : 30-min status + event alerts      ║
╚══════════════════════════════════════════════╝`);

BOT.start();
