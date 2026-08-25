const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCX8wZxV5"; // Token-2022
const ENDPOINTS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
  "https://solana.drpc.org"
];

const MAX_TIMEOUT = 20000;
const MAX_HOLDERS_RETURNED = 100;

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

function readTokenAccount(account) {
  const info = account?.data?.parsed?.info;
  const owner = info?.owner;
  const amount = info?.tokenAmount?.amount;

  if (!owner || typeof amount !== "string") return null;

  try {
    const raw = BigInt(amount);
    if (raw <= 0n) return null;
    return { owner, raw };
  } catch {
    return null;
  }
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

  // Token accounts store the mint pubkey at byte offset 0.
  // Standard SPL Token accounts are 165 bytes. Token-2022 accounts can
  // have extensions, so the Token-2022 query intentionally omits dataSize.
  const queries = [
    {
      programId: TOKEN_PROGRAM_ID,
      filters: [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: mint } }
      ]
    },
    {
      programId: TOKEN_2022_PROGRAM_ID,
      filters: [
        { memcmp: { offset: 0, bytes: mint } }
      ]
    }
  ];

  let lastError = null;

  for (const endpoint of ENDPOINTS) {
    try {
      const byOwner = new Map();
      let tokenAccountCount = 0;

      for (const query of queries) {
        const response = await rpcCall(
          endpoint,
          jsonRpc(
            "getProgramAccounts",
            [
              query.programId,
              {
                encoding: "jsonParsed",
                commitment,
                filters: query.filters
              }
            ],
            2
          )
        );

        const accounts = Array.isArray(response?.result) ? response.result : [];
        tokenAccountCount += accounts.length;

        for (const item of accounts) {
          const parsed = readTokenAccount(item.account);
          if (!parsed) continue;

          const current = byOwner.get(parsed.owner) || 0n;
          byOwner.set(parsed.owner, current + parsed.raw);
        }
      }

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
        tokenAccountCount,
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

    // All ordinary Solana RPC methods are simply proxied.
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
