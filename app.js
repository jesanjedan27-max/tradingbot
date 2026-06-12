document.addEventListener("DOMContentLoaded", async () => {
  const $ = id => document.getElementById(id);

  const loginBtn = $("login");
  const startBtn = $("start");
  const pauseBtn = $("pause");
  const stopBtn  = $("stop");
  const resetBtn = $("reset");

  const priceEl = $("price");
  const balanceEl = $("balance");
  const levelEl = $("level");
  const logEl = $("log");

  const CLIENT_ID = "33wZZKTFZrmsZgFaAH53Z";
  const REDIRECT_URI = "https://jesanjedan27-max.github.io/tradingbot/";
  const VERCEL_URL = "https://oauthexchange23.vercel.app/api/token";
  const WS_APP_ID = 1089;
  const SYMBOL = "R_100";

  let ws;
  let token = localStorage.getItem("access_token");

  let running = false;
  let paused = false;
  let authorized = false;

  let ladderLevel = 0;
  let tradeLock = false;

  let buffer = [];
  let armed = false;
  let m1 = null;
  let m2 = null;

  let totalProfit = 0;

  function log(msg, color = "#fff") {
    logEl.innerHTML += `<div style="color:${color}">${msg}</div>`;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function send(data) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }

  // =========================
  // PKCE (HARDENED)
  // =========================
  function generateVerifier() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array).map(x => x.toString(16).padStart(2, "0")).join("");
  }

  async function sha256(str) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  }

  function base64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  async function createChallenge(verifier) {
    return base64url(await sha256(verifier));
  }

  // =========================
  // LOGIN FIXED
  // =========================
  loginBtn.onclick = async () => {
    const verifier = generateVerifier();
    const challenge = await createChallenge(verifier);

    sessionStorage.setItem("pkce_verifier", verifier);
    sessionStorage.setItem("oauth_state", "active");

    const url =
      `https://oauth.deriv.com/oauth2/authorize` +
      `?response_type=code` +
      `&app_id=${CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&code_challenge=${challenge}` +
      `&code_challenge_method=S256`;

    window.location.href = url;
  };

  // =========================
  // CALLBACK HANDLER (FIXED RELIABILITY)
  // =========================
  async function handleOAuthCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");

    if (!code) return;

    const verifier = sessionStorage.getItem("pkce_verifier");

    try {
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
        log("OAuth Failed", "red");
        return;
      }

      token = data.access_token;
      localStorage.setItem("access_token", token);

      // clean URL safely
      window.history.replaceState({}, document.title, "/");

      log("OAuth Connected", "lime");

    } catch (e) {
      log("OAuth Error: " + e.message, "red");
    }
  }

  await handleOAuthCallback();

  // =========================
  // STRATEGY (UNCHANGED)
  // =========================
  const BASE = 0.35;

  function stake(level) {
    if (level === 1) return BASE;
    if (level === 2) return BASE * 11.57;
    if (level === 3) return BASE * 11.57 * 11.57;
    return BASE;
  }

  function onTick(price) {
    if (!running || paused || tradeLock) return;

    const digit = Math.floor(price % 10);

    priceEl.textContent = price.toFixed(2);

    buffer.push(digit);
    if (buffer.length > 5) buffer.shift();

    if (!armed) {
      if (buffer.slice(-2).join("") === "23") {
        armed = true;
        m1 = null;
        m2 = null;
      }
      return;
    }

    if (m1 === null) return (m1 = digit);
    if (m2 === null) return (m2 = digit);

    const trigger = digit;

    if (trigger === 9) {
      log("Ignored 9", "red");
      armed = false;
      buffer = [];
      m1 = m2 = null;
      return;
    }

    const barrier = trigger + 1;

    armed = false;
    buffer = [];
    m1 = m2 = null;

    if (ladderLevel === 0) {
      ladderLevel = 1;
      placeTrade(1, barrier);
    }
  }

  function placeTrade(level, digit) {
    if (!authorized || tradeLock) return;

    tradeLock = true;

    const amount = stake(level);

    send({
      buy: 1,
      price: amount,
      parameters: {
        amount,
        basis: "stake",
        contract_type: "DIGITDIFF",
        currency: "USD",
        duration: 1,
        duration_unit: "t",
        symbol: SYMBOL,
        barrier: digit
      }
    });

    levelEl.textContent = level;
    log(`TRADE L${level} → ${digit}`, "#38bdf8");
  }

  // =========================
  // CONNECTION
  // =========================
  function connect() {
    ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${WS_APP_ID}`);

    ws.onopen = () => send({ authorize: token });

    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);

      if (d.msg_type === "authorize") {
        authorized = true;
        send({ ticks: SYMBOL, subscribe: 1 });
        send({ balance: 1 });
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
        totalProfit += pnl;

        log(pnl >= 0 ? `WIN +${pnl}` : `LOSS ${pnl}`, pnl >= 0 ? "lime" : "red");

        if (pnl > 0) ladderLevel = 0;
        else if (ladderLevel < 3) ladderLevel++;
      }
    };
  }

  // =========================
  // BUTTONS
  // =========================
  startBtn.onclick = () => {
    if (!token) return alert("Login first");

    running = true;
    paused = false;

    connect();
    log("Bot Started", "lime");
  };

  pauseBtn.onclick = () => {
    paused = !paused;
    log(paused ? "Paused" : "Running", "yellow");
  };

  stopBtn.onclick = () => {
    running = false;
    ws?.close();
    log("Stopped", "red");
  };

  resetBtn.onclick = () => {
    buffer = [];
    armed = false;
    ladderLevel = 0;
    tradeLock = false;
    totalProfit = 0;
    log("Reset Done", "orange");
  };
});
