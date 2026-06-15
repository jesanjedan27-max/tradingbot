document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);

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

  // ================= STRICT STATE MACHINE =================
  let armActive = false;
  let momentum = [];
  let triggerDigit = null;

  let ladderLevel = 0;
  let tradeLock = false;
  let totalProfit = 0;

  let buffer = [];

  function log(msg, c = "#fff") {
    const d = document.createElement("div");
    d.textContent = msg;
    d.style.color = c;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function send(data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
  }

  function digit(price) {
    return Math.floor(Math.abs(price * 100)) % 10;
  }

  function stake(level) {
    const base = Number(stakeInput.value || 0.35);
    return +(base * Math.pow(11.57, level)).toFixed(2);
  }

  function resetState() {
    armActive = false;
    momentum = [];
    triggerDigit = null;
    buffer = [];
    tradeLock = false;
  }

  // ================= FIXED STRATEGY =================
  function onTick(price) {
    if (!running || paused) return;

    const d = digit(price);

    // ALWAYS log first
    log(`Tick ${price.toFixed(2)} → ${d}`, "#38bdf8");

    buffer.push(d);
    if (buffer.length > 10) buffer.shift();

    // ================= ARM =================
    if (!armActive) {
      if (buffer.slice(-2).join("") === "23") {
        armActive = true;
        momentum = [];
        log("ARMED → 2,3 detected", "lime");
      }
      return;
    }

    // ================= MOMENTUM (STRICT 2 DIGITS ONLY) =================
    if (armActive && momentum.length < 2) {
      momentum.push(d);
      log(`MOMENTUM → ${momentum.join(",")}`, "#facc15");
      return;
    }

    // ================= TRIGGER (ONLY 1 DIGIT) =================
    if (armActive && momentum.length === 2 && triggerDigit === null) {
      triggerDigit = d;

      const winDigit = (triggerDigit + 1) % 10;

      log(
        `TRIGGER → momentum [${momentum.join(",")}] | trigger ${triggerDigit} | win ${winDigit}`,
        "#38bdf8"
      );

      placeTrade(winDigit);

      resetState();
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
    resetState();

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

          if (d.msg_type === "tick") {
            onTick(d.tick.quote);
          }

          if (d.msg_type === "balance") {
            balanceEl.textContent = Number(d.balance.balance).toFixed(2);
          }

          if (d.msg_type === "proposal") {
            send({
              buy: d.proposal.id,
              price: d.proposal.ask_price
            });
          }

          if (d.msg_type === "buy") {
            send({
              proposal_open_contract: 1,
              contract_id: d.buy.contract_id,
              subscribe: 1
            });
          }

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
    resetState();
    totalProfit = 0;
    profitEl.textContent = "0.00";
    log("RESET DONE", "orange");
  };

  demoBtn.onclick = () => (ACCOUNT = "demo");
  liveBtn.onclick = () => (ACCOUNT = "live");
});
