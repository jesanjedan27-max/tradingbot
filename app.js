// Deriv DigitDiff bot — consecutive-pair strategy with recovery chaining
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
  const SWITCH_MULTIPLIERS = [1, 4.05 / 0.35, 52.63 / 0.35];

  const savedToken = localStorage.getItem("access_token");
  if (tokenInput && savedToken) {
    tokenInput.value = savedToken;
  }

  const ACCOUNTS = {
    demo: "DOT92927394",
    live: "ROT91650098"
  };

  let account = "demo";
  if (demoBtn) demoBtn.classList.add("active");

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
  let probing = false;
  let pendingBarrier = null;

  let stakeMode = "switch";
  let stakeLevelIdx = 0;

  // Recovery behavior
  let targetPair = null;     // null = open scan, otherwise restrict to this pair
  let recoveryMode = false;  // true after loss, false after win
  let recoveryPair = null;   // the pair to retry after a loss
  let lastTradePair = null;  // the pair that triggered the last trade

  let phase = "scan_ab";
  let seqA = null;
  let seqB = null;
  let settlementDigit = null;
  let captureNextTick = false;

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

  function parsedStakeLevels() {
    const base = Number(stakeInput ? stakeInput.value : 0) || 0.35;
    return SWITCH_MULTIPLIERS.map(m => Number((base * m).toFixed(2)));
  }

  function currentSwitchStake() {
    const levels = parsedStakeLevels();
    return levels[Math.min(stakeLevelIdx, levels.length - 1)];
  }

  function baseStakeAmount() {
    if (stakeMode === "switch") return currentSwitchStake();
    return Number(stakeInput.value || 0.35);
  }

  function recoveryStake(liveRatio) {
    if (stakeMode === "switch") {
      return baseStakeAmount();
    }
    const base = Number(stakeInput.value || 0.35);
    if (recoveryLoss > 0 && liveRatio > 1.01) {
      const needed = recoveryLoss / (liveRatio - 1);
      return Number(Math.max(base, needed).toFixed(2));
    }
    return Number(base.toFixed(2));
  }

  function createSwitchUI() {
    if (!stakeInput) return;
    const container = stakeInput.parentElement;
    if (!container) return;

    const modeBtn = document.createElement("button");
    modeBtn.id = "stakeModeBtn";
    modeBtn.style.cssText =
      "display:block;width:100%;margin-bottom:8px;padding:6px 10px;" +
      "border-radius:6px;border:none;cursor:pointer;font-weight:bold;" +
      "background:#7c3aed;color:#fff;font-size:13px;";
    modeBtn.textContent = "⚡ MODE: STAKE SWITCH";

    const levelsRow = document.createElement("div");
    levelsRow.id = "stakeLevelsRow";
    levelsRow.style.cssText = "margin-bottom:8px;";

    const levelsLbl = document.createElement("div");
    levelsLbl.style.cssText = "color:#94a3b8;font-size:11px;margin-bottom:4px;";
    levelsLbl.textContent = "Auto stake ladder (base × multipliers):";

    const levelsDisplay = document.createElement("div");
    levelsDisplay.id = "levelsDisplay";
    levelsDisplay.style.cssText =
      "padding:5px 8px;border-radius:6px;border:1px solid #374151;" +
      "background:#111827;color:#38bdf8;font-size:12px;font-weight:bold;" +
      "letter-spacing:0.5px;";

    function refreshLevelsDisplay() {
      const levels = parsedStakeLevels();
      levelsDisplay.textContent = levels
        .map((v, i) => `Lvl ${i + 1}: $${v}`)
        .join("  →  ");
    }

    stakeInput.addEventListener("input", () => {
      if (stakeMode === "switch") refreshLevelsDisplay();
    });

    function refreshModeUI() {
      if (stakeMode === "switch") {
        modeBtn.textContent = "⚡ MODE: STAKE SWITCH";
        modeBtn.style.background = "#7c3aed";
        levelsRow.style.display = "";
        if (container.style) container.style.display = "";
        refreshLevelsDisplay();
      } else {
        modeBtn.textContent = "📈 MODE: MARTINGALE";
        modeBtn.style.background = "#059669";
        levelsRow.style.display = "none";
        if (container.style) container.style.display = "";
      }
    }

    modeBtn.onclick = () => {
      stakeMode = stakeMode === "switch" ? "martingale" : "switch";
      stakeLevelIdx = 0;
      recoveryLoss = 0;
      refreshModeUI();
      appendLogLine(
        `Stake mode → ${stakeMode === "switch" ? "STAKE SWITCH" : "MARTINGALE"}`,
        "#a78bfa"
      );
    };

    container.insertAdjacentElement("beforebegin", levelsRow);
    container.insertAdjacentElement("beforebegin", modeBtn);
    refreshModeUI();
  }

  function resetSequence() {
    phase = "scan_ab";
    seqA = null;
    seqB = null;
    settlementDigit = null;
    captureNextTick = false;
    waitingProposal = false;
    proposalVariants = null;
    proposalAttempt = 0;
    activeContractId = null;
    probing = false;
    pendingBarrier = null;

    // Open scan by default
    if (recoveryMode && recoveryPair) {
      targetPair = recoveryPair;
    } else {
      targetPair = null;
    }

    if (targetPair) {
      appendLogLine(
        `Next scan: looking for pair [${targetPair[0]},${targetPair[1]}]`,
        "#a78bfa"
      );
    } else {
      appendLogLine("Next scan: open (any consecutive pair)", "#a78bfa");
    }
  }

  function fullReset() {
    resetSequence();
    totalProfit = 0;
    recoveryMode = false;
    recoveryPair = null;
    lastTradePair = null;
    recoveryLoss = 0;
    lastPayoutRatio = null;
    currentStake = 0;
    lastBalance = null;
    ladder = 0;
    stakeLevelIdx = 0;
    tickBuffer.length = 0;
  }

  function buildProposalVariants(barrier, amount) {
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

    pendingBarrier = barrier;
    probing = true;
    proposalVariants = buildProposalVariants(barrier, baseStakeAmount());
    proposalAttempt = 0;
    waitingProposal = true;
    appendLogLine(`Probing live payout ratio → DIGITDIFF barrier=${barrier}`, "#38bdf8");
    sendNextProposalVariant();
  }

  function onTick(price) {
    if (!running || paused) return;
    const d = digitFromPrice(price);
    if (d === null) return;

    if (priceEl) priceEl.textContent = Number(price).toFixed(2);
    if (lastDigitEl) lastDigitEl.textContent = d;
    tickBuffer.push({ price, digit: d });
    startTickFlush();

    if (captureNextTick) {
      settlementDigit = d;
      captureNextTick = false;
    }

    if (waitingProposal || activeContractId) return;

    if (phase === "scan_ab") {
      if (seqA === null) {
        if (targetPair) {
          if (d === targetPair[0]) {
            seqA = d;
          }
        } else {
          if (d >= 0 && d <= 8) {
            seqA = d;
          }
        }
        return;
      }

      if (d === seqA + 1) {
        if (targetPair && (seqA !== targetPair[0] || d !== targetPair[1])) {
          seqA = d >= 0 && d <= 8 ? d : null;
          return;
        }
        seqB = d;
        phase = "scan_x";
        appendLogLine(`Pair [${seqA},${seqB}] found → waiting for x`, "#38bdf8");
      } else {
        if (targetPair) {
          seqA = d === targetPair[0] ? d : null;
        } else {
          seqA = d >= 0 && d <= 8 ? d : null;
        }
      }
      return;
    }

    if (phase === "scan_x") {
      if (d === 9) {
        appendLogLine("x=9 is invalid; restarting pair scan.", "red");
        resetSequence();
        return;
      }

      const x = d;
      const barrier = x + 1;

      lastTradePair = [seqA, seqB];

      appendLogLine(
        `Pattern [${seqA},${seqB},${x} ddf ${barrier}] → BUY DIGITDIFF barrier=${barrier}`,
        "#22c55e"
      );
      placeTrade(barrier);
    }
  }

  async function connect() {
    resetSequence();

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
            {
              const probeAskPrice = Number(payload.proposal.ask_price || 0);
              const probePayout = Number(payload.proposal.payout || 0);

              if (probePayout > 0 && probeAskPrice > 0) {
                lastPayoutRatio = probePayout / probeAskPrice;
                appendLogLine(
                  `Live payout ratio: ${lastPayoutRatio.toFixed(4)} ` +
                  `(payout=${probePayout} / stake=${probeAskPrice})`,
                  "#38bdf8"
                );
              }

              if (probing) {
                probing = false;

                if (stakeMode === "switch") {
                  const levels = parsedStakeLevels();
                  const levelLabel = `Lvl ${stakeLevelIdx + 1}/${levels.length} ($${currentSwitchStake()})`;
                  currentStake = probeAskPrice;
                  appendLogLine(
                    `TRADE → DIGITDIFF barrier=${pendingBarrier} stake=${currentStake} [${levelLabel}]`,
                    "lime"
                  );
                  sendMessage({ buy: payload.proposal.id, price: payload.proposal.ask_price });
                } else {
                  const correctStake = recoveryStake(lastPayoutRatio);
                  if (Math.abs(correctStake - probeAskPrice) < 0.01) {
                    currentStake = probeAskPrice;
                    appendLogLine(
                      `TRADE → DIGITDIFF barrier=${pendingBarrier} stake=${currentStake}`,
                      "lime"
                    );
                    sendMessage({ buy: payload.proposal.id, price: payload.proposal.ask_price });
                  } else {
                    appendLogLine(
                      `Recovery stake=${correctStake} (probe was ${probeAskPrice}) → re-requesting proposal`,
                      "orange"
                    );
                    currentStake = correctStake;
                    proposalVariants = buildProposalVariants(pendingBarrier, correctStake);
                    proposalAttempt = 0;
                    waitingProposal = true;
                    sendNextProposalVariant();
                  }
                }
              } else {
                currentStake = probeAskPrice;
                appendLogLine(
                  `TRADE → DIGITDIFF barrier=${pendingBarrier} stake=${currentStake}`,
                  "lime"
                );
                sendMessage({ buy: payload.proposal.id, price: payload.proposal.ask_price });
              }
            }
            break;

          case "buy":
            activeContractId = payload.buy?.contract_id || null;
            settlementDigit = null;
            captureNextTick = true;
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

              if (pnl >= 0) {
                // Win: return to open scan
                recoveryMode = false;
                recoveryPair = null;
                lastTradePair = null;
                targetPair = null;

                ladder = 0;
                if (stakeMode === "switch") {
                  stakeLevelIdx = 0;
                }

                appendLogLine(
                  `WIN +${pnl.toFixed(2)} → returning to open scan`,
                  "lime"
                );
              } else {
                // Loss: keep retrying the same pair
                recoveryMode = true;
                recoveryPair = lastTradePair || targetPair || null;
                targetPair = recoveryPair;

                ladder += 1;
                if (stakeMode === "switch") {
                  const levels = parsedStakeLevels();
                  const prevIdx = stakeLevelIdx;
                  stakeLevelIdx = Math.min(stakeLevelIdx + 1, levels.length - 1);
                  const nextSwitchStake = currentSwitchStake();
                  const atMax = stakeLevelIdx === levels.length - 1;

                  appendLogLine(
                    `LOSS ${pnl.toFixed(2)} → step Lvl ${prevIdx + 1}→${stakeLevelIdx + 1} | next stake=$${nextSwitchStake}` +
                    (atMax ? " [MAX LEVEL]" : ""),
                    "red"
                  );
                } else {
                  recoveryLoss += Math.abs(pnl);
                  const nextStake = recoveryStake(lastPayoutRatio);
                  appendLogLine(
                    `LOSS ${pnl.toFixed(2)}; recoveryLoss=${recoveryLoss.toFixed(2)} nextStake≈${nextStake.toFixed(2)}`,
                    "red"
                  );
                }

                if (recoveryPair) {
                  appendLogLine(
                    `Recovery active → retrying same pair [${recoveryPair[0]},${recoveryPair[1]}]`,
                    "#f59e0b"
                  );
                } else {
                  appendLogLine("Recovery active → retrying open scan", "#f59e0b");
                }
              }

              if (levelEl) levelEl.textContent = ladder;

              if (ws && ws.readyState === WebSocket.OPEN) {
                sendMessage({ balance: 1 });
              }

              resetSequence();
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

  createSwitchUI();

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
