const DEFAULT_TIMEOUT = 15000;

// Helius is kept server-side. The API key must only live in Vercel
// Environment Variables as HELIUS_API_KEY.
const HELIUS_RPC = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(process.env.HELIUS_API_KEY)}`
  : null;

const PUBLIC_ENDPOINTS = [
  "https://api.mainnet.solana.com",
  "https://api.mainnet-beta.solana.com"
];

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1XwX3xjFQxqQpKx";
const MAX_PAGES = 20;
const PAGE_LIMIT = 5000;

async function rpcCall(endpoint, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store"
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${endpoint}: invalid JSON (HTTP ${response.status})`);
    }

    if (!response.ok) {
      const detail =
        data?.error?.message ||
        data?.message ||
        text.slice(0, 180) ||
        `HTTP ${response.status}`;
      throw new Error(`${endpoint}: HTTP ${response.status} — ${detail}`);
    }

    if (data?.error) {
      throw new Error(
        `${endpoint}: RPC ${data.error.code || ""} — ${data.error.message || "RPC error"}`
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

function endpoints() {
  return HELIUS_RPC ? [HELIUS_RPC, ...PUBLIC_ENDPOINTS] : PUBLIC_ENDPOINTS;
}

async function firstSuccessful(payload) {
  const errors = [];

  for (const endpoint of endpoints()) {
    try {
      return await rpcCall(endpoint, payload);
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }

  throw new Error(errors.join(" | "));
}

async function getAllTokenAccountsForMint(mint, commitment = "confirmed") {
  if (!HELIUS_RPC) {
    throw new Error("HELIUS_API_KEY is not configured in Vercel.");
  }

  const accounts = [];
  const errors = [];

  // Helius getProgramAccountsV2 gives us cursor pagination, so the
  // leaderboard is not capped at the 20 accounts returned by
  // getTokenLargestAccounts.
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    let paginationKey = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const config = {
        encoding: "jsonParsed",
        commitment,
        limit: PAGE_LIMIT,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: mint
            }
          }
        ]
      };

      if (paginationKey) config.paginationKey = paginationKey;

      try {
        const data = await rpcCall(HELIUS_RPC, {
          jsonrpc: "2.0",
          id: `aura-${programId}-${page}`,
          method: "getProgramAccountsV2",
          params: [programId, config]
        });

        const result = data?.result || {};
        const pageAccounts = result.accounts || [];
        accounts.push(...pageAccounts);

        paginationKey = result.paginationKey || null;

        if (!paginationKey || pageAccounts.length === 0) break;
      } catch (error) {
        errors.push(error?.message || String(error));
        break;
      }
    }
  }

  if (!accounts.length && errors.length) {
    throw new Error(errors.join(" | "));
  }

  return accounts;
}

async function getAuraRanking(mint, config) {
  const commitment = config?.commitment || "confirmed";
  const tokenAccounts = await getAllTokenAccountsForMint(mint, commitment);

  const byOwner = new Map();
  let decimals = 6;

  for (const item of tokenAccounts) {
    const info = item?.account?.data?.parsed?.info;
    const owner = info?.owner;
    const tokenAmount = info?.tokenAmount;

    if (!owner || !tokenAmount) continue;

    const raw = BigInt(tokenAmount.amount || "0");
    if (raw <= 0n) continue;

    decimals = Number(tokenAmount.decimals ?? decimals);

    const existing = byOwner.get(owner);
    byOwner.set(owner, {
      account: item.pubkey || "",
      owner,
      raw: (existing?.raw || 0n) + raw
    });
  }

  const holders = [...byOwner.values()]
    .map(x => ({
      account: x.account,
      owner: x.owner,
      raw: x.raw.toString(),
      ui: Number(x.raw) / 10 ** decimals
    }))
    .filter(x => x.ui > 0)
    .sort((a, b) => {
      const ar = BigInt(a.raw);
      const br = BigInt(b.raw);
      return ar === br ? 0 : ar > br ? -1 : 1;
    });

  if (!holders.length) {
    throw new Error("No non-zero token holders found for this mint.");
  }

  return {
    ok: true,
    method: "getAuraRanking",
    mint,
    decimals,
    holderCount: holders.length,
    holders
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
      message: "Use POST."
    });
  }

  try {
    const payload =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const method = payload?.method;
    const mint = payload?.params?.[0];

    if (!method) {
      return res.status(400).json({
        error: "Missing method",
        message: "A JSON-RPC method is required."
      });
    }

    if (method === "getAuraRanking") {
      if (!mint || typeof mint !== "string") {
        return res.status(400).json({
          error: "Missing mint",
          message: "A Solana token mint is required."
        });
      }

      const result = await getAuraRanking(
        mint,
        payload?.params?.[1] || { commitment: "confirmed" }
      );

      return res.status(200).json({
        jsonrpc: "2.0",
        id: payload?.id ?? 1,
        result
      });
    }

    // Normal RPC proxy for supply and wallet lookups.
    // Helius is tried first, then public RPCs.
    const data = await firstSuccessful(payload);
    return res.status(200).json(data);
  } catch (error) {
    return res.status(502).json({
      error: "Solana RPC proxy error",
      message: error?.message || "Unknown RPC error"
    });
  }
}
