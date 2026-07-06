// Deriv DigitDiff bot — unified 2-pair ascending strategy (used for both normal trading and recovery)
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

  const MARKETS = [
    { symbol: "R_10", label: "Volatility 10 Index" },
    { symbol: "R_25", label: "Volatility 25 Index" },
    { symbol: "R_50", label: "Volatility 50 Index" },
    { symbol: "R_75", label: "Volatility 75 Index" },
    { symbol: "R_100", label: "Volatility 100 Index" },
    { symbol: "1HZ10V", label: "Volatility 10 (1s) Index" },
    { symbol: "1HZ25V", label: "Volatility 25 (1s) Index" },
    { symbol: "1HZ50V", label: "Volatility 50 (1s) Index" },
    { symbol: "1HZ75V", label: "Volatility 75 (1s) Index" },
    { symbol: "1HZ100V", label: "Volatility 100 (1s) Index" }
  ];

  const FALLBACK_DECIMALS = {
    R_10: 3,
    R_25: 3,
    R_50: 4,
    R_75: 4,
    R_100: 2,
    "1HZ10V": 2,
    "1HZ25V": 3,
    "1HZ50V": 2,
    "1HZ75V": 3,
    "1HZ100V": 2
  };

  const DEFAULT_PAYOUT_RATIO = 11.57;

  let symbol = "R_100";
  const symbolDecimals = {};

  function decimalsForSymbol(sym) {
    return symbolDecimals[sym] ?? FALLBACK_DECIMALS[sym] ?? 2;
  }

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

  // ── market selector ─────────────────────────────────────────────────────
  const marketSelect = $("marketSelect");
  marketSelect.innerHTML = "";
  MARKETS.forEach(m => {
    const opt = document.createElement("option");
    opt.value = m.symbol;
    opt.textContent = m.label;
    marketSelect.appendChild(opt);
  });
  marketSelect.value = symbol;
  marketSelect.addEventListener("change", () => {
    switchMarket(marketSelect.value);
  });
  // ─────────────────────────────────────────────────────────────────────────

  let ws = null;
  let running = false;
  let manualStop = false;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const HEARTBEAT_MS = 20000;
  const RECONNECT_BASE_MS = 2000;
  const RECONNECT_MAX_MS = 30000;
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

  let seqA = null;
  let seqB = null;
  let settlementDigit = null;
  let captureNextTick = false;

  let recoveryMode = false;
  let recoveryPair = null;
  let lastTradePair = null;

  // ── 2-pair ascending scan state ──────────────────────────────────────────
  // Pattern: [a, a+1] → [a+2, a+3] → trigger=(a+4) → barrier=(a+5)
  // pair2_head = pair1_tail + 1  (ascending, non-chained)
  // Invalid if barrier would wrap to 0 (i.e. trigger digit = 9)
  let chainScanMode = true;
  let lastSeenConsPair = null;
  let confirmedFirstChainPair = null;
  let confirmedChain = null;
  let prevChainDigit = null;
  let chainPairTailSkip = null;
  // ─────────────────────────────────────────────────────────────────────────

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
        row.textContent = `Tick ${Number(price).toFixed(decimalsForSymbol(symbol))} → ${digit === null ? "-" : digit}`;
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
    const str = value.toFixed(decimalsForSymbol(symbol));
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

  function resetSequence() {
    settlementDigit = null;
    captureNextTick = false;
    waitingProposal = false;
    proposalVariants = null;
    proposalAttempt = 0;
    activeContractId = null;
    chainScanMode = true;
    confirmedFirstChainPair = null;
    chainPairTailSkip = null;
    appendLogLine(
      "Scanning for 2-pair ascending pattern [a,a+1]→[a+2,a+3]→trigger→barrier...",
      "#a78bfa"
    );
  }

  function fullReset() {
    chainScanMode = true;
    lastSeenConsPair = null;
    confirmedFirstChainPair = null;
    confirmedChain = null;
    prevChainDigit = null;
    chainPairTailSkip = null;
    resetSequence();
    totalProfit = 0;
    recoveryLoss = 0;
    lastPayoutRatio = null;
    currentStake = 0;
    lastBalance = null;
    ladder = 0;
    tickBuffer.length = 0;
    recoveryMode = false;
    recoveryPair = null;
    lastTradePair = null;
  }

  function fetchActiveSymbols() {
    if (!sendMessage({ active_symbols: "brief" })) return;
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ping: 1 }));
      }
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function cancelReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (manualStop || !running) return;
    cancelReconnect();
    reconnectAttempts += 1;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(1.5, reconnectAttempts - 1),
      RECONNECT_MAX_MS
    );
    appendLogLine(
      `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`,
      "orange"
    );
    reconnectTimer = setTimeout(() => {
      if (manualStop || !running) return;
      connect();
    }, delay);
  }

  function switchMarket(newSymbol) {
    if (newSymbol === symbol) return;
    const marketMeta = MARKETS.find(m => m.symbol === newSymbol);
    const wasRunning = running;

    lastSeenConsPair = null;
    confirmedFirstChainPair = null;
    confirmedChain = null;
    prevChainDigit = null;
    chainPairTailSkip = null;
    chainScanMode = true;
    settlementDigit = null;
    captureNextTick = false;
    waitingProposal = false;
    proposalVariants = null;
    proposalAttempt = 0;
    tickBuffer.length = 0;
    lastPayoutRatio = null;

    if (ws && ws.readyState === WebSocket.OPEN) {
      sendMessage({ forget_all: "ticks" });
      symbol = newSymbol;
      sendMessage({ ticks: symbol, subscribe: 1 });
    } else {
      symbol = newSymbol;
    }

    appendLogLine(
      `Market switched to ${marketMeta ? marketMeta.label : symbol} (${symbol}), ` +
      `using ${decimalsForSymbol(symbol)} decimal place(s) for last-digit extraction.`,
      "#f59e0b"
    );

    if (wasRunning) {
      appendLogLine(
        "Scanning for 2-pair ascending pattern [a,a+1]→[a+2,a+3]→trigger→barrier...",
        "#a78bfa"
      );
    }
  }

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
      Object.assign({}, base, { underlying_symbol: symbol }),
      Object.assign({}, base, { underlying: symbol }),
      Object.assign({}, base, { symbol: symbol }),
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

    lastTradePair = (seqA !== null && seqB !== null) ? [seqA, seqB] : null;

    proposalVariants = buildProposalVariants(barrier);
    proposalAttempt = 0;
    waitingProposal = true;
    appendLogLine(
      `TRADE → DIGITDIFF barrier=${barrier} stake=${proposalVariants[0].amount}`,
      "lime"
    );
    sendNextProposalVariant();
  }

  function onTick(price) {
    if (!running || paused) return;
    const d = digitFromPrice(price);
    if (d === null) return;

    if (priceEl) priceEl.textContent = Number(price).toFixed(decimalsForSymbol(symbol));
    if (lastDigitEl) lastDigitEl.textContent = d;
    tickBuffer.push({ price, digit: d });
    startTickFlush();

    if (captureNextTick) {
      settlementDigit = d;
      captureNextTick = false;
    }

    if (waitingProposal || activeContractId) return;

    // ── 2-PAIR ASCENDING SCAN ────────────────────────────────────────────────
    // Pattern: [a, a+1] → [a+2, a+3] → trigger=(a+4) → DIGITDIFF barrier=(a+5)
    // pair2_head = pair1_tail + 1 (non-chained, ascending gap)
    // INVALID if barrier would be 0 (trigger digit = 9)
    //
    // Examples:
    //   0,1 ... 2,3 ... 4  → barrier=5  ✓
    //   2,3 ... 4,5 ... 6  → barrier=7  ✓
    //   5,6 ... 7,8 ... 9  → barrier=0, INVALID ✗
    if (chainScanMode) {
      // Phase 2: both pairs confirmed — waiting for trigger digit
      if (confirmedFirstChainPair !== null) {
        const expectedTrigger = (confirmedFirstChainPair[1] + 1) % 10;
        if (d === expectedTrigger) {
          const barrier = (d + 1) % 10;
          if (barrier === 0) {
            appendLogLine(
              `[${lastSeenConsPair[0]},${lastSeenConsPair[1]}]→[${confirmedFirstChainPair[0]},${confirmedFirstChainPair[1]}]→trigger=${d} INVALID (barrier=0) — resetting...`,
              "orange"
            );
            lastSeenConsPair = null;
            confirmedFirstChainPair = null;
            prevChainDigit = null;
            chainPairTailSkip = null;
            appendLogLine(
              "Scanning for 2-pair ascending pattern [a,a+1]→[a+2,a+3]→trigger→barrier...",
              "#a78bfa"
            );
            return;
          }
          chainScanMode = false;
          confirmedChain = null;
          seqA = d;
          seqB = barrier;
          lastTradePair = [seqA, seqB];
          appendLogLine(
            `Chain [${lastSeenConsPair[0]},${lastSeenConsPair[1]}]→[${confirmedFirstChainPair[0]},${confirmedFirstChainPair[1]}]→trigger=${d} → DIGITDIFF barrier=${barrier}`,
            "#f59e0b"
          );
          placeTrade(barrier);
          return;
        }
        // Not the trigger yet — keep waiting
        return;
      }

      // Phase 0 & 1: scanning for pair1, then pair2
      if (prevChainDigit !== null) {
        const a = prevChainDigit;
        const b = d;

        if (b === (a + 1) % 10) {
          if (lastSeenConsPair !== null && a === (lastSeenConsPair[1] + 1) % 10) {
            // Valid pair2: head = pair1_tail + 1
            confirmedFirstChainPair = [a, b];
            prevChainDigit = null;
            chainPairTailSkip = b;
            appendLogLine(
              `Pair2 [${a},${b}] confirmed — awaiting trigger ${(b + 1) % 10}...`,
              "#38bdf8"
            );
            return;
          } else {
            // New pair1
            lastSeenConsPair = [a, b];
            confirmedFirstChainPair = null;
            prevChainDigit = null;
            chainPairTailSkip = b;
            appendLogLine(`Pair [${a},${b}] found, awaiting pair2...`, "#38bdf8");
            return;
          }
        }
      }

      if (chainPairTailSkip !== null) {
        if (d === chainPairTailSkip) {
          chainPairTailSkip = null;
          return;
        }
        chainPairTailSkip = null;
      }
      prevChainDigit = d;
      return;
    }
    // ── END 2-PAIR ASCENDING SCAN ─────────────────────────────────────────────

    if (confirmedChain) {
      if (d === confirmedChain.trigger) {
        const { trigger, barrier } = confirmedChain;
        seqA = trigger;
        seqB = barrier;
        lastTradePair = [seqA, seqB];
        confirmedChain = null;
        appendLogLine(
          `Digit ${d} found → DIGITDIFF barrier=${barrier}`,
          "#22c55e"
        );
        placeTrade(barrier);
      }
      return;
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
        reconnectAttempts = 0;
        cancelReconnect();
        startHeartbeat();
        fetchActiveSymbols();
        sendMessage({ ticks: symbol, subscribe: 1 });
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

          case "active_symbols": {
            const list = payload.active_symbols;
            if (Array.isArray(list)) {
              const wantedSymbols = new Set(MARKETS.map(m => m.symbol));
              list.forEach(entry => {
                if (!entry || !wantedSymbols.has(entry.symbol)) return;
                const pip = Number(entry.pip);
                if (!pip || Number.isNaN(pip)) return;
                const decimals = Math.round(-Math.log10(pip));
                if (decimals >= 0 && decimals <= 6) {
                  symbolDecimals[entry.symbol] = decimals;
                }
              });
              appendLogLine(
                `Live pip precision loaded for ${Object.keys(symbolDecimals).length} market(s). ` +
                `Current market ${symbol} → ${decimalsForSymbol(symbol)} decimal place(s).`,
                "#38bdf8"
              );
            }
            break;
          }

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

            if (
              typeof contract.balance_after === "number" &&
              !Number.isNaN(contract.balance_after) &&
              contract.balance_after > 0
            ) {
              updateBalance(contract.balance_after);
            }

            if (contract.is_sold) {
              activeContractId = null;

              const pnl = Number(contract.profit || 0);
              totalProfit += pnl;
              if (profitEl) profitEl.textContent = totalProfit.toFixed(2);

              const exitPrice = contract.exit_tick || contract.exit_tick_display_value;
              const exitDigit = exitPrice !== undefined ? digitFromPrice(exitPrice) : null;
              const resultDigit = settlementDigit !== null ? settlementDigit : exitDigit;

              if (pnl >= 0) {
                recoveryMode = false;
                recoveryPair = null;
                lastTradePair = null;
                lastSeenConsPair = null;
                confirmedFirstChainPair = null;
                confirmedChain = null;
                prevChainDigit = null;
                chainPairTailSkip = null;
                recoveryLoss = 0;
                currentStake = 0;
                ladder = 0;
                appendLogLine(
                  `WIN +${pnl.toFixed(2)}` +
                  (resultDigit !== null ? ` (digit=${resultDigit})` : ""),
                  "lime"
                );
                resetSequence();
              } else {
                recoveryMode = true;
                lastSeenConsPair = null;
                confirmedFirstChainPair = null;
                confirmedChain = null;
                prevChainDigit = null;
                chainPairTailSkip = null;
                recoveryPair = null;
                recoveryLoss += Math.abs(pnl);
                ladder += 1;
                const nextStake = stake();
                appendLogLine(
                  `LOSS ${pnl.toFixed(2)}; recoveryLoss=${recoveryLoss.toFixed(2)} nextStake=${nextStake.toFixed(2)} → scanning for 2-pair ascending pattern`,
                  "red"
                );
                resetSequence();
              }

              if (levelEl) levelEl.textContent = ladder;

              if (ws && ws.readyState === WebSocket.OPEN) {
                sendMessage({ balance: 1 });
              }
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
        stopHeartbeat();
        if (!manualStop && running) {
          scheduleReconnect();
        }
      };

      ws.onerror = ev => {
        appendLogLine("WS error.", "red");
        console.error("WebSocket error:", ev);
      };
    } catch (err) {
      appendLogLine(`OTP fetch failed: ${String(err)}`, "red");
      console.error(err);
      if (!manualStop && running) {
        scheduleReconnect();
      }
    }
  }

  startBtn.onclick = () => {
    running = true;
    manualStop = false;
    reconnectAttempts = 0;
    cancelReconnect();
    connect();
    appendLogLine("BOT STARTED", "lime");
  };

  pauseBtn.onclick = () => {
    paused = !paused;
    appendLogLine(paused ? "PAUSED" : "RUNNING", "yellow");
  };

  stopBtn.onclick = () => {
    running = false;
    manualStop = true;
    cancelReconnect();
    stopHeartbeat();
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
    manualStop = true;
    cancelReconnect();
    stopHeartbeat();
    if (ws) ws.close();
    stopTickFlush();
  });
});
