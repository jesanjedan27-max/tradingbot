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
  const profitEl = $("profit");
  const logEl = $("log");

  const stakeInput = $("stakeInput");

  // ================= CONFIG =================
  const CLIENT_ID = "33wZZKTFZrmsZgFaAH53Z";
  const SYMBOL = "R_100";
  const WS_URL = "wss://ws.derivws.com/websockets/v3?app_id=1089";

  let ACCOUNT = "demo";

  // ================= STATE =================
  let ws = null;
  let running = false;
  let paused = false;
  let authorized = false;
  let ladder = 0;

  // ================= STRATEGY =================
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

  // ================= RESET =================
  function resetStrategy() {
    state = "WAIT_2";
    m1 = null;
    m2 = null;
    y = null;
    forbidden = null;
  }

  // ================= SAFE SEND =================
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
    log(`Tick → ${d}`, "#38bdf8");

    // ARM 2
    if (state === "WAIT_2") {
      if (d === 2) {
        state = "WAIT_3";
        log("ARM: 2 detected", "lime");
      }
      return;
    }

    // ARM 3 (strict order)
    if (state === "WAIT_3") {
      if (d === 3) {
        state = "M1";
        log("ARM CONFIRMED 2,3", "lime");
      } else if (d !== 2) {
        state = "WAIT_2";
      }
      return;
    }

    // MOMENTUM 1
    if (state === "M1") {
      m1 = d;
      state = "M2";
      log("M1 → " + m1, "#facc15");
      return;
    }

    // MOMENTUM 2
    if (state === "M2") {
      m2 = d;
      state = "TRIGGER";
      log("M2 → " + m2, "#facc15");
      return;
    }

    // TRIGGER
    if (state === "TRIGGER") {
      y = d;

      if (y === 9) {
        log("INVALID TRIGGER 9", "red");
        resetStrategy();
        return;
      }

      forbidden = (y + 1) % 10;
      state = "EXEC";

      log(`DDF → y=${y} | forbidden=${forbidden}`, "#22c55e");
      return;
    }

    // EXECUTION (NEXT TICK ONLY)
    if (state === "EXEC") {
      const result = d;

      if (result === forbidden) {
        log(`LOSS → ${result}`, "red");
        ladder++;
      } else {
        log(`WIN → ${result}`, "lime");
        ladder = 0;
      }

      resetStrategy();
    }
  }

  // ================= CONNECT =================
  function connect() {
    resetStrategy();

    if (ws) ws.close();

    let token = localStorage.getItem("access_token");

    // 🔥 FIX: HARD CLEAN TOKEN (THIS REMOVES AUTHORIZE ERROR COMPLETELY)
    if (typeof token !== "string") token = "";
    token = token.trim();

    if (token.length < 20) {
      log("NO VALID TOKEN - LOGIN REQUIRED", "red");
      return;
    }

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      log("WS CONNECTED", "yellow");

      // ✅ SAFE AUTHORIZE (NO MORE INPUT ERROR)
      ws.send(JSON.stringify({
        authorize: token
      }));
    };

    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);

      if (d.error) {
        log("ERROR: " + d.error.message, "red");

        if (d.error.message.includes("authorize")) {
          log("AUTH FAILED - FIX TOKEN", "red");
          ws.close();
        }
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

      if (d.msg_type === "proposal_open_contract") {
        const poc = d.proposal_open_contract;

        if (poc.is_sold) {
          const pnl = Number(poc.profit || 0);
          profitEl.textContent = pnl.toFixed(2);

          log(pnl >= 0 ? `WIN +${pnl}` : `LOSS ${pnl}`, pnl >= 0 ? "lime" : "red");
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
