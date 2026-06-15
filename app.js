document.addEventListener("DOMContentLoaded", async () => {
  const $ = id => document.getElementById(id);

  // ================= UI =================
  const loginBtn = $("login");
  const startBtn = $("start");
  const pauseBtn = $("pause");
  const stopBtn  = $("stop");
  const resetBtn = $("reset");
  const modeBtn  = $("mode");

  const priceEl = $("price");
  const balanceEl = $("balance");
  const levelEl = $("level");
  const logEl = $("log");
  const stakeInput = $("stakeInput");

  // ================= CONFIG =================
  const CLIENT_ID = "33wZZKTFZrmsZgFaAH53Z";
  const REDIRECT_URI = "https://jesanjedan27-max.github.io/tradingbot/";
  const VERCEL_URL = "https://oauthexchange23.vercel.app/api/token";
  const SYMBOL = "R_100";

  // ✅ YOUR ACCOUNTS (FIXED)
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

  let buffer = [];
  let armed = false;
  let m1 = null;
  let m2 = null;

  let BASE = 0.35;

  // ================= LOG =================
  function log(msg, color = "#fff") {
    logEl.innerHTML += `<div style="color:${color}">${msg}</div>`;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function send(data) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }

  // ================= RESET STATE =================
  function resetState() {
    authorized = false;
    tradeLock = false;
    buffer = [];
    armed = false;
    m1 = null;
    m2 = null;
    ladderLevel = 0;
    BASE = Number(stakeInput.value || 0.35);
  }

  // ================= LOGIN =================
  loginBtn.onclick = async () => {
    const verifier = crypto.randomUUID().replace(/-/g, "");
    const challenge = btoa(verifier).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    localStorage.setItem("pkce_verifier", verifier);

    const authUrl =
      `https://auth.deriv.com/oauth2/auth` +
      `?response_type=code` +
      `&client_id=${CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&scope=trade` +
      `&code_challenge=${challenge}` +
      `&code_challenge_method=S256`;

    window.location.href = authUrl;
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

  // ================= STRATEGY =================
  function onTick(price) {
    if (!running || paused || tradeLock) return;

    const digit = Math.floor(price % 10);

    priceEl.textContent = price.toFixed(2);
    log(`Tick ${price.toFixed(2)} → ${digit}`, "#38bdf8");

    buffer.push(digit);
    if (buffer.length > 10) buffer.shift();

    // 🔥 2,3 ACTIVATOR
    if (!armed) {
      if (buffer.slice(-2).join("") === "23") {
        armed = true;
        m1 = null;
        m2 = null;
        log("ACTIVATOR 2,3 DETECTED", "lime");
      }
      return;
    }

    if (m1 === null) return (m1 = digit);
    if (m2 === null) return (m2 = digit);

    const trigger = digit;

    if (trigger === 9) {
      log("Ignored trigger 9", "red");
      armed = false;
      buffer = [];
      m1 = m2 = null;
      return;
    }

    const barrier = trigger + 1;

    armed = false;
    buffer = [];
    m1 = m2 = null;

    if (ladderLevel === 0) ladderLevel = 1;

    placeTrade(ladderLevel, barrier);
  }

  // ================= TRADE ENGINE =================
  function placeTrade(level, barrier) {
    if (!authorized || tradeLock) return;

    tradeLock = true;

    BASE = Number(stakeInput.value || 0.35);

    const amount = stake(level);

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

    levelEl.textContent = level;
    log(`TRADE L${level} → DIGITDIFF(${barrier})`, "#38bdf8");
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

        log("AUTHORIZED (" + accountType + ")", "lime");
      }

      if (d.msg_type === "tick") {
        onTick(d.tick.quote);
      }

      if (d.msg_type === "balance") {
        balanceEl.textContent = Number(d.balance.balance).toFixed(2);
      }

      if (d.msg_type === "buy") {
        send({
          proposal_open_contract: 1,
          contract_id: d.buy.contract_id,
          subscribe: 1
        });
      }

      if (
        d.msg_type === "proposal_open_contract" &&
        d.proposal_open_contract.is_sold
      ) {
        tradeLock = false;

        const pnl = Number(d.proposal_open_contract.profit || 0);

        log(
          pnl >= 0 ? `WIN +${pnl.toFixed(2)}` : `LOSS ${pnl.toFixed(2)}`,
          pnl >= 0 ? "lime" : "red"
        );

        if (pnl > 0) ladderLevel = 0;
        else if (ladderLevel < 3) ladderLevel++;
      }
    };

    ws.onclose = () => log("WS CLOSED", "red");
  }

  // ================= BUTTONS =================
  startBtn.onclick = () => {
    if (!token) return alert("Login first");

    running = true;
    paused = false;

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

  // ================= DEMO / LIVE SWITCH FIXED =================
  modeBtn.onclick = () => {
    accountType = accountType === "demo" ? "live" : "demo";

    log("Switching to " + accountType + "...", "yellow");

    if (ws) ws.close();

    setTimeout(() => {
      connect();
    }, 500);
  };
});
