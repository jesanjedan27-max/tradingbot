document.addEventListener("DOMContentLoaded", () => {

  const CLIENT_ID = "33wZZKTFZrmsZgFaAH53Z";
  const AUTH_ENDPOINT = "https://auth.deriv.com/oauth2/auth";
  const REDIRECT_URI = "https://jesanjedan27-max.github.io/tradingbot/";
  const WS_ENDPOINT = "wss://ws.derivws.com/websockets/v3?app_id=" + CLIENT_ID;
  const SYMBOL = "R_100";
  const SWITCH_MULTIPLIERS = [1, 4.05 / 0.35, 52.63 / 0.35];

  function el(id) { return document.getElementById(id); }

  var loginBtn            = el("loginBtn");
  var logoutBtn           = el("logoutBtn");
  var accountDisplay      = el("accountDisplay");
  var accountTypeEl       = el("accountType");
  var accountSelectorWrap = el("accountSelectorWrap");
  var accountSelector     = el("accountSelector");
  var modeIndicator       = el("modeIndicator");
  var startBtn            = el("start");
  var pauseBtn            = el("pause");
  var stopBtn             = el("stop");
  var resetBtn            = el("reset");
  var demoBtn             = el("demoBtn");
  var liveBtn             = el("liveBtn");
  var priceEl             = el("price");
  var balanceEl           = el("balance");
  var profitEl            = el("profit");
  var levelEl             = el("level");
  var lastDigitEl         = el("lastDigit");
  var logEl               = el("log");
  var stakeInput          = el("stakeInput");

  var accounts      = [];
  var activeToken   = null;
  var activeLoginid = null;

  var ws      = null;
  var running = false;
  var paused  = false;

  var lastPayoutRatio  = null;
  var recoveryLoss     = 0;
  var currentStake     = 0;
  var lastBalance      = null;
  var ladder           = 0;
  var totalProfit      = 0;

  var waitingProposal  = false;
  var proposalVariants = null;
  var proposalAttempt  = 0;
  var activeContractId = null;
  var probing          = false;
  var pendingBarrier   = null;

  var stakeMode     = "switch";
  var stakeLevelIdx = 0;

  var targetPair      = null;
  var phase           = "scan_ab";
  var seqA            = null;
  var seqB            = null;
  var settlementDigit = null;
  var captureNextTick = false;

  var LOG_MAX       = 1200;
  var TICK_FLUSH_MS = 60;
  var TICK_LIMIT    = 200;
  var tickBuffer     = [];
  var tickFlushTimer = null;

  function buildLoginUrl() {
    return AUTH_ENDPOINT +
      "?response_type=token" +
      "&client_id=" + encodeURIComponent(CLIENT_ID) +
      "&redirect_uri=" + encodeURIComponent(REDIRECT_URI) +
      "&scope=" + encodeURIComponent("trade") +
      "&nonce=derivbot1";
  }

  function log(msg, color) {
    if (!logEl) return;
    var row = document.createElement("div");
    row.style.color = color || "#fff";
    row.textContent = msg;
    logEl.appendChild(row);
    while (logEl.children.length > LOG_MAX) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function updateLoginUI() {
    var loggedIn = !!activeToken;

    if (loginBtn) loginBtn.style.display = loggedIn ? "none" : "";
    if (logoutBtn) logoutBtn.style.display = loggedIn ? "" : "none";

    if (startBtn) startBtn.disabled = !loggedIn;
    if (pauseBtn) pauseBtn.disabled = !loggedIn;
    if (stopBtn) stopBtn.disabled = !loggedIn;
    if (resetBtn) resetBtn.disabled = !loggedIn;
    if (demoBtn) demoBtn.disabled = !loggedIn;
    if (liveBtn) liveBtn.disabled = !loggedIn;
    if (stakeInput) stakeInput.disabled = !loggedIn;

    if (!loggedIn) {
      if (accountDisplay) accountDisplay.textContent = "Not logged in";
      if (accountTypeEl) accountTypeEl.textContent = "-";
      if (modeIndicator) {
        modeIndicator.textContent = "JESAN 💲 MODE - LOGIN";
        modeIndicator.className = "mode-indicator demo";
      }
      if (accountSelectorWrap) accountSelectorWrap.style.display = "none";
      log("Please login to start trading.", "yellow");
    } else if (accounts.length > 1) {
      if (accountSelectorWrap) accountSelectorWrap.style.display = "";
    }
  }

  if (loginBtn) {
    loginBtn.addEventListener("click", function () {
      window.location.href = buildLoginUrl();
    });
  } else {
    console.error("Login button not found in DOM.");
  }

  function parseOAuthCallback() {
    var search = window.location.search;
    var hash = window.location.hash.replace(/^#/, "?");
    var qp = new URLSearchParams(search);
    var hp = new URLSearchParams(hash);
    var params = qp.has("token1") || qp.has("access_token") ? qp : hp;

    if (!params.has("token1") && !params.has("access_token")) return [];

    var result = [];
    if (params.has("token1")) {
      var i = 1;
      while (params.get("token" + i)) {
        var loginid = params.get("acct" + i) || ("Account " + i);
        result.push({
          token: params.get("token" + i),
          loginid: loginid,
          currency: params.get("cur" + i) || "USD",
          is_virtual: loginid.toUpperCase().indexOf("VRT") === 0
        });
        i++;
      }
    } else {
      var loginid = params.get("loginid") || params.get("acct1") || "Deriv Account";
      result.push({
        token: params.get("access_token"),
        loginid: loginid,
        currency: params.get("currency") || "USD",
        is_virtual: params.get("is_virtual") === "1" ||
          loginid.toUpperCase().indexOf("VRT") === 0
      });
    }

    return result;
  }

  function saveAccounts(accs) {
    try { localStorage.setItem("deriv_bot_accounts", JSON.stringify(accs)); } catch (e) {}
  }

  function loadAccounts() {
    try {
      var raw = localStorage.getItem("deriv_bot_accounts");
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function clearSession() {
    try { localStorage.removeItem("deriv_bot_accounts"); } catch (e) {}
    accounts = [];
    activeToken = null;
    activeLoginid = null;
    updateLoginUI();
    window.history.replaceState({}, document.title, REDIRECT_URI);
  }

  function buildAccountDropdown(accs) {
    if (!accountSelector) return;
    accountSelector.innerHTML = "";
    for (var i = 0; i < accs.length; i++) {
      var acc = accs[i];
      var opt = document.createElement("option");
      opt.value = i;
      opt.textContent = acc.loginid + " — " + (acc.is_virtual ? "Demo" : "Real") + " (" + acc.currency + ")";
      accountSelector.appendChild(opt);
    }
  }

  function applyAccount(idx) {
    var acc = accounts[idx];
    if (!acc) return;
    activeToken = acc.token;
    activeLoginid = acc.loginid;
    if (accountDisplay) accountDisplay.textContent = acc.loginid;
    if (accountTypeEl) accountTypeEl.textContent = acc.is_virtual ? "Demo" : "Real";
    if (acc.is_virtual) {
      demoBtn.classList.add("active");
      liveBtn.classList.remove("active");
      modeIndicator.textContent = "JESAN 💲 MODE - DEMO";
      modeIndicator.className = "mode-indicator demo";
    } else {
      liveBtn.classList.add("active");
      demoBtn.classList.remove("active");
      modeIndicator.textContent = "JESAN 💲 MODE - LIVE";
      modeIndicator.className = "mode-indicator live";
    }
    updateLoginUI();
  }

  function startTickFlush() {
    if (tickFlushTimer) return;
    tickFlushTimer = setInterval(function () {
      if (!tickBuffer.length) return;
      var frag = document.createDocumentFragment();
      var batch = tickBuffer.splice(0, TICK_LIMIT);
      for (var i = 0; i < batch.length; i++) {
        var row = document.createElement("div");
        row.style.color = "#7dd3fc";
        row.textContent = "Tick " + Number(batch[i].price).toFixed(2) + " → " + batch[i].digit;
        frag.appendChild(row);
      }
      logEl.appendChild(frag);
      while (logEl.children.length > LOG_MAX) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    }, TICK_FLUSH_MS);
  }

  function stopTickFlush() {
    if (!tickFlushTimer) return;
    clearInterval(tickFlushTimer);
    tickFlushTimer = null;
  }

  function lastDigit(price) {
    var v = Number(price);
    if (isNaN(v)) return null;
    var s = v.toFixed(2);
    return Number(s[s.length - 1]);
  }

  function setBalance(val) {
    var n = Number(val);
    if (isNaN(n)) return;
    lastBalance = n;
    balanceEl.textContent = n.toFixed(2);
  }

  function stakeLevels() {
    var base = Number(stakeInput.value) || 0.35;
    return SWITCH_MULTIPLIERS.map(function(m) { return Number((base * m).toFixed(2)); });
  }

  function switchStake() {
    var lvls = stakeLevels();
    return lvls[Math.min(stakeLevelIdx, lvls.length - 1)];
  }

  function baseStake() {
    return stakeMode === "switch" ? switchStake() : Number(stakeInput.value || 0.35);
  }

  function martingaleStake(ratio) {
    var base = Number(stakeInput.value || 0.35);
    if (recoveryLoss > 0 && ratio > 1.01)
      return Number(Math.max(base, recoveryLoss / (ratio - 1)).toFixed(2));
    return Number(base.toFixed(2));
  }

  function createSwitchUI() {
    if (!stakeInput || el("stakeModeBtn")) return;
    var wrap = stakeInput.parentElement;
    if (!wrap) return;

    var btn = document.createElement("button");
    btn.id = "stakeModeBtn";
    btn.style.cssText = "display:block;width:100%;margin-bottom:8px;padding:6px 10px;" +
      "border-radius:6px;border:none;cursor:pointer;font-weight:bold;" +
      "background:#7c3aed;color:#fff;font-size:13px;";

    var lrow = document.createElement("div");
    lrow.style.marginBottom = "8px";
    var llbl = document.createElement("div");
    llbl.style.cssText = "color:#94a3b8;font-size:11px;margin-bottom:4px;";
    llbl.textContent = "Auto stake ladder:";
    var ldisp = document.createElement("div");
    ldisp.style.cssText = "padding:5px 8px;border-radius:6px;border:1px solid #374151;" +
      "background:#111827;color:#38bdf8;font-size:12px;font-weight:bold;";
    lrow.appendChild(llbl);
    lrow.appendChild(ldisp);

    function refreshLevels() {
      ldisp.textContent = stakeLevels().map(function(v, i) { return "Lvl " + (i+1) + ": $" + v; }).join("  →  ");
    }
    stakeInput.addEventListener("input", function () { if (stakeMode === "switch") refreshLevels(); });

    function refreshUI() {
      if (stakeMode === "switch") {
        btn.textContent = "⚡ MODE: STAKE SWITCH";
        btn.style.background = "#7c3aed";
        lrow.style.display = "";
        refreshLevels();
      } else {
        btn.textContent = "📈 MODE: MARTINGALE";
        btn.style.background = "#059669";
        lrow.style.display = "none";
      }
    }

    btn.onclick = function() {
      stakeMode = stakeMode === "switch" ? "martingale" : "switch";
      stakeLevelIdx = 0; recoveryLoss = 0;
      refreshUI();
      log("Mode → " + (stakeMode === "switch" ? "STAKE SWITCH" : "MARTINGALE"), "#a78bfa");
    };

    wrap.insertAdjacentElement("beforebegin", lrow);
    wrap.insertAdjacentElement("beforebegin", btn);
    refreshUI();
  }

  function nextPair(digit) {
    if (digit === 9) return [0, 1];
    if (digit >= 0 && digit <= 8) return [digit, digit + 1];
    return null;
  }

  function resetSeq(next) {
    phase = "scan_ab"; seqA = null; seqB = null;
    settlementDigit = null; captureNextTick = false;
    waitingProposal = false; proposalVariants = null; proposalAttempt = 0;
    activeContractId = null; probing = false; pendingBarrier = null;
    targetPair = next || null;
    log(next ? "Next: pair [" + next[0] + "," + next[1] + "]" : "Next: open pair scan", "#a78bfa");
  }

  function fullReset() {
    resetSeq(null);
    totalProfit = 0; recoveryLoss = 0; lastPayoutRatio = null;
    currentStake = 0; lastBalance = null; ladder = 0; stakeLevelIdx = 0;
    tickBuffer.length = 0;
  }

  function proposalPayloads(barrier, amount) {
    var base = { proposal: 1, contract_type: "DIGITDIFF", currency: "USD",
                 amount: amount, basis: "stake", duration: 1, duration_unit: "t", barrier: barrier };
    var a = Object.assign({}, base); a.underlying_symbol = SYMBOL;
    var b = Object.assign({}, base); b.underlying = SYMBOL;
    var c = Object.assign({}, base); c.symbol = SYMBOL;
    return [a, b, c, Object.assign({}, base)];
  }

  function send(data) {
    if (!ws || ws.readyState !== 1) { log("WS not ready.", "red"); return false; }
    ws.send(JSON.stringify(data)); return true;
  }

  function retryProposal(errMsg) {
    if (!waitingProposal || !proposalVariants) return false;
    var lower = String(errMsg || "").toLowerCase();
    var keywords = ["underlying_symbol","underlying","not allowed","symbol","missing","invalid","validation"];
    for (var i = 0; i < keywords.length; i++) {
      if (lower.indexOf(keywords[i]) >= 0) {
        log("Proposal failed; trying next variant.", "orange");
        sendProposal(); return true;
      }
    }
    return false;
  }

  function sendProposal() {
    if (!proposalVariants) return;
    if (proposalAttempt >= proposalVariants.length) {
      log("All proposal variants failed.", "red");
      waitingProposal = false; proposalVariants = null; proposalAttempt = 0; return;
    }
    send(proposalVariants[proposalAttempt++]);
  }

  function trade(barrier) {
    if (waitingProposal) return;
    pendingBarrier = barrier; probing = true;
    proposalVariants = proposalPayloads(barrier, baseStake());
    proposalAttempt = 0; waitingProposal = true;
    log("Requesting quote — DIGITDIFF barrier=" + barrier, "#38bdf8");
    sendProposal();
  }

  function onTick(price) {
    if (!running || paused) return;
    var d = lastDigit(price);
    if (d === null) return;

    priceEl.textContent     = Number(price).toFixed(2);
    lastDigitEl.textContent = d;
    tickBuffer.push({ price: price, digit: d });
    startTickFlush();

    if (captureNextTick) { settlementDigit = d; captureNextTick = false; }
    if (waitingProposal || activeContractId) return;

    if (phase === "scan_ab") {
      if (seqA === null) {
        if (targetPair) { if (d === targetPair[0]) seqA = d; }
        else            { if (d >= 0 && d <= 8)    seqA = d; }
        return;
      }
      if (d === seqA + 1) {
        if (targetPair && (seqA !== targetPair[0] || d !== targetPair[1])) {
          seqA = (d >= 0 && d <= 8) ? d : null; return;
        }
        seqB = d; phase = "scan_x";
        log("Pair [" + seqA + "," + seqB + "] found — waiting for x", "#38bdf8");
      } else {
        seqA = targetPair ? (d === targetPair[0] ? d : null) : (d >= 0 && d <= 8 ? d : null);
      }
      return;
    }

    if (phase === "scan_x") {
      if (d === 9) { log("x=9 → restart.", "red"); resetSeq(targetPair); return; }
      var barrier = d + 1;
      log("Pattern [" + seqA + "," + seqB + "," + d + "] → barrier=" + barrier + " → BUY", "#22c55e");
      trade(barrier);
    }
  }

  function connect() {
    if (!activeToken) { log("No token — please login.", "red"); return; }
    resetSeq(null);
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); ws = null; }

    log("Connecting as " + activeLoginid + "…", "yellow");
    ws = new WebSocket(WS_ENDPOINT);

    ws.onopen = function() {
      log("Connected — authorising…", "#38bdf8");
      ws.send(JSON.stringify({ authorize: activeToken }));
    };

    ws.onmessage = function(e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch(err) { log("Bad JSON.", "red"); return; }

      if (msg.error) {
        var errText = msg.error.message || JSON.stringify(msg.error);
        log("Error: " + errText, "red");
        if (!retryProposal(errText)) { waitingProposal = false; proposalVariants = null; proposalAttempt = 0; }
        return;
      }

      var type = msg.msg_type;

      if (type === "authorize") {
        var info = msg.authorize;
        log("✓ Authorised — " + info.loginid + " | " + info.account_type + " | " +
            Number(info.balance).toFixed(2) + " " + info.currency, "lime");
        setBalance(info.balance);
        send({ ticks: SYMBOL, subscribe: 1 });
        send({ balance: 1, subscribe: 1 });
        return;
      }

      if (type === "tick") { onTick(msg.tick.quote); return; }

      if (type === "balance") {
        if (msg.balance && msg.balance.balance !== undefined) setBalance(msg.balance.balance);
        return;
      }

      if (type === "proposal") {
        if (!waitingProposal) return;
        waitingProposal = false; proposalVariants = null; proposalAttempt = 0;
        var prop = msg.proposal;
        if (!prop) { log("Empty proposal.", "red"); return; }
        var ask    = Number(prop.ask_price || 0);
        var payout = Number(prop.payout    || 0);
        if (payout > 0 && ask > 0) { lastPayoutRatio = payout / ask; }

        if (probing) {
          probing = false;
          if (stakeMode === "switch") {
            currentStake = ask;
            log("TRADE barrier=" + pendingBarrier + " stake=$" + currentStake + " [Lvl " + (stakeLevelIdx+1) + "]", "lime");
            send({ buy: prop.id, price: prop.ask_price });
          } else {
            var correct = martingaleStake(lastPayoutRatio);
            if (Math.abs(correct - ask) < 0.01) {
              currentStake = ask;
              log("TRADE barrier=" + pendingBarrier + " stake=$" + currentStake, "lime");
              send({ buy: prop.id, price: prop.ask_price });
            } else {
              log("Re-probe for recovery stake $" + correct, "orange");
              proposalVariants = proposalPayloads(pendingBarrier, correct);
              proposalAttempt = 0; waitingProposal = true;
              sendProposal();
            }
          }
        } else {
          currentStake = ask;
          log("TRADE barrier=" + pendingBarrier + " stake=$" + currentStake, "lime");
          send({ buy: prop.id, price: prop.ask_price });
        }
        return;
      }

      if (type === "buy") {
        activeContractId = (msg.buy && msg.buy.contract_id) || null;
        settlementDigit = null; captureNextTick = true;
        if (activeContractId) send({ proposal_open_contract: 1, contract_id: activeContractId, subscribe: 1 });
        return;
      }

      if (type === "proposal_open_contract") {
        var c = msg.proposal_open_contract;
        if (!c) return;
        profitEl.textContent = Number(c.profit || 0).toFixed(2);
        if (typeof c.balance_after === "number" && c.balance_after > 0) setBalance(c.balance_after);

        if (c.is_sold) {
          var pnl = Number(c.profit || 0);
          totalProfit += pnl;
          profitEl.textContent = totalProfit.toFixed(2);

          var exitD = (c.exit_tick !== undefined) ? lastDigit(c.exit_tick) : null;
          var resD = (settlementDigit !== null) ? settlementDigit : exitD;
          var nxtPair = (resD !== null) ? nextPair(resD) : null;

          if (pnl >= 0) {
            recoveryLoss = 0; currentStake = 0; ladder = 0;
            if (stakeMode === "switch") stakeLevelIdx = 0;
            log("WIN +" + pnl.toFixed(2) +
                (stakeMode === "switch" ? " → Lvl reset" : "") +
                (resD !== null ? " digit=" + resD : "") +
                (nxtPair ? " → next [" + nxtPair[0] + "," + nxtPair[1] + "]" : ""), "lime");
          } else {
            ladder++;
            if (stakeMode === "switch") {
              var prev = stakeLevelIdx;
              stakeLevelIdx = Math.min(stakeLevelIdx + 1, stakeLevels().length - 1);
              log("LOSS $" + Math.abs(pnl).toFixed(2) + " Lvl " + (prev+1) + "→" + (stakeLevelIdx+1) +
                  " next=$" + switchStake() +
                  (stakeLevelIdx === stakeLevels().length - 1 ? " [MAX]" : "") +
                  (resD !== null ? " digit=" + resD : "") +
                  (nxtPair ? " → next [" + nxtPair[0] + "," + nxtPair[1] + "]" : ""), "red");
            } else {
              recoveryLoss += Math.abs(pnl);
              log("LOSS $" + Math.abs(pnl).toFixed(2) + " cumLoss=$" + recoveryLoss.toFixed(2) +
                  " nextStake≈$" + martingaleStake(lastPayoutRatio).toFixed(2), "red");
            }
          }

          levelEl.textContent = ladder;
          send({ balance: 1, subscribe: 1 });
          resetSeq(nxtPair);
        }
        return;
      }
    };

    ws.onclose = function(ev) { log("WebSocket closed (code " + ev.code + ").", "orange"); stopTickFlush(); };
    ws.onerror = function()   { log("WebSocket error.", "red"); };
  }

  logoutBtn.onclick = function() {
    running = false;
    if (ws) ws.close();
    stopTickFlush();
    clearSession();
    log("Logged out.", "yellow");
  };

  startBtn.onclick = function() {
    running = true;
    connect();
    log("BOT STARTED", "lime");
  };

  pauseBtn.onclick = function() {
    paused = !paused;
    log(paused ? "PAUSED" : "RESUMED", "yellow");
  };

  stopBtn.onclick = function() {
    running = false;
    if (ws) ws.close();
    stopTickFlush();
    log("STOPPED", "red");
  };

  resetBtn.onclick = function() {
    fullReset();
    profitEl.textContent  = "0.00";
    levelEl.textContent   = "0";
    balanceEl.textContent = "-";
    log("RESET", "orange");
  };

  demoBtn.onclick = function() {
    var demo = null;
    for (var i = 0; i < accounts.length; i++) { if (accounts[i].is_virtual) { demo = i; break; } }
    if (demo === null) { log("No demo account in session.", "orange"); return; }
    accountSelector.value = demo;
    applyAccount(demo);
    if (ws) { ws.close(); ws = null; }
    log("Switched to DEMO — press Start.", "#3b82f6");
  };

  liveBtn.onclick = function() {
    var live = null;
    for (var i = 0; i < accounts.length; i++) { if (!accounts[i].is_virtual) { live = i; break; } }
    if (live === null) { log("No real account in session.", "orange"); return; }
    accountSelector.value = live;
    applyAccount(live);
    if (ws) { ws.close(); ws = null; }
    log("Switched to LIVE — press Start.", "#ef4444");
  };

  window.addEventListener("beforeunload", function() { if (ws) ws.close(); stopTickFlush(); });

  var fromOAuth = parseOAuthCallback();

  if (fromOAuth.length > 0) {
    accounts = fromOAuth;
    saveAccounts(accounts);
    applyAccount(0);
    createSwitchUI();
    log("Login successful ✓ — connecting…", "lime");
    running = true;
    connect();
  } else {
    accounts = loadAccounts();
    if (accounts.length > 0) {
      applyAccount(0);
      createSwitchUI();
      log("Session restored — press Start to begin.", "lime");
    } else {
      updateLoginUI();
    }
  }
});
