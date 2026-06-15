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

  // ================= STATE =================
  let ws = null;
  let token = localStorage.getItem("access_token");

  let running = false;
  let paused = false;
  let authorized = false;

  let ladderLevel = 0;

  // ================= ENGINE STATE =================
  let state = "WAIT_2";
  let m1 = null;
  let m2 = null;
  let y = null;
  let forbidden = null;

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
    return +(base * Math.pow(2, level)).toFixed(2);
  }

  // ================= RESET ENGINE =================
  function resetEngine() {
    state = "WAIT_2";
    m1 = null;
    m2 = null;
    y = null;
    forbidden = null;
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

    priceEl.textContent = price.toFixed(2);

    log(`Tick ${price.toFixed(2)} → ${d}`, "#38bdf8");

    // ================= STEP 1: WAIT 2 =================
    if (state === "WAIT_2") {
      if (d === 2) {
        state = "WAIT_3";
        log("ARM → 2 detected", "lime");
      }
      return;
    }

    // ================= STEP 2: WAIT 3 (STRICT ORDER) =================
    if (state === "WAIT_3") {
      if (d === 3) {
        state = "M1";
        log("ARM CONFIRMED → 2,3", "lime");
      } else if (d !== 2) {
        state = "WAIT_2";
      }
      return;
    }

    // ================= STEP 3: MOMENTUM 1 =================
    if (state === "M1") {
      m1 = d;
      state = "M2";
      log(`MOMENTUM 1 → ${m1}`, "#facc15");
      return;
    }

    // ================= STEP 4: MOMENTUM 2 =================
    if (state === "M2") {
      m2 = d;
      state = "TRIGGER";
      log(`MOMENTUM 2 → ${m2}`, "#facc15");
      return;
    }

    // ================= STEP 5: TRIGGER =================
    if (state === "TRIGGER") {
      y = d;

      if (y === 9) {
        log("INVALID → trigger 9 ignored", "red");
        resetEngine();
        return;
      }

      forbidden = (y + 1) % 10;

      state = "WAIT_EXEC";

      log(
        `DDF → trigger ${y} | forbidden ${forbidden}`,
        "#22c55e"
      );
      return;
    }

    // ================= STEP 6: EXECUTION (NEXT TICK ONLY) =================
    if (state === "WAIT_EXEC") {
      const result = d;

      log(`EXECUTION → ${result}`, "#60a5fa");

      if (result === forbidden) {
        log(`LOSS → ${result}`, "red");
        ladderLevel += 1;
      } else {
        log(`WIN → ${result}`, "lime");
        ladderLevel = 0;
      }

      resetEngine();
    }
  }

  // ================= CONNECT =================
  function connect() {
    resetEngine();

    if (ws) {
      ws.close();
    }

    token = localStorage.getItem("access_token");

    if (!token) {
      log("NO TOKEN - LOGIN REQUIRED", "red");
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
            pnl >= 0 ? `WIN +${pnl}` : `LOSS ${pnl}`,
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
    resetEngine();
    log("RESET DONE", "orange");
  };

  demoBtn.onclick = () => {
    ACCOUNT = "demo";
    log("DEMO MODE", "blue");
    connect();
  };

  liveBtn.onclick = () => {
    ACCOUNT = "live";
    log("LIVE MODE", "red");
    connect();
  };
});
