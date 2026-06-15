document.addEventListener("DOMContentLoaded", async () => {
  const $ = id => document.getElementById(id);

  // ================= UI =================
  const loginBtn = $("login");
  const startBtn = $("start");
  const pauseBtn = $("pause");
  const stopBtn  = $("stop");
  const resetBtn = $("reset");

  const demoBtn = $("demoBtn");
  const liveBtn = $("liveBtn");
  const modeIndicator = $("modeIndicator");

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

  // Demo / Live accounts
  const ACCOUNTS = {
    demo: "DOT92927394",
    live: "ROT91650098"
  };

  // ================= STATE =================
  let ws;
  let token = localStorage.getItem("access_token");

  let running = false;
  let paused = false;
  let authorized = false;

  let accountType = "demo";

  let ladderLevel = 0;
  let tradeLock = false;

  // strategy state machine
  let buffer = [];
  let armed = false;
  let stage = 0; // 0=search, 1=arm, 2=ready

  let m1 = null;
  let m2 = null;

  let BASE = 0.35;
  let totalProfit = 0;

  let pendingProposalId = null;

  // ================= LOG =================
  function log(msg, color = "#fff") {
    const div = document.createElement("div");
    div.style.color = color;
    div.textContent = msg;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function send(data) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }

  // ================= MODE UI =================
  function updateModeUI() {
    if (accountType === "demo") {
      modeIndicator.textContent = "DEMO MODE";
      modeIndicator.className = "mode-indicator demo";
    } else {
      modeIndicator.textContent = "LIVE MODE";
      modeIndicator.className = "mode-indicator live";
    }
  }

  // ================= RESET =================
  function resetState() {
    authorized = false;
    tradeLock = false;
    buffer = [];
    armed = false;
    stage = 0;
    m1 = null;
    m2 = null;
    ladderLevel = 0;
    totalProfit = 0;
    pendingProposalId = null;
  }

  // ================= LOGIN (PKCE unchanged) =================
  loginBtn.onclick = async () => {
    const verifier = crypto.randomUUID().replace(/-/g, "");
    const challenge = btoa(verifier).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    localStorage.setItem("pkce_verifier", verifier);

    const url =
      `https://auth.deriv.com/oauth2/auth` +
      `?response_type=code&client_id=${CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&scope=trade` +
      `&code_challenge=${challenge}` +
      `&code_challenge_method=S256`;

    window.location.href = url;
  };

  async function handleOAuth() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (!code) return;

    const verifier = localStorage.getItem("pkce_verifier");

    const res = await fetch(VERCEL_URL, {
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

    if (!data.access_token) {
      log("OAuth failed", "red");
      return;
    }

    token = data.access_token;
    localStorage.setItem("access_token", token);

    log("LOGIN SUCCESS", "lime");
    window.history.replaceState({}, document.title, REDIRECT_URI);
  }

  await handleOAuth();

  // ================= STAKE =================
  function stake(level) {
    const mult = Math.pow(11.57, level - 1);
    return +(BASE * mult).toFixed(2);
  }

  // ================= STRATEGY (SAFE STATE MACHINE) =================
  function onTick(price) {
    if (!running || paused || tradeLock) return;

    const digit = Math.floor(price % 10);

    priceEl.textContent = price.toFixed(2);

    log(`Tick ${price.toFixed(2)} → ${digit}`, "#38bdf8");

    buffer.push(digit);
    if (buffer.length > 10) buffer.shift();

    // STEP 1: LOOK FOR 2,3
    if (stage === 0) {
      if (buffer.slice(-2).join("") === "23") {
        stage = 1;
        log("ACTIVATOR 2,3 FOUND", "lime");
      }
      return;
    }

    // STEP 2: MOMENTUM 1
    if (stage === 1) {
      m1 = digit;
      stage = 2;
      return;
    }

    // STEP 3: MOMENTUM 2
    if (stage === 2) {
      m2 = digit;

      const trigger = digit;

      if (trigger === 9) {
        log("INVALID TRIGGER 9 → RESET", "red");
        stage = 0;
        buffer = [];
        return;
      }

      const barrier = trigger + 1;

      executeTrade(barrier);

      stage = 0;
      buffer = [];
    }
  }

  // ================= PROPER TRADE FLOW =================
  function executeTrade(barrier) {
    if (!authorized || tradeLock) return;

    tradeLock = true;

    BASE = Number(stakeInput.value || 0.35);
    const amount = stake(ladderLevel || 1);

    pendingProposalId = null;

    // STEP 1: REQUEST PROPOSAL
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

    log(`PROPOSAL REQUESTED → barrier ${barrier}`, "#38bdf8");

    // buy will happen AFTER proposal response
  }

  // ================= CONNECTION =================
  function connect() {
    resetState();

    ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=1089`);

    ws.onopen = () => {
      log("WS CONNECTED", "yellow");
      send({ authorize: token });
    };

    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);

      if (d.msg_type === "authorize") {
        authorized = true;
        send({ ticks: SYMBOL, subscribe: 1 });
        send({ balance: 1 });
        log("AUTHORIZED", "lime");
      }

      if (d.msg_type === "tick") {
        onTick(d.tick.quote);
      }

      if (d.msg_type === "balance") {
        balanceEl.textContent = Number(d.balance.balance).toFixed(2);
      }

      // STEP 1 RESPONSE → BUY
      if (d.msg_type === "proposal") {
        pendingProposalId = d.proposal.id;

        send({
          buy: pendingProposalId,
          price: d.proposal.ask_price
        });

        log("BUY SENT", "lime");
      }

      // STEP 2 RESULT
      if (d.msg_type === "buy") {
        send({
          proposal_open_contract: 1,
          contract_id: d.buy.contract_id,
          subscribe: 1
        });
      }

      // RESULT
      if (
        d.msg_type === "proposal_open_contract" &&
        d.proposal_open_contract.is_sold
      ) {
        tradeLock = false;

        const pnl = Number(d.proposal_open_contract.profit || 0);
        totalProfit += pnl;

        profitEl.textContent = totalProfit.toFixed(2);

        log(pnl >= 0 ? `WIN +${pnl}` : `LOSS ${pnl}`, pnl >= 0 ? "lime" : "red");

        if (pnl > 0) ladderLevel = 0;
        else if (ladderLevel < 3) ladderLevel++;
      }

      if (d.error) {
        tradeLock = false;
        log("ERROR: " + d.error.message, "red");
      }
    };

    ws.onclose = () => log("WS CLOSED", "red");
  }

  // ================= BUTTONS =================
  startBtn.onclick = () => {
    if (!token) return alert("Login first");
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
    accountType = "demo";
    updateModeUI();
    ws?.close();
    setTimeout(connect, 500);
  };

  liveBtn.onclick = () => {
    accountType = "live";
    updateModeUI();
    ws?.close();
    setTimeout(connect, 500);
  };

  updateModeUI();
});
