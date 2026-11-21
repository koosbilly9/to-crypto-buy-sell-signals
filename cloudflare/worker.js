// Cloudflare Worker: CORS proxy for CoinMarketCap top-50 listings.
// Optional secret: CMC_KEY (your free CoinMarketCap Basic API key). Without it the keyless route is used.

const ALLOWED_ORIGINS = [
  "https://koosbilly9.github.io",
  "null",
  // "https://signals.to-web.co.za",   // add your own domain here when you use it
];

const QS = "start=1&limit=50&convert=USD&sort=market_cap&sort_dir=desc";
const CMC_BASE = "https://pro-api.coinmarketcap.com";
const YAHOO_SYMBOLS = {
  sp500: "^GSPC",
  nasdaq100: "^NDX",
};
const UPSTREAM_CACHE = {
  cacheEverything: true,
  cacheTtlByStatus: {
    "200-299": 600,
    "300-599": -1,
  },
};

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

async function proxyHistory(asset, cors) {
  const symbol = YAHOO_SYMBOLS[asset];
  if (!symbol) {
    return jsonResponse({ error: "Unsupported market history asset" }, 400, cors);
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let upstream;
  try {
    upstream = await fetch(url, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      cf: UPSTREAM_CACHE,
      signal: controller.signal,
    });
  } catch (error) {
    console.error("Yahoo Finance request failed:", error);
    return jsonResponse({ error: "Market history request failed" }, 502, cors);
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    console.error("Yahoo Finance returned HTTP", upstream.status);
    return jsonResponse({ error: "Market history request failed" }, 502, cors);
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch (error) {
    console.error("Yahoo Finance returned invalid JSON:", error);
    return jsonResponse({ error: "Market history response was invalid" }, 502, cors);
  }

  const result = payload && payload.chart && Array.isArray(payload.chart.result) && payload.chart.result[0];
  const timestamps = result && result.timestamp;
  const quote = result && result.indicators && result.indicators.quote &&
    result.indicators.quote[0];
  const closes = quote && quote.close;
  const highs = quote && quote.high;
  const lows = quote && quote.low;
  if (!Array.isArray(timestamps) || !Array.isArray(closes) || timestamps.length !== closes.length) {
    console.error("Yahoo Finance returned an invalid chart.");
    return jsonResponse({ error: "Market history response was invalid" }, 502, cors);
  }

  const now = new Date();
  const currentUtcDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const points = [];
  for (let i = 0; i < timestamps.length; i++) {
    const time = timestamps[i] * 1000;
    const close = closes[i];
    const high = Array.isArray(highs) ? highs[i] : close;
    const low = Array.isArray(lows) ? lows[i] : close;
    if (Number.isSafeInteger(time) && time > 0 && time < currentUtcDay &&
        Number.isFinite(close) && close > 0 &&
        Number.isFinite(high) && Number.isFinite(low) &&
        high >= close && low <= close && high >= low && low > 0) {
      points.push([time, close, high, low]);
    }
  }
  if (!points.length) {
    return jsonResponse({ error: "Market history was empty" }, 502, cors);
  }

  return jsonResponse({ symbol, currency: result.meta && result.meta.currency, points }, 200, {
    ...cors,
    "Cache-Control": "public, max-age=900",
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = origin && ALLOWED_ORIGINS.includes(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Vary": "Origin",
        }
      : { "Vary": "Origin" };

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return jsonResponse({ error: "Origin not allowed" }, 403, cors);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Headers": "Accept",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405, {
        ...cors,
        "Allow": "GET, OPTIONS",
      });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/listings" && url.pathname !== "/global" && url.pathname !== "/history") {
      return jsonResponse({ error: "Not found" }, 404, cors);
    }
    if (url.pathname === "/history" &&
        (url.searchParams.getAll("asset").length !== 1 ||
         [...url.searchParams.keys()].some((key) => key !== "asset"))) {
      return jsonResponse({ error: "Invalid market history asset" }, 400, cors);
    }

    if (!env.CMC_RATE_LIMITER || typeof env.CMC_RATE_LIMITER.limit !== "function") {
      console.error("CMC_RATE_LIMITER binding is missing or invalid.");
      return jsonResponse({ error: "Rate limiting is unavailable" }, 503, cors);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    let allowed;
    try {
      ({ success: allowed } = await env.CMC_RATE_LIMITER.limit({ key: `listings:${ip}` }));
    } catch (error) {
      console.error("CMC_RATE_LIMITER check failed:", error);
      return jsonResponse({ error: "Rate limiting is unavailable" }, 503, cors);
    }

    if (typeof allowed !== "boolean") {
      console.error("CMC_RATE_LIMITER returned an invalid result.");
      return jsonResponse({ error: "Rate limiting is unavailable" }, 503, cors);
    }

    if (!allowed) {
      return jsonResponse({ error: "Rate limit exceeded" }, 429, {
        ...cors,
        "Retry-After": "60",
      });
    }

    if (url.pathname === "/history") {
      return proxyHistory(url.searchParams.get("asset"), cors);
    }

    const endpoint = url.pathname === "/global"
      ? "/v1/global-metrics/quotes/latest?convert=USD"
      : `/v1/cryptocurrency/listings/latest?${QS}`;
    const base = env.CMC_KEY ? CMC_BASE : `${CMC_BASE}/public-api`;
    const headers = { Accept: "application/json" };
    if (env.CMC_KEY) headers["X-CMC_PRO_API_KEY"] = env.CMC_KEY;

    let upstream;
    try {
      upstream = await fetch(base + endpoint, {
        headers,
        redirect: "manual",
        cf: UPSTREAM_CACHE,
      });
    } catch (error) {
      console.error("CoinMarketCap request failed:", error);
      return jsonResponse({ error: "CoinMarketCap request failed" }, 502, cors);
    }

    if (!upstream.ok) {
      const status = upstream.status === 429 ? 429 : 502;
      const errorHeaders = { ...cors };
      if (status === 429) {
        const retryAfter = upstream.headers.get("Retry-After");
        if (retryAfter) {
          errorHeaders["Retry-After"] = retryAfter;
          if (origin && ALLOWED_ORIGINS.includes(origin)) {
            errorHeaders["Access-Control-Expose-Headers"] = "Retry-After";
          }
        }
      }
      console.error("CoinMarketCap returned HTTP", upstream.status);
      return jsonResponse(
        { error: "CoinMarketCap request failed", upstream_status: upstream.status },
        status,
        errorHeaders,
      );
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    });
  },
};