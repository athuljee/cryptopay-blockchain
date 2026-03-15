/**
 * Offline payment server: runs on the merchant terminal (e.g. localhost:3001).
 * Does NOT write to Supabase. All offline transactions are stored locally (SQLite)
 * with status pending_sync, then synced to the main backend when internet is restored.
 * The main backend (server.js) records synced transactions in Supabase and prevents
 * duplicates via tx_id idempotency.
 */
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const { randomUUID } = require("crypto");
const winston = require("winston");

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
      return `${timestamp} ${level.toUpperCase()}: ${message}${metaStr}`;
    }),
  ),
  transports: [new winston.transports.Console()],
});

const ONLINE_BASE_URL = process.env.ONLINE_BASE_URL || "https://cryptopay-blockchain.onrender.com";
const OFFLINE_SERVER_PORT = Number(process.env.OFFLINE_SERVER_PORT || 3001);
const DB_PATH = process.env.OFFLINE_DB_PATH || path.join(__dirname, "offline-store.db");
const SYNC_INTERVAL_MS = 30 * 1000;

const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS offline_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL UNIQUE,
      btc REAL NOT NULL DEFAULT 0,
      eth REAL NOT NULL DEFAULT 0,
      usdt REAL NOT NULL DEFAULT 0,
      nonce INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS offline_wallet_loads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      load_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL,
      amount REAL NOT NULL,
      source_wallet_type TEXT NOT NULL DEFAULT 'main_wallet',
      status TEXT NOT NULL DEFAULT 'synced',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      synced_at TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS offline_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_id TEXT NOT NULL UNIQUE,
      from_user_id TEXT NOT NULL,
      to_user_id TEXT NOT NULL,
      merchant_id TEXT,
      amount REAL NOT NULL,
      token TEXT NOT NULL,
      is_offline_payment INTEGER NOT NULL DEFAULT 1,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      mode TEXT NOT NULL DEFAULT 'offline',
      status TEXT NOT NULL,
      nonce INTEGER,
      signature TEXT,
      source_device_id TEXT,
      local_server_id TEXT,
      offline_created_at TEXT,
      offline_received_at TEXT,
      blockchain_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      synced_at TEXT,
      sync_error TEXT
    )
  `);

  // Backward-compatible schema upgrades for existing sqlite DBs.
  await run(`ALTER TABLE offline_transactions ADD COLUMN is_offline_payment INTEGER NOT NULL DEFAULT 1`).catch(() => {});
  await run(`ALTER TABLE offline_transactions ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'pending'`).catch(() => {});
  await run(`ALTER TABLE offline_transactions ADD COLUMN offline_created_at TEXT`).catch(() => {});
  await run(`ALTER TABLE offline_transactions ADD COLUMN offline_received_at TEXT`).catch(() => {});
  await run(`ALTER TABLE offline_transactions ADD COLUMN blockchain_synced_at TEXT`).catch(() => {});
}

const TOKEN_TO_COLUMN = {
  BTC: "btc",
  ETH: "eth",
  USDT: "usdt",
};

function normalizeToken(token) {
  if (!token) return null;
  const t = String(token).toUpperCase();
  return TOKEN_TO_COLUMN[t] ? t : null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

async function isInternetAvailable() {
  try {
    const res = await fetch(`${ONLINE_BASE_URL}/token-values`, { method: "GET" });
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function getOnlineBalance(userId) {
  const res = await fetch(`${ONLINE_BASE_URL}/balance/${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error(`Online balance request failed: ${res.status}`);
  return await res.json();
}

async function ensureWallet(userId) {
  let row = await get("SELECT * FROM offline_wallets WHERE user_id = ?", [userId]);
  if (!row) {
    await run("INSERT INTO offline_wallets (user_id) VALUES (?)", [userId]);
    row = await get("SELECT * FROM offline_wallets WHERE user_id = ?", [userId]);
  }
  return row;
}

function walletView(row) {
  return {
    userId: row.user_id,
    balances: {
      BTC: Number(row.btc || 0),
      ETH: Number(row.eth || 0),
      USDT: Number(row.usdt || 0),
    },
    nonce: Number(row.nonce || 0),
    updatedAt: row.updated_at,
  };
}

async function adjustWallet(userId, token, delta, { nonce = null } = {}) {
  const col = TOKEN_TO_COLUMN[token];
  const wallet = await ensureWallet(userId);
  const current = Number(wallet[col] || 0);
  const next = current + delta;
  if (next < 0) return { ok: false, reason: "insufficient_offline_wallet" };

  if (nonce != null) {
    const n = Number(nonce);
    if (!Number.isInteger(n) || n <= Number(wallet.nonce || 0)) {
      return { ok: false, reason: "replay_nonce_rejected", currentNonce: Number(wallet.nonce || 0) };
    }
    await run(
      `UPDATE offline_wallets SET ${col} = ?, nonce = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
      [next, n, userId],
    );
    return { ok: true, wallet: await ensureWallet(userId) };
  }

  await run(
    `UPDATE offline_wallets SET ${col} = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
    [next, userId],
  );
  return { ok: true, wallet: await ensureWallet(userId) };
}

app.get("/health", async (_req, res) => {
  try {
    const pending = await get(
      "SELECT COUNT(*) AS c FROM offline_transactions WHERE sync_status IN ('pending','failed')",
    );
    res.json({
      ok: true,
      server: "offline-server",
      port: OFFLINE_SERVER_PORT,
      onlineBaseUrl: ONLINE_BASE_URL,
      pendingCount: Number(pending?.c || 0),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/ping", (_req, res) => {
  res.json({ ok: true, server: "offline-server" });
});

app.get("/offline-wallet/:userId", async (req, res) => {
  try {
    const wallet = await ensureWallet(req.params.userId);
    res.json({ ok: true, wallet: walletView(wallet) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/offline-wallet/load", async (req, res) => {
  const { userId, token, amount } = req.body || {};
  const normalized = normalizeToken(token);
  const amt = num(amount);
  if (!userId || !normalized || !Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ ok: false, status: "rejected", error: "Invalid load payload" });
  }

  try {
    if (!await isInternetAvailable()) {
      return res.status(409).json({ ok: false, status: "rejected", error: "Internet required to load offline wallet" });
    }

    const wallet = await ensureWallet(userId);
    const onlineBalance = await getOnlineBalance(userId);
    const onlineTokenBalance = num(onlineBalance[normalized]);
    const reserved = num(wallet[TOKEN_TO_COLUMN[normalized]]);
    const availableForLoad = onlineTokenBalance - reserved;
    if (!Number.isFinite(onlineTokenBalance) || availableForLoad < amt) {
      return res.status(409).json({
        ok: false,
        status: "rejected",
        error: "Insufficient available main wallet for offline load",
      });
    }

    const result = await adjustWallet(userId, normalized, amt);
    if (!result.ok) {
      return res.status(409).json({ ok: false, status: "rejected", error: result.reason });
    }

    await run(
      "INSERT INTO offline_wallet_loads (load_id, user_id, token, amount, status, synced_at) VALUES (?, ?, ?, ?, 'synced', CURRENT_TIMESTAMP)",
      [randomUUID(), userId, normalized, amt],
    );

    return res.json({
      ok: true,
      status: "synced",
      wallet: walletView(result.wallet),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, status: "failed", error: err.message });
  }
});

app.post("/offline-wallet/deduct", async (req, res) => {
  const { userId, token, amount, nonce } = req.body || {};
  const normalized = normalizeToken(token);
  const amt = num(amount);
  if (!userId || !normalized || !Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ ok: false, status: "rejected", error: "Invalid deduct payload" });
  }

  try {
    const result = await adjustWallet(userId, normalized, -amt, { nonce });
    if (!result.ok) {
      return res.status(409).json({ ok: false, status: "rejected", error: result.reason, currentNonce: result.currentNonce });
    }
    return res.json({ ok: true, status: "pending_sync", wallet: walletView(result.wallet) });
  } catch (err) {
    return res.status(500).json({ ok: false, status: "failed", error: err.message });
  }
});

app.post("/offline-wallet/credit", async (req, res) => {
  const { userId, token, amount } = req.body || {};
  const normalized = normalizeToken(token);
  const amt = num(amount);
  if (!userId || !normalized || !Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ ok: false, status: "rejected", error: "Invalid credit payload" });
  }

  try {
    const result = await adjustWallet(userId, normalized, amt);
    if (!result.ok) {
      return res.status(409).json({ ok: false, status: "rejected", error: result.reason });
    }
    return res.json({ ok: true, status: "pending_sync", wallet: walletView(result.wallet) });
  } catch (err) {
    return res.status(500).json({ ok: false, status: "failed", error: err.message });
  }
});

app.post("/offline-transfer", async (req, res) => {
  const {
    txId,
    fromUserId,
    toUserId,
    merchantId,
    amount,
    token,
    nonce,
    signature,
    sourceDeviceId,
    localServerId,
    offlineCreatedAt,
    offlineReceivedAt,
  } = req.body || {};

  const normalized = normalizeToken(token);
  const amt = num(amount);
  const finalTxId = txId && String(txId).trim().length > 0 ? String(txId).trim() : randomUUID();
  if (!fromUserId || !toUserId || !normalized || !Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ ok: false, status: "rejected", error: "Invalid transfer payload" });
  }

  logger.info("[OFFLINE TX] Received transaction " + finalTxId, {
    from: fromUserId,
    to: toUserId,
    merchantId: merchantId || toUserId,
    amount: amt,
    token: normalized,
  });

  try {
    const existing = await get("SELECT tx_id, status FROM offline_transactions WHERE tx_id = ?", [finalTxId]);
    if (existing) {
      return res.json({ ok: true, duplicated: true, txId: existing.tx_id, status: existing.status });
    }

    const deductResult = await adjustWallet(fromUserId, normalized, -amt, { nonce });
    if (!deductResult.ok) {
      await run(
        `INSERT INTO offline_transactions
         (tx_id, from_user_id, to_user_id, merchant_id, amount, token, is_offline_payment, sync_status, mode, status, nonce, signature, source_device_id, local_server_id, offline_created_at, offline_received_at, sync_error)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'failed', 'offline', 'rejected', ?, ?, ?, ?, ?, ?, ?)`,
        [
          finalTxId,
          fromUserId,
          toUserId,
          merchantId || null,
          amt,
          normalized,
          nonce != null ? Number(nonce) : null,
          signature || null,
          sourceDeviceId || null,
          localServerId || null,
          offlineCreatedAt || new Date().toISOString(),
          offlineReceivedAt || new Date().toISOString(),
          deductResult.reason,
        ],
      );
      logger.warn("[OFFLINE TX] Rejected " + finalTxId + " reason=" + deductResult.reason);
      return res.status(409).json({
        ok: false,
        txId: finalTxId,
        status: "rejected",
        error: deductResult.reason,
        currentNonce: deductResult.currentNonce,
      });
    }

    const creditTarget = merchantId || toUserId;
    const creditResult = await adjustWallet(creditTarget, normalized, amt);
    if (!creditResult.ok) {
      return res.status(409).json({ ok: false, txId: finalTxId, status: "rejected", error: creditResult.reason });
    }

    await run(
      `INSERT INTO offline_transactions
       (tx_id, from_user_id, to_user_id, merchant_id, amount, token, is_offline_payment, sync_status, mode, status, nonce, signature, source_device_id, local_server_id, offline_created_at, offline_received_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', 'offline', 'pending_sync', ?, ?, ?, ?, ?, ?)`,
      [
        finalTxId,
        fromUserId,
        toUserId,
        merchantId || null,
        amt,
        normalized,
        nonce != null ? Number(nonce) : null,
        signature || null,
        sourceDeviceId || null,
        localServerId || null,
        offlineCreatedAt || new Date().toISOString(),
        offlineReceivedAt || new Date().toISOString(),
      ],
    );

    logger.info("[OFFLINE TX] Stored locally as pending_sync", { txId: finalTxId });
    return res.json({ ok: true, txId: finalTxId, status: "pending_sync" });
  } catch (err) {
    logger.error("[OFFLINE TX] Error processing " + finalTxId, { error: err.message });
    return res.status(500).json({ ok: false, status: "failed", error: err.message });
  }
});

app.get("/offline-transactions", async (req, res) => {
  try {
    const { userId, merchantId, status } = req.query;
    const where = [];
    const params = [];
    if (userId) {
      where.push("(from_user_id = ? OR to_user_id = ? OR merchant_id = ?)");
      params.push(String(userId), String(userId), String(userId));
    }
    if (merchantId) {
      where.push("merchant_id = ?");
      params.push(String(merchantId));
    }
    if (status) {
      where.push("status = ?");
      params.push(String(status));
    }
    const sql = `
      SELECT * FROM offline_transactions
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY COALESCE(offline_created_at, created_at) DESC
      LIMIT 300
    `;
    const rows = await all(sql, params);
    res.json({ ok: true, transactions: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function runSync() {
  if (!(await isInternetAvailable())) {
    return null;
  }
  logger.info("[SYNC] Checking internet connection...");
  const pending = await all(
    "SELECT * FROM offline_transactions WHERE sync_status IN ('pending', 'failed') ORDER BY COALESCE(offline_created_at, created_at) ASC LIMIT 300",
  );
  if (pending.length === 0) {
    return { processed: 0, synced: 0, failed: 0, rejected: 0 };
  }
  let synced = 0;
  let failed = 0;
  let rejected = 0;

  for (const tx of pending) {
    try {
      const existsRes = await fetch(`${ONLINE_BASE_URL}/transaction/exists/${encodeURIComponent(tx.tx_id)}`);
      if (existsRes.ok) {
        const existsData = await existsRes.json();
        if (existsData.exists === true) {
          await run(
            "UPDATE offline_transactions SET status = 'synced', sync_status = 'synced', synced_at = CURRENT_TIMESTAMP, blockchain_synced_at = CURRENT_TIMESTAMP, sync_error = NULL WHERE tx_id = ?",
            [tx.tx_id],
          );
          synced++;
          logger.info("[SYNC SUCCESS] " + tx.tx_id + " synced to blockchain (already existed)");
          continue;
        }
      }

      const submitRes = await fetch(`${ONLINE_BASE_URL}/transaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: tx.from_user_id,
          receiver: tx.to_user_id,
          amount: Number(tx.amount),
          token: tx.token,
          txId: tx.tx_id,
          is_offline_payment: true,
          offline_created_at: tx.offline_created_at || tx.created_at,
          offline_received_at: tx.offline_received_at || tx.created_at,
          blockchain_synced_at: new Date().toISOString(),
          sync_status: "synced",
        }),
      });
      const submitBody = await submitRes.json();

      if (submitRes.ok && submitBody?.success === true) {
        await fetch(`${ONLINE_BASE_URL}/mine`);
        await run(
          "UPDATE offline_transactions SET status = 'synced', sync_status = 'synced', synced_at = CURRENT_TIMESTAMP, blockchain_synced_at = CURRENT_TIMESTAMP, sync_error = NULL WHERE tx_id = ?",
          [tx.tx_id],
        );
        synced++;
        logger.info("[SYNC SUCCESS] " + tx.tx_id + " synced to blockchain");
      } else {
        const msg = submitBody?.message || submitBody?.error || "sync_failed";
        const nextStatus = String(msg).toLowerCase().includes("insufficient") ? "rejected" : "failed";
        await run(
          "UPDATE offline_transactions SET status = ?, sync_status = 'failed', sync_error = ? WHERE tx_id = ?",
          [nextStatus, msg, tx.tx_id],
        );
        if (nextStatus === "rejected") rejected++;
        else failed++;
        logger.error("[SYNC ERROR] Failed to sync " + tx.tx_id + " Reason: " + msg);
      }
    } catch (err) {
      await run(
        "UPDATE offline_transactions SET status = 'failed', sync_status = 'failed', sync_error = ? WHERE tx_id = ?",
        [err.message, tx.tx_id],
      );
      failed++;
      logger.error("[SYNC ERROR] Failed to sync " + tx.tx_id + " Reason: " + err.message);
    }
  }

  return { processed: pending.length, synced, failed, rejected };
}

app.post("/sync-offline-transactions", async (_req, res) => {
  try {
    if (!(await isInternetAvailable())) {
      return res.status(409).json({ ok: false, error: "Internet unavailable" });
    }
    const result = await runSync();
    if (result) {
      return res.json({
        ok: true,
        processed: result.processed,
        synced: result.synced,
        failed: result.failed,
        rejected: result.rejected,
      });
    }
    return res.json({ ok: true, processed: 0, synced: 0, failed: 0, rejected: 0 });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

initDb()
  .then(() => {
    app.listen(OFFLINE_SERVER_PORT, "0.0.0.0", () => {
      logger.info("[OFFLINE SERVER] Running on port " + OFFLINE_SERVER_PORT);
      logger.info("[OFFLINE SERVER] Sync target ONLINE_BASE_URL=" + ONLINE_BASE_URL);
      setInterval(() => {
        isInternetAvailable()
          .then((ok) => {
            if (ok) runSync();
          })
          .catch(() => {});
      }, SYNC_INTERVAL_MS);
    });
  })
  .catch((err) => {
    logger.error("Failed to initialize offline DB", { error: err.message });
    process.exit(1);
  });
