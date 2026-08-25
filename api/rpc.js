const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

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
      "https://api.mainnet.solana.com",
      "https://solana.drpc.org",
      "https://endpoints.omniatech.io/v1/sol/mainnet/public"
    ];

    async function rpcCall(endpoint, rpcPayload) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);

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

    // Ranking: use getTokenLargestAccounts directly.
    // This is much lighter than scanning every token account with
    // getProgramAccounts and avoids the public-RPC limits that were
    // causing the old ranking request to fail.
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

          // Fetch the owner of each largest token account.
          const ownerMap = new Map();

          for (let i = 0; i < accounts.length; i += 100) {
            const batch = accounts.slice(i, i + 100);

            const multiple = await rpcCall(endpoint, {
              jsonrpc: "2.0",
              id: 2,
              method: "getMultipleAccounts",
              params: [
                batch.map((x) => x.address),
                {
                  encoding: "jsonParsed",
                  commitment: "confirmed"
                }
              ]
            });

            const infos = multiple?.result?.value || [];

            infos.forEach((account, index) => {
              try {
                const owner =
                  account?.data?.parsed?.info?.owner;

                if (owner) {
                  ownerMap.set(batch[index].address, owner);
                }
              } catch {}
            });
          }

          // Aggregate balances by wallet owner.
          const byOwner = new Map();

          for (const account of accounts) {
            const owner = ownerMap.get(account.address);
            if (!owner) continue;

            const raw = Number(account.amount);
            if (!Number.isFinite(raw) || raw <= 0) continue;

            byOwner.set(owner, (byOwner.get(owner) || 0) + raw);
          }

          const decimals =
            largest?.result?.value?.[0]?.uiAmountString != null &&
            largest?.result?.value?.[0]?.amount
              ? Math.max(
                  0,
                  Math.round(
                    Math.log10(
                      Number(largest.result.value[0].amount) /
                      Math.max(
                        Number(largest.result.value[0].uiAmountString),
                        1e-18
                      )
                    )
                  )
                )
              : 6;

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

    // Generic RPC passthrough for the other calls used by the frontend.
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
