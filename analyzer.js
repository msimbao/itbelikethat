const fs = require("fs");
const lines = fs.readFileSync("fundingbot_log.json", "utf8")
  .split("\n").filter(Boolean).map(l => JSON.parse(l));

const trades = lines.filter(l => l.type === "CLOSE");
const total  = trades.reduce((s, t) => s + t.netPnl, 0);
const wins   = trades.filter(t => t.netPnl >= 0).length;

console.log(`Trades     : ${trades.length}`);
console.log(`Win rate   : ${((wins / trades.length) * 100).toFixed(1)}%`);
console.log(`Total PnL  : $${total.toFixed(4)}`);
console.log(`Avg PnL    : $${(total / trades.length).toFixed(4)}`);
console.log(`Best trade : $${Math.max(...trades.map(t => t.netPnl)).toFixed(4)}`);
console.log(`Worst trade: $${Math.min(...trades.map(t => t.netPnl)).toFixed(4)}`);

// Breakdown by symbol
const bySymbol = {};
for (const t of trades) {
  if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { count: 0, pnl: 0 };
  bySymbol[t.symbol].count++;
  bySymbol[t.symbol].pnl += t.netPnl;
}
console.log("\nBy symbol:");
Object.entries(bySymbol)
  .sort((a, b) => b[1].pnl - a[1].pnl)
  .forEach(([s, v]) => console.log(`  ${s.padEnd(14)} ${v.count} trades  $${v.pnl.toFixed(4)}`));
