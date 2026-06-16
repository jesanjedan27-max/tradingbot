document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);

  const startBtn = $("start");
  const pauseBtn = $("pause");
  const stopBtn = $("stop");
  const resetBtn = $("reset");

  const demoBtn = $("demoBtn");
  const liveBtn = $("liveBtn");

  const priceEl = $("price");
  const balanceEl = $("balance");
  const profitEl = $("profit");
  const levelEl = $("level");
  const logEl = $("log");
  const stakeInput = $("stakeInput");

  const SYMBOL = "R_100";

  let ACCOUNT = "demo";
  const ACCOUNTS = {
    demo: "DOT92927394",
    live: "ROT91650098"
  };

  let ws;
  let running = false;
  let paused = false;

  let ladder = 0;
  let totalProfit = 0;

  let prevDigit = null;
  let arm = false;
  let momentum = [];
  let y = null;
  let executed = false;

  let pendingProposal = null;
  let lastBarrier = null;

  function log(msg, color = "#fff") {
    const div = document.createElement("div");
    div.style.color = color;
    div.textContent = msg;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function digit(price) {
    return Math.floor(Math.abs(price * 100)) % 10;
  }

  function stake(level) {
    const base = Number(stakeInput.value || 0.35);
    return +(base * Math.pow(11.57, level)).toFixed(2);
  }

  function send(data) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify(data));
  }

  function resetStrategy() {
    arm = false;
    momentum = [];
    y = null;
    executed = false;
    prevDigit = null;
  }

  // ================= TRADE REQUEST =================
  function placeTrade(barrier) {
    const amount = stake(ladder);
    lastBarrier = barrier;

    send({
      proposal: 1,
      amount,
      basis: "stake",
      contract_type: "DIGITDIFF",
      currency: "USD",
      duration: 1,
      duration_unit: "t",
      symbol: SYMBOL,
      barrier
    });

    log(`PROPOSAL REQUEST → barrier ${barrier}`, "#38bdf8");
  }

  function onTick(price) {
    if (!running || paused) return;

    const d = digit(price);

    priceEl.textContent = price.toFixed(2);
    log(`Tick ${price.toFixed(2)} → ${d}`, "#38bdf8");

    // ARM
    if (!arm) {
      if (prevDigit === 2 && d === 3) {
        arm = true;
        momentum = [];
        log("ARMED → 2 → 3", "lime");
      }
      prevDigit = d;
      return;
    }

    // MOMENTUM
    if (momentum.length < 2) {
      momentum.push(d);
      log(`MOMENTUM → ${momentum.join(",")}`, "#facc15");
      prevDigit = d;
      return;
    }

    // TRIGGER
    if (momentum.length === 2 && y === null) {
      y = d;

      if (y === 9) {
        log("INVALID TRIGGER → 9 ignored", "red");
        resetStrategy();
        return;
      }

      const forbidden = (y + 1) % 10;

      log(`TRIGGER y=${y} forbidden=${forbidden}`, "#22c55e");

      executed = true;
      y = forbidden;

      prevDigit = d;
      return;
    }

    // EXECUTION
    if (executed && y !== null) {
      placeTrade(y);

      if (d === y) {
        log(`LOSS → ${d}`, "red");
        ladder++;
      } else {
        log(`WIN → ${d}`, "lime");
        ladder = 0;
      }

      levelEl.textContent = ladder;
      resetStrategy();
      prevDigit = d;
    }
  }

  function connect() {
    resetStrategy();

    if (ws) ws.close();

    const accountId = ACCOUNTS[ACCOUNT];

    fetch(`https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + localStorage.getItem("access_token"),
        "Deriv-App-ID": "33wZZKTFZrmsZgFaAH53Z"
      }
    })
      .then(r => r.json())
      .then(data => {

        if (!data?.data?.url) {
          log("OTP FAILED", "red");
          console.log(data);
          return;
        }

        ws = new WebSocket(data.data.url);

        ws.onopen = () => {
          log("WS CONNECTED", "lime");

          setTimeout(() => {
            send({ ticks: SYMBOL, subscribe: 1 });
            send({ balance: 1 });
          }, 300);
        };

        ws.onmessage = (e) => {
          const d = JSON.parse(e.data);

          // TICKS
          if (d.msg_type === "tick") {
            onTick(d.tick.quote);
          }

          // BALANCE
          if (d.msg_type === "balance") {
            balanceEl.textContent = Number(d.balance.balance || 0).toFixed(2);
          }

          // PROPOSAL RESPONSE → BUY EXECUTION (CRITICAL FIX)
          if (d.msg_type === "proposal") {
            if (d.proposal?.id) {
              send({
                buy: d.proposal.id,
                price: d.proposal.ask_price
              });

              log(`BUY SENT → proposal ${d.proposal.id}`, "lime");
            }
          }

          // RESULT TRACKING
          if (d.msg_type === "proposal_open_contract") {
            const c = d.proposal_open_contract;

            if (c.is_sold) {
              const pnl = Number(c.profit || 0);

              totalProfit += pnl;
              profitEl.textContent = totalProfit.toFixed(2);

              balanceEl.textContent = Number(c.balance_after || 0).toFixed(2);

              log(
                pnl >= 0 ? `WIN +${pnl}` : `LOSS ${pnl}`,
                pnl >= 0 ? "lime" : "red"
              );
            }
          }
        };

        ws.onclose = () => log("WS CLOSED", "red");
      });
  }

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
    log("DEMO MODE", "blue");
  };

  liveBtn.onclick = () => {
    ACCOUNT = "live";
    log("LIVE MODE", "red");
  };
});
