// Cloudflare Worker: CORS proxy for CoinMarketCap top-50 listings.
// Optional secret: CMC_KEY (your free CoinMarketCap Basic API key). Without it the keyless route is used.

const ALLOWED_ORIGINS = [
  "https://koosbilly9.github.io",
  // "https://signals.to-web.co.za",   // add your own domain here when you use it
];

const QS = "start=1&limit=50&convert=USD&sort=market_cap&sort_dir=desc";
const CMC_BASE = "https://pro-api.coinmarketcap.com";
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
    if (url.pathname !== "/listings") {
      return jsonResponse({ error: "Not found" }, 404, cors);
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

    const base = env.CMC_KEY
      ? `${CMC_BASE}/v1/cryptocurrency/listings/latest?`
      : `${CMC_BASE}/public-api/v1/cryptocurrency/listings/latest?`;
    const headers = { Accept: "application/json" };
    if (env.CMC_KEY) headers["X-CMC_PRO_API_KEY"] = env.CMC_KEY;

    let upstream;
    try {
      upstream = await fetch(base + QS, {
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