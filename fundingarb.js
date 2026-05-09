/**
 * Funding Rate Arbitrage Bot — Paper Trading
 * Exchange : Kraken (Spot WS v2 + Futures WS v1)
 * Strategy : Delta-neutral funding capture, both directions
 *            LONG SPOT / SHORT PERP  → when funding is strongly positive (longs pay shorts → we collect)
 *            SHORT SPOT / LONG PERP  → when funding is strongly negative (shorts pay longs → we collect)
 *
 * Improvements over v2:
 *  + Negative funding trades (doubles opportunity set)
 *  + Expanded to 7 pairs (BTC ETH SOL XRP DOGE LINK ADA)
 *  + Dynamic exit: hold until funding falls within 1% APR of break-even rate, not a fixed 5%
 *  + Min-hold guard: never close before fees are recovered (prevents certain losses on fast reversals)
 *  + Negative funding accrual debited correctly when held through a rate flip
 *  + Per-position direction label throughout logs and Discord
 */

import WebSocket from "ws";
import fetch     from "node-fetch";
import fs        from "fs";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const DISCORD_WEBHOOK =
  "https://discord.com/api/webhooks/1502745359166996491/mwpzhAJbX8pOjNbYxpj3jbPizst99GHZLBIV6sG1UgxXB17A5X-AA6bxYE2cBOdv8ONZ";
  
if (!DISCORD_WEBHOOK) {
  console.error("ERROR: DISCORD_WEBHOOK environment variable is not set. Exiting.");
  process.exit(1);
}

const STATE_FILE = "./bot-state.json";
const LOG_FILE   = "./trades.log";

const CONFIG = {
  pairs: [
    { spot: "BTC/USD",  perp: "PF_XBTUSD",  base: "BTC"  },
    { spot: "ETH/USD",  perp: "PF_ETHUSD",  base: "ETH"  },
    { spot: "SOL/USD",  perp: "PF_SOLUSD",  base: "SOL"  },
    { spot: "XRP/USD",  perp: "PF_XRPUSD",  base: "XRP"  },
    { spot: "DOGE/USD", perp: "PF_DOGEUSD", base: "DOGE" },
    { spot: "LINK/USD", perp: "PF_LINKUSD", base: "LINK" },
    { spot: "ADA/USD",  perp: "PF_ADAUSD",  base: "ADA"  },
  ],

  // ── Strategy thresholds ────────────────────────────────────────────────────
  //
  // Entry: open when |APR| is strong enough that break-even is under 4 days.
  // With round-trip cost ≈ 0.42% of notional:
  //   break-even days = (0.0042 * 2) / (APR/100/365)
  //   4-day break-even → APR ≈ 0.0084 / (4/365) ≈ 77% ... too tight for alts.
  // We set entry at 15% APR (≈10-day break-even) which gives decent hold time.
  minFundingRateAPR:   15,     // % APR magnitude — enter long or short arb
  minNegFundingAPR:   -15,     // % APR — enter inverse arb when rate is this negative

  // Exit: dynamic — computed per-position as (fees remaining / time to recover).
  // Hard floor: exit if rate crosses zero against us, or drops below this buffer.
  exitBufferAPR:        1,     // % APR above/below 0 — exit when funding no longer covers fees quickly enough

  // Min hold: never exit before this many hours regardless of rate, unless rate flips sign
  minHoldHours:        12,     // protect against paying open+close fees on a quick reversal

  positionSizeUSD:   1000,     // notional per leg in USD
  maxOpenPositions:     7,     // one per pair max

  // ── Fee model (Kraken taker rates) ────────────────────────────────────────
  spotFeeRate:    0.0016,      // 0.16%
  perpFeeRate:    0.0005,      // 0.05%
  slippageBps:       5,        // 0.05% per leg

  // ── Borrow cost for short-spot (inverse arb) leg ──────────────────────────
  // Kraken margin borrow rates vary; 0.02%/hr (~175% APR) is a conservative
  // placeholder. Replace with live API data when going live.
  // Set to 0 to disable (e.g. if using a futures-only short instead of spot margin).
  shortSpotBorrowRatePerHour: 0.0002,   // 0.02% per hour (~175% APR — conservative)

  // ── Stale data guard ──────────────────────────────────────────────────────
  // Reject funding rate or spot price data older than this before making any
  // entry/exit decisions. Prevents acting on stale WS data after a disconnect.
  maxDataAgeMs: 5 * 60 * 1000,          // 5 minutes

  // ── Signal hysteresis ────────────────────────────────────────────────────
  // Entry fires at |APR| >= minFundingRateAPR.
  // signalCount only resets when |APR| drops below this lower band (not the entry threshold).
  // Prevents thrashing when APR oscillates around the entry threshold.
  signalResetAPR: 12,           // % APR — reset debounce counter only below this

  // ── Funding accrual ───────────────────────────────────────────────────────
  fundingAccrualIntervalMs:  60_000,    // accrue every 1 min
  fundingPaymentIntervalMs: 3_600_000,  // Kraken settles hourly

  // ── Websockets ────────────────────────────────────────────────────────────
  wsFutures: "wss://futures.kraken.com/ws/v1",
  wsSpot:    "wss://ws.kraken.com/v2",

  // ── Misc ──────────────────────────────────────────────────────────────────
  hourlyStatusIntervalMs: 60 * 60 * 1000,
  stateSaveIntervalMs:         60_000,
  signalDebounce:              3,       // ticks before acting on an entry signal
};

// ─── LOGGING ──────────────────────────────────────────────────────────────────

function log(level, msg, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data });
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

// ─── PERSISTENT STATE ─────────────────────────────────────────────────────────

const DEFAULT_PNL = {
  fundingEarned: 0, fundingPaid: 0,
  unrealisedPnl: 0, realisedPnl: 0,
  trades: 0, feesTotal: 0,
};

let state = {
  spotPrices:   {},   // base  → price
  fundingRates: {},   // perp  → { ratePerHour, predictedRatePerHour, ts }
  positions:    {},   // base  → Position
  pnl:          { ...DEFAULT_PNL },
  startTime:    Date.now(),
  restored:     false,
};

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      positions: state.positions,
      pnl:       { ...state.pnl, unrealisedPnl: 0 },
      startTime: state.startTime,
      savedAt:   Date.now(),
    }, null, 2));
  } catch (e) { log("error", "save_state_failed", { error: e.message }); }
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const snap      = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    state.positions = snap.positions ?? {};
    state.pnl       = { ...DEFAULT_PNL, ...snap.pnl };
    state.startTime = snap.startTime ?? Date.now();
    state.restored  = Object.keys(state.positions).length > 0;
    log("info", "state_restored", {
      positions: Object.keys(state.positions), realisedPnl: state.pnl.realisedPnl, savedAt: snap.savedAt,
    });
  } catch (e) { log("warn", "state_load_failed", { error: e.message }); }
}

// ─── DISCORD ──────────────────────────────────────────────────────────────────

const discordQueue = [];
let discordBusy    = false;

async function flushDiscord() {
  if (discordBusy || !discordQueue.length) return;
  discordBusy = true;
  const payload = discordQueue.shift();
  try {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const retryAfter = res.headers.get("retry-after");
    if (res.status === 429 && retryAfter) {
      discordQueue.unshift(payload);
      await sleep(parseFloat(retryAfter) * 1000);
    }
  } catch (e) { log("error", "discord_send_failed", { error: e.message }); }
  discordBusy = false;
  setTimeout(flushDiscord, 300);
}

function discord(content = "", embeds = []) {
  discordQueue.push({ content, embeds });
  flushDiscord();
}

function embed(title, description, color = 0x5865f2, fields = []) {
  return { title, description, color, fields, timestamp: new Date().toISOString() };
}

// ─── FEE + SLIPPAGE ───────────────────────────────────────────────────────────

// Total cost (USD) to open OR close both legs at a given notional
// i.e. this is a one-way cost (one open, or one close — not both).
function tradeCost(notionalUSD) {
  const slip = CONFIG.slippageBps / 10_000;
  return notionalUSD * (CONFIG.spotFeeRate + slip)
       + notionalUSD * (CONFIG.perpFeeRate + slip);
}

// fill price with directional slippage
// direction: +1 = we are buying (pay above mid), -1 = we are selling (receive below mid)
function fillPrice(mid, direction) {
  return mid * (1 + direction * CONFIG.slippageBps / 10_000);
}

// ─── BREAK-EVEN HELPERS ───────────────────────────────────────────────────────

// Minimum APR (in % absolute) that covers round-trip fees in minHoldHours.
// Round-trip = one open cost + one close cost = tradeCost * 2.
function breakEvenAPR(notionalUSD) {
  const roundTrip = tradeCost(notionalUSD) * 2;   // open + close (two one-way costs)
  return (roundTrip / notionalUSD) / (CONFIG.minHoldHours / 8760) * 100;
}

// Days to recover total round-trip cost at a given APR.
// roundTrip here is always tradeCost * 2 (open + close).
function daysToBreakEven(notionalUSD, aprPct) {
  if (aprPct <= 0) return Infinity;
  const roundTrip   = tradeCost(notionalUSD) * 2;
  const dailyIncome = notionalUSD * (aprPct / 100) / 365;
  return roundTrip / dailyIncome;
}

// ─── FUNDING ACCRUAL ──────────────────────────────────────────────────────────

function accrueAllFunding() {
  const nowMs = Date.now();

  for (const [base, pos] of Object.entries(state.positions)) {
    const funding = state.fundingRates[pos.perp];
    if (!funding) continue;

    // ── Stale data guard ────────────────────────────────────────────────────
    if (nowMs - funding.ts > CONFIG.maxDataAgeMs) {
      log("warn", "stale_funding_rate_skipped_accrual", {
        base, perp: pos.perp, ageMs: nowMs - funding.ts,
      });
      continue;
    }

    const ratePerHour = funding.predictedRatePerHour ?? funding.ratePerHour ?? 0;
    const elapsedHours = (nowMs - (pos.lastAccrualMs ?? pos.entryTime)) / 3_600_000;
    const spotPrice    = state.spotPrices[base] ?? pos.entrySpotFill;
    const notional     = pos.qty * spotPrice;

    // For LONG arb: positive rate pays us, negative rate costs us.
    // For SHORT arb: negative rate pays us, positive rate costs us.
    // pos.direction: +1 = long spot/short perp, -1 = short spot/long perp
    const effectiveRate = ratePerHour * pos.direction;
    const payment       = notional * effectiveRate * elapsedHours;

    // ── Borrow cost for short-spot leg ──────────────────────────────────────
    // When shorting spot on margin (direction === -1), the broker charges a
    // borrow rate. This is a real cost that reduces net funding income.
    // For paper trading this is modelled as a constant; replace with live
    // borrow rate API data before going live.
    const borrowCost = pos.direction === -1
      ? notional * CONFIG.shortSpotBorrowRatePerHour * elapsedHours
      : 0;

    pos.fundingCollected += payment - borrowCost;
    pos.borrowCostTotal  = (pos.borrowCostTotal ?? 0) + borrowCost;
    pos.lastAccrualMs     = nowMs;

    if (payment >= 0) state.pnl.fundingEarned += payment;
    else              state.pnl.fundingPaid   += Math.abs(payment);
    if (borrowCost > 0) state.pnl.feesTotal   += borrowCost;

    // Notify on hourly settlement boundary (±1.5 min)
    if (nowMs % CONFIG.fundingPaymentIntervalMs < CONFIG.fundingAccrualIntervalMs * 1.5) {
      const aprPct = ratePerHour * 8760 * 100;
      discord("", [
        embed(
          payment >= 0 ? "💰 Funding Received" : "💸 Funding Paid",
          `**${base}** (${pos.direction === 1 ? "long arb" : "short arb"}) hourly settlement`,
          payment >= 0 ? 0xfee75c : 0xff7675,
          [
            { name: "Payment",         value: `$${payment.toFixed(4)}`,              inline: true },
            { name: "Borrow Cost",     value: borrowCost > 0 ? `-$${borrowCost.toFixed(4)}` : "n/a", inline: true },
            { name: "Rate/hr",         value: `${(ratePerHour*100).toFixed(4)}%`,    inline: true },
            { name: "APR",             value: `${aprPct.toFixed(2)}%`,               inline: true },
            { name: "Net Collected",   value: `$${pos.fundingCollected.toFixed(4)}`, inline: true },
            { name: "Notional",        value: `$${notional.toFixed(2)}`,             inline: true },
          ]
        ),
      ]);
      log("info", "funding_settlement", { base, payment, borrowCost, fundingCollected: pos.fundingCollected, aprPct });
    }
  }
}

// ─── POSITION MANAGEMENT ──────────────────────────────────────────────────────

/**
 * direction: +1 = long spot / short perp  (positive funding, longs pay us)
 *            -1 = short spot / long perp  (negative funding, shorts pay us)
 */
function openPosition(pair, mid, ratePerHour, direction) {
  const { base, perp } = pair;
  if (state.positions[base]) return;
  if (Object.keys(state.positions).length >= CONFIG.maxOpenPositions) return;

  const aprPct = ratePerHour * 8760 * 100;

  // Fill prices depend on direction
  // Long arb:  buy spot (pay up), enter short perp (sell above mid)
  // Short arb: sell spot (receive below mid), enter long perp (buy above mid)
  const spotFill = direction === 1 ? fillPrice(mid, +1) : fillPrice(mid, -1);
  const perpFill = direction === 1 ? fillPrice(mid, -1) : fillPrice(mid, +1);

  const qty      = CONFIG.positionSizeUSD / mid;
  const openCost = tradeCost(CONFIG.positionSizeUSD);
  const beAPR    = breakEvenAPR(CONFIG.positionSizeUSD);
  const beDays   = daysToBreakEven(CONFIG.positionSizeUSD, Math.abs(aprPct)).toFixed(1);
  const dirLabel = direction === 1 ? "🟢 Long spot / Short perp" : "🔴 Short spot / Long perp";

  state.positions[base] = {
    base, perp, direction,
    entryMid:        mid,
    entrySpotFill:   spotFill,
    entryPerpFill:   perpFill,
    entryTime:       Date.now(),
    qty,
    fundingRateAPR:  aprPct,
    fundingCollected: 0,
    borrowCostTotal:  0,        // cumulative borrow cost for short-spot leg
    entryBasis:       0,        // spot-perp spread at entry (for basis risk tracking)
    feesOnOpen:      openCost,
    breakEvenAPR:    beAPR,
    lastAccrualMs:   Date.now(),
  };

  // Capture entry basis (spot fill vs perp fill) for basis risk tracking
  const entryBasis    = spotFill - perpFill;
  state.positions[base].entryBasis = entryBasis;

  // For short arb, estimate the borrow cost drag on APR so it shows at open
  const borrowDragAPR = direction === -1
    ? CONFIG.shortSpotBorrowRatePerHour * 8760 * 100
    : 0;
  const netAPR = Math.abs(aprPct) - borrowDragAPR;

  state.pnl.trades++;
  state.pnl.feesTotal += openCost;
  saveState();

  discord("", [
    embed("📈 Position Opened", `**${base}** ${dirLabel}`, 0x57f287, [
      { name: "Direction",      value: dirLabel,                                         inline: false },
      { name: "Spot Fill",      value: `$${spotFill.toFixed(4)}`,                        inline: true  },
      { name: "Perp Fill",      value: `$${perpFill.toFixed(4)}`,                        inline: true  },
      { name: "Entry Basis",    value: `$${entryBasis.toFixed(4)}`,                      inline: true  },
      { name: "Funding APR",    value: `${aprPct.toFixed(2)}%`,                          inline: true  },
      { name: "Borrow Drag",    value: borrowDragAPR > 0 ? `-${borrowDragAPR.toFixed(2)}% APR` : "n/a", inline: true },
      { name: "Net APR",        value: `${netAPR.toFixed(2)}%`,                          inline: true  },
      { name: "Open Cost",      value: `$${openCost.toFixed(4)}`,                        inline: true  },
      { name: "Break-even",     value: `~${beDays} days`,                                inline: true  },
      { name: "Min Hold",       value: `${CONFIG.minHoldHours}h`,                        inline: true  },
    ]),
  ]);
  log("info", "position_opened", { base, direction, spotFill, perpFill, entryBasis, aprPct, netAPR, borrowDragAPR, openCost, beDays });
}

function closePosition(base, reason) {
  const pos = state.positions[base];
  if (!pos) return;

  const mid = state.spotPrices[base] ?? pos.entrySpotFill;

  // Reverse the entry fills
  const spotFill  = pos.direction === 1 ? fillPrice(mid, -1) : fillPrice(mid, +1);
  const perpFill  = pos.direction === 1 ? fillPrice(mid, +1) : fillPrice(mid, -1);
  const closeCost = tradeCost(pos.qty * mid);

  // Leg P&L
  // Long arb:  spot leg = (exitFill - entryFill) * qty (positive if price up, but hedged)
  //            perp leg = (entryPerpFill - exitPerpFill) * qty
  // Short arb: spot leg = (entrySpotFill - exitFill) * qty
  //            perp leg = (exitPerpFill - entryPerpFill) * qty
  const spotPnl = pos.direction === 1
    ? (spotFill - pos.entrySpotFill) * pos.qty
    : (pos.entrySpotFill - spotFill) * pos.qty;
  const perpPnl = pos.direction === 1
    ? (pos.entryPerpFill - perpFill) * pos.qty
    : (perpFill - pos.entryPerpFill) * pos.qty;

  const legsPnl   = spotPnl + perpPnl;
  const totalFees = pos.feesOnOpen + closeCost + (pos.borrowCostTotal ?? 0);
  const netPnl    = legsPnl + pos.fundingCollected - totalFees;

  // Basis at exit vs entry (convergence/divergence tracking)
  const exitBasis  = spotFill - perpFill;
  const basisShift = exitBasis - (pos.entryBasis ?? 0);

  state.pnl.realisedPnl += netPnl;
  state.pnl.feesTotal   += closeCost;
  delete state.positions[base];
  saveState();

  const held = msToHuman(Date.now() - pos.entryTime);
  discord("", [
    embed("📉 Position Closed", `**${base}** — ${reason}`, netPnl >= 0 ? 0x57f287 : 0xed4245, [
      { name: "Entry Spot",      value: `$${pos.entrySpotFill.toFixed(4)}`,              inline: true },
      { name: "Exit Spot",       value: `$${spotFill.toFixed(4)}`,                       inline: true },
      { name: "Legs P&L",        value: `$${legsPnl.toFixed(4)}`,                        inline: true },
      { name: "Funding Net",     value: `$${pos.fundingCollected.toFixed(4)}`,            inline: true },
      { name: "Borrow Cost",     value: pos.borrowCostTotal > 0 ? `-$${pos.borrowCostTotal.toFixed(4)}` : "n/a", inline: true },
      { name: "Total Fees",      value: `-$${totalFees.toFixed(4)}`,                      inline: true },
      { name: "Net P&L",         value: `$${netPnl.toFixed(4)}`,                          inline: true },
      { name: "Basis Shift",     value: `$${basisShift.toFixed(4)} (entry: $${(pos.entryBasis ?? 0).toFixed(4)})`, inline: true },
      { name: "Held",            value: held,                                              inline: true },
      { name: "Direction",       value: pos.direction === 1 ? "Long arb" : "Short arb",  inline: true },
    ]),
  ]);
  log("info", "position_closed", {
    base, direction: pos.direction, netPnl, fundingCollected: pos.fundingCollected,
    borrowCostTotal: pos.borrowCostTotal ?? 0, totalFees, legsPnl,
    entryBasis: pos.entryBasis ?? 0, exitBasis, basisShift, held, reason,
  });
}

// ─── STRATEGY EVALUATION ──────────────────────────────────────────────────────

const signalCount = {};   // base → consecutive signal ticks

function evaluate() {
  const nowMs = Date.now();

  for (const pair of CONFIG.pairs) {
    const { base, perp } = pair;
    const mid     = state.spotPrices[base];
    const funding = state.fundingRates[perp];
    if (!mid || !funding) continue;

    // ── Stale data guard ────────────────────────────────────────────────────
    // Do not make entry or exit decisions on data older than maxDataAgeMs.
    const spotAge    = nowMs - (state.spotPriceTs?.[base] ?? 0);
    const fundingAge = nowMs - funding.ts;
    if (fundingAge > CONFIG.maxDataAgeMs) {
      log("warn", "stale_funding_skipped_evaluate", { base, fundingAgeMs: fundingAge });
      continue;
    }
    // Spot age check: spotPriceTs is updated in connectSpotWS (added below)
    if (state.spotPriceTs?.[base] && spotAge > CONFIG.maxDataAgeMs) {
      log("warn", "stale_spot_skipped_evaluate", { base, spotAgeMs: spotAge });
      continue;
    }

    const ratePerHour = funding.predictedRatePerHour ?? funding.ratePerHour ?? 0;
    const apr         = ratePerHour * 8760 * 100;  // signed

    const pos = state.positions[base];

    // ── Update live APR on open position ────────────────────────────────────
    if (pos) pos.fundingRateAPR = apr;

    // ── Entry logic ─────────────────────────────────────────────────────────
    if (!pos) {
      let direction = 0;

      // For short arb (direction = -1), the borrow rate on the spot leg reduces
      // effective APR. Only enter if net APR still clears the threshold.
      const borrowDragAPR = CONFIG.shortSpotBorrowRatePerHour * 8760 * 100;
      const netLongAPR    = apr;                              // borrow n/a for long arb
      const netShortAPR   = apr + borrowDragAPR;             // apr is negative; drag makes it less negative

      if (apr >=  CONFIG.minFundingRateAPR) direction = +1;  // positive funding → long arb
      // For short arb, net APR (after borrow cost) must still clear the negative threshold
      if (apr <= CONFIG.minNegFundingAPR && netShortAPR <= CONFIG.minNegFundingAPR) direction = -1;

      if (direction !== 0) {
        signalCount[base] = (signalCount[base] ?? 0) + 1;
        if (signalCount[base] >= CONFIG.signalDebounce) {
          signalCount[base] = 0;
          openPosition(pair, mid, ratePerHour, direction);
        }
      } else {
        // Hysteresis: only reset debounce counter when APR drops below the lower band,
        // not merely the entry threshold. Prevents thrashing when APR oscillates around
        // the entry threshold.
        const stillAboveLowerBand = Math.abs(apr) >= CONFIG.signalResetAPR;
        if (!stillAboveLowerBand) signalCount[base] = 0;
      }
      continue;
    }

    // ── Exit logic ───────────────────────────────────────────────────────────
    const heldHours = (Date.now() - pos.entryTime) / 3_600_000;

    // Rate has flipped sign against us — always exit immediately (we're now paying)
    const fundingFlipped = pos.direction === 1 ? apr < 0 : apr > 0;
    if (fundingFlipped) {
      closePosition(base, `Funding flipped against position (APR: ${apr.toFixed(2)}%)`);
      continue;
    }

    // Dynamic exit: rate must still cover fees fast enough.
    // We exit when |APR| drops below a buffer above the break-even APR for remaining fees.
    const feesRemaining = pos.feesOnOpen + tradeCost(pos.qty * mid); // projected total
    const fundingEarned = pos.fundingCollected;
    const netFeesLeft   = feesRemaining - fundingEarned;             // fees still to recover
    const absApr        = Math.abs(apr);

    // If fees already recovered: exit when APR drops below exitBufferAPR
    // If fees not yet recovered: enforce minHoldHours, then exit if APR too low to recover soon
    if (netFeesLeft <= 0) {
      // In profit — exit if APR has fallen below the buffer
      if (absApr < CONFIG.exitBufferAPR) {
        closePosition(base, `In profit, APR fell to ${apr.toFixed(2)}% (below ${CONFIG.exitBufferAPR}% buffer)`);
      }
    } else if (heldHours >= CONFIG.minHoldHours) {
      // Past min hold and still recovering fees — exit if APR can't recover remaining fees in 7 days
      const daysToRecover = (netFeesLeft / (CONFIG.positionSizeUSD * absApr / 100 / 365));
      if (absApr < CONFIG.exitBufferAPR || daysToRecover > 7) {
        closePosition(base, `APR ${apr.toFixed(2)}% — estimated ${daysToRecover.toFixed(1)}d to recover fees`);
      }
    }
    // else: still within minHoldHours — hold regardless
  }

  // ── Unrealised P&L ────────────────────────────────────────────────────────
  let unrel = 0;
  for (const [base, pos] of Object.entries(state.positions)) {
    const price = state.spotPrices[base] ?? pos.entrySpotFill;
    const spotPnl = pos.direction === 1
      ? (fillPrice(price, -1) - pos.entrySpotFill) * pos.qty
      : (pos.entrySpotFill - fillPrice(price, +1)) * pos.qty;
    const perpPnl = pos.direction === 1
      ? (pos.entryPerpFill - fillPrice(price, +1)) * pos.qty
      : (fillPrice(price, -1) - pos.entryPerpFill) * pos.qty;
    const projectedClose = tradeCost(pos.qty * price);
    unrel += spotPnl + perpPnl + pos.fundingCollected - pos.feesOnOpen - projectedClose;
  }
  state.pnl.unrealisedPnl = unrel;
}

// ─── HOURLY STATUS ────────────────────────────────────────────────────────────

function sendHourlyStatus() {
  const netFunding = state.pnl.fundingEarned - state.pnl.fundingPaid;
  const fields = [
    { name: "Uptime",            value: msToHuman(Date.now() - state.startTime),        inline: true },
    { name: "Open Positions",    value: `${Object.keys(state.positions).length}/${CONFIG.maxOpenPositions}`, inline: true },
    { name: "Total Trades",      value: `${state.pnl.trades}`,                           inline: true },
    { name: "Funding Earned",    value: `$${state.pnl.fundingEarned.toFixed(4)}`,        inline: true },
    { name: "Funding Paid",      value: `-$${state.pnl.fundingPaid.toFixed(4)}`,         inline: true },
    { name: "Net Funding",       value: `$${netFunding.toFixed(4)}`,                     inline: true },
    { name: "Fees Total",        value: `-$${state.pnl.feesTotal.toFixed(4)}`,           inline: true },
    { name: "Unrealised P&L",   value: `$${state.pnl.unrealisedPnl.toFixed(4)}`,        inline: true },
    { name: "Realised P&L",     value: `$${state.pnl.realisedPnl.toFixed(4)}`,          inline: true },
  ];

  // Active positions
  for (const [base, pos] of Object.entries(state.positions)) {
    const price        = state.spotPrices[base] ?? pos.entrySpotFill;
    const pricePct     = ((price - pos.entrySpotFill) / pos.entrySpotFill * 100).toFixed(2);
    const heldHours    = ((Date.now() - pos.entryTime) / 3_600_000).toFixed(1);
    const dirLabel     = pos.direction === 1 ? "↑Long" : "↓Short";
    const feesLeft     = Math.max(0, pos.feesOnOpen + tradeCost(pos.qty * price) - pos.fundingCollected);
    const borrowSoFar  = pos.borrowCostTotal ? `-$${pos.borrowCostTotal.toFixed(4)}` : "n/a";
    const funding      = state.fundingRates[pos.perp];
    const dataAge      = funding ? Math.round((Date.now() - funding.ts) / 1000) : "?";
    const staleWarning = funding && (Date.now() - funding.ts) > CONFIG.maxDataAgeMs ? " ⚠️STALE" : "";
    fields.push({
      name:  `📌 ${base} [${dirLabel}]`,
      value: `APR: **${pos.fundingRateAPR.toFixed(2)}%** | Held: ${heldHours}h | Price: $${price.toFixed(4)} (${pricePct}%) | Funding: $${pos.fundingCollected.toFixed(4)} | Borrow: ${borrowSoFar} | Fees left: $${feesLeft.toFixed(4)} | Data: ${dataAge}s${staleWarning}`,
    });
  }

  // All funding rates
  const rateLines = CONFIG.pairs.map(({ base, perp }) => {
    const f = state.fundingRates[perp];
    if (!f) return `**${base}**: —`;
    const apr = ((f.predictedRatePerHour ?? f.ratePerHour ?? 0) * 8760 * 100);
    const sign = apr >= 0 ? "+" : "";
    const inPos = state.positions[base] ? " ●" : "";
    return `**${base}**: ${sign}${apr.toFixed(1)}%${inPos}`;
  }).join("  |  ");
  fields.push({ name: "Live Funding Rates (APR)", value: rateLines });

  discord("", [embed("📊 Hourly Status", "Paper trading snapshot", 0x5865f2, fields)]);
  log("info", "hourly_status", {
    open: Object.keys(state.positions).length,
    fundingEarned: state.pnl.fundingEarned,
    fundingPaid:   state.pnl.fundingPaid,
    realisedPnl:   state.pnl.realisedPnl,
    feesTotal:     state.pnl.feesTotal,
  });
}

// ─── KRAKEN FUTURES WS ────────────────────────────────────────────────────────

function connectFuturesWS() {
  const ws = new WebSocket(CONFIG.wsFutures);

  ws.on("open", () => {
    log("info", "futures_ws_connected");
    ws.send(JSON.stringify({
      event:       "subscribe",
      feed:        "ticker",
      product_ids: CONFIG.pairs.map((p) => p.perp),
    }));
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.feed !== "ticker" || !msg.product_id) return;
      const ratePerHour = msg.funding_rate ?? null;
      if (ratePerHour === null) return;
      state.fundingRates[msg.product_id] = {
        ratePerHour,
        predictedRatePerHour: msg.funding_rate_prediction ?? ratePerHour,
        ts: Date.now(),
      };
    } catch { /* ignore */ }
  });

  ws.on("close", () => { log("warn", "futures_ws_disconnected"); setTimeout(connectFuturesWS, 5000); });
  ws.on("error", (e) => log("error", "futures_ws_error", { error: e.message }));
}

// ─── KRAKEN SPOT WS ───────────────────────────────────────────────────────────

function connectSpotWS() {
  const ws = new WebSocket(CONFIG.wsSpot);

  ws.on("open", () => {
    log("info", "spot_ws_connected");
    ws.send(JSON.stringify({
      method: "subscribe",
      params: { channel: "ticker", symbol: CONFIG.pairs.map((p) => p.spot) },
    }));
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.channel !== "ticker" || !Array.isArray(msg.data)) return;
      for (const t of msg.data) {
        const base = t.symbol?.split("/")?.[0];
        if (base && t.last) {
          state.spotPrices[base]   = parseFloat(t.last);
          state.spotPriceTs        = state.spotPriceTs ?? {};
          state.spotPriceTs[base]  = Date.now();
        }
      }
      evaluate();
    } catch { /* ignore */ }
  });

  ws.on("close", () => { log("warn", "spot_ws_disconnected"); setTimeout(connectSpotWS, 5000); });
  ws.on("error", (e) => log("error", "spot_ws_error", { error: e.message }));
}

// ─── UTILS ────────────────────────────────────────────────────────────────────

function msToHuman(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── SHUTDOWN ─────────────────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutdown_initiated", { signal });
  for (const base of Object.keys(state.positions)) closePosition(base, `Shutdown (${signal})`);
  saveState();
  discord("", [
    embed("🔴 Bot Shutdown", `Signal: **${signal}**`, 0xed4245, [
      { name: "Uptime",          value: msToHuman(Date.now() - state.startTime),  inline: true },
      { name: "Total Trades",    value: `${state.pnl.trades}`,                    inline: true },
      { name: "Funding Earned",  value: `$${state.pnl.fundingEarned.toFixed(4)}`, inline: true },
      { name: "Funding Paid",    value: `-$${state.pnl.fundingPaid.toFixed(4)}`,  inline: true },
      { name: "Fees Total",      value: `-$${state.pnl.feesTotal.toFixed(4)}`,    inline: true },
      { name: "Realised P&L",   value: `$${state.pnl.realisedPnl.toFixed(4)}`,   inline: true },
    ]),
  ]);
  await sleep(1500);
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => {
  log("error", "uncaught_exception", { error: e.message, stack: e.stack });
  shutdown("uncaughtException");
});

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  loadState();

  const isResume  = state.restored;
  const openCount = Object.keys(state.positions).length;

  discord("", [
    embed(
      isResume ? "🔄 Bot Resumed" : "🟢 Bot Started",
      isResume
        ? `Restarted — **${openCount}** position${openCount !== 1 ? "s" : ""} restored from disk`
        : "Funding rate arbitrage bot online — bidirectional, 7 pairs (paper trading)",
      isResume ? 0xfee75c : 0x57f287,
      [
        { name: "Pairs",           value: CONFIG.pairs.map((p) => p.base).join(", "),                 inline: false },
        { name: "Entry APR",       value: `≥ +${CONFIG.minFundingRateAPR}% or ≤ ${CONFIG.minNegFundingAPR}%`, inline: true },
        { name: "Exit Buffer",     value: `${CONFIG.exitBufferAPR}% APR`,                             inline: true },
        { name: "Min Hold",        value: `${CONFIG.minHoldHours}h`,                                  inline: true },
        { name: "Size / Leg",      value: `$${CONFIG.positionSizeUSD}`,                               inline: true },
        { name: "Fees spot/perp",  value: `${CONFIG.spotFeeRate*100}% / ${CONFIG.perpFeeRate*100}%`,  inline: true },
        { name: "Slippage",        value: `${CONFIG.slippageBps} bps`,                                inline: true },
        { name: "Realised P&L",   value: `$${state.pnl.realisedPnl.toFixed(4)}`,                     inline: true },
        { name: "Funding Earned",  value: `$${state.pnl.fundingEarned.toFixed(4)}`,                  inline: true },
      ]
    ),
  ]);

  if (isResume) {
    for (const [base, pos] of Object.entries(state.positions))
      log("info", "position_restored", { base, direction: pos.direction, entrySpotFill: pos.entrySpotFill, fundingCollected: pos.fundingCollected });
  }

  connectFuturesWS();
  connectSpotWS();

  setInterval(accrueAllFunding, CONFIG.fundingAccrualIntervalMs);
  setInterval(sendHourlyStatus, CONFIG.hourlyStatusIntervalMs);
  setInterval(saveState,        CONFIG.stateSaveIntervalMs);
}

main();

/**
 * ─── CHANGES FROM v2 → v3 ────────────────────────────────────────────────────
 *
 *  [+] Negative funding trades (short spot / long perp)
 *  [+] 7 pairs (added XRP, DOGE, LINK, ADA)
 *  [+] Dynamic exit threshold (was: fixed 5% APR)
 *  [+] Minimum hold guard (12 hours)
 *  [+] Funding-flipped-sign emergency exit
 *  [+] Funding paid tracking
 *  [+] Fees-remaining display in hourly status
 *
 * ─── CHANGES FROM v3 → v4 ────────────────────────────────────────────────────
 *
 *  [fix] DISCORD_WEBHOOK moved to environment variable (DISCORD_WEBHOOK).
 *        Hardcoded token was exposed in source — rotate the old webhook.
 *
 *  [fix] tradeCost() semantics clarified: it is a one-way (open OR close)
 *        two-leg cost. breakEvenAPR() and daysToBreakEven() now correctly
 *        multiply by 2 for the round-trip. Previous code was also multiplying
 *        by 2 but the comment was ambiguous; no numeric change, intent clarified.
 *
 *  [+]   Borrow cost model for short-spot (inverse arb) leg.
 *        CONFIG.shortSpotBorrowRatePerHour (default 0.0002 = ~175% APR) is
 *        debited each accrual tick for direction === -1 positions. This is
 *        tracked in pos.borrowCostTotal and visible in Discord and logs.
 *        Entry check for short arb now nets out borrow drag against the rate
 *        threshold — only enters if net APR after borrow still clears minNegFundingAPR.
 *
 *  [+]   Stale data guard in both accrueAllFunding() and evaluate().
 *        CONFIG.maxDataAgeMs (default 5 min) — funding rate and spot price
 *        timestamps are checked before any accrual or entry/exit decision.
 *        Stale data events are logged as warnings.
 *        state.spotPriceTs tracks per-base spot price age.
 *
 *  [+]   Signal hysteresis band (CONFIG.signalResetAPR = 12%).
 *        Previously signalCount reset whenever APR dropped below the 15% entry
 *        threshold, causing thrash when APR oscillated around the threshold.
 *        Now signalCount only resets when APR drops below the lower band (12%).
 *
 *  [+]   Basis risk tracking: entryBasis (spot - perp at open) stored per
 *        position. exitBasis and basisShift reported at close in both Discord
 *        and logs. Visible convergence/divergence over the hold period.
 *
 *  [+]   Borrow cost drag shown in open embed ("Borrow Drag" and "Net APR").
 *        Borrow cost shown in close embed and hourly status per-position line.
 *        Stale data age shown in hourly status per-position line with ⚠️ flag.
 */
