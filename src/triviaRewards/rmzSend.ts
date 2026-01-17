import crypto from "crypto";

export type RmzSendParams = {
  toAddress: string;
  amountRmz: number;
  tokenId: string;
  mnemonic?: string;
  wif?: string;
};

export type RmzSendResult =
  | { ok: true; txid: string }
  | { ok: false; error: "payout_not_implemented" };

const isDryRun = () =>
  String(process.env.REWARD_DRY_RUN || "").toLowerCase() === "true";

export const sendRmz = async (params: RmzSendParams): Promise<RmzSendResult> => {
  if (isDryRun()) {
    const hash = crypto
      .createHash("sha256")
      .update(
        `${params.toAddress}:${params.amountRmz}:${params.tokenId}:${Date.now()}`
      )
      .digest("hex")
      .slice(0, 16);
    return { ok: true, txid: `dryrun_${hash}` };
  }

  return { ok: false, error: "payout_not_implemented" };
};
