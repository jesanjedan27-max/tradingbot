// Deriv DigitDiff bot optimized for OTP error handling
// Save this file as app.js alongside index.html.

document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);

  const startBtn = $("start");
  const pauseBtn = $("pause");
  const stopBtn = $("stop");
  const resetBtn = $("reset");
  const demoBtn = $("demoBtn");
  const liveBtn = $("liveBtn");

  const priceEl = $("price");
  const balanceEl = $("balance");
  const profitEl = $("profit");
  const levelEl = $("level");
  const logEl = $("log");
  const stakeInput = $("stakeInput");

  const SYMBOL = "R_100";

  const ACCOUNTS = {
    demo: "DOT92927394",
    live: "ROT91650098"
  };

  let account = "demo";
  let ws = null;
  let running = false;
  let paused = false;
  let ladder = 0;
  let totalProfit = 0;
  let sequence = [];
  let waitingProposal = false;
  let proposalVariants = null;
  let proposalAttempt = 0;
  let activeContractId = null;

  const LOG_MAX_ENTRIES = 1200;
  const TICK_FLUSH_MS = 60;
  const TICK_BATCH_LIMIT = 200;
  let tickBuffer = [];
  let tickFlushTimer = null;

  function appendLogLine(message, color = "#fff") {
    const entry = document.createElement("div");
    entry.style.color = color;
    entry.textContent = message;
    logEl.appendChild(entry);
    while (logEl.children.length > LOG_MAX_ENTRIES) {
      logEl.removeChild(logEl.firstChild);
    }
    logEl.scrollTop = logEl.scrollHeight;
    console.log(message);
  }

  function log(message, color = "#fff") {
    appendLogLine(message, color);
  }

  function startTickFlush() {
    if (tickFlushTimer) return;
    tickFlushTimer = setInterval(() => {
      if (!tickBuffer.length) return;
      const fragment = document.createDocumentFragment();
      const batch = tickBuffer.splice(0, TICK_BATCH_LIMIT);
      batch.forEach(({ price, digit }) => {
        const row = document.createElement("div");
        row.style.color = "#7dd3fc";
        row.textContent = `Tick ${Number(price).toFixed(2)} → ${digit}`;
        fragment.appendChild(row);
      });
      logEl.appendChild(fragment);
      while (logEl.children.length > LOG_MAX_ENTRIES) {
        logEl.removeChild(logEl.firstChild);
      }
      logEl.scrollTop = logEl.scrollHeight;
    }, TICK_FLUSH_MS);
  }

  function stopTickFlush() {
    if (!tickFlushTimer) return;
    clearInterval(tickFlushTimer);
    tickFlushTimer = null;
  }

  function digitFromPrice(price) {
    return Math.floor(Math.abs(price * 100)) % 10;
  }

  function stake(level) {
    const baseStake = Number(stakeInput.value || 0.35);
    return Number((baseStake * Math.pow(11.57, level)).toFixed(2));
  }

  function resetStrategy() {
    sequence = [];
    waitingProposal = false;
    proposalVariants = null;
    proposalAttempt = 0;
    activeContractId = null;
    tickBuffer.length = 0;
  }

  function buildProposalVariants(barrier) {
    const amount = stake(ladder);
    const base = {
      proposal: 1,
      contract_type: "DIGITDIFF",
      currency: "USD",
      amount,
      basis: "stake",
      duration: 1,
      duration_unit: "t",
      barrier
    };

    return [
      Object.assign({}, base),
      Object.assign({}, base, { underlying_symbol: SYMBOL }),
      Object.assign({}, base, { underlying: SYMBOL }),
      Object.assign({}, base, { symbol: SYMBOL })
    ];
  }

  function sendMessage(data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      appendLogLine("WS not open; cannot send.", "red");
      return false;
    }
    ws.send(JSON.stringify(data));
    return true;
  }

  function handleValidationError(errorText) {
    if (!waitingProposal || !proposalVariants) return false;
    const lower = String(errorText || "").toLowerCase();

    if (lower.includes("underlying_symbol") || lower.includes("underlying") || lower.includes("properties not allowed") || lower.includes("symbol")) {
      sendNextProposalVariant();
      return true;
    }

    if (lower.includes("missing") || lower.includes("invalid") || lower.includes("validation failed")) {
      sendNextProposalVariant();
      return true;
    }

    return false;
  }

  function sendNextProposalVariant() {
    if (!proposalVariants) return;
    if (proposalAttempt >= proposalVariants.length) {
      appendLogLine("All proposal variants failed.", "red");
      waitingProposal = false;
      proposalVariants = null;
      proposalAttempt = 0;
      return;
    }

    const payload = proposalVariants[proposalAttempt++];
    appendLogLine(`Proposal attempt ${proposalAttempt}: ${JSON.stringify(payload)}`, "#a78bfa");
    sendMessage(payload);
  }

  function placeTrade(barrier) {
    if (waitingProposal) {
      appendLogLine("Already waiting for a proposal.", "orange");
      return;
    }

    proposalVariants = buildProposalVariants(barrier);
    proposalAttempt = 0;
    waitingProposal = true;
    appendLogLine(`TRADE -> DIGITDIFF barrier=${barrier} stake=${proposalVariants[0].amount}`, "lime");
    sendNextProposalVariant();
  }

  function onTick(price) {
    if (!running || paused) return;
    const d = digitFromPrice(price);

    if (priceEl) priceEl.textContent = Number(price).toFixed(2);
    tickBuffer.push({ price, digit: d });
    startTickFlush();

    if (waitingProposal || activeContractId) return;

    sequence.push(d);
    if (sequence.length > 5) sequence.shift();
    if (sequence.length < 5) return;

    const [a, b, z1, z2, x] = sequence;
    if (a === 2 && b === 3) {
      if (x === 9) {
        appendLogLine("Invalid x=9; ignoring.", "red");
        sequence = [];
        return;
      }
      const barrier = x + 1;
      appendLogLine(`Pattern ${sequence.join(",")} -> buy DIGITDIFF ${barrier}`, "#22c55e");
      placeTrade(barrier);
      sequence = [];
    }
  }

  async function connect() {
    resetStrategy();
    if (ws) ws.close();

    const accountId = ACCOUNTS[account];
    const accessToken = localStorage.getItem("access_token");

    if (!accessToken) {
      appendLogLine("Missing access_token in localStorage.", "red");
      return;
    }

    try {
      const response = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Deriv-App-ID": "33wZZKTFZrmsZgFaAH53Z"
        }
      });

      const text = await response.text();
      if (!response.ok) {
        appendLogLine(`OTP request failed ${response.status}.`, "red");
        appendLogLine(text, "red");
        console.error("OTP failure response:", text);
        return;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        appendLogLine("OTP response is not JSON.", "red");
        appendLogLine(text, "red");
        console.error("OTP parse error:", err, "response:", text);
        return;
      }

      if (!data?.data?.url) {
        appendLogLine("OTP response missing data.url.", "red");
        appendLogLine(JSON.stringify(data), "red");
        return;
      }

      ws = new WebSocket(data.data.url);

      ws.onopen = () => {
        appendLogLine("WS connected.", "lime");
        sendMessage({ ticks: SYMBOL, subscribe: 1 });
        sendMessage({ balance: 1 });
      };

      ws.onmessage = e => {
        let payload;
        try {
          payload = JSON.parse(e.data);
        } catch (err) {
          appendLogLine("Invalid JSON from WS.", "red");
          console.error("WS parse error:", err, e.data);
          return;
        }

        if (payload.error) {
          const message = payload.error.message || JSON.stringify(payload.error);
          appendLogLine(`Error: ${message}`, "red");
          if (!handleValidationError(message)) {
            waitingProposal = false;
            proposalVariants = null;
            proposalAttempt = 0;
          }
          return;
        }

        switch (payload.msg_type) {
          case "tick":
            onTick(payload.tick.quote);
            break;
          case "balance":
            if (balanceEl) balanceEl.textContent = Number(payload.balance.balance || 0).toFixed(2);
            break;
          case "proposal":
            if (!waitingProposal) break;
            waitingProposal = false;
            proposalVariants = null;
            proposalAttempt = 0;
            if (!payload.proposal) {
              appendLogLine("Proposal response missing payload.", "red");
              break;
            }
            sendMessage({ buy: payload.proposal.id, price: payload.proposal.ask_price });
            break;
          case "buy":
            activeContractId = payload.buy?.contract_id || null;
            if (activeContractId) {
              sendMessage({ proposal_open_contract: 1, contract_id: activeContractId, subscribe: 1 });
            }
            break;
          case "proposal_open_contract":
            const contract = payload.proposal_open_contract;
            if (!contract) return;
            if (profitEl) profitEl.textContent = Number(contract.profit || 0).toFixed(2);
            if (balanceEl) balanceEl.textContent = Number(contract.balance_after || 0).toFixed(2);
            if (contract.is_sold) {
              const pnl = Number(contract.profit || 0);
              totalProfit += pnl;
              profitEl.textContent = totalProfit.toFixed(2);
              if (pnl >= 0) {
                ladder = 0;
                appendLogLine(`WIN +${pnl.toFixed(2)}`, "lime");
              } else {
                ladder += 1;
                appendLogLine(`LOSS ${pnl.toFixed(2)}`, "red");
              }
              if (levelEl) levelEl.textContent = ladder;
              waitingProposal = false;
              proposalVariants = null;
              proposalAttempt = 0;
              activeContractId = null;
              resetStrategy();
            }
            break;
          default:
            break;
        }
      };

      ws.onclose = ev => {
        appendLogLine(`WS closed (code ${ev.code}).`, "orange");
        stopTickFlush();
      };

      ws.onerror = ev => {
        appendLogLine("WS error.", "red");
        console.error("WebSocket error:", ev);
      };
    } catch (err) {
      appendLogLine(`OTP fetch failed: ${String(err)}`, "red");
      console.error(err);
    }
  }

  startBtn.onclick = () => {
    running = true;
    connect();
    appendLogLine("BOT STARTED", "lime");
  };

  pauseBtn.onclick = () => {
    paused = !paused;
    appendLogLine(paused ? "PAUSED" : "RUNNING", "yellow");
  };

  stopBtn.onclick = () => {
    running = false;
    if (ws) ws.close();
    stopTickFlush();
    appendLogLine("STOPPED", "red");
  };

  resetBtn.onclick = () => {
    resetStrategy();
    totalProfit = 0;
    if (profitEl) profitEl.textContent = "0.00";
    appendLogLine("RESET DONE", "orange");
  };

  demoBtn.onclick = () => {
    account = "demo";
    appendLogLine("DEMO MODE", "blue");
    const mi = $("modeIndicator");
    if (mi) mi.textContent = "JESAN 💲 MODE - DEMO";
  };

  liveBtn.onclick = () => {
    account = "live";
    appendLogLine("LIVE MODE", "red");
    const mi = $("modeIndicator");
    if (mi) mi.textContent = "JESAN 💲 MODE - LIVE";
  };

  window.addEventListener("beforeunload", () => {
    if (ws) ws.close();
    stopTickFlush();
  });
});
