const CLIENT_ID = "33wZZKTFZrmsZgFaAH53Z";
const REDIRECT_URI = "https://jesanjedan27-max.github.io/tradingbot/";
const WS_ENDPOINT = "wss://ws.derivws.com/websockets/v3?app_id=" + CLIENT_ID;
const SYMBOL = "R_100";

const $ = (id) => document.getElementById(id);

const loginBtn = $("login");
const logoutBtn = $("logout");
const startBtn = $("start");
const pauseBtn = $("pause");
const stopBtn = $("stop");
const resetBtn = $("reset");

const statusEl = $("status");
const balanceEl = $("balance");
const priceEl = $("price");
const logEl = $("log");
const accountDisplay = $("accountDisplay");
const accountTypeEl = $("accountType");

let ws = null;
let accessToken = null;
let activeLoginid = null;
let running = false;
let paused = false;

function log(msg, color) {
  if (!logEl) return;
  const row = document.createElement("div");
  row.style.color = color || "#fff";
  row.textContent = msg;
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

function setLoginState(token, loginid, currency, isVirtual) {
  accessToken = token;
  activeLoginid = loginid;
  if (accountDisplay) accountDisplay.textContent = loginid;
  if (accountTypeEl) accountTypeEl.textContent = isVirtual ? "Demo" : "Real";
  if (loginBtn) loginBtn.style.display = "none";
  if (logoutBtn) logoutBtn.style.display = "inline-block";
  [startBtn, pauseBtn, stopBtn, resetBtn].forEach((btn) => {
    if (btn) btn.disabled = false;
  });
  setStatus("Logged in");
  log(`Logged in as ${loginid} (${isVirtual ? "Demo" : "Real"})`, "lime");
}

function setLoggedOutState() {
  accessToken = null;
  activeLoginid = null;
  if (accountDisplay) accountDisplay.textContent = "Not logged in";
  if (accountTypeEl) accountTypeEl.textContent = "-";
  if (loginBtn) loginBtn.style.display = "inline-block";
  if (logoutBtn) logoutBtn.style.display = "none";
  [startBtn, pauseBtn, stopBtn, resetBtn].forEach((btn) => {
    if (btn) btn.disabled = true;
  });
  setStatus("Logged out");
  log("Please login to start trading.", "yellow");
}

function buildLoginUrl() {
  return (
    "https://auth.deriv.com/oauth2/auth" +
    "?response_type=token" +
    `&client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    "&scope=" +
    encodeURIComponent("trade") +
    "&nonce=derivbot1"
  );
}

if (loginBtn) {
  loginBtn.addEventListener("click", () => {
    window.location.href = buildLoginUrl();
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    if (ws) ws.close();
    setLoggedOutState();
    window.history.replaceState({}, document.title, REDIRECT_URI);
  });
}

function parseTokenFromUrl() {
  const hash = window.location.hash.replace(/^#/, "?");
  const params = new URLSearchParams(hash);
  if (params.has("access_token")) {
    return {
      token: params.get("access_token"),
      loginid: params.get("loginid") || "Deriv Account",
      currency: params.get("currency") || "USD",
      isVirtual:
        params.get("is_virtual") === "1" ||
        (params.get("loginid") || "").toUpperCase().startsWith("VRT"),
    };
  }
  return null;
}

function connect() {
  if (!accessToken) {
    log("No access token. Please login.", "red");
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))
    return;

  if (ws) ws.close();

  ws = new WebSocket(WS_ENDPOINT);

  ws.onopen = () => {
    log("Connected to Deriv WebSocket", "lime");
    ws.send(JSON.stringify({ authorize: accessToken }));
    ws.send(JSON.stringify({ ticks: SYMBOL, subscribe: 1 }));
    ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
  };

  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (err) {
      log("Invalid WebSocket message", "red");
      return;
    }

    if (msg.error) {
      log(msg.error.message, "red");
      return;
    }

    if (msg.msg_type === "authorize") {
      log("Authorization success", "lime");
      setStatus("Connected");
      return;
    }

    if (msg.msg_type === "tick" && msg.tick && typeof msg.tick.quote === "number") {
      if (priceEl) priceEl.textContent = msg.tick.quote.toFixed(2);
      log(`Tick: ${msg.tick.quote.toFixed(2)}`);
      return;
    }

    if (msg.msg_type === "balance" && msg.balance) {
      if (balanceEl) balanceEl.textContent = Number(msg.balance.balance).toFixed(2);
      log(`Balance: ${Number(msg.balance.balance).toFixed(2)}`);
      return;
    }
  };

  ws.onerror = () => log("WebSocket error", "red");
  ws.onclose = () => log("WebSocket disconnected", "orange");
}

if (startBtn) {
  startBtn.onclick = () => {
    running = true;
    paused = false;
    setStatus("Starting");
    connect();
    log("Bot started", "lime");
  };
}

if (pauseBtn) {
  pauseBtn.onclick = () => {
    paused = !paused;
    setStatus(paused ? "Paused" : "Running");
    log(paused ? "Paused" : "Running", "yellow");
  };
}

if (stopBtn) {
  stopBtn.onclick = () => {
    running = false;
    paused = false;
    if (ws) ws.close();
    setStatus("Stopped");
    log("Bot stopped", "red");
  };
}

if (resetBtn) {
  resetBtn.onclick = () => {
    running = false;
    paused = false;
    if (ws) ws.close();
    setStatus("Reset");
    log("Reset done", "orange");
  };
}

function init() {
  const tokenData = parseTokenFromUrl();
  if (tokenData) {
    setLoginState(
      tokenData.token,
      tokenData.loginid,
      tokenData.currency,
      tokenData.isVirtual
    );
    window.history.replaceState({}, document.title, REDIRECT_URI);
  } else {
    setLoggedOutState();
  }
}

init();
