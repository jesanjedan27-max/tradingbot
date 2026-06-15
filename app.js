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
  const modeIndicator = $("modeIndicator");
  const stakeInput = $("stakeInput");

  // ================= CONFIG =================
  const CLIENT_ID = "33wZZKTFZrmsZgFaAH53Z";
  const REDIRECT_URI = "https://jesanjedan27-max.github.io/tradingbot/";
  const OTP_URL = "https://api.derivws.com/trading/v1/options/accounts";
  const SYMBOL = "R_100";

  const ACCOUNTS = {
    demo: "DOT92927394",
    live: "ROT91650098"
  };

  // ================= STATE =================
  let ws = null;
  let token = localStorage.getItem("access_token");

  let ACCOUNT = "demo";
  let running = false;
  let paused = false;
  let authorized = false;

  let ladder = 0;
  let tradeLock = false;
  let profit = 0;

  // ================= LOG =================
  function log(msg, color = "#fff") {
    const div = document.createElement("div");
    div.style.color = color;
    div.textContent = msg;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ================= MODE UI =================
  function updateModeUI() {
    if (ACCOUNT === "demo") {
      modeIndicator.textContent = "JESAN 💲 MODE - DEMO";
      modeIndicator.style.color = "#38bdf8";
    } else {
      modeIndicator.textContent = "JESAN 💲 MODE - LIVE";
      modeIndicator.style.color = "#ef4444";
    }
  }

  // ================= SAFE SEND =================
  function send(data) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify(data));
  }

  // ================= DIGIT =================
  const lastDigit = price =>
    Math.floor(Math.abs(price * 100)) % 10;

  // ================= STAKE =================
  function stake() {
    return Number(stakeInput.value || 0.35);
  }

  // ================= RESET =================
  function resetState() {
    authorized = false;
    tradeLock = false;
    ladder = 0;
    profit = 0;
    profitEl.textContent = "0.00";
    levelEl.textContent = "0";
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
    token = data.access_token;

    if (!token) return log("LOGIN FAILED", "red");

    localStorage.setItem("access_token", token);
    log("LOGIN SUCCESS", "lime");

    window.history.replaceState({}, document.title, REDIRECT_URI);
  }

  handleOAuth();

  // ================= CONNECT (FIXED OTP FLOW) =================
  async function connect() {
    resetState();

    if (ws) ws.close();

    token = localStorage.getItem("access_token");
    if (!token) return log("NO TOKEN", "red");

    const accountId = ACCOUNTS[ACCOUNT];

    const res = await fetch(`${OTP_URL}/${accountId}/otp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Deriv-App-ID": "33wZZKTFZrmsZgFaAH53Z"
      }
    });

    const json = await res.json();
    const wsUrl = json?.data?.url;

    if (!wsUrl) {
      log("OTP FAILED", "red");
      return;
    }

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      log("WS CONNECTED", "yellow");
      send({ authorize: token });
    };

    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);

      if (d.error) {
        log("ERROR: " + d.error.message, "red");
        return;
      }

      // AUTH
      if (d.msg_type === "authorize") {
        authorized = true;
        log(`AUTHORIZED (${ACCOUNT})`, "lime");

        send({ ticks: SYMBOL, subscribe: 1 });
        send({ balance: 1 });
      }

      // BALANCE
      if (d.msg_type === "balance") {
        balanceEl.textContent = Number(d.balance.balance).toFixed(2);
      }

      // TICKS
      if (d.msg_type === "tick") {
        const price = d.tick.quote;
        const digit = lastDigit(price);

        priceEl.textContent = price.toFixed(2);

        log(`Tick ${price.toFixed(2)} → ${digit}`, "#38bdf8");

        if (!running || paused || tradeLock) return;

        if (digit === 3) {
          placeTrade(5);
        }
      }

      // PROPOSAL → BUY
      if (d.msg_type === "proposal") {
        send({
          buy: d.proposal.id,
          price: d.proposal.ask_price
        });
      }

      // BUY → TRACK CONTRACT
      if (d.msg_type === "buy") {
        send({
          proposal_open_contract: 1,
          contract_id: d.buy.contract_id,
          subscribe: 1
        });
      }

      // RESULT
      if (d.msg_type === "proposal_open_contract" && d.proposal_open_contract.is_sold) {
        tradeLock = false;

        const pnl = Number(d.proposal_open_contract.profit || 0);
        profit += pnl;

        profitEl.textContent = profit.toFixed(2);

        log(
          pnl >= 0 ? `WIN +${pnl.toFixed(2)}` : `LOSS ${pnl.toFixed(2)}`,
          pnl >= 0 ? "lime" : "red"
        );

        ladder = pnl > 0 ? 0 : ladder + 1;
        levelEl.textContent = ladder;
      }
    };

    ws.onclose = () => log("WS CLOSED", "red");
  }

  // ================= TRADE =================
  function placeTrade(barrier) {
    if (!authorized || tradeLock) return;

    tradeLock = true;

    send({
      proposal: 1,
      amount: stake(),
      basis: "stake",
      contract_type: "DIGITDIFF",
      currency: "USD",
      duration: 1,
      duration_unit: "t",
      underlying_symbol: SYMBOL,
      barrier
    });

    log(`TRADE → ${barrier}`, "#38bdf8");
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
