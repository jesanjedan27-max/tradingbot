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
  const logEl = $("log");
  const profitEl = $("profit");

  // ================= CONFIG =================
  const CLIENT_ID = "33wZZKTFZrmsZgFaAH53Z";
  const REDIRECT_URI = "https://jesanjedan27-max.github.io/tradingbot/";
  const VERCEL_URL = "https://oauthexchange23.vercel.app/api/token";
  const SYMBOL = "R_100";
  const APP_ID = 1089;

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

  let buffer = [];
  let stage = 0;

  let ladderLevel = 0;
  let tradeLock = false;

  let profitTotal = 0;
  let lastDigit = null;

  // ================= LOG =================
  function log(msg, color = "#fff") {
    const div = document.createElement("div");
    div.style.color = color;
    div.textContent = msg;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setModeUI() {
    demoBtn.style.background = ACCOUNT === "demo" ? "#2563eb" : "";
    liveBtn.style.background = ACCOUNT === "live" ? "#ef4444" : "";
  }

  function digit(price) {
    return Math.floor(price) % 10;
  }

  function stake(level) {
    const base = 0.35;
    return +(base * Math.pow(11.57, level)).toFixed(2);
  }

  function resetState() {
    authorized = false;
    tradeLock = false;
    buffer = [];
    stage = 0;
    ladderLevel = 0;
    lastDigit = null;
  }

  // ================= SAFE SEND =================
  function send(data) {
    if (!ws || ws.readyState !== 1) return;
    if (!authorized) return;
    ws.send(JSON.stringify(data));
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

    token = data.access_token || data.data?.access_token;

    if (!token) {
      log("OAuth FAILED", "red");
      return;
    }

    localStorage.setItem("access_token", token);
    log("LOGIN SUCCESS", "lime");

    window.history.replaceState({}, document.title, REDIRECT_URI);
  }

  handleOAuth();

  // ================= STRATEGY =================
  function onTick(price) {
    if (!running || paused || tradeLock) return;

    const d = digit(price);
    lastDigit = d;

    priceEl.textContent = price.toFixed(2);
    log(`Tick ${price.toFixed(2)} → ${d}`, "#38bdf8");

    buffer.push(d);
    if (buffer.length > 10) buffer.shift();

    // ACTIVATOR 2,3
    if (stage === 0) {
      if (buffer.slice(-2).join("") === "23") {
        stage = 1;
        log("ACTIVATOR 2,3", "lime");
      }
      return;
    }

    // M1
    if (stage === 1) {
      stage = 2;
      return;
    }

    // M2 + TRIGGER
    if (stage === 2) {
      const trigger = d;

      if (trigger === 9) {
        log("IGNORED 9", "red");
        stage = 0;
        buffer = [];
        return;
      }

      const barrier = trigger + 1;

      placeTrade(barrier, trigger);

      stage = 0;
      buffer = [];
    }
  }

  // ================= TRADE =================
  function placeTrade(barrier, triggerDigit) {
    if (!authorized || tradeLock) return;

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

    log(`TRADE → barrier ${barrier}`, "#38bdf8");
  }

  // ================= CONNECT =================
  function connect() {
    resetState();

    if (ws) {
      try { ws.close(); } catch {}
    }

    token = localStorage.getItem("access_token");

    if (!token) {
      log("NO TOKEN", "red");
      return;
    }

    ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

    ws.onopen = () => {
      log("WS CONNECTED", "yellow");
      ws.send(JSON.stringify({ authorize: token }));
    };

    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);

      if (d.error) {
        log("ERROR: " + d.error.message, "red");
        tradeLock = false;
        return;
      }

      if (d.msg_type === "authorize") {
        authorized = true;
        log(`AUTHORIZED (${ACCOUNT})`, "lime");

        ws.send({ ticks: SYMBOL, subscribe: 1 });
        ws.send({ balance: 1 });
      }

      if (d.msg_type === "tick") {
        onTick(d.tick.quote);
      }

      if (d.msg_type === "balance") {
        balanceEl.textContent = Number(d.balance.balance).toFixed(2);
      }

      // PROPOSAL → BUY
      if (d.msg_type === "proposal") {
        ws.send({
          buy: d.proposal.id,
          price: d.proposal.ask_price
        });
      }

      // BUY → TRACK CONTRACT
      if (d.msg_type === "buy") {
        ws.send({
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
        const winDigit = lastDigit;

        profitTotal += pnl;
        profitEl.textContent = profitTotal.toFixed(2);

        log(
          pnl >= 0
            ? `WIN +${pnl.toFixed(2)} (digit=${winDigit})`
            : `LOSS ${pnl.toFixed(2)} (digit=${winDigit})`,
          pnl >= 0 ? "lime" : "red"
        );

        ladderLevel = pnl > 0 ? 0 : ladderLevel + 1;
        levelEl.textContent = ladderLevel;
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

  stopBtn.onclick = () => {
    running = false;
    ws?.close();
    log("STOPPED", "red");
  };

  pauseBtn.onclick = () => {
    paused = !paused;
    log(paused ? "PAUSED" : "RUNNING", "yellow");
  };

  resetBtn.onclick = () => {
    profitTotal = 0;
    profitEl.textContent = "0.00";
    resetState();
    log("RESET DONE", "orange");
  };

  demoBtn.onclick = () => {
    ACCOUNT = "demo";
    setModeUI();
    connect();
  };

  liveBtn.onclick = () => {
    ACCOUNT = "live";
    setModeUI();
    connect();
  };

  setModeUI();
});
