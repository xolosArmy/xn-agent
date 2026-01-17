const getChronikUrl = () => {
  const base = process.env.CHRONIK_URL || process.env.CHRONIK_HTTP_URL;
  if (!base) {
    throw new Error("CHRONIK_URL is not set.");
  }
  return base.replace(/\/+$/, "");
};

const chronikFetch = async (path: string) => {
  const base = getChronikUrl();
  const url = `${base}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Chronik request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
};

export const getBlockHeight = async () => {
  const data = await chronikFetch("/blockchaininfo");
  const height =
    data?.blockHeight ??
    data?.block_height ??
    data?.tip_height ??
    data?.height;
  if (typeof height !== "number") {
    throw new Error("Chronik blockchaininfo missing block height.");
  }
  return height;
};

const tokenMatch = (token: any, tokenId: string) => {
  const id = token?.tokenId || token?.token_id || token?.tokenid;
  return typeof id === "string" && id.toLowerCase() === tokenId.toLowerCase();
};

const tokenAmount = (token: any): bigint | null => {
  const raw =
    token?.amount ??
    token?.amountBase ??
    token?.tokenAmount ??
    token?.amount_decimal ??
    token?.value;
  if (raw === undefined || raw === null) return null;
  try {
    return typeof raw === "string" ? BigInt(raw) : BigInt(Math.floor(raw));
  } catch {
    return null;
  }
};

const hasTokenInUtxos = (data: any, tokenId: string) => {
  const utxos = data?.utxos || data?.utxo || data?.outputs || [];
  if (!Array.isArray(utxos)) return false;
  return utxos.some((utxo) => {
    const tokens = utxo?.token ? [utxo.token] : utxo?.tokens || [];
    if (!Array.isArray(tokens)) return false;
    return tokens.some((token: any) => tokenMatch(token, tokenId));
  });
};

const hasTokenInBalance = (data: any, tokenId: string) => {
  const tokens = data?.tokens || data?.tokenBalances || data?.balances || [];
  if (!Array.isArray(tokens)) return false;
  return tokens.some((token) => tokenMatch(token, tokenId));
};

export const getTokenBalance = async (address: string, tokenId: string) => {
  try {
    const data = await chronikFetch(`/address/${address}/tokens`);
    const tokens = data?.tokens || data?.tokenBalances || data?.balances || [];
    if (!Array.isArray(tokens)) return 0n;
    for (const token of tokens) {
      if (!tokenMatch(token, tokenId)) continue;
      const amount = tokenAmount(token);
      if (amount !== null) return amount;
      return 1n;
    }
  } catch {
    return 0n;
  }
  return 0n;
};

export const hasToken = async (address: string, tokenId: string) => {
  const endpoints = [
    `/address/${address}/utxos`,
    `/address/${address}/tokens`,
    `/address/${address}/balance`,
  ];

  for (const endpoint of endpoints) {
    try {
      const data = await chronikFetch(endpoint);
      if (hasTokenInUtxos(data, tokenId) || hasTokenInBalance(data, tokenId)) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
};

export const ownsToken = async (address: string, tokenId: string) => {
  const balance = await getTokenBalance(address, tokenId);
  if (balance > 0n) return true;
  return hasToken(address, tokenId);
};
