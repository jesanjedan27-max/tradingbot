document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);

  // ================= UI =================
  const loginBtn = $("login");
  const startBtn = $("start");
  const pauseBtn = $("pause");
  const stopBtn = $("stop");
  const resetBtn = $("reset");

  const demoBtn = $("demoBtn");
  const liveBtn = $("liveBtn");

  const priceEl = $("price");
  const balanceEl = $("balance");
  const levelEl = $("level");
  const profitEl = $("profit");
  const logEl = $("log");

  const stakeInput = $("stakeInput");

  // ================= CONFIG =================
  const CLIENT_ID = "33wZZKTFZrmsZgFaAH53Z";
  const REDIRECT_URI = "https://jesanjedan27-max.github.io/tradingbot/";
  const VERCEL_URL = "https://oauthexchange23.vercel.app/api/token";
  const SYMBOL = "R_100";

  let ACCOUNT = "demo";
  const ACCOUNTS = {
    demo: "DOT92927394",
    live: "ROT91650098"
  };

  // ================= STATE =================
  let ws = null;
  let token = localStorage.getItem("access_token");

  let running = false;
  let paused = false;
  let authorized = false;

  let ladderLevel = 0;
  let tradeLock = false;

  // ================= STRATEGY STATE =================
  let armActive = false;
  let momentum = [];
  let triggerDigit = null;
  let waitingNextTick = false;
  let forbiddenDigit = null;
  let lastTickDigit = null;

  // ================= LOG =================
  function log(msg, color = "#fff") {
    const div = document.createElement("div");
    div.style.color = color;
    div.textContent = msg;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ================= DIGIT =================
  function digit(price) {
    return Math.floor(Math.abs(price * 100)) % 10;
  }

  // ================= STAKE =================
  function stake(level) {
    const base = Number(stakeInput.value || 0.35);
    const mult = Math.pow(2, level);
    return +(base * mult).toFixed(2);
  }

  // ================= RESET =================
  function resetState() {
    armActive = false;
    momentum = [];
    triggerDigit = null;
    waitingNextTick = false;
    forbiddenDigit = null;
    tradeLock = false;
  }

  // ================= SEND =================
  function send(data) {
    if (!ws || ws.readyState !== 1) return;
    if (!authorized) return;
    ws.send(JSON.stringify(data));
  }

  // ================= STRATEGY ENGINE =================
  function onTick(price) {
    if (!running || paused) return;

    const d = digit(price);
    lastTickDigit = d;

    priceEl.textContent = price.toFixed(2);

    log(`Tick ${price.toFixed(2)} → ${d}`, "#38bdf8");

    // ================= ARM (2,3) =================
    if (!armActive) {
      if (d === 2 || d === 3) {
        armActive = true;
        momentum = [];
        log("ARM → 2,3 detected", "lime");
      }
      return;
    }

    // ================= MOMENTUM (2 digits) =================
    if (momentum.length < 2) {
      momentum.push(d);
      log(`MOMENTUM → ${momentum.join(",")}`, "#facc15");
      return;
    }

    // ================= TRIGGER =================
    if (!waitingNextTick) {
      if (d === 9) {
        log("INVALID → trigger 9 ignored", "red");
        resetState();
        return;
      }

      triggerDigit = d;
      forbiddenDigit = (triggerDigit + 1) % 10;

      waitingNextTick = true;

      log(
        `DDF → trigger ${triggerDigit} | forbidden ${forbiddenDigit}`,
        "#22c55e"
      );
      return;
    }

    // ================= EXECUTION (NEXT TICK ONLY) =================
    if (waitingNextTick) {
      waitingNextTick = false;

      log(`EXECUTION CHECK → digit ${d}`, "#60a5fa");

      if (d === forbiddenDigit) {
        log(`LOSS → ${d}`, "red");
        ladderLevel += 1;
      } else {
        log(`WIN +0.02 → ${d}`, "lime");
        ladderLevel = 0;
      }

      tradeLock = false;
      resetState();
    }
  }

  // ================= CONNECT =================
  function connect() {
    resetState();

    if (ws) {
      ws.onmessage = null;
      ws.onopen = null;
      ws.close();
    }

    token = localStorage.getItem("access_token");

    if (!token) {
      log("NO TOKEN", "red");
      return;
    }

    ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

    ws.onopen = () => {
      log("WS CONNECTED", "yellow");
      ws.send(JSON.stringify({ authorize: token }));
    };

    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);

      if (d.error) {
        log("ERROR: " + d.error.message, "red");
        return;
      }

      if (d.msg_type === "authorize") {
        authorized = true;
        log(`AUTHORIZED (${ACCOUNT})`, "lime");

        ws.send(JSON.stringify({ ticks: SYMBOL, subscribe: 1 }));
        ws.send(JSON.stringify({ balance: 1 }));
      }

      if (d.msg_type === "tick") {
        onTick(d.tick.quote);
      }

      if (d.msg_type === "balance") {
        balanceEl.textContent = Number(d.balance.balance).toFixed(2);
      }

      if (d.msg_type === "proposal") {
        ws.send(JSON.stringify({
          buy: d.proposal.id,
          price: d.proposal.ask_price
        }));
      }

      if (d.msg_type === "buy") {
        ws.send(JSON.stringify({
          proposal_open_contract: 1,
          contract_id: d.buy.contract_id,
          subscribe: 1
        }));
      }

      if (d.msg_type === "proposal_open_contract") {
        const poc = d.proposal_open_contract;

        if (poc.is_sold) {
          const pnl = Number(poc.profit || 0);

          profitEl.textContent = pnl.toFixed(2);

          log(
            pnl >= 0 ? `WIN REAL +${pnl}` : `LOSS ${pnl}`,
            pnl >= 0 ? "lime" : "red"
          );
        }
      }
    };

    ws.onclose = () => log("WS CLOSED", "red");
  }

  // ================= BUTTONS =================
  startBtn.onclick = () => {
    running = true;
    connect();
    log("BOT STARTED", "lime");
  };

  pauseBtn.onclick = () => {
    paused = !paused;
    log(paused ? "PAUSED" : "RUNNING", "yellow");
  };

  stopBtn.onclick = () => {
    running = false;
    ws?.close();
    log("STOPPED", "red");
  };

  resetBtn.onclick = () => {
    resetState();
    log("RESET DONE", "orange");
  };

  demoBtn.onclick = () => {
    ACCOUNT = "demo";
    log("SWITCHED DEMO", "blue");
    connect();
  };

  liveBtn.onclick = () => {
    ACCOUNT = "live";
    log("SWITCHED LIVE", "red");
    connect();
  };
});
