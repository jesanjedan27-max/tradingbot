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

  // ================= CONFIG =================
  const CLIENT_ID = "33wZZKTFZrmsZgFaAH53Z";
  const REDIRECT_URI = "https://jesanjedan27-max.github.io/tradingbot/";
  const VERCEL_URL = "https://oauthexchange23.vercel.app/api/token";
  const SYMBOL = "R_100";

  const ACCOUNTS = {
    demo: "DOT92927394",
    live: "ROT91650098"
  };

  let ACCOUNT = "demo";

  // ================= STATE =================
  let ws = null;
  let token = localStorage.getItem("access_token");

  let running = false;
  let paused = false;

  let tradeLock = false;
  let ladderLevel = 0;

  let buffer = [];
  let stage = 0;

  // ================= LOG =================
  function log(msg, color = "#fff") {
    const div = document.createElement("div");
    div.style.color = color;
    div.textContent = msg;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ================= DIGIT (FIXED) =================
  function digit(price) {
    const str = Number(price).toFixed(2);
    return Number(str[str.length - 1]);
  }

  // ================= STAKE =================
  function stake(level) {
    const base = 0.35;
    const mult = Math.pow(11.57, level);
    return +(base * mult).toFixed(2);
  }

  // ================= SEND =================
  function send(data) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify(data));
  }

  // ================= RESET =================
  function resetState() {
    tradeLock = false;
    buffer = [];
    stage = 0;
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
    priceEl.textContent = price.toFixed(2);

    log(`Tick ${price.toFixed(2)} → ${d}`, "#38bdf8");

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

    log(`TRADE → ${barrier}`, "#38bdf8");
  }

  // ================= CONNECT (FIXED - NO AUTHORIZE) =================
  function connect() {
    resetState();

    if (ws) {
      ws.close();
      ws = null;
    }

    const accountId = ACCOUNTS[ACCOUNT];

    if (!token) {
      log("NO TOKEN - LOGIN FIRST", "red");
      return;
    }

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

          // IMPORTANT: NO authorize EVER
          send({ balance: 1 });
          send({ ticks: SYMBOL, subscribe: 1 });
        };

        ws.onmessage = (e) => {
          const d = JSON.parse(e.data);

          if (d.msg_type === "balance") {
            balanceEl.textContent =
              Number(d.balance.balance).toFixed(2);
          }

          if (d.msg_type === "tick") {
            onTick(d.tick.quote);
          }

          if (d.msg_type === "proposal") {
            send({
              buy: d.proposal.id,
              price: d.proposal.ask_price
            });
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
            d.proposal_open_contract.is_sold === 1
          ) {
            tradeLock = false;

            const pnl = Number(d.proposal_open_contract.profit || 0);

            log(
              pnl >= 0 ? `WIN +${pnl}` : `LOSS ${pnl}`,
              pnl >= 0 ? "lime" : "red"
            );

            ladderLevel = pnl > 0 ? 0 : ladderLevel + 1;
            levelEl.textContent = ladderLevel;
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
    resetState();
    log("RESET DONE", "orange");
  };

  demoBtn.onclick = () => {
    ACCOUNT = "demo";
    connect();
  };

  liveBtn.onclick = () => {
    ACCOUNT = "live";
    connect();
  };
});
