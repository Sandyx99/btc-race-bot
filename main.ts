// Range trader for cbBTC (CBBTC/USDC), long only, one asset.
//
// Idea: on 1-minute bars the price spends most of a day oscillating inside a
// wide range (the dev window ran $63,874-$65,467, ending +0.49%). Fast
// trend-following bleeds on this: every round trip costs ~26 bps in fee,
// slippage and price impact, and 1-minute EMA crosses whipsaw dozens of
// times a day. So this bot trades rarely and only at the edges of the range:
// it buys near the 8-hour low and sells near the 8-hour high, with a hard
// stop and a take-profit so no single trade can hurt it much.
//
// Rules, read again on every bar's close (fills land at the next bar's open):
//   - Entry (flat only): at least 480 bars of history, close inside the
//     bottom 15% of the last 480 bars' high-low range, the close ticked up
//     from the previous bar (a small reversal confirmation), and the 480-bar
//     return is no worse than -2% (do not catch a knife in a hard downtrend).
//     Buys with all available cash.
//   - Exit (holding): the whole position is sold when the close reaches the
//     top 10% of the same 480-bar range, or the position is worth 1.2% over
//     its cost (take-profit), or 0.6% under it (stop-loss).
//   - At most one order per reply; max slippage 100 bps from the close the
//     order was decided on, so a fill into a sudden gap is refused and the
//     signal is re-read on the next bar.
//
// Everything is a pure function of the bars seen so far (float64 arithmetic
// only, no clock, no environment, no randomness), so two runs on the same
// data produce the same orders.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Bars of history a range is measured over (8 hours of 1-minute bars). */
const LOOKBACK = 480;
/** Buy when the close sits in the bottom 15% of the lookback range. */
const BUY_ZONE = 0.15;
/** Sell when the close reaches the top 10% of the lookback range. */
const SELL_ZONE = 0.10;
/** Take-profit: position worth 101.2% of its cost. */
const TAKE_PROFIT = 1.012;
/** Stop-loss: position worth 99.4% of its cost. */
const STOP_LOSS = 0.994;
/** Do not buy into a 480-bar fall worse than -2%. */
const DOWNTREND_GUARD = -0.02;
/** Max slippage, in bps from the close the order was decided on. */
const MAX_SLIPPAGE_BPS = 100;

/** The closes, highs and lows seen so far, oldest first. */
const closes: number[] = [];
const highs: number[] = [];
const lows: number[] = [];

function rangeHighLow(): { hi: number; lo: number } | null {
  // The range is measured over the 480 bars BEFORE the current one, so the
  // bar being decided on never widens its own range.
  if (closes.length < LOOKBACK + 1) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = closes.length - LOOKBACK - 1; i < closes.length - 1; i++) {
    if (highs[i]! > hi) hi = highs[i]!;
    if (lows[i]! < lo) lo = lows[i]!;
  }
  return { hi, lo };
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      closes.push(Number(bar.c));
      highs.push(Number(bar.h));
      lows.push(Number(bar.l));
    }
    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    const held = state.positions.get(SYMBOL);
    const range = rangeHighLow();
    if (range === null) return [];
    const span = range.hi - range.lo;
    if (span <= 0) return [];

    if (held === undefined) {
      const prevClose = closes.length >= 2 ? closes[closes.length - 2]! : close;
      const longReturn = closes[closes.length - LOOKBACK - 1] !== undefined
        ? close / closes[closes.length - LOOKBACK - 1]! - 1
        : 0;
      const inBuyZone = close <= range.lo + BUY_ZONE * span;
      const tickedUp = close > prevClose;
      const notFalling = longReturn >= DOWNTREND_GUARD;
      if (inBuyZone && tickedUp && notFalling && state.cash > 0n) {
        const buy: BuyInput = {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        return [buy];
      }
      return [];
    }

    const value = state.value(SYMBOL, held.qty);
    const cost = held.cost;
    const nearTop = close >= range.hi - SELL_ZONE * span;
    const takeProfit = Number(value) >= Number(cost) * TAKE_PROFIT;
    const stopLoss = Number(value) <= Number(cost) * STOP_LOSS;
    if (nearTop || takeProfit || stopLoss) {
      const sell: SellInput = {
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      return [sell];
    }
    return [];
  },
});
