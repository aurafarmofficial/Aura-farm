export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const endpoints = [
      "https://api.mainnet-beta.solana.com",
      "https://api.mainnet.solana.com",
      "https://solana-rpc.publicnode.com",
      "https://solana.drpc.org",
      "https://endpoints.omniatech.io/v1/sol/mainnet/public"
    ];

    const request = async (endpoint) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        const text = await response.text();

        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(`Invalid RPC response (HTTP ${response.status})`);
        }

        if (!response.ok || data.error) {
          throw new Error(
            data?.error?.message || `RPC HTTP ${response.status}`
          );
        }

        return data;
      } finally {
        clearTimeout(timer);
      }
    };

    // Ask all RPC endpoints at the same time.
    // The first successful response wins.
    const result = await Promise.any(
      endpoints.map((endpoint) => request(endpoint))
    );

    return res.status(200).json(result);
  } catch (error) {
    return res.status(502).json({
      error: "All Solana RPC endpoints failed",
      message: error?.message || "Unknown RPC error"
    });
  }
}
