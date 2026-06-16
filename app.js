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
  const profitEl = $("profit");
  const levelEl = $("level");
  const logEl = $("log");
  const stakeInput = $("stakeInput");

  // ================= CONFIG =================
  const CLIENT_ID = "33wZZKTFZrmsZgFaAH53Z";
  const SYMBOL = "R_100";

  let ACCOUNT = "demo";
  const ACCOUNTS = {
    demo: "DOT92927394",
    live: "ROT91650098"
  };

  // ================= STATE =================
  let ws;
  let token = (localStorage.getItem("access_token") || "").trim();

  let running = false;
  let paused = false;

  let ladder = 0;
  let totalProfit = 0;

  // ================= STRATEGY STATE =================
  let prevDigit = null;
  let arm = false;
  let momentum = [];
  let y = null;
  let executed = false;

  // ================= LOG =================
  function log(msg, color = "#fff") {
    const div = document.createElement("div");
    div.style.color = color;
    div.textContent = msg;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ================= SEND (FIXED - NO AUTH BLOCK) =================
  function send(data) {
    if (!ws || ws.readyState !== 1) return;
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
    arm = false;
    momentum = [];
    y = null;
    executed = false;
    prevDigit = null;
  }

  // ================= STRATEGY =================
  function onTick(price) {
    if (!running || paused) return;

    const d = digit(price);

    priceEl.textContent = price.toFixed(2);
    log(`Tick ${price.toFixed(2)} → ${d}`, "#38bdf8");

    // ARM: strict 2 → 3 sequence
    if (!arm) {
      if (prevDigit === 2 && d === 3) {
        arm = true;
        momentum = [];
        log("ARMED → 2 → 3 detected", "lime");
      }
      prevDigit = d;
      return;
    }

    // MOMENTUM (first 2 digits)
    if (momentum.length < 2) {
      momentum.push(d);
      log(`MOMENTUM → ${momentum.join(",")}`, "#facc15");
      prevDigit = d;
      return;
    }

    // TRIGGER digit (y)
    if (momentum.length === 2 && !executed) {
      y = d;
      executed = true;

      const forbidden = (y + 1) % 10;

      log(`TRIGGER → y=${y} | forbidden=${forbidden}`, "#22c55e");
      prevDigit = d;
      return;
    }

    // EXECUTION ON NEXT TICK ONLY
    if (executed) {
      const forbidden = (y + 1) % 10;

      if (d === forbidden) {
        log(`LOSS → digit ${d}`, "red");
        ladder++;
      } else {
        log(`WIN → digit ${d}`, "lime");
        ladder = 0;
      }

      levelEl.textContent = ladder;
      resetStrategy();
      prevDigit = d;
    }
  }

  // ================= CONNECT (FIXED OTP FLOW) =================
  function connect() {
    resetStrategy();

    if (ws) ws.close();

    token = (localStorage.getItem("access_token") || "").trim();

    if (!token || token.length < 20) {
      log("NO VALID TOKEN", "red");
      return;
    }

    const accountId = ACCOUNTS[ACCOUNT];

    fetch(
      `https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Deriv-App-ID": CLIENT_ID
        }
      }
    )
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

          if (d.error) {
            log("ERROR: " + d.error.message, "red");
            return;
          }

          // TICK
          if (d.msg_type === "tick") {
            if (d.tick?.quote !== undefined) {
              onTick(d.tick.quote);
            }
          }

          // BALANCE
          if (d.msg_type === "balance") {
            balanceEl.textContent = Number(d.balance?.balance || 0).toFixed(2);
          }

          // RESULT
          if (d.msg_type === "proposal_open_contract") {
            const c = d.proposal_open_contract;

            if (c.is_sold) {
              const pnl = Number(c.profit || 0);
              totalProfit += pnl;

              profitEl.textContent = totalProfit.toFixed(2);

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
    log("DEMO MODE", "blue");
  };

  liveBtn.onclick = () => {
    ACCOUNT = "live";
    log("LIVE MODE", "red");
  };
});
