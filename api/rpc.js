const ENDPOINTS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
  "https://solana.drpc.org",
  "https://endpoints.omniatech.io/v1/sol/mainnet/public"
];

const MAX_TIMEOUT = 15000;

function rpcPayload(method, params, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

async function callRpc(endpoint, payload) {
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

async function callWithFallback(method, params, id = 1) {
  let lastError = null;

  for (const endpoint of ENDPOINTS) {
    try {
      return await callRpc(endpoint, rpcPayload(method, params, id));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("All Solana RPC endpoints failed");
}

function toUiAmount(raw, decimals) {
  return Number(raw) / Math.pow(10, decimals);
}

async function buildRanking(mint, commitment) {
  // IMPORTANT:
  // We deliberately use getTokenLargestAccounts here first.
  // It is much lighter and more reliable on public Solana RPCs than
  // scanning every token account with getProgramAccounts.
  const supplyResponse = await callWithFallback(
    "getTokenSupply",
    [mint, { commitment }],
    1
  );

  const supply = supplyResponse?.result?.value;

  if (!supply?.amount || typeof supply.decimals !== "number") {
    throw new Error("Could not read token supply");
  }

  const decimals = Number(supply.decimals);

  const largestResponse = await callWithFallback(
    "getTokenLargestAccounts",
    [mint, { commitment }],
    2
  );

  const tokenAccounts = largestResponse?.result?.value || [];

  if (!Array.isArray(tokenAccounts) || tokenAccounts.length === 0) {
    throw new Error("No token accounts returned");
  }

  const addresses = tokenAccounts
    .map((x) => x?.address)
    .filter(Boolean);

  const multipleResponse = await callWithFallback(
    "getMultipleAccounts",
    [
      addresses,
      {
        encoding: "jsonParsed",
        commitment
      }
    ],
    3
  );

  const infos = multipleResponse?.result?.value || [];
  const byOwner = new Map();

  tokenAccounts.forEach((account, index) => {
    try {
      const owner =
        infos[index]?.data?.parsed?.info?.owner;

      const rawString = account?.amount;

      if (!owner || typeof rawString !== "string") return;

      const raw = BigInt(rawString);
      if (raw <= 0n) return;

      const old = byOwner.get(owner) || 0n;
      byOwner.set(owner, old + raw);
    } catch {
      // Ignore malformed token accounts.
    }
  });

  const holders = [...byOwner.entries()]
    .map(([owner, raw]) => ({
      account: "",
      owner,
      raw: raw.toString(),
      ui: toUiAmount(raw.toString(), decimals)
    }))
    .filter((x) => Number.isFinite(x.ui) && x.ui > 0)
    .sort((a, b) => {
      const ar = BigInt(a.raw);
      const br = BigInt(b.raw);
      if (br > ar) return 1;
      if (br < ar) return -1;
      return 0;
    });

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
    // This is the number of wallets represented in the top-20
    // token-account snapshot, not the total number of holders.
    totalHolders: holders.length,
    tokenAccountsChecked: tokenAccounts.length,
    holders: holders.slice(0, 20)
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const payload =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    const method = payload?.method;
    const params = Array.isArray(payload?.params)
      ? payload.params
      : [];

    if (!method || typeof method !== "string") {
      return res.status(400).json({
        error: "Missing RPC method"
      });
    }

    if (method === "getAuraRanking") {
      const mint = params[0];

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

      try {
        const result = await buildRanking(mint, commitment);
        return res.status(200).json(result);
      } catch (error) {
        console.error("getAuraRanking failed:", error);

        return res.status(502).json({
          error: "Ranking unavailable",
          message: error?.message || "Could not load Solana ranking"
        });
      }
    }

    // Normal RPC proxy for the wallet check and token supply calls.
    let lastError = null;

    for (const endpoint of ENDPOINTS) {
      try {
        const result = await callRpc(
          endpoint,
          rpcPayload(method, params, payload.id ?? 1)
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
