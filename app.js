document.addEventListener("DOMContentLoaded", async () => {
  const $ = id => document.getElementById(id);

  // =========================
  // UI ELEMENTS
  // =========================
  const loginBtn = $("login");
  const startBtn = $("start");
  const pauseBtn = $("pause");
  const stopBtn  = $("stop");
  const resetBtn = $("reset");

  const priceEl = $("price");
  const balanceEl = $("balance");
  const levelEl = $("level");
  const logEl = $("log");

  const tokenInput = $("token");

  // =========================
  // CONFIG
  // =========================
  const WS_APP_ID = 1089;
  const CLIENT_ID = "33wZZKTFZrmsZgFaAH53Z";
  const REDIRECT_URI = "https://jesanjedan27-max.github.io/tradingbot/";
  const VERCEL_URL = "https://oauthexchange23.vercel.app/api/token";
  const SYMBOL = "R_100";

  // =========================
  // STATE
  // =========================
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

  // =========================
  // LOG SYSTEM
  // =========================
  function log(msg, color = "#ffffff") {
    logEl.innerHTML += `<div style="color:${color}">${msg}</div>`;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function send(data) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }

  // =========================
  // PKCE HELPERS
  // =========================
  function generateVerifier() {
    return [...crypto.getRandomValues(new Uint8Array(32))]
      .map(x => x.toString(16).padStart(2, "0"))
      .join("");
  }

  async function sha256(str) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  }

  function base64url(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  async function createChallenge(verifier) {
    return base64url(await sha256(verifier));
  }

  // =========================
  // LOGIN (DERIV OAUTH)
  // =========================
  loginBtn.onclick = async () => {
    const verifier = generateVerifier();
    const challenge = await createChallenge(verifier);

    localStorage.setItem("pkce_verifier", verifier);

    window.location.href =
      `https://oauth.deriv.com/oauth2/authorize` +
      `?app_id=${CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&code_challenge=${challenge}` +
      `&code_challenge_method=S256`;
  };

  // =========================
  // EXCHANGE CODE VIA VERCEL
  // =========================
  async function handleOAuthCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");

    if (!code) return;

    const verifier = localStorage.getItem("pkce_verifier");

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

      window.history.replaceState({}, document.title, "/");

      log("✅ OAuth Connected", "lime");

    } catch (err) {
      log("OAuth Error: " + err.message, "red");
    }
  }

  await handleOAuthCallback();

  // =========================
  // STAKE ENGINE
  // =========================
  const BASE_STAKE = 0.35;

  function stake(level) {
    if (level === 1) return BASE_STAKE;
    if (level === 2) return BASE_STAKE * 11.57;
    if (level === 3) return BASE_STAKE * 11.57 * 11.57;
    return BASE_STAKE;
  }

  // =========================
  // STRATEGY (2,3 ACTIVATOR SYSTEM)
  // =========================
  function onTick(price) {
    if (!running || paused || tradeLock) return;

    const digit = Math.floor(price % 10);

    priceEl.textContent = price.toFixed(2);

    buffer.push(digit);
    if (buffer.length > 5) buffer.shift();

    // WAIT FOR ACTIVATOR 2,3
    if (!armed) {
      if (buffer.slice(-2).join("") === "23") {
        armed = true;
        m1 = null;
        m2 = null;
      }
      return;
    }

    // MOMENTUM COLLECTION
    if (m1 === null) return m1 = digit;
    if (m2 === null) return m2 = digit;

    const trigger = digit;

    // INVALID DIGIT RULE
    if (trigger === 9) {
      log("Ignored trigger 9", "red");
      armed = false;
      buffer = [];
      m1 = null;
      m2 = null;
      return;
    }

    const barrier = trigger + 1;

    armed = false;
    buffer = [];
    m1 = null;
    m2 = null;

    if (ladderLevel === 0) {
      ladderLevel = 1;
      trade(1, barrier);
    }
  }

  // =========================
  // TRADE EXECUTION
  // =========================
  function trade(level, digit) {
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

    log(`TRADE L${level} → DIGITDIFF ${digit} | $${amount.toFixed(2)}`, "#38bdf8");
    levelEl.textContent = level;
  }

  // =========================
  // DERIV CONNECTION
  // =========================
  function connect() {
    ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${WS_APP_ID}`);

    ws.onopen = () => {
      send({ authorize: token });
    };

    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);

      if (data.msg_type === "authorize") {
        authorized = true;
        log("Authorized", "lime");
        send({ ticks: SYMBOL, subscribe: 1 });
      }

      if (data.msg_type === "tick") {
        onTick(data.tick.quote);
      }

      if (data.msg_type === "buy") {
        const id = data.buy.contract_id;

        send({
          proposal_open_contract: 1,
          contract_id: id,
          subscribe: 1
        });
      }

      if (
        data.msg_type === "proposal_open_contract" &&
        data.proposal_open_contract.is_sold
      ) {
        tradeLock = false;
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
    log("Reset Done", "orange");
  };
});
