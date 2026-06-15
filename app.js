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
  const modeIndicator = $("modeIndicator");

  // ================= CONFIG =================
  const CLIENT_ID = "33wZZKTFZrmsZgFaAH53Z";
  const SYMBOL = "R_100";

  const ACCOUNTS = {
    demo: "DOT92927394",
    live: "ROT91650098"
  };

  let ws;
  let token = localStorage.getItem("access_token");

  let ACCOUNT = "demo";
  let running = false;
  let paused = false;

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
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
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

    // ================= ALWAYS LOG FIRST (FIX) =================
    log(`Tick ${price.toFixed(2)} → ${d}`, "#38bdf8");

    priceEl.textContent = price.toFixed(2);

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

    // ================= MOMENTUM =================
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
        `TRADE SIGNAL → momentum [${momentum.join(",")}] | win digit ${barrier}`,
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

    const accountId = ACCOUNTS[ACCOUNT];

    fetch(`https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Deriv-App-ID": CLIENT_ID
      }
    })
      .then(r => r.json())
      .then(res => {

        ws = new WebSocket(res.data.url);

        ws.onopen = () => {
          log("WS CONNECTED", "lime");

          send({ ticks: SYMBOL, subscribe: 1 });
          send({ balance: 1 });
        };

        ws.onmessage = (e) => {
          const d = JSON.parse(e.data);

          // ================= BALANCE =================
          if (d.msg_type === "balance") {
            balanceEl.textContent = Number(d.balance.balance).toFixed(2);
          }

          // ================= TICK =================
          if (d.msg_type === "tick") {
            onTick(d.tick.quote);
          }

          // ================= BUY =================
          if (d.msg_type === "buy") {
            send({
              proposal_open_contract: 1,
              contract_id: d.buy.contract_id,
              subscribe: 1
            });
          }

          // ================= RESULT =================
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

          if (d.error) {
            log("ERROR: " + d.error.message, "red");
          }
        };
      });
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

  demoBtn.onclick = () => (ACCOUNT = "demo");
  liveBtn.onclick = () => (ACCOUNT = "live");
});
