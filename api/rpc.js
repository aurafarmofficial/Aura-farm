export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const method = payload?.method;
    const mint = payload?.params?.[0];

    if (!mint || typeof mint !== "string") {
      return res.status(400).json({
        error: "Missing mint",
        message: "A Solana token mint is required."
      });
    }

    const endpoints = [
      "https://solana-rpc.publicnode.com",
      "https://api.mainnet-beta.solana.com",
      "https://solana.drpc.org"
    ];

    async function rpcCall(endpoint, rpcPayload) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rpcPayload),
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

    if (method === "getAuraRanking") {
      let lastError = null;

      for (const endpoint of endpoints) {
        try {
          const largest = await rpcCall(endpoint, {
            jsonrpc: "2.0",
            id: 1,
            method: "getTokenLargestAccounts",
            params: [mint, { commitment: "confirmed" }]
          });

          const accounts = largest?.result?.value || [];
          if (!accounts.length) {
            throw new Error("No token accounts returned");
          }

          const addresses = accounts.map((x) => x.address);
          const multiple = await rpcCall(endpoint, {
            jsonrpc: "2.0",
            id: 2,
            method: "getMultipleAccounts",
            params: [
              addresses,
              {
                encoding: "jsonParsed",
                commitment: "confirmed"
              }
            ]
          });

          const infos = multiple?.result?.value || [];
          const byOwner = new Map();
          const decimals = 6; // Decimales seguros estándar para Pump.fun

          accounts.forEach((acc, i) => {
            try {
              const info = infos[i]?.data?.parsed?.info;
              const owner = info?.owner;
              const raw = Number(acc.amount);

              if (owner && Number.isFinite(raw) && raw > 0) {
                byOwner.set(owner, (byOwner.get(owner) || 0) + raw);
              }
            } catch (err) {}
          });

          const holders = [...byOwner.entries()]
            .map(([owner, raw]) => ({
              account: "",
              owner,
              raw,
              ui: raw / 10 ** decimals
            }))
            .filter((x) => x.raw > 0)
            .sort((a, b) => b.raw - a.raw)
            .slice(0, 20);

          return res.status(200).json({
            ok: true,
            method: "getAuraRanking",
            mint,
            decimals,
            holders
          });
        } catch (error) {
          lastError = error;
        }
      }

      return res.status(502).json({
        error: "All Solana RPC endpoints failed",
        message: lastError?.message || "Unknown RPC error"
      });
    }

    let lastError = null;

    for (const endpoint of endpoints) {
      try {
        return res.status(200).json(
          await rpcCall(endpoint, payload)
        );
      } catch (error) {
        lastError = error;
      }
    }

    return res.status(502).json({
      error: "All Solana RPC endpoints failed",
      message: lastError?.message || "Unknown RPC error"
    });
  } catch (error) {
    return res.status(500).json({
      error: "RPC proxy error",
      message: error?.message || "Unknown error"
    });
  }
}
