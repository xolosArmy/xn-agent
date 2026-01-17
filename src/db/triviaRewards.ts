import type Database from "better-sqlite3";
import { elizaLogger } from "@elizaos/core";

export type TriviaStatus = "open" | "closed";

export type TriviaRecord = {
  trivia_id: string;
  tweet_id: string;
  correct_answers: string;
  window_minutes: number;
  reward_rmz: number;
  created_at: number;
  closes_at: number;
  status: TriviaStatus;
  block_height: number | null;
  seed: string | null;
  winner_twitter_user_id: string | null;
  winner_tweet_id: string | null;
  claim_code: string | null;
  claim_expires_at: number | null;
  used_at: number | null;
  used_address: string | null;
  txid: string | null;
  invalid_attempts: number | null;
  lock_expires_at: number | null;
};

export type TriviaReplyRecord = {
  id: number;
  trivia_id: string;
  tweet_id: string;
  twitter_user_id: string;
  twitter_username: string | null;
  reply_text: string;
  normalized_text: string;
  is_correct: number;
  created_at: number;
};

export type TriviaReplyInsert = Omit<TriviaReplyRecord, "id">;

export type PayoutRecord = {
  id: number;
  trivia_id: string;
  twitter_user_id: string;
  address: string;
  rmz_amount: number;
  txid: string;
  created_at: number;
  day_key: string;
};

export function ensureTriviaTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trivia_rewards (
      trivia_id TEXT PRIMARY KEY,
      tweet_id TEXT NOT NULL,
      correct_answers TEXT NOT NULL,
      window_minutes INTEGER NOT NULL,
      reward_rmz INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      closes_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      block_height INTEGER,
      seed TEXT,
      winner_twitter_user_id TEXT,
      winner_tweet_id TEXT,
      claim_code TEXT,
      claim_expires_at INTEGER,
      used_at INTEGER,
      used_address TEXT,
      txid TEXT,
      invalid_attempts INTEGER NOT NULL DEFAULT 0,
      lock_expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS trivia_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trivia_id TEXT NOT NULL,
      tweet_id TEXT NOT NULL,
      twitter_user_id TEXT NOT NULL,
      twitter_username TEXT,
      reply_text TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      is_correct INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(trivia_id, tweet_id)
    );

    CREATE TABLE IF NOT EXISTS trivia_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trivia_id TEXT NOT NULL,
      twitter_user_id TEXT NOT NULL,
      address TEXT NOT NULL,
      rmz_amount INTEGER NOT NULL,
      txid TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      day_key TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_spend (
      day_key TEXT PRIMARY KEY,
      total_rmz INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trivia_claim_attempts (
      claim_code TEXT PRIMARY KEY,
      invalid_attempts INTEGER NOT NULL DEFAULT 0,
      lock_expires_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS trivia_rewards_status_idx
      ON trivia_rewards (status);
    CREATE INDEX IF NOT EXISTS trivia_replies_trivia_idx
      ON trivia_replies (trivia_id);
    CREATE INDEX IF NOT EXISTS trivia_replies_user_idx
      ON trivia_replies (twitter_user_id);
    CREATE INDEX IF NOT EXISTS trivia_payouts_day_idx
      ON trivia_payouts (day_key);
    CREATE INDEX IF NOT EXISTS trivia_payouts_user_idx
      ON trivia_payouts (twitter_user_id);
    CREATE INDEX IF NOT EXISTS trivia_payouts_addr_idx
      ON trivia_payouts (address);
    CREATE INDEX IF NOT EXISTS trivia_claim_attempts_lock_idx
      ON trivia_claim_attempts (lock_expires_at);
  `);

  const columns = db
    .prepare("PRAGMA table_info(trivia_rewards)")
    .all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  if (!columnNames.has("invalid_attempts")) {
    db.exec(
      "ALTER TABLE trivia_rewards ADD COLUMN invalid_attempts INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!columnNames.has("lock_expires_at")) {
    db.exec("ALTER TABLE trivia_rewards ADD COLUMN lock_expires_at INTEGER");
  }
}

export function getSqliteDb(adapter: any): Database {
  if (!adapter || !adapter.db) {
    throw new Error("SQLite database adapter not available.");
  }
  return adapter.db as Database;
}

export class TriviaRewardsStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    ensureTriviaTables(this.db);
  }

  createTrivia(params: {
    triviaId: string;
    tweetId: string;
    correctAnswers: string[];
    windowMinutes: number;
    rewardRmz: number;
    createdAt: number;
    closesAt: number;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO trivia_rewards (
        trivia_id,
        tweet_id,
        correct_answers,
        window_minutes,
        reward_rmz,
        created_at,
        closes_at,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      params.triviaId,
      params.tweetId,
      JSON.stringify(params.correctAnswers),
      params.windowMinutes,
      params.rewardRmz,
      params.createdAt,
      params.closesAt,
      "open"
    );
  }

  getTrivia(triviaId: string): TriviaRecord | undefined {
    return this.db
      .prepare("SELECT * FROM trivia_rewards WHERE trivia_id = ?")
      .get(triviaId) as TriviaRecord | undefined;
  }

  getClaimByCode(claimCode: string): TriviaRecord | undefined {
    return this.db
      .prepare("SELECT * FROM trivia_rewards WHERE claim_code = ?")
      .get(claimCode) as TriviaRecord | undefined;
  }

  addReplies(replies: TriviaReplyInsert[]) {
    if (!replies.length) return;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO trivia_replies (
        trivia_id,
        tweet_id,
        twitter_user_id,
        twitter_username,
        reply_text,
        normalized_text,
        is_correct,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      for (const reply of replies) {
        insert.run(
          reply.trivia_id,
          reply.tweet_id,
          reply.twitter_user_id,
          reply.twitter_username,
          reply.reply_text,
          reply.normalized_text,
          reply.is_correct,
          reply.created_at
        );
      }
    });

    tx();
  }

  listCorrectReplies(triviaId: string): TriviaReplyRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM trivia_replies WHERE trivia_id = ? AND is_correct = 1 ORDER BY created_at ASC"
      )
      .all(triviaId) as TriviaReplyRecord[];
  }

  closeTrivia(params: {
    triviaId: string;
    blockHeight: number;
    seed: string;
    winnerTwitterUserId: string | null;
    winnerTweetId: string | null;
    claimCode: string | null;
    claimExpiresAt: number | null;
  }) {
    const stmt = this.db.prepare(`
      UPDATE trivia_rewards
      SET status = ?,
          block_height = ?,
          seed = ?,
          winner_twitter_user_id = ?,
          winner_tweet_id = ?,
          claim_code = ?,
          claim_expires_at = ?
      WHERE trivia_id = ?
    `);

    stmt.run(
      "closed",
      params.blockHeight,
      params.seed,
      params.winnerTwitterUserId,
      params.winnerTweetId,
      params.claimCode,
      params.claimExpiresAt,
      params.triviaId
    );
  }

  markClaimUsed(params: {
    triviaId: string;
    usedAt: number;
    usedAddress: string;
    txid: string;
  }) {
    const stmt = this.db.prepare(`
      UPDATE trivia_rewards
      SET used_at = ?,
          used_address = ?,
          txid = ?,
          invalid_attempts = 0,
          lock_expires_at = NULL
      WHERE trivia_id = ? AND used_at IS NULL
    `);
    const result = stmt.run(
      params.usedAt,
      params.usedAddress,
      params.txid,
      params.triviaId
    );

    if (result.changes === 0) {
      elizaLogger.warn("Claim already used or missing trivia.");
    }
    return result.changes > 0;
  }

  clearClaimLock(triviaId: string) {
    this.db
      .prepare(
        "UPDATE trivia_rewards SET invalid_attempts = 0, lock_expires_at = NULL WHERE trivia_id = ?"
      )
      .run(triviaId);
  }

  recordInvalidAttempt(params: {
    triviaId: string;
    now: number;
    maxAttempts: number;
    lockMs: number;
  }) {
    const row = this.db
      .prepare(
        "SELECT invalid_attempts, lock_expires_at FROM trivia_rewards WHERE trivia_id = ?"
      )
      .get(params.triviaId) as
      | { invalid_attempts: number | null; lock_expires_at: number | null }
      | undefined;
    let invalidAttempts = row?.invalid_attempts ?? 0;
    let lockExpiresAt = row?.lock_expires_at ?? null;

    if (lockExpiresAt && params.now >= lockExpiresAt) {
      invalidAttempts = 0;
      lockExpiresAt = null;
    }

    invalidAttempts += 1;
    let newLockExpiresAt: number | null = lockExpiresAt;
    if (invalidAttempts >= params.maxAttempts) {
      newLockExpiresAt = params.now + params.lockMs;
    }

    this.db
      .prepare(
        "UPDATE trivia_rewards SET invalid_attempts = ?, lock_expires_at = ? WHERE trivia_id = ?"
      )
      .run(invalidAttempts, newLockExpiresAt, params.triviaId);

    return { invalidAttempts, lockExpiresAt: newLockExpiresAt };
  }

  getClaimAttemptByCode(claimCode: string) {
    return this.db
      .prepare(
        "SELECT claim_code, invalid_attempts, lock_expires_at FROM trivia_claim_attempts WHERE claim_code = ?"
      )
      .get(claimCode) as
      | {
          claim_code: string;
          invalid_attempts: number;
          lock_expires_at: number | null;
        }
      | undefined;
  }

  clearClaimAttemptLock(claimCode: string) {
    this.db
      .prepare(
        "UPDATE trivia_claim_attempts SET invalid_attempts = 0, lock_expires_at = NULL, updated_at = ? WHERE claim_code = ?"
      )
      .run(Date.now(), claimCode);
  }

  recordInvalidClaimCodeAttempt(params: {
    claimCode: string;
    now: number;
    maxAttempts: number;
    lockMs: number;
  }) {
    const existing = this.getClaimAttemptByCode(params.claimCode);
    let invalidAttempts = existing?.invalid_attempts ?? 0;
    let lockExpiresAt = existing?.lock_expires_at ?? null;

    if (lockExpiresAt && params.now >= lockExpiresAt) {
      invalidAttempts = 0;
      lockExpiresAt = null;
    }

    invalidAttempts += 1;
    let newLockExpiresAt: number | null = lockExpiresAt;
    if (invalidAttempts >= params.maxAttempts) {
      newLockExpiresAt = params.now + params.lockMs;
    }

    this.db
      .prepare(
        `INSERT INTO trivia_claim_attempts (claim_code, invalid_attempts, lock_expires_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(claim_code) DO UPDATE SET invalid_attempts = excluded.invalid_attempts,
           lock_expires_at = excluded.lock_expires_at,
           updated_at = excluded.updated_at`
      )
      .run(
        params.claimCode,
        invalidAttempts,
        newLockExpiresAt,
        params.now
      );

    return { invalidAttempts, lockExpiresAt: newLockExpiresAt };
  }

  recordPayout(params: {
    triviaId: string;
    twitterUserId: string;
    address: string;
    rmzAmount: number;
    txid: string;
    createdAt: number;
    dayKey: string;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO trivia_payouts (
        trivia_id,
        twitter_user_id,
        address,
        rmz_amount,
        txid,
        created_at,
        day_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      params.triviaId,
      params.twitterUserId,
      params.address,
      params.rmzAmount,
      params.txid,
      params.createdAt,
      params.dayKey
    );
  }

  getDailySpend(dayKey: string): number {
    const row = this.db
      .prepare("SELECT total_rmz FROM daily_spend WHERE day_key = ?")
      .get(dayKey) as { total_rmz: number } | undefined;
    return row?.total_rmz ?? 0;
  }

  incrementDailySpend(dayKey: string, amount: number) {
    const stmt = this.db.prepare(`
      INSERT INTO daily_spend (day_key, total_rmz)
      VALUES (?, ?)
      ON CONFLICT(day_key) DO UPDATE SET total_rmz = total_rmz + excluded.total_rmz
    `);
    stmt.run(dayKey, amount);
  }

  recordClaimAndPayout(params: {
    triviaId: string;
    usedAt: number;
    usedAddress: string;
    txid: string;
    twitterUserId: string;
    rmzAmount: number;
    dayKey: string;
  }) {
    const tx = this.db.transaction(() => {
      const updated = this.markClaimUsed({
        triviaId: params.triviaId,
        usedAt: params.usedAt,
        usedAddress: params.usedAddress,
        txid: params.txid,
      });
      if (!updated) return false;
      this.recordPayout({
        triviaId: params.triviaId,
        twitterUserId: params.twitterUserId,
        address: params.usedAddress,
        rmzAmount: params.rmzAmount,
        txid: params.txid,
        createdAt: params.usedAt,
        dayKey: params.dayKey,
      });
      this.incrementDailySpend(params.dayKey, params.rmzAmount);
      return true;
    });
    return tx();
  }

  countWinsForUser(dayKey: string, twitterUserId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(1) as cnt FROM trivia_payouts WHERE day_key = ? AND twitter_user_id = ?"
      )
      .get(dayKey, twitterUserId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  sumAddressSpend(dayKey: string, address: string): number {
    const row = this.db
      .prepare(
        "SELECT SUM(rmz_amount) as total FROM trivia_payouts WHERE day_key = ? AND address = ?"
      )
      .get(dayKey, address) as { total: number | null } | undefined;
    return row?.total ?? 0;
  }
}
