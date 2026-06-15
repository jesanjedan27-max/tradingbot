document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);

  // ================= UI =================
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
  const SYMBOL = "R_100";

  const ACCOUNTS = {
    demo: "DOT92927394",
    live: "ROT91650098"
  };

  let ACCOUNT = "demo";

  let ws;
  let token = (localStorage.getItem("access_token") || "").trim();

  let running = false;
  let paused = false;

  let authorized = false;

  let armActive = false;
  let momentum = [];
  let lastDigits = [];

  let tradeLock = false;
  let ladderLevel = 0;
  let totalProfit = 0;

  // ================= LOG =================
  function log(msg, color = "#fff") {
    const div = document.createElement("div");
    div.style.color = color;
    div.textContent = msg;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ================= SEND =================
  function send(data) {
    if (!ws || ws.readyState !== 1) return;
    if (!authorized) return;
    ws.send(JSON.stringify(data));
  }

  // ================= DIGIT =================
  function digit(price) {
    return Math.floor(Math.abs(price * 100)) % 10;
  }

  // ================= STAKE =================
  function stake(level) {
    const base = Number(stakeInput.value || 0.35);
    return +(base * Math.pow(11.57, level)).toFixed(2);
  }

  // ================= RESET =================
  function resetStrategy() {
    armActive = false;
    momentum = [];
    lastDigits = [];
    tradeLock = false;
  }

  // ================= STRATEGY =================
  function onTick(price) {
    if (!running || paused) return;

    const d = digit(price);

    priceEl.textContent = price.toFixed(2);

    log(`Tick ${price.toFixed(2)} → ${d}`, "#38bdf8");

    lastDigits.push(d);
    if (lastDigits.length > 10) lastDigits.shift();

    // ================= ARM =================
    if (!armActive) {
      if (lastDigits.slice(-2).join("") === "23") {
        armActive = true;
        momentum = [];
        log("ARMED → 2,3 detected", "lime");
      }
      return;
    }

    // ================= MOMENTUM (EXACTLY 3 DIGITS) =================
    if (armActive && momentum.length < 3) {
      momentum.push(d);
      log(`MOMENTUM → ${momentum.join(",")}`, "#facc15");
      return;
    }

    // ================= TRIGGER =================
    if (armActive && momentum.length >= 3) {
      if (d === 9) {
        log("IGNORED 9", "red");
        resetStrategy();
        return;
      }

      const barrier = (d + 1) % 10;

      log(
        `TRADE SIGNAL → momentum [${momentum.join(",")}] | barrier ${barrier}`,
        "#38bdf8"
      );

      placeTrade(barrier);
      resetStrategy();
    }
  }

  // ================= TRADE =================
  function placeTrade(barrier) {
    if (tradeLock) return;

    tradeLock = true;

    const amount = stake(ladderLevel);

    send({
      proposal: 1,
      amount,
      basis: "stake",
      contract_type: "DIGITDIFF",
      currency: "USD",
      duration: 1,
      duration_unit: "t",
      underlying_symbol: SYMBOL,
      barrier
    });

    log(`TRADE SENT → ${barrier} | stake ${amount}`, "#38bdf8");
  }

  // ================= CONNECT =================
  function connect() {
    resetStrategy();

    if (ws) ws.close();

    if (!token || token.length < 20) {
      log("NO VALID TOKEN - LOGIN REQUIRED", "red");
      return;
    }

    authorized = false;

    ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

    ws.onopen = () => {
      log("WS CONNECTED", "lime");

      // 🔥 FIX: AUTHORIZE FIRST (THIS REMOVES YOUR ERROR)
      ws.send(JSON.stringify({
        authorize: token
      }));
    };

    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);

      // ================= ERROR HANDLING =================
      if (d.error) {
        log("ERROR: " + d.error.message, "red");
        return;
      }

      // ================= AUTHORIZE SUCCESS =================
      if (d.msg_type === "authorize") {
        authorized = true;
        log(`AUTHORIZED (${ACCOUNT})`, "lime");

        // ONLY AFTER AUTH
        send({ ticks: SYMBOL, subscribe: 1 });
        send({ balance: 1 });
      }

      // ================= TICKS =================
      if (d.msg_type === "tick") {
        onTick(d.tick.quote);
      }

      // ================= BALANCE =================
      if (d.msg_type === "balance") {
        balanceEl.textContent = Number(d.balance.balance).toFixed(2);
      }

      // ================= TRADE RESULT =================
      if (d.msg_type === "proposal_open_contract") {
        const c = d.proposal_open_contract;

        if (c.is_sold) {
          tradeLock = false;

          const pnl = Number(c.profit || 0);
          totalProfit += pnl;

          profitEl.textContent = totalProfit.toFixed(2);

          log(
            pnl >= 0 ? `WIN +${pnl}` : `LOSS ${pnl}`,
            pnl >= 0 ? "lime" : "red"
          );

          ladderLevel = pnl > 0 ? 0 : ladderLevel + 1;
          levelEl.textContent = ladderLevel;
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
    resetStrategy();
    totalProfit = 0;
    profitEl.textContent = "0.00";
    log("RESET DONE", "orange");
  };

  demoBtn.onclick = () => {
    ACCOUNT = "demo";
    log("SWITCHED DEMO", "blue");
  };

  liveBtn.onclick = () => {
    ACCOUNT = "live";
    log("SWITCHED LIVE", "red");
  };
});
