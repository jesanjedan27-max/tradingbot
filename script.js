/* =========================================================
   DERIV DIGITDIFF BOT (FINAL STABLE VERSION)
   ZERO-TICK SAFE + BALANCE FIXED
========================================================= */

document.addEventListener("DOMContentLoaded", () => {

const $ = id => document.getElementById(id);

/* ================= UI ================= */

const startBtn  = $("start");
const pauseBtn  = $("pause");
const stopBtn   = $("stop");
const resetBtn  = $("reset");

const logEl     = $("log");
const statusEl  = $("status");
const balanceEl = $("balance");
const profitEl  = $("profit");
const priceEl   = $("price");
const stakeEl   = $("currentStake");

/* ================= CONFIG ================= */

const APP_ID = 1089;
const SYMBOL = "R_100";

/* ================= WS ================= */

let ws = null;
let running = false;
let paused = false;
let authorized = false;
let manualStop = false;
let reconnectTimer = null;
let reconnecting = false;
let apiToken = null;

/* ================= ENGINE ================= */

let totalProfit = 0;
let digits = new Int8Array(4);

let warmupTicks = 0;
let scanningActive = false;

let cooldownTicks = 0;

let mode = "SIM";

let simWaiting = false;
let simBarrier = null;

let tradeLock = false;
let pendingContract = false;
let activeContractId = null;
let currentBarrier = null;

/* ================= MARTINGALE ================= */

let ladderLevel = 1;
let BASE_STAKE = 0.35;

const MARTINGALE_L2 = 11.57;
const MARTINGALE_L3 = 11.41;

/* ================= ZERO-TICK SAFETY ================= */

let tickBusy = false;
let uiBuffer = null;

/* ================= LOG SYSTEM (UNCHANGED BEHAVIOR) ================= */

let logQueue = [];
let lastFlush = 0;

function log(msg, type="info") {

    const color =
        type === "win" ? "lime" :
        type === "loss" ? "red" :
        type === "tick" ? "#38bdf8" : "#ccc";

    logQueue.push(`<span style="color:${color}">${msg}</span><br>`);
}

function flushLogs() {

    const now = Date.now();

    if (logQueue.length && now - lastFlush > 80) {

        logEl.insertAdjacentHTML("beforeend", logQueue.join(""));
        logQueue = [];

        logEl.scrollTop = logEl.scrollHeight;
        lastFlush = now;
    }
}

/* ================= SAFE SEND ================= */

function safeSend(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
        return true;
    }
    return false;
}

/* ================= DIGIT ENGINE (STABLE FIX) ================= */

function getLastDigitFast(price) {
    const s = price.toFixed(2);
    return s.charCodeAt(s.length - 1) - 48;
}

/* ================= STAKE ================= */

function getStake(level) {
    if (level === 1) return +BASE_STAKE.toFixed(2);
    if (level === 2) return +(BASE_STAKE * MARTINGALE_L2).toFixed(2);
    if (level === 3) return +(BASE_STAKE * MARTINGALE_L2 * MARTINGALE_L3).toFixed(2);
    return +BASE_STAKE.toFixed(2);
}

function updateStakeDisplay() {
    stakeEl.textContent = `$${getStake(ladderLevel).toFixed(2)}`;
}

/* ================= STATUS ================= */

function setStatus(text, color="white") {
    statusEl.textContent = text;
    statusEl.style.color = color;
}

/* ================= RESET ================= */

function resetTradeState() {
    tradeLock = false;
    pendingContract = false;
    activeContractId = null;
    currentBarrier = null;
}

function fullReset() {
    digits.fill(0);
    warmupTicks = 0;
    scanningActive = false;
    cooldownTicks = 0;
    mode = "SIM";
    simWaiting = false;
    simBarrier = null;
    ladderLevel = 1;
    resetTradeState();
    updateStakeDisplay();
}

/* ================= SIM RESULT ================= */

function processSimResult(digit) {

    simWaiting = false;

    log(`SIM RESULT ${digit} | BARRIER ${simBarrier}`);

    cooldownTicks = 4;

    if (digit !== simBarrier) {
        mode = "SIM";
        simBarrier = null;
        log("SIM WIN → CONTINUE", "win");
    } else {
        mode = "REAL";
        log("SIM LOSS → SWITCH REAL", "loss");
    }
}

/* ================= TRADE ================= */

function executeTrade(barrier) {

    if (!authorized || paused || !running || pendingContract || tradeLock) return;

    tradeLock = true;
    pendingContract = true;

    currentBarrier = barrier;

    const stake = getStake(ladderLevel);

    safeSend({
        buy: 1,
        price: stake,
        parameters: {
            amount: stake,
            basis: "stake",
            contract_type: "DIGITDIFF",
            currency: "USD",
            duration: 1,
            duration_unit: "t",
            symbol: SYMBOL,
            barrier: barrier
        }
    });

    updateStakeDisplay();
    log(`TRADE L${ladderLevel} → ${barrier} | $${stake}`);
}

/* ================= RESULT ================= */

function handleResult(contract) {

    const pnl = Number(contract.profit || 0);
    totalProfit += pnl;

    profitEl.textContent = totalProfit.toFixed(2);

    const exitDigit =
        contract.exit_tick
            ? getLastDigitFast(Number(contract.exit_tick))
            : "?";

    log(`RESULT ${exitDigit} | BARRIER ${currentBarrier} | PnL ${pnl}`);

    cooldownTicks = 4;

    if (pnl > 0) {
        ladderLevel = 1;
        mode = "SIM";
        log("WIN → BACK SIM", "win");
    } else {
        if (ladderLevel === 1) ladderLevel = 2;
        else if (ladderLevel === 2) ladderLevel = 3;
        else {
            ladderLevel = 1;
            mode = "SIM";
            log("MAX LOSS RESET", "loss");
        }
        log(`MARTINGALE L${ladderLevel}`, "loss");
    }

    resetTradeState();
    updateStakeDisplay();
}

/* ================= HANDLE TICK (ZERO-TICK CORE) ================= */

function handleTick(price) {

    if (tickBusy || !running || paused) return;
    tickBusy = true;

    const digit = getLastDigitFast(price);

    digits[0] = digits[1];
    digits[1] = digits[2];
    digits[2] = digits[3];
    digits[3] = digit;

    uiBuffer = `${price.toFixed(2)} → ${digit}`;

    if (!scanningActive) {

        warmupTicks++;

        log(`WARMUP ${warmupTicks}/10`, "tick");

        if (warmupTicks >= 10) {
            scanningActive = true;
            setStatus("Running", "lime");
            log("ENGINE ACTIVE", "win");
        }

        tickBusy = false;
        return;
    }

    if (simWaiting) processSimResult(digit);

    if (cooldownTicks > 0) {
        cooldownTicks--;
        tickBusy = false;
        return;
    }

    const d1 = digits[1];
    const d2 = digits[2];
    const d3 = digits[3];

    const pattern =
        (d1 >= 5 && d1 === d2 && d2 === d3) ||
        (d1 <= 4 && d1 === d2 && d2 === d3);

    if (!tradeLock && !pendingContract && pattern) {

        if (mode === "SIM") {
            simWaiting = true;
            simBarrier = digits[0];
            log(`SIM SIGNAL ${digits[0]}`);
        } else {
            executeTrade(digits[0]);
            log(`REAL SIGNAL ${digits[0]}`);
        }
    }

    log(`Tick ${digit}`, "tick");

    tickBusy = false;
}

/* ================= WS CONNECT ================= */

function connect() {

    ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

    ws.onopen = () => {
        log("CONNECTED");
        safeSend({ authorize: apiToken });
    };

    ws.onmessage = (e) => {

        const msg = JSON.parse(e.data);

        if (msg.error) {
            log(msg.error.message, "loss");
            tradeLock = false;
            pendingContract = false;
            return;
        }

        /* AUTH */
        if (msg.msg_type === "authorize") {
            authorized = true;
            setStatus("Running", "lime");

            safeSend({ ticks: SYMBOL, subscribe: 1 });

            // 🔥 FIXED BALANCE SUBSCRIPTION
            safeSend({ balance: 1, subscribe: 1 });
        }

        /* TICK */
        if (msg.msg_type === "tick") {
            handleTick(msg.tick.quote);
        }

        /* BALANCE FIX */
        if (msg.msg_type === "balance") {
            const bal =
                msg.balance?.balance ??
                msg.balance?.cash_balance ??
                0;

            balanceEl.textContent = Number(bal).toFixed(2);
        }

        /* BUY */
        if (msg.msg_type === "buy") {
            activeContractId = msg.buy.contract_id;

            safeSend({
                proposal_open_contract: 1,
                contract_id: activeContractId,
                subscribe: 1
            });
        }

        /* RESULT */
        if (msg.msg_type === "proposal_open_contract") {

            const c = msg.proposal_open_contract;

            if (c.is_sold) handleResult(c);
        }
    };
}

/* ================= UI UPDATE LOOP ================= */

setInterval(() => {

    if (uiBuffer) {
        priceEl.textContent = uiBuffer;
        uiBuffer = null;
    }

    flushLogs();

}, 50);

/* ================= BUTTONS ================= */

startBtn.onclick = () => {

    apiToken = $("token").value.trim();
    if (!apiToken) return alert("Enter token");

    running = true;
    paused = false;

    totalProfit = 0;
    profitEl.textContent = "0.00";

    fullReset();
    updateStakeDisplay();

    setStatus("Running", "lime");
    connect();
};

pauseBtn.onclick = () => {
    paused = !paused;
    setStatus(paused ? "Paused" : "Running");
};

stopBtn.onclick = () => {
    running = false;
    ws?.close();
    setStatus("Stopped", "red");
};

resetBtn.onclick = () => {
    running = false;
    ws?.close();
    totalProfit = 0;
    profitEl.textContent = "0.00";
    fullReset();
    setStatus("Reset", "red");
};

});
