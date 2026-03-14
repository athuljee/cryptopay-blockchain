const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  "https://aestyrhopdszbispwyhg.supabase.co",
  "sb_publishable_4n478x91JNx-BBW-yK_lrQ_42cVjUbH"
);

const express = require("express");
const bodyParser = require("body-parser");
const SHA256 = require("crypto-js/sha256");
const AES = require("crypto-js/aes");
const Utf8 = require("crypto-js/enc-utf8");

/* ---------------- ENCRYPTION KEY ---------------- */

const ENCRYPTION_KEY = "CryptoPay2024SecureKey!@#";
const cors = require("cors");

const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});
/* ---------------- TOKEN VALUES ---------------- */

const TOKEN_VALUES = {
    BTC: 52000,
    ETH: 3400,
    USDT: 1
};

/* ---------------- BLOCK CLASS ---------------- */

class Block {

    constructor(index, timestamp, transactions, previousHash = "") {
        this.index = index;
        this.timestamp = timestamp;
        this.transactions = transactions;
        this.previousHash = previousHash;
        this.nonce = 0;
        this.hash = this.calculateHash();
    }

    calculateHash() {
        return SHA256(
            this.index +
            this.previousHash +
            this.timestamp +
            JSON.stringify(this.transactions) +
            this.nonce
        ).toString();
    }

    mineBlock(difficulty) {

        while (
            this.hash.substring(0, difficulty) !==
            Array(difficulty + 1).join("0")
        ) {
            this.nonce++;
            this.hash = this.calculateHash();
        }

        console.log("Block mined:", this.hash);
    }
}

/* ---------------- BLOCKCHAIN CLASS ---------------- */

class Blockchain {

    constructor() {

        this.chain = [this.createGenesisBlock()];
        this.difficulty = 2;
        this.pendingTransactions = [];
    }

    createGenesisBlock() {
        return new Block(0, Date.now(), "Genesis Block", "0");
    }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }

    async addTransaction(transaction) {

        const { sender, receiver, amount, token } = transaction;

        try {
            // Get sender balance
            const { data: senderData, error: senderError } = await supabase
                .from('users')
                .select('btc, eth, usdt')
                .eq('username', sender)
                .single();

            if (senderError || !senderData) {
                return { success: false, message: "Sender not found" };
            }

            // Get receiver balance
            const { data: receiverData, error: receiverError } = await supabase
                .from('users')
                .select('btc, eth, usdt')
                .eq('username', receiver)
                .single();

            if (receiverError || !receiverData) {
                return { success: false, message: "Receiver not found" };
            }

            const senderBalance = {
                BTC: parseFloat(senderData.btc || 0),
                ETH: parseFloat(senderData.eth || 0),
                USDT: parseFloat(senderData.usdt || 0)
            };

            if (senderBalance[token] < amount) {
                return { success: false, message: "Insufficient balance" };
            }

            // Update sender balance
            const newSenderBalance = { ...senderBalance };
            newSenderBalance[token] -= amount;

            await supabase
                .from('users')
                .update({
                    btc: newSenderBalance.BTC,
                    eth: newSenderBalance.ETH,
                    usdt: newSenderBalance.USDT
                })
                .eq('username', sender);

            // Update receiver balance
            const receiverBalance = {
                BTC: parseFloat(receiverData.btc || 0),
                ETH: parseFloat(receiverData.eth || 0),
                USDT: parseFloat(receiverData.usdt || 0)
            };
            receiverBalance[token] += amount;

            await supabase
                .from('users')
                .update({
                    btc: receiverBalance.BTC,
                    eth: receiverBalance.ETH,
                    usdt: receiverBalance.USDT
                })
                .eq('username', receiver);

            this.pendingTransactions.push(transaction);

            return { success: true };
        } catch (err) {
            console.error('Error in addTransaction:', err);
            return { success: false, message: "Transaction failed" };
        }
    }

    async minePendingTransactions() {

        if (this.pendingTransactions.length === 0) {
            return "No transactions to mine";
        }

        const block = new Block(
            this.chain.length,
            Date.now(),
            this.pendingTransactions,
            this.getLatestBlock().hash
        );

        block.mineBlock(this.difficulty);

        for (const tx of this.pendingTransactions) {

            // SAVE TRANSACTION IN SUPABASE

            await supabase
                .from("transactions")
                .insert({
                    sender: tx.sender,
                    receiver: tx.receiver,
                    amount: tx.amount,
                    token: tx.token
                });

            // NOTIFY MERCHANT TERMINAL

            

        }

        this.chain.push(block);
        this.pendingTransactions = [];

        return "Block mined successfully";
    }

    async getBalance(address) {
        try {
            const { data, error } = await supabase
                .from('users')
                .select('btc, eth, usdt')
                .eq('username', address)
                .single();

            if (error || !data) {
                console.log(`Balance for ${address}: not found`); // Debug log
                return { BTC: 0, ETH: 0, USDT: 0 };
            }

            const balance = {
                BTC: parseFloat(data.btc || 0),
                ETH: parseFloat(data.eth || 0),
                USDT: parseFloat(data.usdt || 0)
            };
            console.log(`Balance for ${address}:`, balance); // Debug log
            return balance;
        } catch (err) {
            console.error('Error getting balance:', err);
            return { BTC: 0, ETH: 0, USDT: 0 };
        }
    }
}

const myCoin = new Blockchain();

/* ---------------- PAYMENT NOTIFICATION ---------------- */

let lastPayment = null;

app.post("/notify-payment", (req, res) => {

    lastPayment = req.body;

    console.log("Payment notification:", lastPayment);

    res.json({ success: true });

});

app.get("/last-payment", (req, res) => {

    if (!lastPayment) {
        return res.json(null);
    }

    res.json(lastPayment);

});

app.post("/clear-payment", (req, res) => {

    lastPayment = null;

    res.json({ success: true });

});

/* ---------------- API ROUTES ---------------- */

app.post("/transaction", async (req, res) => {

    const result = await myCoin.addTransaction(req.body);
    res.json(result);

});

app.get("/mine", async (req, res) => {

    const result = await myCoin.minePendingTransactions();
    res.json({ message: result });

});

app.get("/chain", (req, res) => {

    res.json(myCoin.chain);

});

app.get("/balance/:address", async (req, res) => {

    const balance = await myCoin.getBalance(req.params.address);
    res.json(balance);

});

/* ---------------- LOGIN USING SUPABASE ---------------- */

app.post("/login", async (req, res) => {

    const { username, password } = req.body;

    try {

        const { data, error } = await supabase
            .from("users")
            .select("*")
            .eq("username", username)
            .single();

        if (error || !data) {

            return res.json({
                success: false,
                message: "Invalid username or password"
            });

        }

        // Decrypt stored password
        const storedPassword = data.password;
        if (!storedPassword.startsWith('$crypt::')) {
            return res.json({
                success: false,
                message: "Invalid password format"
            });
        }

        const encryptedPart = storedPassword.substring(8); // Remove '$crypt::'
        const decryptedPassword = AES.decrypt(encryptedPart, ENCRYPTION_KEY).toString(Utf8);

        if (decryptedPassword !== password) {
            return res.json({
                success: false,
                message: "Invalid username or password"
            });
        }

        res.json({
            success: true,
            role: data.role
        });

    } catch (err) {

        res.json({
            success: false,
            message: "Server error"
        });

    }

});

/* ---------------- SIGNUP USING SUPABASE ---------------- */

app.post("/signup", async (req, res) => {

    const { username, password, role } = req.body;

    try {

        const { data: existing } = await supabase
            .from("users")
            .select("username")
            .eq("username", username)
            .single();

        if (existing) {

            return res.json({
                success: false,
                message: "User already exists"
            });

        }

        // Encrypt password
        const encryptedPassword = AES.encrypt(password, ENCRYPTION_KEY).toString();
        const storedPassword = `$crypt::${encryptedPassword}`;

        await supabase
            .from("users")
            .insert({
                username,
                password: storedPassword,
                role
            });

        res.json({
            success: true,
            message: "User created"
        });

    } catch (err) {

        res.json({
            success: false,
            message: "Server error"
        });

    }

});

/* ---------------- TOKEN VALUES ---------------- */

app.get("/token-values", (req, res) => {

    res.json(TOKEN_VALUES);

});

/* ---------------- SERVER ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Blockchain server running on port ${PORT}`);
});