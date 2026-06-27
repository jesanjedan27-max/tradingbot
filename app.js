// Deriv DigitDiff bot — consecutive-pair strategy with post-result chaining
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
  const lastDigitEl = $("lastDigit");
  const logEl = $("log");
  const stakeInput = $("stakeInput");
  const tokenInput = $("tokenInput");

  const SYMBOL = "R_100";
  const DEFAULT_PAYOUT_RATIO = 11.57;

  const savedToken = localStorage.getItem("access_token");
  if (tokenInput && savedToken) {
    tokenInput.value = savedToken;
  }

  const ACCOUNTS = {
    demo: "DOT92927394",
    live: "ROT91650098"
  };

  let account = "demo";
  demoBtn.classList.add("active");
  let ws = null;
  let running = false;
  let lastPayoutRatio = null;
  let recoveryLoss = 0;
  let currentStake = 0;
  let lastBalance = null;
  let paused = false;
  let ladder = 0;
  let totalProfit = 0;
  let waitingProposal = false;
  let proposalVariants = null;
  let proposalAttempt = 0;
  let activeContractId = null;

  // ── Strategy state ──────────────────────────────────────────────────────────
  // When set, the bot only looks for this specific A,B pair next.
  // null = open scan (any valid pair).
  let targetPair = null;    // e.g. [1, 2]

  // Phase tracking within a sequence
  // "scan_ab" → waiting to see A then B consecutively
  // "scan_x"  → A,B seen; now waiting for x (0-8, not 9)
  //             trade fires immediately: barrier = x+1 (that's y)
  let phase = "scan_ab";
  let seqA = null;
  let seqB = null;
  let settlementDigit = null;  // digit of the first tick after buy — the true settlement digit
  let captureNextTick = false; // when true, the next tick is the settlement tick

  // ── Log / tick buffering ────────────────────────────────────────────────────
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
        row.textContent = `Tick ${Number(price).toFixed(2)} → ${digit === null ? "-" : digit}`;
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
    const value = Number(price);
    if (Number.isNaN(value)) return null;
    const str = value.toFixed(2);
    return Number(str[str.length - 1]);
  }

  function updateBalance(value) {
    if (typeof value !== "number" || Number.isNaN(value)) return;
    lastBalance = value;
    if (balanceEl) balanceEl.textContent = value.toFixed(2);
  }

  function stake() {
    const baseStake = Number(stakeInput.value || 0.35);
    const payoutRatio = lastPayoutRatio && lastPayoutRatio > 1.01
      ? lastPayoutRatio
      : DEFAULT_PAYOUT_RATIO;
    if (recoveryLoss > 0 && payoutRatio > 1.01) {
      const neededStake = recoveryLoss / (payoutRatio - 1);
      return Number(Math.max(baseStake, neededStake).toFixed(2));
    }
    return Number(baseStake.toFixed(2));
  }

  // ── Strategy helpers ────────────────────────────────────────────────────────

  /**
   * Given a result digit (the last digit of the settled contract price),
   * derive the next target pair.
   * Special rule: digit 9 → next pair is [0, 1].
   */
  function nextPairFromResultDigit(digit) {
    if (digit === 9) return [0, 1];
    if (digit >= 0 && digit <= 8) return [digit, digit + 1];
    return null; // shouldn't happen
  }

  /**
   * Reset sequence scan but keep the martingale state intact.
   * If nextTarget is provided, restrict the next scan to that pair.
   */
  function resetSequence(nextTarget = null) {
    phase = "scan_ab";
    seqA = null;
    seqB = null;
    settlementDigit = null;
    captureNextTick = false;
    waitingProposal = false;
    proposalVariants = null;
    proposalAttempt = 0;
    activeContractId = null;
    targetPair = nextTarget;

    if (nextTarget) {
      appendLogLine(
        `Next scan: looking for pair [${nextTarget[0]},${nextTarget[1]}]`,
        "#a78bfa"
      );
    } else {
      appendLogLine("Next scan: open (any consecutive pair)", "#a78bfa");
    }
  }

  function fullReset() {
    resetSequence(null);
    totalProfit = 0;
    recoveryLoss = 0;
    lastPayoutRatio = null;
    currentStake = 0;
    lastBalance = null;
    ladder = 0;
    tickBuffer.length = 0;
  }

  // ── Proposal / trade plumbing ───────────────────────────────────────────────

  function buildProposalVariants(barrier) {
    const amount = stake();
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
      Object.assign({}, base, { underlying_symbol: SYMBOL }),
      Object.assign({}, base, { underlying: SYMBOL }),
      Object.assign({}, base, { symbol: SYMBOL }),
      Object.assign({}, base)
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
    if (
      lower.includes("underlying_symbol") ||
      lower.includes("underlying") ||
      lower.includes("properties not allowed") ||
      lower.includes("symbol") ||
      lower.includes("missing") ||
      lower.includes("invalid") ||
      lower.includes("validation failed")
    ) {
      appendLogLine("Proposal validation failed; retrying next variant.", "orange");
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
    const symbolLabel = payload.underlying_symbol
      ? "underlying_symbol"
      : payload.underlying
        ? "underlying"
        : payload.symbol
          ? "symbol"
          : "none";
    appendLogLine(`Proposal attempt ${proposalAttempt}: ${symbolLabel} mode`, "#a78bfa");
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
    appendLogLine(
      `TRADE → DIGITDIFF barrier=${barrier} stake=${proposalVariants[0].amount}`,
      "lime"
    );
    sendNextProposalVariant();
  }

  // ── Tick / sequence engine ──────────────────────────────────────────────────

  function onTick(price) {
    if (!running || paused) return;
    const d = digitFromPrice(price);
    if (d === null) return;

    if (priceEl) priceEl.textContent = Number(price).toFixed(2);
    if (lastDigitEl) lastDigitEl.textContent = d;
    tickBuffer.push({ price, digit: d });
    startTickFlush();

    // Capture the very first tick after buy is confirmed — that IS the settlement tick
    if (captureNextTick) {
      settlementDigit = d;
      captureNextTick = false;
    }

    // Don't process sequence logic while a trade is in flight
    if (waitingProposal || activeContractId) return;

    // ── Phase: scan_ab ────────────────────────────────────────────────────────
    // Looking for two consecutive digits (A, B) where B = A+1, A in 0-8.
    // If targetPair is set we only accept that specific pair.
    if (phase === "scan_ab") {
      if (seqA === null) {
        // Need the first digit of a candidate pair
        if (targetPair) {
          if (d === targetPair[0]) {
            seqA = d;
          }
        } else {
          // Any digit 0-8 can start a pair
          if (d >= 0 && d <= 8) {
            seqA = d;
          }
        }
        return;
      }

      // We have seqA; check if d is seqA+1 (i.e. B = A+1)
      if (d === seqA + 1) {
        // Valid pair!
        if (targetPair && (seqA !== targetPair[0] || d !== targetPair[1])) {
          // Doesn't match required pair — restart candidate
          seqA = (d >= 0 && d <= 8) ? d : null;
          return;
        }
        seqB = d;
        phase = "scan_x";
        appendLogLine(`Pair [${seqA},${seqB}] found → waiting for x`, "#38bdf8");
      } else {
        // Not consecutive; reset candidate
        // d itself could be the start of a new pair
        if (targetPair) {
          seqA = (d === targetPair[0]) ? d : null;
        } else {
          seqA = (d >= 0 && d <= 8) ? d : null;
        }
      }
      return;
    }

    // ── Phase: scan_x ────────────────────────────────────────────────────────
    // Waiting for x: any digit 0-8 (digit 9 invalidates → restart from scan_ab).
    // Once x is seen, fire trade immediately — barrier = x+1 (that's y).
    if (phase === "scan_x") {
      if (d === 9) {
        appendLogLine("x=9 is invalid; restarting pair scan.", "red");
        resetSequence(targetPair);
        return;
      }
      const x = d;
      const barrier = x + 1; // y = x+1
      appendLogLine(
        `Pattern [${seqA},${seqB},${x} ddf ${barrier}] → BUY DIGITDIFF barrier=${barrier}`,
        "#22c55e"
      );
      placeTrade(barrier);
      // Sequence resets after contract settles (in proposal_open_contract handler)
    }
  }

  // ── WebSocket / connection ──────────────────────────────────────────────────

  async function connect() {
    resetSequence(null);
    if (ws) ws.close();

    const accountId = ACCOUNTS[account];
    const inputToken = tokenInput?.value.trim();
    const storedToken = localStorage.getItem("access_token");
    const accessToken = inputToken || storedToken;

    if (!accessToken) {
      appendLogLine("Missing access_token. Paste it in the Access Token field.", "red");
      return;
    }

    if (inputToken) {
      localStorage.setItem("access_token", accessToken);
      appendLogLine("Using access_token from input field.", "yellow");
    } else {
      appendLogLine("Using access_token from localStorage.", "yellow");
    }

    try {
      const response = await fetch(
        `https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Deriv-App-ID": "33wZZKTFZrmsZgFaAH53Z"
          }
        }
      );

      const text = await response.text();
      if (!response.ok) {
        appendLogLine(`OTP request failed ${response.status}.`, "red");
        appendLogLine(text, "red");
        return;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        appendLogLine("OTP response is not JSON.", "red");
        appendLogLine(text, "red");
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
            if (payload.balance?.balance !== undefined) {
              updateBalance(Number(payload.balance.balance));
            }
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
            currentStake = Number(payload.proposal.ask_price || 0);
            if (payload.proposal.payout && currentStake > 0) {
              lastPayoutRatio = Number(payload.proposal.payout / currentStake);
              appendLogLine(
                `Payout ratio set to ${lastPayoutRatio.toFixed(2)}`,
                "#38bdf8"
              );
            }
            sendMessage({
              buy: payload.proposal.id,
              price: payload.proposal.ask_price
            });
            break;

          case "buy":
            activeContractId = payload.buy?.contract_id || null;
            settlementDigit = null;
            captureNextTick = true; // next tick = settlement tick for 1-tick DIGITDIFF
            if (activeContractId) {
              sendMessage({
                proposal_open_contract: 1,
                contract_id: activeContractId,
                subscribe: 1
              });
            }
            break;

          case "proposal_open_contract": {
            const contract = payload.proposal_open_contract;
            if (!contract) return;

            if (profitEl) profitEl.textContent = Number(contract.profit || 0).toFixed(2);

            if (
              typeof contract.balance_after === "number" &&
              !Number.isNaN(contract.balance_after) &&
              contract.balance_after > 0
            ) {
              updateBalance(contract.balance_after);
            }

            if (contract.is_sold) {
              const pnl = Number(contract.profit || 0);
              totalProfit += pnl;
              if (profitEl) profitEl.textContent = totalProfit.toFixed(2);

              // Get result digit: settlementDigit = first tick after buy (the true settlement tick).
              // Fall back to exit_tick from contract if settlementDigit wasn't captured.
              const exitPrice = contract.exit_tick || contract.exit_tick_display_value;
              const exitDigit = exitPrice !== undefined ? digitFromPrice(exitPrice) : null;
              const resultDigit = settlementDigit !== null ? settlementDigit : exitDigit;

              // Compute the next target pair from the result digit
              const nextTarget = resultDigit !== null
                ? nextPairFromResultDigit(resultDigit)
                : null;

              if (pnl >= 0) {
                recoveryLoss = 0;
                currentStake = 0;
                ladder = 0;
                appendLogLine(
                  `WIN +${pnl.toFixed(2)}` +
                  (resultDigit !== null ? ` (digit=${resultDigit})` : "") +
                  (nextTarget ? ` → next pair [${nextTarget[0]},${nextTarget[1]}]` : ""),
                  "lime"
                );
              } else {
                recoveryLoss += Math.abs(pnl);
                ladder += 1;
                const nextStake = stake();
                appendLogLine(
                  `LOSS ${pnl.toFixed(2)}; recoveryLoss=${recoveryLoss.toFixed(2)} nextStake=${nextStake.toFixed(2)}` +
                  (resultDigit !== null ? ` (digit=${resultDigit})` : "") +
                  (nextTarget ? ` → next pair [${nextTarget[0]},${nextTarget[1]}]` : ""),
                  "red"
                );
              }

              if (levelEl) levelEl.textContent = ladder;

              if (ws && ws.readyState === WebSocket.OPEN) {
                sendMessage({ balance: 1 });
              }

              // Reset sequence, feeding the next target pair
              resetSequence(nextTarget);
            }
            break;
          }

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

  // ── Button handlers ─────────────────────────────────────────────────────────

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
    fullReset();
    if (profitEl) profitEl.textContent = "0.00";
    if (levelEl) levelEl.textContent = "0";
    if (balanceEl) balanceEl.textContent = "-";
    appendLogLine("RESET DONE", "orange");
  };

  demoBtn.onclick = () => {
    account = "demo";
    demoBtn.classList.add("active");
    liveBtn.classList.remove("active");
    appendLogLine("DEMO MODE", "blue");
    const mi = $("modeIndicator");
    if (mi) {
      mi.textContent = "JESAN 💲 MODE - DEMO";
      mi.classList.add("demo");
      mi.classList.remove("live");
    }
  };

  liveBtn.onclick = () => {
    account = "live";
    liveBtn.classList.add("active");
    demoBtn.classList.remove("active");
    appendLogLine("LIVE MODE", "red");
    const mi = $("modeIndicator");
    if (mi) {
      mi.textContent = "JESAN 💲 MODE - LIVE";
      mi.classList.add("live");
      mi.classList.remove("demo");
    }
  };

  window.addEventListener("beforeunload", () => {
    if (ws) ws.close();
    stopTickFlush();
  });
});
