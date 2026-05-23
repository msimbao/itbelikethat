#!/usr/bin/env node
/**
 * ============================================================
 *  BINANCE STATISTICAL ARBITRAGE BOT  v5
 *  Paper-trading simulation — realistic Binance fee model
 *
 *  Architecture:
 *  - Binance combined WebSocket (bookTicker) — lightest stream
 *  - Ticks only update latestPrice in memory (no computation)
 *  - Heavy work (OLS beta, ADF, z-score) runs ONCE per minute
 *    when the sample timer fires — minimises CPU and data use
 *    while still using live prices for entry/exit execution
 *  - BNB fee discount supported via config flag
 *  - Break-even filter: expected reversion > MIN_PROFIT_COST_RATIO × costs
 *  - Full state persistence for crash/restart recovery
 *  - Discord alerts: open, close, errors, hourly status
 * ============================================================
 */

"use strict";

const https     = require("https");
const http      = require("http");
const fs        = require("fs");
const path      = require("path");
const WebSocket = require("ws");

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const CONFIG = {

  // ── Capital ──────────────────────────────────────────────
  STARTING_BALANCE:   1000,     // USD paper balance
  POSITION_SIZE_FRAC: 0.20,     // fraction of balance per leg
  MAX_OPEN_POSITIONS: 2,        // max simultaneous positions

  // ── Pairs (Binance USDT-quoted) ───────────────────────────
  PAIRS: [
    ["BTCUSDT",  "ETHUSDT"],
    ["ETHUSDT",  "SOLUSDT"],
    ["BTCUSDT",  "SOLUSDT"],
    ["ETHUSDT",  "AVAXUSDT"],
    ["SOLUSDT",  "AVAXUSDT"],
    ["BTCUSDT",  "BNBUSDT"],
    ["ETHUSDT",  "BNBUSDT"],
    ["BTCUSDT",  "AVAXUSDT"],
  ],

  // ── Spread window ─────────────────────────────────────────
  SAMPLE_INTERVAL_MS: 60_000,   // 1 price sample per minute
  WINDOW_SAMPLES:     120,      // 2-hour rolling window
  WARMUP_SAMPLES:     60,       // 1 hour before trading starts

  // ── Z-score thresholds ───────────────────────────────────
  // Binance's lower fees allow a lower Z_ENTRY (more opportunities)
  // while still being profitable. sigma_be at Z_ENTRY=2.0 with BNB
  // discount = 0.00156 — easily cleared by crypto pairs (typical 0.004-0.015)
  Z_ENTRY:         2.0,         // enter when |z| > this
  Z_ENTRY_CONFIRM: 3,           // must hold for N consecutive 1-min samples
  Z_EXIT:          0.4,         // exit when |z| < this (hold for full reversion)
  Z_STOP:          3.8,         // emergency stop if spread blows out further

  // ── Trade guards ─────────────────────────────────────────
  MIN_HOLD_MS:      10 * 60_000, // 10 min minimum hold
  PAIR_COOLDOWN_MS: 15 * 60_000, // 15 min cooldown after close

  // ── Break-even filter ────────────────────────────────────
  MIN_PROFIT_COST_RATIO: 1.2,   // expected profit must be 1.2× round-trip costs

  // ── Binance fee model ────────────────────────────────────
  USE_BNB_DISCOUNT: true,       // set false if you don't hold BNB
  // Taker fees: standard 0.10%, with BNB discount 25% off = 0.075%
  TAKER_FEE_STANDARD: 0.0010,
  TAKER_FEE_BNB:      0.00075,
  SLIPPAGE:           0.0003,   // 0.03% market impact (Binance is tighter)
  SPREAD_HALF:        0.0002,   // 0.02% half-spread (Binance is liquid)

  // ── Infrastructure ───────────────────────────────────────
  DISCORD_WEBHOOK:      "https://discord.com/api/webhooks/1503490609728589825/m0eKSz4QsEGQaxIDEe1zgX-hO6e5OKUqEkb_cjzzENpnNyNTpNozjBX-DQOSrp-2hZKd",
  DISCORD_RATE_LIMIT_MS: 3_000,
  STATUS_INTERVAL_MS:   60 * 60_000,  // hourly status
  STATE_FILE:           path.join(__dirname, "statarb_state.json"),

  // kline_1m stream: one message per completed minute candle — ~4 MB/day total
  BINANCE_WS_BASE: "wss://stream.binance.com:9443/stream?streams=",
  RECONNECT_DELAY: 5_000,
  MAX_RECONNECT_BEFORE_ALERT: 3,
};

// Derived: effective taker fee based on BNB setting
function takerFee() {
  return CONFIG.USE_BNB_DISCOUNT ? CONFIG.TAKER_FEE_BNB : CONFIG.TAKER_FEE_STANDARD;
}

// One-way cost rate per leg (entry OR exit, one side)
function legCostRate() {
  return takerFee() + CONFIG.SLIPPAGE + CONFIG.SPREAD_HALF;
}

// Round-trip cost rate on total notional (nA+nB):
// entry(A)+entry(B)+exit(A)+exit(B) = 2 × legCostRate × (nA+nB)
// Per unit of (nA+nB): 2 × legCostRate
function roundTripCostRate() {
  return 2 * legCostRate();
}

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function now()        { return new Date().toISOString(); }
function log(...a)    { console.log(`[${now()}]`, ...a); }
function logErr(...a) { console.error(`[${now()}] ERR`, ...a); }
function msToMin(ms)  { return (ms / 60_000).toFixed(1); }

// ─── DISCORD ─────────────────────────────────────────────────────────────────

const discordQueue   = [];
let   discordBusy    = false;
let   lastDiscordSent = 0;
const recentMessages  = new Map();

async function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data   = JSON.stringify(body);
    const req    = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end",  () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
    req.write(data); req.end();
  });
}

async function flushDiscordQueue() {
  if (discordBusy || discordQueue.length === 0) return;
  discordBusy = true;
  const wait = CONFIG.DISCORD_RATE_LIMIT_MS - (Date.now() - lastDiscordSent);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  const { content, isError } = discordQueue.shift();
  try {
    const res = await httpsPost(CONFIG.DISCORD_WEBHOOK, {
      content: content.slice(0, 2000),
      embeds: [{ description: content.slice(0, 4096), color: isError ? 0xff0000 : 0x00b4d8, timestamp: now() }],
    });
    if (res.status < 200 || res.status >= 300) logErr(`Discord ${res.status}:`, res.body);
    lastDiscordSent = Date.now();
  } catch (e) { logErr("Discord failed:", e.message); }
  discordBusy = false;
  if (discordQueue.length > 0) setImmediate(flushDiscordQueue);
}

function discord(content, isError = false) {
  // Deduplicate identical messages within 10s (prevents double-send on restart)
  const key  = content.slice(0, 120);
  const last = recentMessages.get(key) || 0;
  if (Date.now() - last < 10_000) { log("Discord dedup skipped"); return; }
  recentMessages.set(key, Date.now());
  if (recentMessages.size > 50) {
    const cutoff = Date.now() - 60_000;
    for (const [k, t] of recentMessages) if (t < cutoff) recentMessages.delete(k);
  }
  discordQueue.push({ content, isError });
  flushDiscordQueue();
}

// ─── STATISTICS ──────────────────────────────────────────────────────────────

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr, mu) {
  const m = mu ?? mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function zScore(value, mu, sigma) {
  return sigma < 1e-10 ? 0 : (value - mu) / sigma;
}

/**
 * Dickey-Fuller test for spread stationarity.
 * Regresses Δy[t] = α + β·y[t-1] + ε via OLS.
 * Significantly negative β (tStat < -1.95) means mean-reverting.
 * Critical value -1.95 at 10% significance — appropriate for 60-sample windows.
 */
function adfTest(samples) {
  const n = samples.length;
  if (n < 20) return { stationary: false, tStat: 0 };
  const dy = [], yLag = [];
  for (let i = 1; i < n; i++) {
    dy.push(samples[i] - samples[i - 1]);
    yLag.push(samples[i - 1]);
  }
  const m = dy.length, muY = mean(yLag), muDy = mean(dy);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < m; i++) {
    sxy += (yLag[i] - muY) * (dy[i] - muDy);
    sxx += (yLag[i] - muY) ** 2;
  }
  if (sxx < 1e-20) return { stationary: false, tStat: 0 };
  const beta  = sxy / sxx;
  const alpha = muDy - beta * muY;
  let sse = 0;
  for (let i = 0; i < m; i++) { const e = dy[i] - alpha - beta * yLag[i]; sse += e * e; }
  const se    = Math.sqrt((sse / (m - 2)) / sxx);
  const tStat = se < 1e-20 ? 0 : beta / se;
  return { stationary: tStat < -1.95, tStat: +tStat.toFixed(4) };
}

/**
 * OLS hedge ratio: β = Cov(log pB, log pA) / Var(log pB)
 * Makes the spread log(pA) - β·log(pB) stationary by construction.
 */
function calcHedgeRatio(samplesA, samplesB) {
  const n = samplesA.length;
  if (n < 2) return 1;
  const logA = samplesA.map(Math.log);
  const logB = samplesB.map(Math.log);
  const muA  = mean(logA), muB = mean(logB);
  let cov = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    cov  += (logB[i] - muB) * (logA[i] - muA);
    varB += (logB[i] - muB) ** 2;
  }
  return varB < 1e-20 ? 1 : cov / varB;
}

/** Beta-adjusted log spread: log(pA) - β·log(pB) */
function betaSpread(pA, pB, beta) {
  return Math.log(pA) - beta * Math.log(pB);
}

/**
 * Expected PnL from full mean reversion to Z_EXIT.
 * Each leg earns notional_i × sigma × zTravel (Δp/p ≈ Δlog p).
 * Total = (nA + nB) × sigma × (|z| - Z_EXIT)
 */
function expectedReversionPnl(notionalA, z, sigma, beta) {
  const zTravel = Math.abs(z) - CONFIG.Z_EXIT;
  if (zTravel <= 0) return 0;
  return (notionalA + notionalA / (beta || 1)) * sigma * zTravel;
}

// ─── STATE ───────────────────────────────────────────────────────────────────

function pairKey(a, b) { return `${a}::${b}`; }

function freshPairData() {
  return {
    samples:       [],     // beta-adjusted spread (for z-score)
    samplesA:      [],     // raw prices of A (for OLS)
    samplesB:      [],     // raw prices of B (for OLS)
    lastSampleAt:  0,
    consecutiveZ:  0,
    lastClosedAt:  0,
    lastZ:         0,
    lastSigma:     0,
    lastAdfTStat:  null,
    beta:          1,
    isCointegrated: false,
  };
}

function ensurePairData(state) {
  if (!state.pairData) state.pairData = {};
  for (const [a, b] of CONFIG.PAIRS) {
    const key = pairKey(a, b);
    if (!state.pairData[key]) state.pairData[key] = freshPairData();
    // Patch any missing fields on old state versions
    const pd = state.pairData[key];
    const fresh = freshPairData();
    for (const [k, v] of Object.entries(fresh)) {
      if (pd[k] == null) pd[k] = Array.isArray(v) ? [] : v;
    }
  }
}

function defaultState() {
  return {
    version:            5,
    balance:            CONFIG.STARTING_BALANCE,
    equity:             CONFIG.STARTING_BALANCE,
    totalFeesPaid:      0,
    totalSlippagePaid:  0,
    trades:             [],
    positions:          {},
    pairData:           {},
    prices:             {},   // latest live price per symbol
    stats:              { totalTrades: 0, winners: 0, losers: 0, grossPnl: 0 },
    startedAt:          now(),
    lastSaved:          now(),
  };
}

function saveState(state) {
  state.lastSaved = now();
  try { fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2), "utf8"); }
  catch (e) { logErr("State save failed:", e.message); }
}

function loadState() {
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, "utf8"));
      ensurePairData(saved);
      // Restore warmup alert set
      for (const [a, b] of CONFIG.PAIRS) {
        const key = pairKey(a, b);
        if (saved.pairData[key]?.samples?.length >= CONFIG.WARMUP_SAMPLES) {
          warmupAlerted.add(key);
        }
      }
      log(`Resumed — balance: $${saved.balance.toFixed(2)}, positions: ${Object.keys(saved.positions).length}, warmed: ${warmupAlerted.size}/${CONFIG.PAIRS.length}`);
      return saved;
    }
  } catch (e) { logErr("Could not load state, starting fresh:", e.message); }
  const s = defaultState();
  ensurePairData(s);
  return s;
}

// ─── WARMUP ──────────────────────────────────────────────────────────────────

const warmupAlerted = new Set();

function checkWarmupAlert(key, pd) {
  if (warmupAlerted.has(key) || pd.samples.length < CONFIG.WARMUP_SAMPLES) return;
  warmupAlerted.add(key);
  const pct = (warmupAlerted.size / CONFIG.PAIRS.length * 100).toFixed(0);
  discord(
    `🟡 **Warmup Complete: \`${key.replace("::", " / ")}\`**\n` +
    `Pairs ready: \`${warmupAlerted.size}/${CONFIG.PAIRS.length}\` (${pct}%)\n` +
    (warmupAlerted.size === CONFIG.PAIRS.length
      ? `✅ **All pairs warmed — bot is now trading!**`
      : `⏳ Waiting for remaining pairs...`)
  );
}

// ─── KLINE HANDLER ───────────────────────────────────────────────────────────
// Called once per completed 1-minute candle per symbol.
// closePrice = last traded price of that minute — fresh and accurate.
// All sampling, OLS, ADF, z-score, entry/exit logic runs here.

function onKlineClose(state, symbol, closePrice) {
  state.prices[symbol] = closePrice;
  const nowMs = Date.now();

  for (const [symA, symB] of CONFIG.PAIRS) {
    if (symbol !== symA && symbol !== symB) continue;

    const pA = state.prices[symA];
    const pB = state.prices[symB];
    if (!pA || !pB) continue;

    const key = pairKey(symA, symB);
    const pd  = state.pairData[key];

    // Gate: each pair processes once per minute — skip if already sampled
    // within the last 50s (both symbols share pairs, only first fires)
    if (nowMs - pd.lastSampleAt < 50_000) continue;

    // ── Take sample ────────────────────────────────────────────
    pd.samplesA.push(pA);
    pd.samplesB.push(pB);
    if (pd.samplesA.length > CONFIG.WINDOW_SAMPLES) pd.samplesA.shift();
    if (pd.samplesB.length > CONFIG.WINDOW_SAMPLES) pd.samplesB.shift();

    pd.beta = calcHedgeRatio(pd.samplesA, pd.samplesB);
    pd.samples.push(betaSpread(pA, pB, pd.beta));
    pd.lastSampleAt = nowMs;
    if (pd.samples.length > CONFIG.WINDOW_SAMPLES) pd.samples.shift();

    if (pd.samples.length >= 20) {
      const adf        = adfTest(pd.samples);
      pd.isCointegrated = adf.stationary;
      pd.lastAdfTStat   = adf.tStat;
    }

    checkWarmupAlert(key, pd);

    if (pd.samples.length < CONFIG.WARMUP_SAMPLES) continue;
    if (!pd.isCointegrated) { pd.lastZ = 0; pd.lastSigma = 0; continue; }

    // ── Z-score ────────────────────────────────────────────────
    const mu    = mean(pd.samples);
    const sigma = stddev(pd.samples, mu);
    const z     = zScore(betaSpread(pA, pB, pd.beta), mu, sigma);
    pd.lastZ     = z;
    pd.lastSigma = sigma;

    if (Math.abs(z) > CONFIG.Z_ENTRY) pd.consecutiveZ++;
    else pd.consecutiveZ = 0;

    const pos = state.positions[key];

    if (!pos) {
      // ── Entry ──────────────────────────────────────────────
      const cooldownOk = (nowMs - pd.lastClosedAt) > CONFIG.PAIR_COOLDOWN_MS;
      const capacityOk = Object.keys(state.positions).length < CONFIG.MAX_OPEN_POSITIONS;
      const signalOk   = Math.abs(z) > CONFIG.Z_ENTRY
                      && Math.abs(z) < CONFIG.Z_STOP
                      && pd.consecutiveZ >= CONFIG.Z_ENTRY_CONFIRM;

      if (cooldownOk && capacityOk && signalOk) {
        const beta        = pd.beta ?? 1;
        const notionalA   = Math.min(state.balance * CONFIG.POSITION_SIZE_FRAC, state.balance * 0.35);
        const notionalB   = notionalA / beta;
        const totalCosts  = roundTripCostRate() * (notionalA + notionalB);
        const expectedPnl = expectedReversionPnl(notionalA, z, sigma, beta);
        const profitRatio = totalCosts > 0 ? expectedPnl / totalCosts : 0;

        if (profitRatio < CONFIG.MIN_PROFIT_COST_RATIO) {
          log(`[${key}] Skip — ratio ${profitRatio.toFixed(2)}x | sigma=${sigma.toFixed(5)} beta=${(pd.beta??1).toFixed(4)}`);
        } else {
          openPosition(state, key, symA, symB, pA, pB, z, mu, sigma);
          pd.consecutiveZ = 0;
        }
      }

    } else {
      // ── Exit / stop ───────────────────────────────────────
      pos.currentZ      = z;
      pos.currentSpread = betaSpread(pA, pB, pd.beta);
      updateEquity(state);

      const heldMs    = nowMs - new Date(pos.openedAt).getTime();
      const minHoldOk = heldMs >= CONFIG.MIN_HOLD_MS;

      if (minHoldOk && Math.abs(z) < CONFIG.Z_EXIT)  closePosition(state, key, pA, pB, z, "exit");
      else if (Math.abs(z) > CONFIG.Z_STOP)           closePosition(state, key, pA, pB, z, "stop");
    }
  }
}

// ─── OPEN POSITION

// ─── OPEN POSITION ───────────────────────────────────────────────────────────

function openPosition(state, key, symA, symB, pA, pB, z, mu, sigma) {
  const pd        = state.pairData[key];
  const beta      = pd.beta ?? 1;
  const direction = z > 0 ? "short_A_long_B" : "long_A_short_B";

  const notionalA     = Math.min(state.balance * CONFIG.POSITION_SIZE_FRAC, state.balance * 0.35);
  const notionalB     = notionalA / beta;
  const totalNotional = notionalA + notionalB;
  const entryCosts    = legCostRate() * totalNotional;  // entry only (exit paid at close)

  if (notionalA < 10) { log(`[${key}] Skip open — insufficient balance`); return; }
  if (state.balance < totalNotional + entryCosts) { log(`[${key}] Skip open — would overdraw`); return; }

  state.balance -= totalNotional + entryCosts;

  const feeShare  = takerFee() / legCostRate();
  const slipShare = 1 - feeShare;
  state.totalFeesPaid     += entryCosts * feeShare;
  state.totalSlippagePaid += entryCosts * slipShare;

  state.positions[key] = {
    key, symA, symB, direction, beta,
    entryZ: z, currentZ: z,
    entryMu: mu, entrySigma: sigma,
    entryPriceA: pA, entryPriceB: pB,
    qtyA: notionalA / pA,
    qtyB: notionalB / pB,
    notionalA, notionalB,
    totalNotional,
    entryCosts,
    currentSpread: betaSpread(pA, pB, beta),
    openedAt: now(),
  };

  updateEquity(state);
  const bnbStr = CONFIG.USE_BNB_DISCOUNT ? " (BNB discount)" : "";
  const msg =
    `📂 **Position Opened**\n` +
    `Pair: \`${key.replace("::", " / ")}\` | Dir: \`${direction}\`\n` +
    `Z: \`${z.toFixed(3)}\` | σ: \`${sigma.toFixed(5)}\` | β: \`${beta.toFixed(4)}\`\n` +
    `Notional A: \`$${notionalA.toFixed(2)}\` B: \`$${notionalB.toFixed(2)}\` | Entry costs: \`$${entryCosts.toFixed(4)}\`${bnbStr}\n` +
    `Prices: A=\`$${pA.toFixed(4)}\` B=\`$${pB.toFixed(4)}\`\n` +
    `Balance: \`$${state.balance.toFixed(2)}\` | Equity: \`$${state.equity.toFixed(2)}\``;

  log(`OPEN [${key}] dir=${direction} z=${z.toFixed(3)} beta=${beta.toFixed(4)} nA=$${notionalA.toFixed(2)} nB=$${notionalB.toFixed(2)}`);
  discord(msg);
  saveState(state);
}

// ─── CLOSE POSITION ──────────────────────────────────────────────────────────

function closePosition(state, key, pA, pB, currentZ, reason) {
  const pos = state.positions[key];
  if (!pos) return;

  // Raw PnL: price moves on each leg since entry
  let rawPnl = 0;
  if (pos.direction === "short_A_long_B") {
    rawPnl += (pos.entryPriceA - pA) * pos.qtyA;   // short A
    rawPnl += (pB - pos.entryPriceB) * pos.qtyB;   // long  B
  } else {
    rawPnl += (pA - pos.entryPriceA) * pos.qtyA;   // long  A
    rawPnl += (pos.entryPriceB - pB) * pos.qtyB;   // short B
  }

  const exitCosts  = legCostRate() * pos.totalNotional;
  const netPnl     = rawPnl - exitCosts;   // entry costs paid at open

  // Return locked capital + net PnL
  state.balance += pos.totalNotional + netPnl;

  const feeShare  = takerFee() / legCostRate();
  const slipShare = 1 - feeShare;
  state.totalFeesPaid     += exitCosts * feeShare;
  state.totalSlippagePaid += exitCosts * slipShare;

  const heldMs   = Date.now() - new Date(pos.openedAt).getTime();
  const heldMin  = msToMin(heldMs);
  const totalCosts = pos.entryCosts + exitCosts;

  state.trades.push({
    key, direction: pos.direction,
    openedAt: pos.openedAt, closedAt: now(),
    holdMinutes: +heldMin,
    entryZ: +pos.entryZ.toFixed(4), exitZ: +currentZ.toFixed(4),
    entryPriceA: pos.entryPriceA, exitPriceA: pA,
    entryPriceB: pos.entryPriceB, exitPriceB: pB,
    notionalA: +pos.notionalA.toFixed(2), notionalB: +pos.notionalB.toFixed(2),
    beta: +pos.beta.toFixed(4),
    rawPnl: +rawPnl.toFixed(4), netPnl: +netPnl.toFixed(4),
    totalCosts: +totalCosts.toFixed(4), reason,
  });

  state.stats.totalTrades++;
  state.stats.grossPnl += netPnl;
  if (netPnl >= 0) state.stats.winners++;
  else              state.stats.losers++;

  state.pairData[key].lastClosedAt = Date.now();
  state.pairData[key].consecutiveZ = 0;
  delete state.positions[key];
  updateEquity(state);

  const emoji = netPnl >= 0 ? "✅" : "❌";
  const msg =
    `${emoji} **Position Closed** (\`${reason}\`)\n` +
    `Pair: \`${key.replace("::", " / ")}\`\n` +
    `Net PnL: \`$${netPnl.toFixed(4)}\` | Raw: \`$${rawPnl.toFixed(4)}\` | Costs: \`$${totalCosts.toFixed(4)}\`\n` +
    `Held: \`${heldMin}m\` | Z: entry=\`${pos.entryZ.toFixed(3)}\` → exit=\`${currentZ.toFixed(3)}\`\n` +
    `Balance: \`$${state.balance.toFixed(2)}\` | Equity: \`$${state.equity.toFixed(2)}\``;

  log(`CLOSE ${emoji} [${key}] reason=${reason} z=${currentZ.toFixed(3)} pnl=$${netPnl.toFixed(4)} held=${heldMin}m`);
  discord(msg);
  saveState(state);
}

// ─── EQUITY ──────────────────────────────────────────────────────────────────

function updateEquity(state) {
  let locked = 0, unrealised = 0;
  for (const pos of Object.values(state.positions)) {
    locked += pos.totalNotional;
    const pA = state.prices[pos.symA];
    const pB = state.prices[pos.symB];
    if (!pA || !pB) continue;
    if (pos.direction === "short_A_long_B") {
      unrealised += (pos.entryPriceA - pA) * pos.qtyA;
      unrealised += (pB - pos.entryPriceB) * pos.qtyB;
    } else {
      unrealised += (pA - pos.entryPriceA) * pos.qtyA;
      unrealised += (pos.entryPriceB - pB) * pos.qtyB;
    }
  }
  state.equity = state.balance + locked + unrealised;
}

// ─── STATUS REPORT ───────────────────────────────────────────────────────────

async function sendStatusReport(state) {
  updateEquity(state);
  const nowMs = Date.now();

  const returnPct = ((state.equity - CONFIG.STARTING_BALANCE) / CONFIG.STARTING_BALANCE * 100).toFixed(2);
  const winRate   = state.stats.totalTrades > 0
    ? (state.stats.winners / state.stats.totalTrades * 100).toFixed(1) : "N/A";

  const openLines = Object.values(state.positions).map(p => {
    const heldMin = msToMin(nowMs - new Date(p.openedAt).getTime());
    return `• \`${p.symA}/${p.symB}\` dir=\`${p.direction}\` z=\`${(p.currentZ ?? p.entryZ).toFixed(2)}\` held=\`${heldMin}m\``;
  }).join("\n") || "None";

  const recentLines = state.trades.slice(-5).reverse()
    .map(t => `• \`${t.key.replace("::", "/")}\` pnl=\`$${t.netPnl.toFixed(2)}\` held=\`${t.holdMinutes}m\` ${t.netPnl >= 0 ? "✅" : "❌"}`)
    .join("\n") || "None yet";

  const pairLines = CONFIG.PAIRS.map(([a, b]) => {
    const key    = pairKey(a, b);
    const pd     = state.pairData[key];
    const openPos = state.positions[key];

    if (!pd || pd.samples.length < CONFIG.WARMUP_SAMPLES) {
      const n = pd ? pd.samples.length : 0;
      return `⏳ \`${a}/${b}\` warming up \`${n}/${CONFIG.WARMUP_SAMPLES}\``;
    }

    const z        = pd.lastZ     ?? 0;
    const sigma    = pd.lastSigma ?? 0;
    const beta     = pd.beta      ?? 1;
    const absZ     = Math.abs(z);
    const cointStr = pd.isCointegrated ? "✅" : "❌";
    const tStr     = pd.lastAdfTStat != null ? `t=\`${Number(pd.lastAdfTStat).toFixed(2)}\`` : "";

    let icon, note;
    if (openPos) {
      icon = "🔵";
      note = `IN POSITION z=\`${z.toFixed(3)}\` exit<\`${CONFIG.Z_EXIT}\``;
    } else if (!pd.isCointegrated) {
      icon = "🚫";
      note = `not cointegrated ADF ${tStr}`;
    } else {
      const cooldownMs = nowMs - (pd.lastClosedAt || 0);
      const cooldownOk = cooldownMs > CONFIG.PAIR_COOLDOWN_MS;
      const capacityOk = Object.keys(state.positions).length < CONFIG.MAX_OPEN_POSITIONS;
      const signalOk   = absZ > CONFIG.Z_ENTRY && absZ < CONFIG.Z_STOP && pd.consecutiveZ >= CONFIG.Z_ENTRY_CONFIRM;
      const nA         = state.balance * CONFIG.POSITION_SIZE_FRAC;
      const costs      = roundTripCostRate() * (nA + nA / beta);
      const expPnl     = expectedReversionPnl(nA, z, sigma, beta);
      const profitOk   = costs > 0 && (expPnl / costs) >= CONFIG.MIN_PROFIT_COST_RATIO;

      if (signalOk && cooldownOk && capacityOk && profitOk) {
        icon = "🟢"; note = `WOULD ENTER z=\`${z.toFixed(3)}\` confirm=\`${pd.consecutiveZ}/${CONFIG.Z_ENTRY_CONFIRM}\``;
      } else if (absZ > CONFIG.Z_ENTRY) {
        const blocks = [];
        if (!cooldownOk) blocks.push(`cooldown \`${msToMin(CONFIG.PAIR_COOLDOWN_MS - cooldownMs)}m\``);
        if (!capacityOk) blocks.push(`at capacity`);
        if (!signalOk)   blocks.push(`confirm \`${pd.consecutiveZ}/${CONFIG.Z_ENTRY_CONFIRM}\``);
        if (!profitOk)   blocks.push(`profit \`${costs>0?(expPnl/costs).toFixed(2):'0.00'}x\``);
        icon = "🟡"; note = `SIGNAL z=\`${z.toFixed(3)}\` blocked: ${blocks.join(", ")}`;
      } else {
        icon = "⚪"; note = `no signal z=\`${z.toFixed(3)}\` (need |z|>\`${CONFIG.Z_ENTRY}\` for ${CONFIG.Z_ENTRY_CONFIRM} mins)`;
      }
    }
    return `${icon} \`${a}/${b}\` β=\`${beta.toFixed(3)}\` σ=\`${sigma.toFixed(5)}\` ADF${cointStr}${tStr} — ${note}`;
  }).join("\n");

  const bnbStr = CONFIG.USE_BNB_DISCOUNT ? " | BNB discount ✅" : "";
  discord([
    `## 📊 StatArb Bot — Hourly Status`,
    `**Balance:** \`$${state.balance.toFixed(2)}\` | **Equity:** \`$${state.equity.toFixed(2)}\``,
    `**Return:** \`${returnPct}%\` | **Since:** \`${state.startedAt}\``,
    `**Trades:** ${state.stats.totalTrades} | **Win Rate:** ${winRate}%${bnbStr}`,
    `**Fees:** \`$${state.totalFeesPaid.toFixed(2)}\` | **Slippage:** \`$${state.totalSlippagePaid.toFixed(2)}\``,
    ``,
    `**Open Positions (${Object.keys(state.positions).length}/${CONFIG.MAX_OPEN_POSITIONS}):**`,
    openLines,
    ``,
    `**Pair Scanner:**`,
    pairLines,
    ``,
    `**Recent Trades:**`,
    recentLines,
  ].join("\n"));
  log("Status report queued.");
}

// ─── BINANCE WEBSOCKET ────────────────────────────────────────────────────────

let reconnectAttempts = 0;
let wsInstance        = null;

function connectBinance(state, allSymbols) {
  // kline_1m: fires once per completed minute candle — ~400 bytes/msg
  const streams = allSymbols.map(s => `${s.toLowerCase()}@kline_1m`).join("/");
  const url     = CONFIG.BINANCE_WS_BASE + streams;

  log(`Connecting to Binance kline_1m WS (attempt ${reconnectAttempts + 1})…`);
  const ws = new WebSocket(url);
  wsInstance = ws;

  ws.on("open", () => {
    log("Binance kline_1m WS connected:", allSymbols.join(", "));
    reconnectAttempts = 0;
  });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // Combined stream wraps in { stream, data }
    const data = msg.data ?? msg;
    if (!data?.k) return;                  // not a kline message
    if (!data.k.x) return;                // x=false: candle still open, skip
    const closePrice = parseFloat(data.k.c); // candle close price
    if (data.k.s && !isNaN(closePrice) && closePrice > 0) onKlineClose(state, data.k.s, closePrice);
  });

  ws.on("error", async e => {
    logErr("WS error:", e.message);
    reconnectAttempts++;
    if (reconnectAttempts >= CONFIG.MAX_RECONNECT_BEFORE_ALERT) {
      discord(`⚠️ **Binance WS Error** (attempt ${reconnectAttempts}): \`${e.message}\``, true);
    }
  });

  ws.on("close", code => {
    log(`WS closed (${code}). Reconnecting in ${CONFIG.RECONNECT_DELAY / 1000}s…`);
    setTimeout(() => connectBinance(state, allSymbols), CONFIG.RECONNECT_DELAY);
  });

  // Binance requires a pong response to ping frames (ws library handles this automatically)
  // but we send a listenKey keepalive every 30m for good measure
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 3 * 60_000);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  log("=== Binance StatArb Bot v6 Starting ===");
  try { require.resolve("ws"); } catch { logErr("Run: npm install ws"); process.exit(1); }

  const state      = loadState();
  const allSymbols = [...new Set(CONFIG.PAIRS.flat())];

  discord([
    `🚀 **Binance StatArb Bot v6 Started (kline_1m ~4 MB/day)**`,
    `Balance: \`$${state.balance.toFixed(2)}\``,
    `Pairs: \`${CONFIG.PAIRS.length}\` | Symbols: \`${allSymbols.length}\``,
    `Fee: \`${(takerFee()*100).toFixed(3)}%\` taker${CONFIG.USE_BNB_DISCOUNT ? " (BNB discount)" : ""}`,
    `Z entry/exit/stop: \`${CONFIG.Z_ENTRY}\` / \`${CONFIG.Z_EXIT}\` / \`${CONFIG.Z_STOP}\``,
    `Break-even σ: \`${(roundTripCostRate() / (CONFIG.Z_ENTRY - CONFIG.Z_EXIT)).toFixed(5)}\` (pairs need σ above this)`,
    `Warmup: \`${CONFIG.WARMUP_SAMPLES}\` min | Window: \`${CONFIG.WINDOW_SAMPLES}\` min`,
    `⏳ No trades until all pairs warm up.`,
  ].join("\n"));

  connectBinance(state, allSymbols);

  // No sample timer — kline_1m stream IS the 1-min trigger
  setInterval(() => sendStatusReport(state), CONFIG.STATUS_INTERVAL_MS);
  setInterval(() => saveState(state), 60_000);

  process.on("SIGINT",  () => shutdown(state, "SIGINT"));
  process.on("SIGTERM", () => shutdown(state, "SIGTERM"));
  process.on("uncaughtException", async e => {
    logErr("Uncaught:", e);
    discord(`🔴 **Uncaught Exception:** \`${e.message}\`\n\`\`\`${(e.stack||"").slice(0,800)}\`\`\``, true);
    saveState(state);
  });
  process.on("unhandledRejection", async reason => {
    logErr("Unhandled rejection:", reason);
    discord(`🔴 **Unhandled Rejection:** \`${String(reason).slice(0,500)}\``, true);
  });
}

async function shutdown(state, signal) {
  log(`${signal} — saving and shutting down`);
  if (wsInstance) wsInstance.close();
  saveState(state);
  discord(`🛑 **Bot Stopped** (${signal}) — balance: \`$${state.balance.toFixed(2)}\` | equity: \`$${state.equity.toFixed(2)}\``);
  await new Promise(r => setTimeout(r, 4000));
  process.exit(0);
}

main().catch(async e => {
  logErr("Fatal:", e);
  discord(`🔴 **Fatal Startup Error:** \`${e.message}\``, true);
  process.exit(1);
});
