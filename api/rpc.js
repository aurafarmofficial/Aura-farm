const HELIUS_RPC = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : null;

const ENDPOINTS = [
  ...(HELIUS_RPC ? [HELIUS_RPC] : []),
  "https://api.mainnet.solana.com",
  "https://api.mainnet-beta.solana.com"
];

const DEFAULT_TIMEOUT = 15000;

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
        text.slice(0, 160) ||
        `HTTP ${response.status}`;

      throw new Error(
        `${endpoint}: HTTP ${response.status} — ${detail}`
      );
    }

    if (data?.error) {
      throw new Error(
        `${endpoint}: RPC ${data.error.code || ""} — ${
          data.error.message || "RPC error"
        }`
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function firstSuccessful(payload) {
  const errors = [];

  for (const endpoint of ENDPOINTS) {
    try {
      return await rpcCall(endpoint, payload);
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }

  throw new Error(errors.join(" | "));
}

async function getAuraRanking(mint, config) {
  const errors = [];

  for (const endpoint of ENDPOINTS) {
    try {
      const largest = await rpcCall(endpoint, {
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenLargestAccounts",
        params: [
          mint,
          config || { commitment: "confirmed" }
        ]
      });

      const accounts = largest?.result?.value || [];

      if (!accounts.length) {
        throw new Error(
          `${endpoint}: getTokenLargestAccounts returned zero accounts`
        );
      }

      const decimals = Number(accounts[0]?.decimals ?? 6);
      const addresses = accounts
        .map(x => x.address)
        .filter(Boolean);

      const multiple = await rpcCall(endpoint, {
        jsonrpc: "2.0",
        id: 2,
        method: "getMultipleAccounts",
        params: [
          addresses,
          {
            encoding: "jsonParsed",
            commitment: config?.commitment || "confirmed"
          }
        ]
      });

      const infos = multiple?.result?.value || [];
      const byOwner = new Map();

      accounts.forEach((acc, i) => {
        const info = infos[i]?.data?.parsed?.info;
        const owner = info?.owner;
        const raw = Number(acc.amount);

        if (owner && Number.isFinite(raw) && raw > 0) {
          byOwner.set(
            owner,
            (byOwner.get(owner) || 0) + raw
          );
        }
      });

      const holders = [...byOwner.entries()]
        .map(([owner, raw]) => ({
          account: "",
          owner,
          raw,
          ui: raw / 10 ** decimals
        }))
        .filter(x => x.raw > 0)
        .sort((a, b) => b.raw - a.raw)
        .slice(0, 20);

      if (!holders.length) {
        throw new Error(
          `${endpoint}: token accounts found but no owners could be parsed`
        );
      }

      return {
        ok: true,
        method: "getAuraRanking",
        mint,
        decimals,
        holders
      };
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }

  throw new Error(errors.join(" | "));
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
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

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
        payload?.params?.[1] || {
          commitment: "confirmed"
        }
      );

      return res.status(200).json({
        jsonrpc: "2.0",
        id: payload?.id ?? 1,
        result
      });
    }

    const data = await firstSuccessful(payload);

    return res.status(200).json(data);
  } catch (error) {
    return res.status(502).json({
      error: "Solana RPC proxy error",
      message: error?.message || "Unknown RPC error"
    });
  }
}
