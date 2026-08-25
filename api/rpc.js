export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // IMPORTANT: use one RPC at a time. Hitting every public RPC
    // simultaneously was causing rate limits, so the ranking failed
    // after the first successful request.
    const endpoints = [
      "https://solana-rpc.publicnode.com",
      "https://api.mainnet-beta.solana.com",
      "https://api.mainnet.solana.com",
      "https://solana.drpc.org",
      "https://endpoints.omniatech.io/v1/sol/mainnet/public"
    ];

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

        if (!response.ok) {
          throw new Error(`RPC HTTP ${response.status}`);
        }

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
