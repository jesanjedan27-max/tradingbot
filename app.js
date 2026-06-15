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
  const REDIRECT_URI = "https://jesanjedan27-max.github.io/tradingbot/";

  const ACCOUNTS = {
    demo: "DOT92927394",
    live: "ROT91650098"
  };

  const SYMBOL = "R_100";

  // ================= STATE =================
  let ws = null;
  let token = localStorage.getItem("access_token");

  let ACCOUNT = "demo";
  let running = false;
  let paused = false;

  let buffer = [];
  let stage = 0;

  let ladderLevel = 0;
  let tradeLock = false;

  let totalProfit = 0;
  let lastContractId = null;

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
  function resetState() {
    buffer = [];
    stage = 0;
    tradeLock = false;
  }

  // ================= MODE UI =================
  function updateModeUI() {
    modeIndicator.textContent =
      ACCOUNT === "demo" ? "JESAN 💲 MODE - DEMO" : "JESAN 💲 MODE - LIVE";

    modeIndicator.style.color =
      ACCOUNT === "demo" ? "#38bdf8" : "#ef4444";

    demoBtn.style.background = ACCOUNT === "demo" ? "#2563eb" : "";
    liveBtn.style.background = ACCOUNT === "live" ? "#ef4444" : "";
  }

  // ================= LOGIN =================
  loginBtn.onclick = async () => {
    const verifier = crypto.randomUUID().replace(/-/g, "");
    localStorage.setItem("pkce_verifier", verifier);

    const challenge = btoa(verifier)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const url =
      `https://auth.deriv.com/oauth2/auth` +
      `?response_type=code&client_id=${CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&scope=trade` +
      `&code_challenge=${challenge}` +
      `&code_challenge_method=S256`;

    window.location.href = url;
  };

  // ================= OAUTH =================
  async function handleOAuth() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (!code) return;

    const verifier = localStorage.getItem("pkce_verifier");

    const res = await fetch("https://oauthexchange23.vercel.app/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI
      })
    });

    const data = await res.json();

    token = data.access_token || data.data?.access_token;

    if (!token) {
      log("LOGIN FAILED", "red");
      return;
    }

    localStorage.setItem("access_token", token);
    log("LOGIN SUCCESS", "lime");

    window.history.replaceState({}, document.title, REDIRECT_URI);
  }

  handleOAuth();

  // ================= CONNECT (FIXED - NO AUTHORIZE EVER) =================
  function connect() {
    resetState();

    if (ws) ws.close();

    token = localStorage.getItem("access_token");
    if (!token) {
      log("LOGIN REQUIRED", "red");
      return;
    }

    const accountId = ACCOUNTS[ACCOUNT];

    fetch(`https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Deriv-App-ID": CLIENT_ID
      }
    })
      .then(r => r.json())
      .then(data => {
        ws = new WebSocket(data.data.url);

        ws.onopen = () => {
          log("WS CONNECTED", "yellow");

          // ONLY THESE (NO AUTHORIZE)
          send({ ticks: SYMBOL, subscribe: 1 });
          send({ balance: 1 });
        };

        ws.onmessage = (e) => {
          const d = JSON.parse(e.data);

          if (d.error) {
            log("ERROR: " + d.error.message, "red");
            return;
          }

          // ================= BALANCE =================
          if (d.msg_type === "balance") {
            balanceEl.textContent =
              Number(d.balance.balance).toFixed(2);

            log(
              `Balance (${ACCOUNT}): ${d.balance.balance}`,
              "lime"
            );
          }

          // ================= TICKS =================
          if (d.msg_type === "tick") {
            const price = d.tick.quote;
            const dig = digit(price);

            priceEl.textContent = price.toFixed(2);

            log(`Tick ${price.toFixed(2)} → ${dig}`, "#38bdf8");

            onTick(price);
          }

          // ================= BUY =================
          if (d.msg_type === "buy") {
            lastContractId = d.buy.contract_id;

            send({
              proposal_open_contract: 1,
              contract_id: lastContractId,
              subscribe: 1
            });
          }

          // ================= CONTRACT RESULT =================
          if (d.msg_type === "proposal_open_contract") {
            const c = d.proposal_open_contract;

            if (c.is_sold) {
              tradeLock = false;

              const pnl = Number(c.profit || 0);
              totalProfit += pnl;

              profitEl.textContent = totalProfit.toFixed(2);

              const winDigit = c.exit_spot
                ? Math.floor(Number(c.exit_spot) * 100) % 10
                : "-";

              log(
                pnl >= 0
                  ? `WIN +${pnl.toFixed(2)} | Digit ${winDigit}`
                  : `LOSS ${pnl.toFixed(2)} | Digit ${winDigit}`,
                pnl >= 0 ? "lime" : "red"
              );

              ladderLevel = pnl > 0 ? 0 : ladderLevel + 1;
            }
          }
        };

        ws.onclose = () => log("WS CLOSED", "red");
      });
  }

  // ================= STRATEGY =================
  function onTick(price) {
    if (!running || paused || tradeLock) return;

    const d = digit(price);

    buffer.push(d);
    if (buffer.length > 10) buffer.shift();

    if (stage === 0) {
      if (buffer.slice(-2).join("") === "23") {
        stage = 1;
        log("ACTIVATOR 2,3", "lime");
      }
      return;
    }

    if (stage === 1) {
      stage = 2;
      return;
    }

    if (stage === 2) {
      if (d === 9) {
        log("IGNORED 9", "red");
        stage = 0;
        buffer = [];
        return;
      }

      const barrier = d + 1;
      placeTrade(barrier);

      stage = 0;
      buffer = [];
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

    levelEl.textContent = ladderLevel;
    log(`TRADE → ${barrier} | Stake ${amount}`, "#38bdf8");
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

  demoBtn.onclick = () => {
    ACCOUNT = "demo";
    updateModeUI();
    connect();
  };

  liveBtn.onclick = () => {
    ACCOUNT = "live";
    updateModeUI();
    connect();
  };

  updateModeUI();
});
