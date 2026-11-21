# crypto-buy-sell-signals

## Price chart

The chart uses the existing Binance requests to show up to 30 completed UTC daily closes, a rolling MA200, and up to five years of highs and lows. The MA200 requires 200 consecutive completed days; the high and low also include the latest available candle. Binance USDT prices are approximate USD. Stablecoins and coins without available Binance history may not have a chart.

The three realized-price levels are fixed BTC defaults, not live data, and are hidden for other coins. Chart history and preferences are stored in browser local storage, not cookies. Changing the chart makes no provider requests; market data normally uses a two-hour cache in each browser profile, not a cache shared across visitors. Older saved snapshots gain chart history at the next permitted refresh. Bitcoin Fear & Greed is fetched separately.

## Cloudflare Worker

[`cloudflare/worker.js`](cloudflare/worker.js) proxies CoinMarketCap listings and global metrics, plus five-year S&P 500 and Nasdaq 100 history from Yahoo Finance. `/history` only accepts the configured `sp500` and `nasdaq100` assets. Deploy it with Wrangler using [`wrangler.toml`](wrangler.toml); it is not deployed automatically. Before deploying, choose a positive `namespace_id` in that file that is unique in your Cloudflare account. The rate-limit binding allows up to 10 requests per minute per IP, per Cloudflare location; it is approximate, not a global quota. CORS permits the listed website origins and `null` for local `file://` previews; it is not authentication, and the proxy only returns public market data.

The rate-limit binding requires Wrangler 4.36.0 or later and is not configured in the dashboard editor. From the repository root, run `npx wrangler deploy`. If using a CoinMarketCap API key, set it separately with `npx wrangler secret put CMC_KEY`; do not commit the key. Without a key, the Worker uses CoinMarketCap's keyless endpoint. The upstream cache is per Cloudflare location for successful responses; errors are not cached. The browser caches successful responses for five minutes.

## Tests

Run `node --test tests/price-chart.test.js` and `node --test tests/worker.test.mjs`.