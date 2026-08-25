const ENDPOINTS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
  "https://solana.drpc.org",
  "https://endpoints.omniatech.io/v1/sol/mainnet/public"
];

const TIMEOUT = 15000;

async function call(endpoint, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store"
    });

    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from RPC (HTTP ${response.status})`);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${data?.error?.message || text.slice(0,200)}`);
    }

    if (data?.error) {
      throw new Error(
        `${data.error.code ?? "RPC"}: ${data.error.message || "RPC error"}`
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function fallback(method, params) {
  let errors = [];

  for (const endpoint of ENDPOINTS) {
    try {
      return await call(endpoint, {
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params
      });
    } catch (e) {
      errors.push(`${endpoint}: ${e?.message || e}`);
    }
  }

  throw new Error(errors.join(" | "));
}

async function rankingDiagnostic(mint, commitment) {
  const attempts = [];

  // First: the exact lightweight route currently used by the site.
  for (const endpoint of ENDPOINTS) {
    try {
      const largest = await call(endpoint, {
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenLargestAccounts",
        params: [mint, { commitment }]
      });

      const accounts = largest?.result?.value || [];

      if (!accounts.length) {
        throw new Error("getTokenLargestAccounts returned 0 accounts");
      }

      const addresses = accounts.map(x => x.address).filter(Boolean);

      const multiple = await call(endpoint, {
        jsonrpc: "2.0",
        id: 2,
        method: "getMultipleAccounts",
        params: [
          addresses,
          { encoding: "jsonParsed", commitment }
        ]
      });

      const infos = multiple?.result?.value || [];
      const byOwner = new Map();

      accounts.forEach((account, i) => {
        const owner = infos[i]?.data?.parsed?.info?.owner;
        const raw = account?.amount;

        if (!owner || typeof raw !== "string") return;

        const n = BigInt(raw);
        if (n <= 0n) return;

        byOwner.set(owner, (byOwner.get(owner) || 0n) + n);
      });

      const supplyResponse = await call(endpoint, {
        jsonrpc: "2.0",
        id: 3,
        method: "getTokenSupply",
        params: [mint, { commitment }]
      });

      const supply = supplyResponse?.result?.value;
      const decimals = Number(supply?.decimals ?? 0);

      const holders = [...byOwner.entries()]
        .map(([owner, raw]) => ({
          owner,
          raw: raw.toString(),
          ui: Number(raw) / 10 ** decimals
        }))
        .sort((a,b) => BigInt(b.raw) > BigInt(a.raw) ? 1 : -1)
        .slice(0, 20);

      return {
        ok: true,
        method: "getAuraRanking",
        mint,
        decimals,
        supply: {
          amount: String(supply.amount),
          decimals,
          uiAmountString: String(supply.uiAmountString ?? "")
        },
        totalHolders: holders.length,
        holders,
        diagnostic: {
          endpoint,
          method: "getTokenLargestAccounts + getMultipleAccounts",
          tokenAccountsReturned: accounts.length,
          message: "Ranking route succeeded."
        }
      };
    } catch (e) {
      attempts.push({
        endpoint,
        message: e?.message || String(e)
      });
    }
  }

  const diagnosticText = attempts
    .map(x => `${x.endpoint} -> ${x.message}`)
    .join("\n");

  const error = new Error(
    "RANKING_DIAGNOSTIC\n" + diagnosticText
  );
  error.attempts = attempts;
  throw error;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const method = payload?.method;
    const params = Array.isArray(payload?.params) ? payload.params : [];

    if (!method) {
      return res.status(400).json({ error: "Missing RPC method" });
    }

    if (method === "getAuraRanking") {
      const mint = params[0];

      if (!mint || typeof mint !== "string") {
        return res.status(400).json({
          error: "Missing mint",
          message: "A Solana token mint is required."
        });
      }

      try {
        const result = await rankingDiagnostic(
          mint,
          params[1]?.commitment || "confirmed"
        );
        return res.status(200).json(result);
      } catch (e) {
        console.error(e);

        return res.status(502).json({
          error: "Ranking diagnostic failed",
          message: e?.message || "Unknown ranking error",
          attempts: e?.attempts || []
        });
      }
    }

    let lastError = null;

    for (const endpoint of ENDPOINTS) {
      try {
        return res.status(200).json(
          await call(endpoint, {
            jsonrpc: "2.0",
            id: payload.id ?? 1,
            method,
            params
          })
        );
      } catch (e) {
        lastError = e;
      }
    }

    return res.status(502).json({
      error: "All Solana RPC endpoints failed",
      message: lastError?.message || "Unknown RPC error"
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: "RPC proxy error",
      message: e?.message || "Unknown error"
    });
  }
}
