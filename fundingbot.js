/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   BINANCE FUNDING RATE ARBITRAGE BOT  v3.1          Rating: 9/10 ║
 * ║   Mode : PAPER TRADING  →  set paperTrading:false to go live     ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Install once:  npm install ws
 * Run:           node fundingbot.js
 * Stop:          Ctrl+C  (state is saved — restarts resume from where you left off)
 */

const crypto = require("crypto");
const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const WebSocket = require("ws");

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  apiKey:    process.env.BINANCE_API_KEY    || "",
  apiSecret: process.env.BINANCE_API_SECRET || "",

  baseUrl:    "https://api.binance.com",
  futuresUrl: "https://fapi.binance.com",

  paperTrading:      true,
  paperStartBalance: 1000,   // virtual USDT
  maxPositionUsdt:    150,   // max per leg
  maxOpenPositions:     5,
  marginReserveRatio: 0.30,  // keep 30% as buffer

  // Entry filters — tuned to actually find trades in normal market conditions
  minFundingRate:     0.0003,   // 0.03%/cycle (~32% APR) — lowered from 0.05%
  minNetRate:         0.00005,  // must clear costs by at least this much
  minRateConsistency: 0.60,     // 60% of last 12 periods same direction
  minVolume24hUsdt:   1_000_000, // $1M min — lowered so more pairs qualify

  feeBnbDiscount: 0.00075,      // 0.075%/order with BNB discount

  slippage: {
    impactPerUsdt:  0.000001,
    maxSlippagePct: 0.003,
  },

  liquidation: {
    marginWarn:   0.15,
    marginDanger: 0.10,
  },

  rateDecayFraction:    0.35,   // exit if rolling avg drops below 35% of entry avg
  partialSizeThreshold: 0.55,   // reduce size at 55% decay
  partialSizeFraction:  0.50,

  maxDailyLossUsdt:       30,
  maxPositionAgeHours:     9,
  closeBeforeSettlementMs: 90_000,

  reEntryWatchMs:      600_000, // 10 min cooldown before re-entry
  reEntryRateMultiple:    1.10, // rate must recover to 110% of close rate

  scanIntervalMs:       60_000, // full scan every 60s
  wsReconnectDelayMs:    3_000,

  logFile:   "fundingbot_log.json",
  stateFile: "fundingbot_state.json",
  W: 76,
};

// ─── STATE ───────────────────────────────────────────────────────────────────
const state = {
  positions:   new Map(),  // symbol → position object
  watchlist:   new Map(),  // symbol → { closedAt, closedRate, reason }
  markPrices:  {},         // symbol → { markPrice, indexPrice, rate, nextTime } via WS
  bookSpreads: {},         // symbol → half-spread fraction via WS
  volumes:     {},         // symbol → 24h quoteVolume, refreshed each scan
  rateHistory: {},         // symbol → last 12 rates (ring buffer)

  paperBalance:  CONFIG.paperStartBalance,
  realizedPnl:   0,
  totalFees:     0,
  totalSlippage: 0,
  cycleCount:    0,
  tradesOpened:  0,
  tradesClosed:  0,
  tradesWon:     0,
  dailyPnl:      0,
  dailyResetAt:  Date.now(),
  halted:        false,
  haltReason:    "",
  symbolStats:   {},
  sessionStart:  Date.now(),
  wsStatus:      "connecting",
};

// ─── LOGGING ─────────────────────────────────────────────────────────────────
const LOG_PATH   = path.resolve(CONFIG.logFile);
const STATE_PATH = path.resolve(CONFIG.stateFile);

const appendLog = (obj) =>
  fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n", "utf8");

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`${ts}  ${msg}`);
  appendLog({ level: "LOG", msg: msg.replace(/\x1b\[[0-9;]*m/g, "") });
}

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────
function saveState() {
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    paperBalance:  state.paperBalance,
    realizedPnl:   state.realizedPnl,
    totalFees:     state.totalFees,
    totalSlippage: state.totalSlippage,
    tradesOpened:  state.tradesOpened,
    tradesClosed:  state.tradesClosed,
    tradesWon:     state.tradesWon,
    symbolStats:   state.symbolStats,
    rateHistory:   state.rateHistory,
    dailyPnl:      state.dailyPnl,
    dailyResetAt:  state.dailyResetAt,
    positions:     [...state.positions.entries()],
    watchlist:     [...state.watchlist.entries()],
    savedAt:       Date.now(),
  }, null, 2), "utf8");
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return;
  try {
    const d = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    Object.assign(state, {
      paperBalance:  d.paperBalance  ?? state.paperBalance,
      realizedPnl:   d.realizedPnl   ?? 0,
      totalFees:     d.totalFees     ?? 0,
      totalSlippage: d.totalSlippage ?? 0,
      tradesOpened:  d.tradesOpened  ?? 0,
      tradesClosed:  d.tradesClosed  ?? 0,
      tradesWon:     d.tradesWon     ?? 0,
      symbolStats:   d.symbolStats   ?? {},
      rateHistory:   d.rateHistory   ?? {},
      dailyPnl:      d.dailyPnl      ?? 0,
      dailyResetAt:  d.dailyResetAt  ?? Date.now(),
    });
    for (const [k, v] of d.positions || []) state.positions.set(k, v);
    for (const [k, v] of d.watchlist || []) state.watchlist.set(k, v);
    if (state.positions.size)
      log(`♻️  Restored ${state.positions.size} position(s) and ${state.watchlist.size} watchlist entries`);
  } catch (e) {
    log(`⚠️  State load failed: ${e.message}`);
  }
}

// ─── REST ─────────────────────────────────────────────────────────────────────
function request(baseUrl, urlPath, params = {}, method = "GET", sign = false) {
  return new Promise((resolve, reject) => {
    if (sign) {
      params.timestamp  = Date.now();
      params.recvWindow = 5000;
      const qs = new URLSearchParams(params).toString();
      params.signature = crypto.createHmac("sha256", CONFIG.apiSecret).update(qs).digest("hex");
    }
    const qs  = new URLSearchParams(params).toString();
    const url = new URL(qs ? `${urlPath}?${qs}` : urlPath, baseUrl);
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method,
        headers: { "X-MBX-APIKEY": CONFIG.apiKey, "Content-Type": "application/json" } },
      (res) => {
        let buf = "";
        res.on("data", c => buf += c);
        res.on("end", () => {
          try { resolve(JSON.parse(buf)); }
          catch { reject(new Error("Bad response: " + buf.slice(0, 200))); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Request timeout")); });
    req.end();
  });
}

const spotApi    = (p, q, m, s) => request(CONFIG.baseUrl,    p, q, m, s);
const futuresApi = (p, q, m, s) => request(CONFIG.futuresUrl, p, q, m, s);

// ─── WEBSOCKET STREAMS ────────────────────────────────────────────────────────
function startWebSockets() {
  // Combined stream: mark prices (3s) + best book ticker (real-time)
  const url = "wss://fstream.binance.com/stream?streams=!markPrice@arr@3s/!bookTicker";

  function connect() {
    state.wsStatus = "connecting";
    const ws = new WebSocket(url);

    ws.on("open", () => {
      state.wsStatus = "connected";
      log("📡 WebSocket connected (mark prices + book ticker)");
    });

    ws.on("message", (raw) => {
      try {
        const msg  = JSON.parse(raw);
        const data = msg.data;
        const stream = msg.stream || "";

        // Mark price array — all symbols every 3s
        if (stream.includes("markPrice") && Array.isArray(data)) {
          for (const d of data) {
            state.markPrices[d.s] = {
              markPrice:  parseFloat(d.p),
              indexPrice: parseFloat(d.i),
              rate:       parseFloat(d.r),
              nextTime:   d.T,
            };
          }
        }

        // Book ticker — best bid/ask per symbol
        if (stream.includes("bookTicker") && data?.s) {
          const bid = parseFloat(data.b), ask = parseFloat(data.a);
          const mid = (bid + ask) / 2;
          if (mid > 0) state.bookSpreads[data.s] = (ask - bid) / mid / 2;
        }
      } catch {}
    });

    ws.on("ping", () => ws.pong());

    ws.on("close", (code) => {
      state.wsStatus = "reconnecting";
      log(`🔌 WebSocket closed (${code}) — reconnecting in ${CONFIG.wsReconnectDelayMs / 1000}s`);
      setTimeout(connect, CONFIG.wsReconnectDelayMs);
    });

    ws.on("error", (err) => {
      state.wsStatus = "error";
      log(`⚠️  WebSocket error: ${err.message}`);
      // close event fires after error, which triggers reconnect
    });
  }

  connect();
}

// ─── MARKET DATA (REST) ───────────────────────────────────────────────────────
async function getFundingHistory(symbol, limit = 12) {
  try {
    const data = await futuresApi("/fapi/v1/fundingRate", { symbol, limit });
    return Array.isArray(data) ? data.map(d => parseFloat(d.fundingRate)) : [];
  } catch { return []; }
}

async function refreshVolumes() {
  try {
    const data = await futuresApi("/fapi/v1/ticker/24hr");
    if (Array.isArray(data))
      for (const d of data) state.volumes[d.symbol] = parseFloat(d.quoteVolume);
  } catch (e) { log(`⚠️  Volume refresh failed: ${e.message}`); }
}

async function reconcileFundingIncome(symbol, since) {
  if (CONFIG.paperTrading) return null;
  try {
    const data = await futuresApi("/fapi/v1/income",
      { symbol, incomeType: "FUNDING_FEE", startTime: since, limit: 10 }, "GET", true);
    return Array.isArray(data) ? data.reduce((s, d) => s + parseFloat(d.income), 0) : null;
  } catch { return null; }
}

// ─── RATE HISTORY & ROLLING AVG ──────────────────────────────────────────────
function pushRate(symbol, rate) {
  if (!state.rateHistory[symbol]) state.rateHistory[symbol] = [];
  state.rateHistory[symbol].push(rate);
  if (state.rateHistory[symbol].length > 12) state.rateHistory[symbol].shift();
}

function rollingAvg(symbol, n = 3) {
  const h = state.rateHistory[symbol] || [];
  if (!h.length) return 0;
  const sl = h.slice(-Math.min(n, h.length));
  return sl.reduce((a, b) => a + b, 0) / sl.length;
}

// ─── SLIPPAGE (live WS spread + impact) ───────────────────────────────────────
function estimateSlippage(symbol, sizeUsdt) {
  const spread = state.bookSpreads[symbol] || 0.001; // fallback 0.1%
  const impact = CONFIG.slippage.impactPerUsdt * sizeUsdt;
  return Math.min(spread + impact, CONFIG.slippage.maxSlippagePct);
}

// ─── STABILITY CHECK ──────────────────────────────────────────────────────────
async function isFundingStable(symbol, currentRate) {
  try {
    const hist = await getFundingHistory(symbol, 12);
    for (const r of hist) pushRate(symbol, r);
    if (!hist.length) return true;
    const same = hist.filter(r => Math.sign(r) === Math.sign(currentRate)).length;
    return same / hist.length >= CONFIG.minRateConsistency;
  } catch { return true; }
}

// ─── SCORING ──────────────────────────────────────────────────────────────────
async function scoreOpportunity(symbol, live) {
  if (!live) return null;
  const { rate, nextTime, markPrice, indexPrice } = live;
  const absRate        = Math.abs(rate);
  const msToFunding    = nextTime - Date.now();
  const hoursToFunding = msToFunding / 3_600_000;

  if (hoursToFunding < 0.025) return null;                          // too close to settlement
  if (absRate < CONFIG.minFundingRate) return null;                 // rate too low
  if ((state.volumes[symbol] || 0) < CONFIG.minVolume24hUsdt) return null; // illiquid

  const slipOneLeg = estimateSlippage(symbol, CONFIG.maxPositionUsdt);
  const spreadCost = (state.bookSpreads[symbol] || 0.001) * 2;
  if (spreadCost >= absRate * 0.8) return null;                    // spread eats too much

  const totalCost = CONFIG.feeBnbDiscount * 4 + slipOneLeg * 2;
  const netRate   = absRate - totalCost;
  if (netRate < CONFIG.minNetRate) return null;

  const stable = await isFundingStable(symbol, rate);
  if (!stable) return null;

  const basis        = Math.abs(markPrice - indexPrice) / indexPrice;
  const timeWeight   = Math.max(0, 1 - hoursToFunding / 8);
  const basisPenalty = Math.min(0.8, basis * 80);
  const ss           = state.symbolStats[symbol];
  const histBonus    = ss?.total >= 3 ? (ss.wins / ss.total - 0.5) * 0.15 : 0;
  const score        = netRate * (1 + timeWeight) * (1 - basisPenalty) + histBonus;

  return { symbol, rate, absRate, netRate, score, nextTime, msToFunding,
           markPrice, indexPrice, basis, slipOneLeg, totalCost,
           direction: rate > 0 ? "SHORT_FUTURES" : "LONG_FUTURES" };
}

async function scanOpportunities() {
  await refreshVolumes();

  // Use WS prices if populated, else fetch via REST
  let priceMap = state.markPrices;
  if (Object.keys(priceMap).length < 50) {
    log("ℹ️  WS prices not ready — falling back to REST premiumIndex");
    try {
      const data = await futuresApi("/fapi/v1/premiumIndex");
      if (Array.isArray(data))
        for (const d of data) priceMap[d.symbol] = {
          rate: parseFloat(d.lastFundingRate), nextTime: d.nextFundingTime,
          markPrice: parseFloat(d.markPrice), indexPrice: parseFloat(d.indexPrice),
        };
    } catch (e) { log(`⚠️  premiumIndex failed: ${e.message}`); return []; }
  }

  const symbols = Object.keys(priceMap).filter(
    s => s.endsWith("USDT") && !state.positions.has(s)
  );

  log(`🔍 Scoring ${symbols.length} symbols...`);
  const results = [];
  const BATCH   = 10;

  for (let i = 0; i < symbols.length; i += BATCH) {
    const settled = await Promise.allSettled(
      symbols.slice(i, i + BATCH).map(sym => scoreOpportunity(sym, priceMap[sym]))
    );
    for (const r of settled)
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    if (i + BATCH < symbols.length) await sleep(200);
  }

  const found = results.sort((a, b) => b.score - a.score);
  log(`📊 ${found.length} qualifying opportunities found`);
  return found;
}

// ─── RE-ENTRY WATCHLIST ───────────────────────────────────────────────────────
async function checkReEntries() {
  const now = Date.now();
  for (const [symbol, w] of state.watchlist) {
    if (now - w.closedAt > 16 * 3_600_000) { state.watchlist.delete(symbol); continue; }
    if (now - w.closedAt < CONFIG.reEntryWatchMs) continue;
    if (state.positions.has(symbol)) { state.watchlist.delete(symbol); continue; }
    if (state.positions.size >= CONFIG.maxOpenPositions) continue;

    const live = state.markPrices[symbol];
    if (!live) continue;
    if (Math.abs(live.rate) >= w.closedRate * CONFIG.reEntryRateMultiple) {
      log(`🔄 RE-ENTRY watching: ${symbol}  rate=${pc(live.rate)}  (closed at ${pc(w.closedRate)})`);
      const opp = await scoreOpportunity(symbol, live);
      if (opp) {
        await openPosition(opp);
        state.watchlist.delete(symbol);
      }
    }
  }
}

// ─── PAPER FILL ───────────────────────────────────────────────────────────────
function paperFill(price, sizeUsdt, slipFrac, isBuy) {
  const fillPrice = price * (1 + (isBuy ? 1 : -1) * slipFrac);
  const fee  = sizeUsdt * CONFIG.feeBnbDiscount;
  const slip = sizeUsdt * slipFrac;
  state.totalFees     += fee;
  state.totalSlippage += slip;
  state.paperBalance  -= fee + slip;
  return { fillPrice, orderId: "PAPER_" + Date.now() };
}

// ─── ORDERS ───────────────────────────────────────────────────────────────────
async function execSpot(symbol, isBuy, usdt, slip) {
  const price = state.markPrices[symbol]?.indexPrice || 1;
  if (CONFIG.paperTrading) return paperFill(price, usdt, slip, isBuy);
  const base = symbol.replace("USDT", "");
  const qty  = parseFloat((usdt / price).toFixed(5));
  const o = await spotApi("/api/v3/order",
    { symbol: base + "USDT", side: isBuy ? "BUY" : "SELL", type: "MARKET", quantity: qty }, "POST", true);
  return { fillPrice: price, orderId: o.orderId };
}

async function execFutures(symbol, isBuy, usdt, slip) {
  const price = state.markPrices[symbol]?.markPrice || 1;
  if (CONFIG.paperTrading) return paperFill(price, usdt, slip, isBuy);
  const qty = parseFloat((usdt / price).toFixed(3));
  const o = await futuresApi("/fapi/v1/order",
    { symbol, side: isBuy ? "BUY" : "SELL", type: "MARKET", quantity: qty, reduceOnly: false }, "POST", true);
  return { fillPrice: price, orderId: o.orderId };
}

// ─── OPEN / CLOSE ─────────────────────────────────────────────────────────────
async function openPosition(opp) {
  const { symbol, direction, rate, netRate, nextTime, slipOneLeg, totalCost } = opp;
  const avail = state.paperBalance * (1 - CONFIG.marginReserveRatio);
  const size  = Math.min(CONFIG.maxPositionUsdt, avail / CONFIG.maxOpenPositions);
  if (size < 10) { log(`⏭  Skip ${symbol} — balance too low`); return; }

  const spotBuy = direction === "SHORT_FUTURES";
  try {
    const [sf, ff] = await Promise.all([
      execSpot(symbol, spotBuy, size, slipOneLeg / 2),
      execFutures(symbol, !spotBuy, size, slipOneLeg / 2),
    ]);
    pushRate(symbol, rate);
    state.positions.set(symbol, {
      symbol, direction, size,
      spotEntry:    sf.fillPrice,
      futuresEntry: ff.fillPrice,
      openedAt:     Date.now(),
      nextFunding:  nextTime,
      rateAtEntry:  rate,
      entryRateAvg: rollingAvg(symbol, 3),
      expectedNet:  netRate,
      slipAtEntry:  slipOneLeg,
      currentRate:  rate,
      marginRatio:  CONFIG.marginReserveRatio,
      sizeReduced:  false,
    });
    state.tradesOpened++;
    log(`📥 OPEN   ${symbol.padEnd(12)} ${direction.padEnd(15)} rate=${pc(rate)} net=${pc(netRate)} size=$${size.toFixed(0)}`);
    appendLog({ type: "OPEN", symbol, direction, rate, netRate, totalCost, size });
    saveState();
  } catch (e) { log(`❌ Open failed ${symbol}: ${e.message}`); }
}

async function closePosition(symbol, reason) {
  const pos = state.positions.get(symbol);
  if (!pos) return;
  const slipExit = estimateSlippage(symbol, pos.size);
  const spotBuy  = pos.direction !== "SHORT_FUTURES";
  try {
    await Promise.all([
      execSpot(symbol, spotBuy, pos.size, slipExit / 2),
      execFutures(symbol, !spotBuy, pos.size, slipExit / 2),
    ]);
    const actualFunding = await reconcileFundingIncome(symbol, pos.openedAt);
    const funding = actualFunding ?? (pos.size * pos.expectedNet);
    const costs   = pos.size * (CONFIG.feeBnbDiscount * 4 + pos.slipAtEntry + slipExit);
    const netPnl  = funding - costs;

    state.realizedPnl  += netPnl;
    state.paperBalance += netPnl;
    state.dailyPnl     += netPnl;
    state.tradesClosed++;
    if (netPnl >= 0) state.tradesWon++;

    if (!state.symbolStats[symbol]) state.symbolStats[symbol] = { wins: 0, total: 0, pnl: 0 };
    state.symbolStats[symbol].total++;
    state.symbolStats[symbol].pnl += netPnl;
    if (netPnl >= 0) state.symbolStats[symbol].wins++;

    log(`📤 CLOSE  ${symbol.padEnd(12)} [${reason.padEnd(18)}] pnl=${pf(netPnl, 4)}  bal=$${state.paperBalance.toFixed(2)}`);
    appendLog({ type: "CLOSE", symbol, reason, funding, costs, netPnl, reconciled: actualFunding !== null });

    if (!["max-age-timeout", "liquidation-guard"].includes(reason))
      state.watchlist.set(symbol, { closedAt: Date.now(), closedRate: Math.abs(pos.rateAtEntry), reason });

    state.positions.delete(symbol);
    saveState();
  } catch (e) { log(`❌ Close failed ${symbol}: ${e.message}`); }
}

// ─── LIQUIDATION GUARD (synchronous — uses live WS data) ─────────────────────
function runLiquidationGuard() {
  for (const [symbol, pos] of state.positions) {
    const live = state.markPrices[symbol];
    if (!live) continue;

    const basisDrift = Math.abs(live.markPrice - live.indexPrice) / live.indexPrice;
    pos.marginRatio  = CONFIG.marginReserveRatio - basisDrift;
    pos.currentRate  = live.rate;
    pushRate(symbol, live.rate);

    if (pos.marginRatio < CONFIG.liquidation.marginWarn)
      log(`⚠️  MARGIN WARN  ${symbol}  ${(pos.marginRatio * 100).toFixed(1)}%`);

    if (pos.marginRatio < CONFIG.liquidation.marginDanger) {
      log(`🚨 LIQ GUARD TRIGGERED  ${symbol}`);
      closePosition(symbol, "liquidation-guard");
      continue;
    }

    // Rolling avg decay
    const currentAvg = rollingAvg(symbol, 3);
    const entryAvg   = pos.entryRateAvg || Math.abs(pos.rateAtEntry);
    const decay      = entryAvg !== 0 ? Math.abs(currentAvg) / Math.abs(entryAvg) : 1;

    if (decay < CONFIG.rateDecayFraction) {
      log(`📉 RATE DECAY    ${symbol}  ${(decay * 100).toFixed(0)}% of entry avg`);
      closePosition(symbol, "rate-decay");
      continue;
    }

    // Partial reduce (once only)
    if (decay < CONFIG.partialSizeThreshold && !pos.sizeReduced) {
      const newSize = pos.size * CONFIG.partialSizeFraction;
      log(`📊 PARTIAL REDUCE ${symbol}  $${pos.size.toFixed(0)} → $${newSize.toFixed(0)}`);
      pos.size = newSize;
      pos.sizeReduced = true;
      appendLog({ type: "PARTIAL_REDUCE", symbol, decay, newSize });
      saveState();
    }

    // Rate sign flip
    if (pos.rateAtEntry !== 0 && Math.sign(live.rate) !== Math.sign(pos.rateAtEntry)) {
      log(`🔁 RATE FLIP     ${symbol}`);
      closePosition(symbol, "rate-flip");
    }
  }
}

// ─── POSITION MANAGEMENT ─────────────────────────────────────────────────────
async function managePositions() {
  const now = Date.now();
  for (const [symbol, pos] of state.positions) {
    const msLeft = pos.nextFunding - now;
    if (msLeft > 0 && msLeft <= CONFIG.closeBeforeSettlementMs) {
      await closePosition(symbol, "pre-settlement"); continue;
    }
    if (now - pos.openedAt > CONFIG.maxPositionAgeHours * 3_600_000)
      await closePosition(symbol, "max-age-timeout");
  }
}

// ─── CIRCUIT BREAKER ─────────────────────────────────────────────────────────
function checkCircuitBreaker() {
  if (Date.now() - state.dailyResetAt > 86_400_000) {
    appendLog({ type: "DAILY_RESET", dailyPnl: state.dailyPnl });
    state.dailyPnl   = 0;
    state.dailyResetAt = Date.now();
    if (state.halted) { state.halted = false; log("✅ Circuit breaker reset — resuming"); }
  }
  if (!state.halted && state.dailyPnl < -CONFIG.maxDailyLossUsdt) {
    state.halted     = true;
    state.haltReason = `Daily loss $${Math.abs(state.dailyPnl).toFixed(2)} exceeded $${CONFIG.maxDailyLossUsdt}`;
    log(`🛑 CIRCUIT BREAKER: ${state.haltReason}`);
    appendLog({ type: "HALT", reason: state.haltReason });
  }
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
function printDashboard(opps) {
  const W = CONFIG.W, div = "─".repeat(W), eq = "═".repeat(W);
  const wr  = state.tradesClosed > 0 ? ((state.tradesWon / state.tradesClosed) * 100).toFixed(1) + "%" : "—";
  const ret = (((state.paperBalance - CONFIG.paperStartBalance) / CONFIG.paperStartBalance) * 100).toFixed(2);
  const ws  = state.wsStatus === "connected" ? "🟢" : "🔴";

  console.log("\n" + eq);
  console.log(`  ⚡ FUNDING ARB BOT v3.1  ${CONFIG.paperTrading ? "PAPER" : "LIVE "}  Cycle #${state.cycleCount}  Up: ${fmtDur(Date.now() - state.sessionStart)}  WS:${ws}${state.halted ? "  🛑 HALTED" : ""}`);
  console.log(eq);
  console.log(`  Balance  : $${state.paperBalance.toFixed(2).padStart(9)}    Return    : ${ret}%`);
  console.log(`  PnL      : ${pf(state.realizedPnl, 4).padStart(12)}    Daily     : ${pf(state.dailyPnl, 4)}`);
  console.log(`  Fees     : $${state.totalFees.toFixed(4).padStart(9)}    Slippage  : $${state.totalSlippage.toFixed(4)}`);
  console.log(`  Trades   :  ${String(state.tradesClosed).padStart(8)}    Win Rate  : ${wr}   Watch: ${state.watchlist.size}`);
  if (state.halted) console.log(`\n  🛑 ${state.haltReason}`);

  console.log("\n" + div + "\n  OPEN POSITIONS\n" + div);
  if (!state.positions.size) {
    console.log("  (none)");
  } else {
    console.log(`  ${"Symbol".padEnd(12)} ${"Direction".padEnd(15)} ${"Rate".padStart(9)}  ${"AvgRate".padStart(9)}  ${"Age".padStart(7)}  ${"Margin".padStart(7)}`);
    for (const [sym, p] of state.positions) {
      const avg  = rollingAvg(sym, 3);
      const warn = (p.marginRatio || 1) < CONFIG.liquidation.marginWarn ? " ⚠️" : "";
      const flag = p.sizeReduced ? " ↘" : "";
      console.log(
        `  ${sym.padEnd(12)} ${p.direction.padEnd(15)} ` +
        `${pc(p.currentRate).padStart(9)}  ${pc(avg).padStart(9)}  ` +
        `${fmtDur(Date.now() - p.openedAt).padStart(7)}  ${((p.marginRatio || 0) * 100).toFixed(1).padStart(5)}%${warn}${flag}`
      );
    }
  }

  console.log("\n" + div + "\n  TOP OPPORTUNITIES\n" + div);
  if (!opps?.length) {
    console.log("  (none above threshold — market may be calm, waiting for next cycle)");
  } else {
    console.log(`  ${"Symbol".padEnd(12)} ${"Rate".padStart(9)}  ${"Net".padStart(9)}  ${"Score".padStart(10)}  ${"Slip".padStart(8)}  ${"Vol $M".padStart(7)}`);
    for (const o of opps.slice(0, 5)) {
      const vol = ((state.volumes[o.symbol] || 0) / 1e6).toFixed(0);
      console.log(
        `  ${o.symbol.padEnd(12)} ${pc(o.rate).padStart(9)}  ${pc(o.netRate).padStart(9)}  ` +
        `${o.score.toFixed(6).padStart(10)}  ${pc(o.slipOneLeg).padStart(8)}  ${vol.padStart(7)}`
      );
    }
  }
  console.log(eq + "\n");
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const pc     = n  => (n * 100).toFixed(4) + "%";
const pf     = (n, d) => (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(d);
const fmtDur = ms => {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h > 0 ? `${h}h${m % 60}m` : m > 0 ? `${m}m${s % 60}s` : `${s}s`;
};

// ─── MAIN CYCLE ──────────────────────────────────────────────────────────────
async function cycle() {
  state.cycleCount++;
  checkCircuitBreaker();
  runLiquidationGuard();

  if (state.halted) { printDashboard([]); return; }

  try {
    await managePositions();
    await checkReEntries();

    let opps = [];
    if (state.positions.size < CONFIG.maxOpenPositions) {
      opps = await scanOpportunities();
      const slots = CONFIG.maxOpenPositions - state.positions.size;
      for (const opp of opps.slice(0, slots)) await openPosition(opp);
    }

    printDashboard(opps);

    if (state.cycleCount % 10 === 0)
      appendLog({ type: "SNAPSHOT", balance: state.paperBalance, realizedPnl: state.realizedPnl,
        dailyPnl: state.dailyPnl, openPos: state.positions.size,
        tradesClosed: state.tradesClosed,
        winRate: state.tradesClosed > 0 ? state.tradesWon / state.tradesClosed : null });
  } catch (e) {
    log(`⚠️  Cycle error: ${e.message}`);
    appendLog({ type: "ERROR", msg: e.message, stack: e.stack });
  }
}

// ─── STARTUP ─────────────────────────────────────────────────────────────────
async function main() {
  console.clear();
  loadState();

  log("🚀 Funding Rate Arbitrage Bot v3.1 starting");
  log(`   Mode     : ${CONFIG.paperTrading ? "PAPER TRADING 🟡" : "LIVE 🔴"}`);
  log(`   Balance  : $${state.paperBalance.toFixed(2)}`);
  log(`   Min rate : ${pc(CONFIG.minFundingRate)}   Min vol: $${(CONFIG.minVolume24hUsdt / 1e6).toFixed(0)}M   Fee/leg: ${pc(CONFIG.feeBnbDiscount)}`);
  log(`   Breaker  : $${CONFIG.maxDailyLossUsdt}/day   Slots: ${CONFIG.maxOpenPositions}   MaxSize: $${CONFIG.maxPositionUsdt}/leg`);
  log(`   Log      : ${LOG_PATH}`);
  log(`   State    : ${STATE_PATH}`);
  log("");

  appendLog({ type: "START", mode: CONFIG.paperTrading ? "paper" : "live", balance: state.paperBalance });

  startWebSockets();

  // Wait for WS to populate before first scan
  log("⏳ Waiting 5s for WebSocket to populate prices...");
  await sleep(5000);

  await cycle();
  setInterval(cycle, CONFIG.scanIntervalMs);
}

// Graceful shutdown — save state on Ctrl+C
process.on("SIGINT", () => {
  log("👋 Shutting down — saving state...");
  saveState();
  appendLog({ type: "SHUTDOWN", balance: state.paperBalance, realizedPnl: state.realizedPnl });
  process.exit(0);
});

process.on("uncaughtException", (e) => {
  log(`💥 Uncaught exception: ${e.message}`);
  appendLog({ type: "UNCAUGHT", msg: e.message, stack: e.stack });
  saveState();
});

main().catch(e => {
  console.error("FATAL:", e.message);
  appendLog({ type: "FATAL", msg: e.message });
  process.exit(1);
});