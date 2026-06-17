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

  let ACCOUNT = "demo";
  const ACCOUNTS = {
    demo: "DOT92927394",
    live: "ROT91650098"
  };

  let ws;
  let running = false;
  let paused = false;

  let ladder = 0;
  let totalProfit = 0;

  let sequence = [];
  let waitingProposal = false;
  let proposalVariants = null;
  let proposalAttempt = 0;
  let activeContractId = null;

  // Logging/tick config
  const LOG_MAX_ENTRIES = 1200;
  const TICK_FLUSH_MS = 60;
  const TICK_BATCH_LIMIT = 500;
  let tickBuffer = [];
  let tickFlushTimer = null;

  function appendLogLine(msg, color = "#fff") {
    const div = document.createElement("div");
    div.style.color = color;
    div.textContent = msg;
    logEl.appendChild(div);
    while (logEl.children.length > LOG_MAX_ENTRIES) {
      logEl.removeChild(logEl.firstChild);
    }
    logEl.scrollTop = logEl.scrollHeight;
    console.log(msg);
  }

  function startTickFlush() {
    if (tickFlushTimer) return;
    tickFlushTimer = setInterval(flushTickBuffer, TICK_FLUSH_MS);
  }

  function stopTickFlush() {
    if (!tickFlushTimer) return;
    clearInterval(tickFlushTimer);
    tickFlushTimer = null;
  }

  function flushTickBuffer() {
    if (!tickBuffer.length) return;
    const batch = tickBuffer.splice(0, TICK_BATCH_LIMIT);
    const frag = document.createDocumentFragment();

    for (let i = 0; i < batch.length; i++) {
      const t = batch[i];
      const div = document.createElement("div");
      div.style.color = "#38bdf8";
      div.textContent = `Tick ${Number(t.price).toFixed(2)} → ${t.digit}`;
      frag.appendChild(div);
    }

    logEl.appendChild(frag);
    while (logEl.children.length > LOG_MAX_ENTRIES) {
      logEl.removeChild(logEl.firstChild);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  function log(msg, color = "#fff") {
    appendLogLine(msg, color);
  }

  function digit(price) {
    return Math.floor(Math.abs(price * 100)) % 10;
  }

  function stake(level) {
    const base = Number(stakeInput.value || 0.35);
    return +(base * Math.pow(11.57, level)).toFixed(2);
  }

  function send(data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      appendLogLine("WS not open — cannot send", "red");
      return false;
    }
    const payload = JSON.stringify(data);
    ws.send(payload);
    console.log("SENT:", payload);
    return true;
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
      amount: amount,
      basis: "stake",
      duration: 1,
      duration_unit: "t",
      barrier: barrier
    };

    return [
      Object.assign({}, base),
      Object.assign({}, base, { underlying_symbol: SYMBOL }),
      Object.assign({}, base, { underlying: SYMBOL }),
      Object.assign({}, base, { symbol: SYMBOL })
    ];
  }

  function sendNextProposalVariant() {
    if (!proposalVariants) return;
    if (proposalAttempt >= proposalVariants.length) {
      appendLogLine("All proposal variants attempted — no accepted proposal", "red");
      waitingProposal = false;
      proposalVariants = null;
      proposalAttempt = 0;
      return;
    }
    const req = proposalVariants[proposalAttempt];
    proposalAttempt++;
    appendLogLine(`SENDING PROPOSAL VARIANT #${proposalAttempt}`, "#a78bfa");
    send(req);
  }

  function placeTrade(barrier) {
    if (waitingProposal) {
      appendLogLine("Already waiting for a proposal — skipping new trade", "orange");
      return;
    }

    proposalVariants = buildProposalVariants(barrier);
    proposalAttempt = 0;
    waitingProposal = true;

    appendLogLine(`PROPOSAL INIT → DIGITDIFF ${barrier} | stake ${proposalVariants[0].amount}`, "#38bdf8");
    sendNextProposalVariant();
  }

  function handleValidationError(errMsg) {
    if (!waitingProposal || !proposalVariants) return false;
    const msg = String(errMsg || "").toLowerCase();

    if (msg.includes("underlying_symbol") || msg.includes("underlying symbol") || msg.includes("underlying")) {
      appendLogLine("Server requires underlying symbol — trying next variant", "orange");
      sendNextProposalVariant();
      return true;
    }

    if (msg.includes("properties not allowed") && msg.includes("symbol")) {
      proposalVariants = proposalVariants.filter(v => !("symbol" in v));
      appendLogLine("Server rejected 'symbol' property — removed symbol variants and retrying", "orange");
      sendNextProposalVariant();
      return true;
    }

    if (msg.includes("missing") || msg.includes("invalid") || msg.includes("validation failed")) {
      appendLogLine("Validation error from server — trying next proposal variant", "orange");
      sendNextProposalVariant();
      return true;
    }

    return false;
  }

  function onTick(price) {
    if (!running || paused) return;

    const d = digit(price);

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
        appendLogLine("INVALID x=9 → ignored", "red");
        sequence = [];
        return;
      }

      const barrier = x + 1;

      appendLogLine(`PATTERN FOUND → ${sequence.join(",")} → DIGITDIFF ${barrier}`, "lime");

      placeTrade(barrier);

      sequence = [];
    }
  }

  function connect() {
    resetStrategy();

    if (ws) ws.close();

    const accountId = ACCOUNTS[ACCOUNT];

    fetch(
      `https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + localStorage.getItem("access_token"),
          "Deriv-App-ID": "33wZZKTFZrmsZgFaAH53Z"
        }
      }
    )
      .then(r => r.json())
      .then(data => {
        if (!data?.data?.url) {
          appendLogLine("OTP FAILED", "red");
          console.log(data);
          return;
        }

        ws = new WebSocket(data.data.url);

        ws.onopen = () => {
          appendLogLine("WS CONNECTED", "lime");
          setTimeout(() => {
            send({ ticks: SYMBOL, subscribe: 1 });
            send({ balance: 1 });
          }, 150);
        };

        ws.onmessage = (e) => {
          let d;
          try {
            d = JSON.parse(e.data);
          } catch (err) {
            console.error("Invalid JSON message", e.data);
            appendLogLine("Received invalid JSON from WS", "red");
            return;
          }

          if (d.error) {
            appendLogLine(`ERROR → ${d.error.message || JSON.stringify(d.error)}`, "red");
            console.error("Server error object:", d.error);

            if (waitingProposal) {
              const tried = handleValidationError(d.error.message || JSON.stringify(d.error));
              if (!tried) {
                waitingProposal = false;
                proposalVariants = null;
                proposalAttempt = 0;
              }
            } else {
              waitingProposal = false;
              proposalVariants = null;
              proposalAttempt = 0;
            }
            return;
          }

          if (d.msg_type === "tick") {
            onTick(d.tick.quote);
          }

          if (d.msg_type === "balance") {
            balanceEl.textContent = Number(d.balance.balance || 0).toFixed(2);
          }

          if (d.msg_type === "proposal") {
            if (!waitingProposal) {
              console.log("IGNORING unsolicited proposal", d);
              return;
            }

            waitingProposal = false;
            proposalVariants = null;
            proposalAttempt = 0;

            const propSym = (d.proposal && (d.proposal.underlying_symbol || d.proposal.symbol || d.proposal.underlying)) || null;
            if (propSym && propSym !== SYMBOL) {
              appendLogLine(`PROPOSAL for unexpected underlying ${propSym} — ignoring`, "red");
              return;
            }

            send({
              buy: d.proposal.id,
              price: d.proposal.ask_price
            });
          }

          if (d.msg_type === "buy") {
            if (!d.buy || !d.buy.contract_id) {
              appendLogLine("BUY response missing contract_id", "red");
              return;
            }

            activeContractId = d.buy.contract_id;

            send({
              proposal_open_contract: 1,
              contract_id: activeContractId,
              subscribe: 1
            });
          }

          if (d.msg_type === "proposal_open_contract") {
            const c = d.proposal_open_contract;
            if (!c) return;

            profitEl.textContent = Number(c.profit || 0).toFixed(2);
            balanceEl.textContent = Number(c.balance_after || 0).toFixed(2);

            if (c.is_sold) {
              const pnl = Number(c.profit || 0);
              totalProfit += pnl;
              profitEl.textContent = totalProfit.toFixed(2);

              if (pnl >= 0) {
                ladder = 0;
                appendLogLine(`WIN +${pnl}`, "lime");
              } else {
                ladder++;
                appendLogLine(`LOSS ${pnl}`, "red");
              }

              levelEl.textContent = ladder;

              waitingProposal = false;
              proposalVariants = null;
              proposalAttempt = 0;
              activeContractId = null;

              resetStrategy();
            }
          }
        };

        ws.onclose = (ev) => {
          appendLogLine(`WS CLOSED (code ${ev.code})`, "red");
          stopTickFlush();
        };

        ws.onerror = (ev) => {
          appendLogLine("WS ERROR — check console for details", "red");
          console.error("WebSocket error", ev);
        };
      })
      .catch(err => {
        appendLogLine("OTP fetch failed: " + String(err), "red");
        console.error(err);
      });
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
    ws?.close();
    appendLogLine("STOPPED", "red");
    stopTickFlush();
  };

  resetBtn.onclick = () => {
    resetStrategy();
    totalProfit = 0;
    profitEl.textContent = "0.00";
    appendLogLine("RESET DONE", "orange");
  };

  demoBtn.onclick = () => {
    ACCOUNT = "demo";
    appendLogLine("DEMO MODE", "blue");
  };

  liveBtn.onclick = () => {
    ACCOUNT = "live";
    appendLogLine("LIVE MODE", "red");
  };

  window.addEventListener("beforeunload", () => {
    try { ws?.close(); } catch (e) {}
    stopTickFlush();
  });
});
