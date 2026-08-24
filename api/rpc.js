export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const payload =
    typeof req.body === "string" ? JSON.parse(req.body) : req.body;

  const endpoints = [
    "https://solana-rpc.publicnode.com",
    "https://api.mainnet.solana.com"
  ];

  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const text = await response.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(
          `Invalid RPC response (HTTP ${response.status})`
        );
      }

      if (!response.ok || data.error) {
        throw new Error(
          data?.error?.message || `RPC HTTP ${response.status}`
        );
      }

      return res.status(200).json(data);

    } catch (error) {
      lastError = error;
    }
  }

  return res.status(502).json({
    error: "All Solana RPC endpoints failed",
    message: lastError?.message || "Unknown RPC error"
  });
}
