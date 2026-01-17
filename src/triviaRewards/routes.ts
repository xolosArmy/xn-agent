import crypto from "crypto";
import { elizaLogger } from "@elizaos/core";
import {
  TriviaRewardsStore,
  getSqliteDb,
  type TriviaReplyInsert,
  type TriviaReplyRecord,
} from "../db/triviaRewards.ts";
import {
  deterministicPick,
  normalizeAnswer,
  parseTweetForReply,
  toDayKey,
} from "./helpers.ts";
import { getBlockHeight, ownsToken } from "./chronik.ts";
import { sendRmz } from "./rmzSend.ts";

const REWARD_RMZ_DEFAULT = 3;
const TRIVIA_WINDOW_MINUTES_DEFAULT = 10;
const CLAIM_TTL_MS = 60 * 60 * 1000;
const CLAIM_LOCK_MS = 15 * 60 * 1000;

const rateLimitWindowMs = 60 * 1000;
// In-memory rate limiting is per-process; multiple instances can bypass this.
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

const allowRateLimit = (key: string, limit: number) => {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
    return true;
  }
  if (bucket.count >= limit) {
    return false;
  }
  bucket.count += 1;
  return true;
};

const extractBearerToken = (req: any) => {
  const header =
    req?.headers?.authorization || req?.headers?.Authorization || "";
  if (typeof header !== "string") return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
};

const requireAdmin = (req: any, res: any) => {
  const expected = process.env.TRIVIA_ADMIN_TOKEN;
  const provided = extractBearerToken(req);
  if (!expected || provided !== expected) {
    elizaLogger.warn("Unauthorized trivia admin request.");
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
};

const getRequestIp = (req: any) => {
  const forwarded = req?.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req?.ip || "unknown";
};

const isValidEcashAddress = (address: string) =>
  typeof address === "string" &&
  address.startsWith("ecash:") &&
  address.length > 12;

const getRuntime = (directClient: any, agentId?: string) => {
  const agents: Map<string, any> | undefined =
    directClient?.agents || directClient?.["agents"];
  if (!agents) return null;
  if (agentId && agents.has(agentId)) {
    return agents.get(agentId);
  }
  if (agentId) {
    for (const runtime of agents.values()) {
      if (
        runtime?.character?.name &&
        runtime.character.name.toLowerCase() === agentId.toLowerCase()
      ) {
        return runtime;
      }
    }
  }
  return agents.values().next().value ?? null;
};

const getTwitterManager = (runtime: any) => {
  if (!runtime?.clients) return null;
  return runtime.clients.find((client: any) => client?.client?.fetchSearchTweets);
};

const collectReplies = async (params: {
  twitterManager: any;
  tweetId: string;
  triviaId: string;
  correctAnswers: string[];
  createdAt: number;
  closesAt: number;
}) => {
  const { twitterManager, tweetId, triviaId, correctAnswers, createdAt, closesAt } =
    params;
  const query = `conversation_id:${tweetId}`;
  const searchResult = await twitterManager.client.fetchSearchTweets(
    query,
    100,
    undefined
  );

  const rawTweets = searchResult?.tweets || [];
  const replies: TriviaReplyInsert[] = [];

  for (const raw of rawTweets) {
    const parsed = parseTweetForReply(raw);
    if (!parsed) continue;
    if (parsed.inReplyToStatusId && parsed.inReplyToStatusId !== tweetId) {
      continue;
    }
    if (
      parsed.createdAtMs &&
      (parsed.createdAtMs < createdAt || parsed.createdAtMs > closesAt)
    ) {
      continue;
    }

    const normalized = normalizeAnswer(parsed.text);
    const isCorrect = correctAnswers.includes(normalized) ? 1 : 0;
    replies.push({
      trivia_id: triviaId,
      tweet_id: parsed.id,
      twitter_user_id: parsed.twitterUserId,
      twitter_username: parsed.twitterUsername,
      reply_text: parsed.text,
      normalized_text: normalized,
      is_correct: isCorrect,
      created_at: parsed.createdAtMs ?? Date.now(),
    });
  }

  return replies;
};

export const registerTriviaRoutes = (params: {
  app: any;
  dbAdapter: any;
  directClient: any;
}) => {
  const { app, dbAdapter, directClient } = params;
  const store = new TriviaRewardsStore(getSqliteDb(dbAdapter));

  app.post("/api/trivia/create", (req: any, res: any) => {
    if (!requireAdmin(req, res)) return;
    const { triviaId, tweetId, correctAnswers, windowMinutes, rewardRmz } =
      req.body || {};

    if (!triviaId || !tweetId || !Array.isArray(correctAnswers)) {
      res.status(400).json({ error: "Missing triviaId, tweetId, or answers." });
      return;
    }

    const normalizedAnswers = correctAnswers
      .map((answer: string) => normalizeAnswer(answer))
      .filter(Boolean);
    if (!normalizedAnswers.length) {
      res.status(400).json({ error: "No valid answers provided." });
      return;
    }

    const existing = store.getTrivia(triviaId);
    if (existing) {
      res.status(409).json({ error: "Trivia already exists." });
      return;
    }

    const createdAt = Date.now();
    const windowMinutesFinal =
      Number(windowMinutes) || TRIVIA_WINDOW_MINUTES_DEFAULT;
    const rewardFinal = Number(rewardRmz) || REWARD_RMZ_DEFAULT;
    const closesAt = createdAt + windowMinutesFinal * 60 * 1000;

    store.createTrivia({
      triviaId,
      tweetId,
      correctAnswers: normalizedAnswers,
      windowMinutes: windowMinutesFinal,
      rewardRmz: rewardFinal,
      createdAt,
      closesAt,
    });

    elizaLogger.log(`Trivia created: ${triviaId} for tweet ${tweetId}`);
    res.json({
      triviaId,
      tweetId,
      windowMinutes: windowMinutesFinal,
      rewardRmz: rewardFinal,
      closesAt,
    });
  });

  app.post("/api/trivia/close", async (req: any, res: any) => {
    try {
      if (!requireAdmin(req, res)) return;
      const { triviaId, agentId } = req.body || {};
      if (!triviaId) {
        res.status(400).json({ error: "Missing triviaId." });
        return;
      }

      const trivia = store.getTrivia(triviaId);
      if (!trivia) {
        res.status(404).json({ error: "Trivia not found." });
        return;
      }
      if (trivia.status === "closed") {
        res.status(409).json({ error: "Trivia already closed." });
        return;
      }
      const now = Date.now();
      if (now < trivia.closes_at) {
        res.status(400).json({ error: "Trivia window still open." });
        return;
      }

      const runtime = getRuntime(directClient, agentId);
      if (!runtime) {
        res.status(500).json({ error: "Runtime not available." });
        return;
      }
      const twitterManager = getTwitterManager(runtime);
      if (!twitterManager) {
        res.status(500).json({ error: "Twitter client not available." });
        return;
      }

      const correctAnswers = JSON.parse(trivia.correct_answers) as string[];
      const replies = await collectReplies({
        twitterManager,
        tweetId: trivia.tweet_id,
        triviaId: trivia.trivia_id,
        correctAnswers,
        createdAt: trivia.created_at,
        closesAt: trivia.closes_at,
      });
      store.addReplies(replies);

      const correctReplies = store.listCorrectReplies(trivia.trivia_id);
      const uniqueCorrect = new Map<string, TriviaReplyRecord>();
      for (const reply of correctReplies) {
        if (!uniqueCorrect.has(reply.twitter_user_id)) {
          uniqueCorrect.set(reply.twitter_user_id, reply);
        }
      }
      const salt = process.env.TRIVIA_SALT;
      if (!salt) {
        res.status(500).json({ error: "TRIVIA_SALT not configured." });
        return;
      }

      const blockHeight = await getBlockHeight();
      const participantIds = Array.from(uniqueCorrect.keys()).sort();
      const seed = `${salt}:${trivia.trivia_id}:${trivia.tweet_id}:${participantIds.join(
        ","
      )}`;

      if (!participantIds.length) {
        store.closeTrivia({
          triviaId: trivia.trivia_id,
          blockHeight,
          seed,
          winnerTwitterUserId: null,
          winnerTweetId: null,
          claimCode: null,
          claimExpiresAt: null,
        });
        elizaLogger.log(`Trivia closed without winners: ${trivia.trivia_id}`);
        res.json({
          triviaId: trivia.trivia_id,
          seed,
          status: "no_correct_answers",
          winner: null,
        });
        return;
      }

      const winnerIndex = deterministicPick(seed, participantIds.length);
      const winnerId = participantIds[winnerIndex];
      const winner = uniqueCorrect.get(winnerId);
      if (!winner) {
        res.status(500).json({ error: "Failed to pick winner." });
        return;
      }
      const claimCode = crypto.randomBytes(16).toString("hex");
      const claimExpiresAt = Date.now() + CLAIM_TTL_MS;

      store.closeTrivia({
        triviaId: trivia.trivia_id,
        blockHeight,
        seed,
        winnerTwitterUserId: winner.twitter_user_id,
        winnerTweetId: winner.tweet_id,
        claimCode,
        claimExpiresAt,
      });

      elizaLogger.log(`Trivia closed: ${trivia.trivia_id} winner ${winner.twitter_user_id}`);
      res.json({
        triviaId: trivia.trivia_id,
        seed,
        winner: {
          twitterUserId: winner.twitter_user_id,
          tweetId: winner.tweet_id,
        },
        claimCode,
        claimExpiresAt,
      });
    } catch (error) {
      elizaLogger.error("Trivia close failed:", error);
      res.status(500).json({ error: "Failed to close trivia." });
    }
  });

  app.post("/api/claim", async (req: any, res: any) => {
    const claimRateLimit = Number(
      process.env.CLAIM_RATE_LIMIT_PER_MINUTE || 10
    );
    const requestIp = getRequestIp(req);
    if (!allowRateLimit(`ip:${requestIp}`, claimRateLimit)) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }

    try {
      const { claimCode, address } = req.body || {};
      if (!claimCode || !address) {
        res.status(400).json({ error: "Missing claimCode or address." });
        return;
      }

      const now = Date.now();
      const claimAttempt = store.getClaimAttemptByCode(claimCode);
      if (
        claimAttempt?.lock_expires_at &&
        now < Number(claimAttempt.lock_expires_at)
      ) {
        res.status(429).json({ error: "rate_limited" });
        return;
      }
      if (
        claimAttempt?.lock_expires_at &&
        now >= Number(claimAttempt.lock_expires_at)
      ) {
        store.clearClaimAttemptLock(claimCode);
      }

      const claim = store.getClaimByCode(claimCode);
      if (!claim) {
        const lock = store.recordInvalidClaimCodeAttempt({
          claimCode,
          now,
          maxAttempts: 3,
          lockMs: CLAIM_LOCK_MS,
        });
        if (lock.lockExpiresAt && now < lock.lockExpiresAt) {
          res.status(429).json({ error: "rate_limited" });
          return;
        }
        res.status(404).json({ error: "Claim code not found." });
        return;
      }
      elizaLogger.log(`Claim request: ${claim.trivia_id} address ${address}`);
      if (
        claim.lock_expires_at &&
        now < Number(claim.lock_expires_at)
      ) {
        res.status(429).json({ error: "rate_limited" });
        return;
      }
      if (
        claim.lock_expires_at &&
        now >= Number(claim.lock_expires_at)
      ) {
        store.clearClaimLock(claim.trivia_id);
      }
      if (
        claim.winner_twitter_user_id &&
        !allowRateLimit(`user:${claim.winner_twitter_user_id}`, claimRateLimit)
      ) {
        res.status(429).json({ error: "rate_limited" });
        return;
      }
      if (claim.used_at) {
        res.json({
          triviaId: claim.trivia_id,
          txid: claim.txid,
          status: "already_paid",
        });
        return;
      }
      if (!isValidEcashAddress(address)) {
        const lock = store.recordInvalidAttempt({
          triviaId: claim.trivia_id,
          now,
          maxAttempts: 3,
          lockMs: CLAIM_LOCK_MS,
        });
        if (lock.lockExpiresAt && now < lock.lockExpiresAt) {
          res.status(429).json({ error: "rate_limited" });
          return;
        }
        res.status(400).json({ error: "invalid_address" });
        return;
      }
      if (claim.claim_expires_at && now > claim.claim_expires_at) {
        const lock = store.recordInvalidAttempt({
          triviaId: claim.trivia_id,
          now,
          maxAttempts: 3,
          lockMs: CLAIM_LOCK_MS,
        });
        if (lock.lockExpiresAt && now < lock.lockExpiresAt) {
          res.status(429).json({ error: "rate_limited" });
          return;
        }
        res.status(410).json({ error: "Claim expired." });
        return;
      }
      if (!claim.winner_twitter_user_id) {
        res.status(400).json({ error: "Claim not eligible." });
        return;
      }

      const gatingTokenId = process.env.RMZSTATE_TOKEN_ID;
      if (!gatingTokenId) {
        res.status(500).json({ error: "RMZSTATE_TOKEN_ID not configured." });
        return;
      }
      // Address is both the RMZState NFT owner address and the payout address.
      const hasGate = await ownsToken(address, gatingTokenId);
      if (!hasGate) {
        const lock = store.recordInvalidAttempt({
          triviaId: claim.trivia_id,
          now,
          maxAttempts: 3,
          lockMs: CLAIM_LOCK_MS,
        });
        elizaLogger.warn(
          `Claim not eligible (missing token): ${claim.trivia_id} address ${address}`
        );
        if (lock.lockExpiresAt && now < lock.lockExpiresAt) {
          res.status(429).json({ error: "rate_limited" });
          return;
        }
        res.status(403).json({ error: "not_eligible" });
        return;
      }

      const rewardRmz = claim.reward_rmz;
      const dayKey = toDayKey(now);
      const dailyCap = Number(process.env.DAILY_CAP_RMZ || 50);
      const maxWinPerUser = Number(process.env.MAX_WIN_PER_USER_PER_DAY || 1);
      const maxRmzPerAddress = Number(
        process.env.MAX_RMZ_PER_USER_PER_DAY || 3
      );

      const spendSoFar = store.getDailySpend(dayKey);
      if (spendSoFar + rewardRmz > dailyCap) {
        elizaLogger.warn(`Daily cap reached for ${claim.trivia_id}`);
        res.status(429).json({ error: "rate_limited" });
        return;
      }

      const winsSoFar = store.countWinsForUser(
        dayKey,
        claim.winner_twitter_user_id
      );
      if (winsSoFar >= maxWinPerUser) {
        elizaLogger.warn(
          `User daily win limit reached for ${claim.winner_twitter_user_id}`
        );
        res.status(429).json({ error: "rate_limited" });
        return;
      }

      const addressSpend = store.sumAddressSpend(dayKey, address);
      if (addressSpend + rewardRmz > maxRmzPerAddress) {
        elizaLogger.warn(`Address daily limit reached for ${address}`);
        res.status(429).json({ error: "rate_limited" });
        return;
      }

      const tokenId = process.env.RMZ_TOKEN_ID;
      if (!tokenId) {
        res.status(500).json({ error: "RMZ_TOKEN_ID not configured." });
        return;
      }

      elizaLogger.log(
        `Claim payout attempt: ${claim.trivia_id} -> ${address} (${rewardRmz} RMZ)`
      );
      const sendResult = await sendRmz({
        toAddress: address,
        amountRmz: rewardRmz,
        tokenId,
        mnemonic: process.env.REWARD_WALLET_MNEMONIC,
        wif: process.env.REWARD_WALLET_WIF,
      });
      if (!sendResult.ok) {
        elizaLogger.warn(`Payout not implemented for ${claim.trivia_id}`);
        res.status(501).json({ error: "payout_not_implemented" });
        return;
      }

      store.recordClaimAndPayout({
        triviaId: claim.trivia_id,
        usedAt: now,
        usedAddress: address,
        txid: sendResult.txid,
        twitterUserId: claim.winner_twitter_user_id,
        rmzAmount: rewardRmz,
        dayKey,
      });

      elizaLogger.log(
        `Claim paid: ${claim.trivia_id} -> ${address} txid ${sendResult.txid}`
      );
      res.json({
        triviaId: claim.trivia_id,
        txid: sendResult.txid,
        rewardRmz,
      });
    } catch (error) {
      elizaLogger.error("Claim failed:", error);
      res.status(500).json({ error: "Claim failed." });
    }
  });
};
