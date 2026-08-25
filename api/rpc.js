const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const endpoints = [
      "https://solana-rpc.publicnode.com",
      "https://api.mainnet-beta.solana.com",
      "https://api.mainnet.solana.com",
      "https://solana.drpc.org",
      "https://endpoints.omniatech.io/v1/sol/mainnet/public"
    ];

    if (payload?.method === "getAuraRanking") {
      const mint = payload?.params?.[0];

      if (!mint || typeof mint !== "string") {
        return res.status(400).json({
          error: "Missing mint",
          message: "getAuraRanking requires the token mint"
        });
      }

      let lastError = null;

      for (const endpoint of endpoints) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);

        try {
          const rpcPayload = {
            jsonrpc: "2.0",
            id: payload.id ?? 1,
            method: "getProgramAccounts",
            params: [
              TOKEN_PROGRAM_ID,
              {
                encoding: "jsonParsed",
                filters: [
                  { dataSize: 165 },
                  { memcmp: { offset: 0, bytes: mint } }
                ],
                commitment: "confirmed"
              }
            ]
          };

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

          if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
          if (data?.error) {
            throw new Error(data.error.message || "RPC error");
          }

          const accounts = Array.isArray(data?.result) ? data.result : [];
          const balancesByOwner = new Map();

          for (const account of accounts) {
            try {
              const info = account.account.data.parsed.info;
              const owner = info.owner;
              const raw = BigInt(info.tokenAmount.amount);

              if (!owner || raw <= 0n) continue;

              balancesByOwner.set(
                owner,
                (balancesByOwner.get(owner) || 0n) + raw
              );
            } catch {
              // Ignore malformed token accounts.
            }
          }

          const holders = Array.from(balancesByOwner.entries())
            .map(([owner, raw]) => ({ owner, raw: raw.toString() }))
            .sort((a, b) => {
              const ar = BigInt(a.raw);
              const br = BigInt(b.raw);
              return ar > br ? -1 : ar < br ? 1 : 0;
            })
            .slice(0, 100);

          return res.status(200).json({
            jsonrpc: "2.0",
            id: payload.id ?? 1,
            result: {
              accountsScanned: accounts.length,
              holders
            }
          });
        } catch (error) {
          lastError = error;
        } finally {
          clearTimeout(timer);
        }
      }

      return res.status(502).json({
        error: "Aura ranking unavailable",
        message: lastError?.message || "All Solana RPC endpoints failed"
      });
    }

    let lastError = null;

    for (const endpoint of endpoints) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);

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

        if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
        if (data?.error) {
          throw new Error(data.error.message || "RPC error");
        }

        return res.status(200).json(data);
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
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
