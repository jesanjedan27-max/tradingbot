const CLIENT_ID    = "33uJq820h9LseRDAZ80iZ";
const REDIRECT_URI = "https://tradingbot270.netlify.app/";
const API_BASE     = "https://tradingbot270.netlify.app/.netlify/functions";

let ws              = null;
let running         = false;
let paused          = false;
let martingaleLevel = 0;
const martingale    = [1, 11.57, 11.42];
let lastTradeTime   = 0;
const COOLDOWN      = 3000;
let token           = null;

const $     = id => document.getElementById(id);
const logEl = $("log");

function log(msg) {
  const line = document.createElement("div");
  line.textContent = "[" + new Date().toLocaleTimeString() + "] " + msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

/* ── AUTH HELPERS ──────────────────────────────────────────── */

function setLoggedIn(t) {
  token = t;
  localStorage.setItem("deriv_token", t);
  $("login").style.display    = "none";
  $("logout").style.display   = "block";
  $("authStatus").textContent = "Logged in ✓";
  $("authStatus").classList.add("connected");
  log("Authenticated successfully.");
}

function setLoggedOut() {
  token = null;
  localStorage.removeItem("deriv_token");
  localStorage.removeItem("oauth_state");
  $("login").style.display    = "block";
  $("logout").style.display   = "none";
  $("authStatus").textContent = "Not logged in";
  $("authStatus").classList.remove("connected");
}

/* ── LOGIN BUTTON ──────────────────────────────────────────── */

$("login").onclick = () => {
  const state = crypto.randomUUID();
  localStorage.setItem("oauth_state", state);

  const params = new URLSearchParams({
    response_type: "code",
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    scope:         "trade",
    state
  });

  window.location.href = "https://oauth.deriv.com/oauth2/auth?" + params.toString();
};

/* ── LOGOUT BUTTON ─────────────────────────────────────────── */

$("logout").onclick = () => {
  running = false;
  if (ws) { ws.close(); ws = null; }
  setLoggedOut();
  log("Logged out.");
};

/* ── OAUTH CALLBACK HANDLER (runs on page load) ────────────── */

async function handleOAuthCallback() {
  const params        = new URLSearchParams(window.location.search);
  const code          = params.get("code");
  const returnedState = params.get("state");

  if (!code) return; // Not a callback page load — skip

  // Remove ?code= from URL immediately to prevent re-exchange on refresh
  window.history.replaceState({}, document.title, "/");

  // Validate state param — prevents CSRF and redirect loops
  const savedState = localStorage.getItem("oauth_state");
  if (!savedState || savedState !== returnedState) {
    log("Auth error: state mismatch. Please log in again.");
    setLoggedOut();
    return;
  }
  localStorage.removeItem("oauth_state");

  log("Exchanging code for token…");

  try {
    const res = await fetch(API_BASE + "/oauth-exchange", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ code, redirect_uri: REDIRECT_URI })
    });

    const data = await res.json();

    if (!data.access_token) {
      log("Token exchange failed: " + (data.error || "no access_token returned"));
      setLoggedOut();
      return;
    }

    setLoggedIn(data.access_token);
  } catch (err) {
    log("Token exchange error: " + err.message);
    setLoggedOut();
  }
}

/* ── MODE BUTTONS ──────────────────────────────────────────── */

$("demoBtn").onclick = () => log("Demo mode selected");
$("liveBtn").onclick = () => log("Live mode selected");

/* ── STRATEGY ──────────────────────────────────────────────── */

async function strategy(price) {
  const res = await fetch(API_BASE + "/strategy", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ price })
  });
  return res.json();
}

/* ── TRADE ─────────────────────────────────────────────────── */

async function trade(barrier, stake) {
  if (!token) { log("Not authenticated — cannot trade."); return null; }

  const res = await fetch(API_BASE + "/trade", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ barrier, stake, token })
  });
  return res.json();
}

/* ── WEBSOCKET CONNECTION ───────────────────────────────────── */

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return; // Already connected — do not open a duplicate
  }

  ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${CLIENT_ID}`);

  ws.onopen = () => {
    log("Connected to Deriv WebSocket.");
    ws.send(JSON.stringify({ ticks: "R_100", subscribe: 1 }));
  };

  ws.onmessage = async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.msg_type === "tick") {
      const price = msg.tick.quote;
      $("price").textContent = price;

      if (!running || paused) return;
      if (Date.now() - lastTradeTime < COOLDOWN) return;

      let result;
      try { result = await strategy(price); } catch (err) {
        log("Strategy error: " + err.message);
        return;
      }

      if (!result || result.signal === "HOLD") return;
      if (result.signal === "IGNORE_9") { log("Skipped — digit 9 activation"); return; }

      const stake = martingale[martingaleLevel];
      log(`Signal: ${result.signal} | Barrier: ${result.barrier} | Stake: $${stake}`);

      let exec;
      try { exec = await trade(result.barrier, stake); } catch (err) {
        log("Trade error: " + err.message);
        return;
      }

      if (!exec) return;

      if (exec.status === "TRADE_EXECUTED") {
        lastTradeTime = Date.now();
        martingaleLevel = result.signal === "LOSS"
          ? Math.min(martingaleLevel + 1, martingale.length - 1)
          : 0;
        $("level").textContent = martingaleLevel;
        log(`Trade executed — contract ID: ${exec.contract_id} | Buy price: $${exec.buy_price}`);
      } else {
        log("Trade failed: " + (exec.error || JSON.stringify(exec)));
      }
    }

    if (msg.msg_type === "balance") {
      $("balance").textContent = "$" + Number(msg.balance.balance).toFixed(2);
    }

    if (msg.error) {
      log("WS error: " + msg.error.message);
    }
  };

  ws.onerror = () => log("WebSocket connection error.");
  ws.onclose = () => { log("WebSocket closed."); ws = null; };
}

/* ── BOT CONTROLS ──────────────────────────────────────────── */

$("start").onclick = () => {
  if (!token) { log("Please log in before starting the bot."); return; }
  running = true;
  paused  = false;
  connect();
  log("Bot started.");
};

$("pause").onclick = () => {
  paused = !paused;
  log(paused ? "Bot paused." : "Bot resumed.");
};

$("stop").onclick = () => {
  running = false;
  if (ws) { ws.close(); ws = null; }
  log("Bot stopped.");
};

$("reset").onclick = () => {
  running         = false;
  paused          = false;
  martingaleLevel = 0;
  lastTradeTime   = 0;
  if (ws) { ws.close(); ws = null; }
  $("level").textContent = "0";
  log("Bot reset.");
};

/* ── INIT ───────────────────────────────────────────────────── */

(async () => {
  // If already logged in from a previous session, restore token
  const saved = localStorage.getItem("deriv_token");
  if (saved) {
    setLoggedIn(saved);
    return;
  }

  // If Deriv redirected back with ?code= in URL, handle the exchange
  await handleOAuthCallback();
})();