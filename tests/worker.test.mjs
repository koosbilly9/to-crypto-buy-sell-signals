import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../cloudflare/worker.js", import.meta.url), "utf8");
const { default: worker } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

const SITE = "https://koosbilly9.github.io";
const OTHER = "https://example.com";
const API = "https://pro-api.coinmarketcap.com";
const env = {
  CMC_RATE_LIMITER: {
    calls: [],
    async limit(input) {
      this.calls.push(input);
      return { success: true };
    },
  },
};

function request(path = "/listings", options = {}) {
  const headers = new Headers({ Origin: SITE, "CF-Connecting-IP": "192.0.2.10" });
  new Headers(options.headers).forEach((value, name) => headers.set(name, value));
  return new Request(`https://crypto-proxy.example${path}`, { ...options, headers });
}

async function withFetch(mock, run) {
  const original = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = mock;
  console.error = () => {};
  try {
    await run();
  } finally {
    globalThis.fetch = original;
    console.error = originalError;
  }
}

test("allows configured browser origins and rejects unknown origins", async () => {
  await withFetch(async () => new Response('{"data":[]}'), async () => {
    const allowed = await worker.fetch(request(), env);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), SITE);

    const rejected = await worker.fetch(
      request("/listings", { headers: { Origin: OTHER } }),
      env,
    );
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(env.CMC_RATE_LIMITER.calls.length, 1);
  });
});

test("allows the null origin for local file previews", async () => {
  await withFetch(async () => new Response('{"data":[]}'), async () => {
    const response = await worker.fetch(
      request("/listings", { headers: { Origin: "null" } }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "null");
  });
});

test("allows preflight and rejects other methods without upstream calls", async () => {
  await withFetch(async () => {
    throw new Error("unexpected upstream request");
  }, async () => {
    const preflight = await worker.fetch(
      request("/listings", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET" } }),
      env,
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), SITE);
    assert.equal(preflight.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");

    const post = await worker.fetch(request("/listings", { method: "POST" }), env);
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("Allow"), "GET, OPTIONS");

    const missing = await worker.fetch(request("/other"), env);
    assert.equal(missing.status, 404);
  });
});

test("serves total market cap from the global metrics endpoint", async () => {
  await withFetch(async (url, options) => {
    assert.equal(url, `${API}/v1/global-metrics/quotes/latest?convert=USD`);
    assert.equal(options.headers["X-CMC_PRO_API_KEY"], "test-key");
    return new Response('{"data":{"quote":{"USD":{"total_market_cap":100}}}}');
  }, async () => {
    const response = await worker.fetch(request("/global"), { ...env, CMC_KEY: "test-key" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.quote.USD.total_market_cap, 100);
  });
});

test("serves supported index history and rejects unknown symbols", async () => {
  const yesterday = Math.floor(Date.now() / 86400000) * 86400 - 86400;
  await withFetch(async (url, options) => {
    assert.equal(url, "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=5y&interval=1d");
    assert.equal(options.redirect, "manual");
    return new Response(JSON.stringify({
      chart: {
        result: [{
          meta: { currency: "USD" },
          timestamp: [yesterday],
          indicators: { quote: [{ close: [6000], high: [6010], low: [5990] }] },
        }],
      },
    }), { headers: { "Content-Type": "application/json" } });
  }, async () => {
    const response = await worker.fetch(request("/history?asset=sp500"), env);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).points, [[yesterday * 1000, 6000, 6010, 5990]]);
    assert.equal((await worker.fetch(request("/history?asset=unknown"), env)).status, 400);
  });
});

test("requires a working rate-limit binding and keys its limit by client IP", async () => {
  await withFetch(async () => {
    throw new Error("upstream must not be called");
  }, async () => {
    const missing = await worker.fetch(request(), {});
    assert.equal(missing.status, 503);

    const deniedEnv = {
      CMC_RATE_LIMITER: { limit: async () => ({ success: false }) },
    };
    const denied = await worker.fetch(request(), deniedEnv);
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get("Retry-After"), "60");

    const ip = "198.51.100.27";
    await worker.fetch(request("/listings", { headers: { "CF-Connecting-IP": ip } }), env);
    assert.deepEqual(env.CMC_RATE_LIMITER.calls.at(-1), { key: `listings:${ip}` });
  });
});

test("uses a manual redirect, keeps the API key upstream, and caches only success", async () => {
  await withFetch(async (url, options) => {
    assert.equal(url, `${API}/v1/cryptocurrency/listings/latest?start=1&limit=50&convert=USD&sort=market_cap&sort_dir=desc`);
    assert.equal(options.headers["X-CMC_PRO_API_KEY"], "test-key");
    assert.equal(options.redirect, "manual");
    assert.equal(options.cf.cacheEverything, true);
    assert.deepEqual(options.cf.cacheTtlByStatus, { "200-299": 600, "300-599": -1 });
    return new Response('{"data":[]}', { headers: { "Content-Type": "application/json" } });
  }, async () => {
    const response = await worker.fetch(request(), { ...env, CMC_KEY: "test-key" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=300");
    assert.equal((await response.json()).data.length, 0);
  });
});

test("preserves upstream rate limits without leaking credentials or caching errors", async () => {
  await withFetch(async () => new Response("limited", {
    status: 429,
    headers: { "Retry-After": "45", Location: "https://attacker.example/" },
  }), async () => {
    const response = await worker.fetch(request(), { ...env, CMC_KEY: "test-key" });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "45");
    assert.equal(response.headers.get("Access-Control-Expose-Headers"), "Retry-After");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Location"), null);
    assert.deepEqual(await response.json(), {
      error: "CoinMarketCap request failed",
      upstream_status: 429,
    });
  });
});

test("does not follow upstream redirects or forward redirect locations", async () => {
  await withFetch(async (_url, options) => {
    assert.equal(options.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: { Location: "https://attacker.example/" },
    });
  }, async () => {
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Location"), null);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  });
});

test("reports upstream network failures as explicit non-cacheable errors", async () => {
  await withFetch(async () => {
    throw new Error("network unavailable");
  }, async () => {
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), { error: "CoinMarketCap request failed" });
  });
});
