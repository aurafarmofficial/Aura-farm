const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ENDPOINTS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
  "https://solana.drpc.org"
];

const MAX_TIMEOUT = 12000;
const MAX_HOLDERS_RETURNED = 20;

function jsonRpc(method, params, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

async function rpcCall(endpoint, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_TIMEOUT);

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
      throw new Error(`Invalid RPC response (HTTP ${response.status})`);
    }

    if (!response.ok) {
      throw new Error(`RPC HTTP ${response.status}`);
    }

    if (data?.error) {
      throw new Error(data.error.message || "RPC error");
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function withFallback(buildPayload) {
  let lastError = null;

  for (const endpoint of ENDPOINTS) {
    try {
      return await rpcCall(endpoint, buildPayload());
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("All Solana RPC endpoints failed");
}

async function getAuraRanking(mint, commitment = "confirmed") {
  const supplyResponse = await withFallback(() =>
    jsonRpc("getTokenSupply", [mint, { commitment }], 1)
  );

  const supply = supplyResponse?.result?.value;
  if (!supply?.amount || typeof supply.decimals !== "number") {
    throw new Error("Could not read token supply");
  }

  const decimals = Number(supply.decimals);

  // Usar getTokenLargestAccounts evita sobrecargar el nodo con getProgramAccounts
  let lastError = null;

  for (const endpoint of ENDPOINTS) {
    try {
      const largestResponse = await rpcCall(
        endpoint,
        jsonRpc("getTokenLargestAccounts", [mint, { commitment }], 2)
      );

      const accounts = largestResponse?.result?.value || [];
      if (!accounts.length) {
        throw new Error("No token accounts returned");
      }

      const addresses = accounts.map((x) => x.address);
      const multipleResponse = await rpcCall(
        endpoint,
        jsonRpc(
          "getMultipleAccounts",
          [
            addresses,
            {
              encoding: "jsonParsed",
              commitment
            }
          ],
          3
        )
      );

      const infos = multipleResponse?.result?.value || [];
      const byOwner = new Map();

      accounts.forEach((acc, i) => {
        try {
          const info = infos[i]?.data?.parsed?.info;
          const owner = info?.owner;
          const raw = BigInt(acc.amount);

          if (owner && raw > 0n) {
            const current = byOwner.get(owner) || 0n;
            byOwner.set(owner, current + raw);
          }
        } catch {}
      });

      const holders = [...byOwner.entries()]
        .map(([owner, raw]) => ({
          account: "",
          owner,
          raw: raw.toString(),
          ui: Number(raw) / 10 ** decimals
        }))
        .filter((x) => Number.isFinite(x.ui) && x.ui > 0)
        .sort((a, b) => {
          const ar = BigInt(a.raw);
          const br = BigInt(b.raw);
          return br > ar ? 1 : br < ar ? -1 : 0;
        })
        .slice(0, MAX_HOLDERS_RETURNED);

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
        totalHolders: byOwner.size,
        tokenAccountCount: accounts.length,
        holders
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("All Solana RPC endpoints failed");
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
    const mint = params[0];

    if (method === "getAuraRanking") {
      if (!mint || typeof mint !== "string") {
        return res.status(400).json({
          error: "Missing mint",
          message: "A Solana token mint is required."
        });
      }

      const commitment =
        typeof params[1]?.commitment === "string"
          ? params[1].commitment
          : "confirmed";

      const result = await getAuraRanking(mint, commitment);
      return res.status(200).json(result);
    }

    if (!method || typeof method !== "string") {
      return res.status(400).json({
        error: "Missing RPC method",
        message: "A JSON-RPC method is required."
      });
    }

    let lastError = null;

    for (const endpoint of ENDPOINTS) {
      try {
        const result = await rpcCall(
          endpoint,
          jsonRpc(method, params, payload.id ?? 1)
        );
        return res.status(200).json(result);
      } catch (error) {
        lastError = error;
      }
    }

    return res.status(502).json({
      error: "All Solana RPC endpoints failed",
      message: lastError?.message || "Unknown RPC error"
    });
  } catch (error) {
    console.error("RPC proxy error:", error);

    return res.status(500).json({
      error: "RPC proxy error",
      message: error?.message || "Unknown error"
    });
  }
}
