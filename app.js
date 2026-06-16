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

  // ================= STRATEGY STATE =================
  let sequence = [];
  let waitingProposal = false;
  let proposalId = null;

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
    sequence = [];
    waitingProposal = false;
    proposalId = null;
  }

  // ================= TRADE =================
  function placeTrade(barrier) {
    const amount = stake(ladder);

    waitingProposal = true;

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

    log(`PROPOSAL SENT → DIGITDIFF ${barrier} | stake ${amount}`, "#38bdf8");
  }

  // ================= STRATEGY =================
  function onTick(price) {
    if (!running || paused) return;

    const d = digit(price);

    priceEl.textContent = price.toFixed(2);

    log(`Tick ${price.toFixed(2)} → ${d}`, "#38bdf8");

    if (waitingProposal) return;

    sequence.push(d);
    if (sequence.length > 5) sequence.shift();

    if (sequence.length < 5) return;

    const [a, b, z1, z2, x] = sequence;

    // PATTERN: 2,3,z,z,x
    if (a === 2 && b === 3) {

      if (x === 9) {
        log("INVALID SEQUENCE (x=9)", "red");
        sequence = [];
        return;
      }

      const barrier = x + 1;

      log(
        `PATTERN FOUND → ${sequence.join(",")} → TRADE DIGITDIFF ${barrier}`,
        "lime"
      );

      placeTrade(barrier);

      sequence = [];
    }
  }

  // ================= CONNECT =================
  function connect() {
    resetStrategy();

    if (ws) ws.close();

    const accountId = ACCOUNTS[ACCOUNT];

    fetch(
      `https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + localStorage.getItem("access_token"),
          "Deriv-App-ID": "33wZZKTFZrmsZgFaAH53Z"
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

          // ================= TICKS =================
          if (d.msg_type === "tick") {
            onTick(d.tick.quote);
          }

          // ================= BALANCE =================
          if (d.msg_type === "balance") {
            balanceEl.textContent = Number(d.balance.balance || 0).toFixed(2);
          }

          // ================= PROPOSAL RESPONSE =================
          if (d.msg_type === "proposal") {

            if (!waitingProposal) return;

            proposalId = d.proposal.id;

            log("PROPOSAL RECEIVED → BUYING", "#22c55e");

            send({
              buy: proposalId,
              price: d.proposal.ask_price
            });
          }

          // ================= CONTRACT RESULT =================
          if (d.msg_type === "proposal_open_contract") {

            const c = d.proposal_open_contract;

            if (!c.is_sold) return;

            const pnl = Number(c.profit || 0);

            totalProfit += pnl;

            profitEl.textContent = totalProfit.toFixed(2);
            balanceEl.textContent = Number(c.balance_after || 0).toFixed(2);

            if (pnl >= 0) {
              ladder = 0;
              log(`WIN +${pnl}`, "lime");
            } else {
              ladder++;
              log(`LOSS ${pnl}`, "red");
            }

            levelEl.textContent = ladder;

            waitingProposal = false;
            resetStrategy();
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
