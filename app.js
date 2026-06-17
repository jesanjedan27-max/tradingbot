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
  // proposal retry state
  let waitingProposal = false;
  let proposalVariants = null;
  let proposalAttempt = 0;
  let activeContractId = null;

  function log(msg, color = "#fff") {
    const div = document.createElement("div");
    div.style.color = color;
    div.textContent = msg;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
    console.log(msg);
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
      log("WS not open — cannot send", "red");
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
  }

  // build proposal variants (ordered attempts)
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

    // variants: start with minimal (no symbol), then try underlying_symbol, then underlying, finally symbol
    return [
      Object.assign({}, base), // minimal
      Object.assign({}, base, { underlying_symbol: SYMBOL }),
      Object.assign({}, base, { underlying: SYMBOL }),
      Object.assign({}, base, { symbol: SYMBOL })
    ];
  }

  // send next available variant
  function sendNextProposalVariant() {
    if (!proposalVariants) return;
    if (proposalAttempt >= proposalVariants.length) {
      log("All proposal variants attempted — giving up", "red");
      waitingProposal = false;
      proposalVariants = null;
      proposalAttempt = 0;
      return;
    }
    const req = proposalVariants[proposalAttempt];
    proposalAttempt++;
    log(`SENDING PROPOSAL VARIANT #${proposalAttempt}`, "#a78bfa");
    send(req);
  }

  // ================= TRADE (RETRYABLE) =================
  function placeTrade(barrier) {
    if (waitingProposal) {
      log("Already waiting for a proposal — skipping new trade", "orange");
      return;
    }

    // prepare variants then send first
    proposalVariants = buildProposalVariants(barrier);
    proposalAttempt = 0;
    waitingProposal = true;

    log(`PROPOSAL SENT → DIGITDIFF ${barrier} | stake ${proposalVariants[0].amount}`, "#38bdf8");
    sendNextProposalVariant();
  }

  // ================= STRATEGY =================
  function onTick(price) {
    if (!running || paused) return;

    const d = digit(price);

    if (priceEl) priceEl.textContent = price.toFixed(2);
    log(`Tick ${price.toFixed(2)} → ${d}`, "#38bdf8");

    if (waitingProposal || activeContractId) return;

    sequence.push(d);
    if (sequence.length > 5) sequence.shift();

    if (sequence.length < 5) return;

    const [a, b, z1, z2, x] = sequence;

    if (a === 2 && b === 3) {
      if (x === 9) {
        log("INVALID x=9 → ignored", "red");
        sequence = [];
        return;
      }

      const barrier = x + 1;

      log(`PATTERN FOUND → ${sequence.join(",")} → DIGITDIFF ${barrier}`, "lime");

      placeTrade(barrier);

      sequence = [];
    }
  }

  // helper to inspect server error and decide retry
  function handleValidationError(errMsg) {
    if (!waitingProposal || !proposalVariants) return false;

    // Normalize message
    const msg = String(errMsg || "").toLowerCase();

    // If server complains about missing underlying symbol, try variants that include it
    if (msg.includes("underlying_symbol") || msg.includes("underlying symbol") || msg.includes("underlying")) {
      log("Server requires underlying symbol — trying next variant", "orange");
      sendNextProposalVariant();
      return true;
    }

    // If server complains about symbol not allowed, skip variants that include symbol (they are last)
    if (msg.includes("properties not allowed") && msg.includes("symbol")) {
      // drop any remaining variants that include 'symbol'
      proposalVariants = proposalVariants.filter(v => !("symbol" in v));
      log("Server rejected 'symbol' property — removed symbol variants and retrying", "orange");
      // reset attempt index to current length already tried; continue
      sendNextProposalVariant();
      return true;
    }

    // Generic "missing" or "invalid" clues: try next variant
    if (msg.includes("missing") || msg.includes("invalid") || msg.includes("validation failed")) {
      log("Validation error from server — trying next proposal variant", "orange");
      sendNextProposalVariant();
      return true;
    }

    return false;
  }

  // ================= CONNECT =================
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
          log("OTP FAILED", "red");
          console.log(data);
          return;
        }

        ws = new WebSocket(data.data.url);

        ws.onopen = () => {
          log("WS CONNECTED", "lime");
          setTimeout(() => {
            send({ ticks: SYMBOL, subscribe: 1 });
            send({ balance: 1 });
          }, 300);
        };

        ws.onmessage = (e) => {
          let d;
          try {
            d = JSON.parse(e.data);
          } catch (err) {
            console.error("Invalid JSON message", e.data);
            log("Received invalid JSON from WS", "red");
            return;
          }

          if (d.error) {
            log(`ERROR → ${d.error.message || JSON.stringify(d.error)}`, "red");
            console.error("Server error object:", d.error);

            // If this is a validation error while waiting for proposal, attempt next variant
            if (waitingProposal) {
              const tried = handleValidationError(d.error.message || JSON.stringify(d.error));
              if (!tried) {
                // no retry possible
                waitingProposal = false;
                proposalVariants = null;
                proposalAttempt = 0;
              }
            } else {
              // reset proposal state if not relevant
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
            // only accept proposals when we are expecting one
            if (!waitingProposal) {
              console.log("IGNORING unsolicited proposal", d);
              return;
            }

            // Accept proposal and reset retry state
            waitingProposal = false;
            proposalVariants = null;
            proposalAttempt = 0;

            // Validate if proposal underlying matches (if provided)
            const propSym = (d.proposal && (d.proposal.underlying_symbol || d.proposal.symbol || d.proposal.underlying)) || null;
            if (propSym && propSym !== SYMBOL) {
              log(`PROPOSAL for unexpected underlying ${propSym} — ignoring`, "red");
              return;
            }

            log("PROPOSAL RECEIVED → BUYING", "#22c55e");

            send({
              buy: d.proposal.id,
              price: d.proposal.ask_price
            });
          }

          if (d.msg_type === "buy") {
            if (!d.buy || !d.buy.contract_id) {
              log("BUY response missing contract_id", "red");
              return;
            }

            activeContractId = d.buy.contract_id;
            log(`BUY CONFIRMED → ${activeContractId}`, "#22c55e");

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
                log(`WIN +${pnl}`, "lime");
              } else {
                ladder++;
                log(`LOSS ${pnl}`, "red");
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
          log(`WS CLOSED (code ${ev.code})`, "red");
        };

        ws.onerror = (ev) => {
          log("WS ERROR — check console for details", "red");
          console.error("WebSocket error", ev);
        };
      })
      .catch(err => {
        log("OTP fetch failed: " + String(err), "red");
        console.error(err);
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
    resetStrategy();
    totalProfit = 0;
    profitEl.textContent = "0.00";
    log("RESET DONE", "orange");
  };

  demoBtn.onclick = () => {
    ACCOUNT = "demo";
    log("DEMO MODE", "blue");
  };

  liveBtn.onclick = () => {
    ACCOUNT = "live";
    log("LIVE MODE", "red");
  };
});
