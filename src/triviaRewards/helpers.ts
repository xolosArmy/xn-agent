import crypto from "crypto";

export const normalizeAnswer = (answer: string) => {
  return answer
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

export const deterministicPick = (seed: string, count: number) => {
  if (count <= 0) {
    return -1;
  }
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  const value = BigInt(`0x${hash}`);
  return Number(value % BigInt(count));
};

export const toDayKey = (timestampMs: number) => {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export type ParsedTweet = {
  id: string;
  text: string;
  twitterUserId: string;
  twitterUsername: string | null;
  inReplyToStatusId: string | null;
  createdAtMs: number | null;
};

const pickFirstString = (...values: Array<string | undefined | null>) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
};

export const parseTweetForReply = (raw: any): ParsedTweet | null => {
  if (!raw || typeof raw !== "object") return null;

  const id = pickFirstString(
    raw.id,
    raw.rest_id,
    raw.tweet_id,
    raw.legacy?.id_str
  );
  if (!id) return null;

  const text = pickFirstString(
    raw.text,
    raw.full_text,
    raw.legacy?.full_text,
    raw.legacy?.text
  );

  const twitterUserId = pickFirstString(
    raw.userId,
    raw.user_id,
    raw.core?.user_results?.result?.rest_id,
    raw.user?.id_str
  );
  if (!twitterUserId) return null;

  const twitterUsername = pickFirstString(
    raw.username,
    raw.core?.user_results?.result?.legacy?.screen_name,
    raw.user?.screen_name
  );

  const inReplyToStatusId = pickFirstString(
    raw.inReplyToStatusId,
    raw.in_reply_to_status_id_str,
    raw.legacy?.in_reply_to_status_id_str
  );

  let createdAtMs: number | null = null;
  if (typeof raw.timestamp === "number") {
    createdAtMs = raw.timestamp * 1000;
  } else if (typeof raw.created_at === "number") {
    createdAtMs = raw.created_at;
  } else if (typeof raw.legacy?.created_at === "string") {
    const parsed = Date.parse(raw.legacy.created_at);
    if (!Number.isNaN(parsed)) {
      createdAtMs = parsed;
    }
  }

  return {
    id,
    text: text ?? "",
    twitterUserId,
    twitterUsername: twitterUsername || null,
    inReplyToStatusId: inReplyToStatusId || null,
    createdAtMs,
  };
};
