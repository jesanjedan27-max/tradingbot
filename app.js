// Deriv DigitDiff bot — adjusted chain-pair strategy
// Allowed digits: 3, 4, 5, 6
// Trigger: [n1,n1,n2,n2] → [n3,n3],n4 → DIGITDIFF n4
// Conditions: n1 !== n2, n3 !== n4, and all digits are allowed.

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

  let selectedBaseStake = Number(stakeInput.value || 0.35);

  stakeInput.addEventListener("change", () => {
    const nextBaseStake = Number(stakeInput.value || 0.35);

    if (!Number.isFinite(nextBaseStake) || nextBaseStake <= 0) return;
    if (nextBaseStake === selectedBaseStake) return;

    selectedBaseStake = nextBaseStake;
    recoveryLoss = 0;
    ladder = 0;

    if (levelEl) levelEl.textContent = "0";

    appendLogLine(
      `Base stake changed to ${nextBaseStake.toFixed(2)} — fresh ladder started.`,
      "#f59e0b"
    );
  });

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

  const ALLOWED_CHAIN_DIGITS = [3, 4, 5, 6];

  const DEFAULT_PAYOUT_RATIO = 1.09;
  const DIGITDIFF_DURATION_TICKS = 1;
  const MARTINGALE_LEVEL_2_MULTIPLIER = 17.49;
  const MARTINGALE_LEVEL_3_MULTIPLIER = 16.99;

  function roundStake(value) {
    return Number(value.toFixed(2));
  }

  let symbol = "R_100";
  const symbolDecimals = {};

  function decimalsForSymbol(sym) {
    return symbolDecimals[sym] ?? FALLBACK_DECIMALS[sym] ?? 2;
  }

  function isAllowedChainDigit(digit) {
    return ALLOWED_CHAIN_DIGITS.includes(digit);
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
  let tradeInFlight = false;
  let proposalVariants = null;
  let proposalAttempt = 0;
  let activeContractId = null;
  let settlementDigit = null;
  let captureNextTick = false;

  // phase: "scan" | "waiting" | "armed" | "recovery"
  let phase = "scan";
  let prevDigit = null;
  let firstPairDigit = null;
  let secondPairDigit = null;
  let triggerPairDigit = null;

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

      tickBuffer
        .splice(0, TICK_BATCH_LIMIT)
        .forEach(({ price, digit }) => {
          const row = document.createElement("div");
          row.style.color = "#7dd3fc";
          row.textContent =
            `Tick ${Number(price).toFixed(decimalsForSymbol(symbol))} → ${digit}`;
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

    if (balanceEl) {
      balanceEl.textContent = value.toFixed(2);
    }
  }

  function getBaseStake() {
    const enteredStake = Number(stakeInput.value || 0.35);

    if (!Number.isFinite(enteredStake) || enteredStake <= 0) {
      return 0.35;
    }

    return Number(enteredStake.toFixed(2));
  }

  function stake() {
    const baseStake = getBaseStake();

    // Ladder 0 = base stake
    // Ladder 1 = Martingale level 2
    // Ladder 2+ = Martingale level 3
    // Level 3 is capped so extended losses do not create unlimited stakes.

    if (ladder <= 0) {
      return baseStake;
    }

    const levelTwoStake =
      baseStake * MARTINGALE_LEVEL_2_MULTIPLIER;

    if (ladder === 1) {
      return roundStake(levelTwoStake);
    }

    const levelThreeStake =
      levelTwoStake * MARTINGALE_LEVEL_3_MULTIPLIER;

    return roundStake(levelThreeStake);
  }

  function clearContractState() {
    settlementDigit = null;
    captureNextTick = false;
    tradeInFlight = false;
    waitingProposal = false;
    proposalVariants = null;
    proposalAttempt = 0;
    activeContractId = null;
    triggerPairDigit = null;
  }

  function resetToScan() {
    clearContractState();
    phase = "scan";
    prevDigit = null;
    firstPairDigit = null;
    secondPairDigit = null;
    triggerPairDigit = null;
    appendLogLine("Scanning...", "#a78bfa");
  }

  function fullReset() {
    clearContractState();
    phase = "scan";
    prevDigit = null;
    firstPairDigit = null;
    secondPairDigit = null;
    triggerPairDigit = null;
    totalProfit = 0;
    recoveryLoss = 0;
    lastPayoutRatio = null;
    currentStake = 0;
    lastBalance = null;
    ladder = 0;
    tickBuffer.length = 0;
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
      if (!manualStop && running) {
        connect();
      }
    }, delay);
  }

  function switchMarket(newSymbol) {
    if (newSymbol === symbol) return;

    const marketMeta = MARKETS.find(m => m.symbol === newSymbol);
    const wasRunning = running;

    phase = "scan";
    prevDigit = null;
    firstPairDigit = null;
    secondPairDigit = null;
    triggerPairDigit = null;
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

      sendMessage({
        ticks: symbol,
        subscribe: 1
      });
    } else {
      symbol = newSymbol;
    }

    appendLogLine(
      `Market → ${marketMeta ? marketMeta.label : symbol}`,
      "#f59e0b"
    );

    if (wasRunning) {
      appendLogLine("Scanning...", "#a78bfa");
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
      duration: DIGITDIFF_DURATION_TICKS,
      duration_unit: "t",
      barrier
    };

    return [
      Object.assign({}, base, {
        underlying_symbol: symbol
      }),
      Object.assign({}, base, {
        underlying: symbol
      }),
      Object.assign({}, base, {
        symbol
      }),
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
    if (!waitingProposal || !proposalVariants) {
      return false;
    }

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
      appendLogLine(
        "Proposal validation failed; retrying next variant.",
        "orange"
      );

      sendNextProposalVariant();
      return true;
    }

    return false;
  }

  function sendNextProposalVariant() {
    if (!proposalVariants) return;

    if (proposalAttempt >= proposalVariants.length) {
      appendLogLine("All proposal variants failed.", "red");

      tradeInFlight = false;
      waitingProposal = false;
      proposalVariants = null;
      proposalAttempt = 0;

      return;
    }

    sendMessage(proposalVariants[proposalAttempt++]);
  }

  function placeTrade(barrier) {
    if (waitingProposal || tradeInFlight || activeContractId) {
      appendLogLine("Trade already in progress.", "orange");
      return;
    }

    tradeInFlight = true;
    proposalVariants = buildProposalVariants(String(barrier));
    proposalAttempt = 0;
    waitingProposal = true;

    appendLogLine(
      `TRADE DIGITDIFF barrier=${barrier} stake=${proposalVariants[0].amount}`,
      "lime"
    );

    sendNextProposalVariant();
  }

  function onTick(price) {
    if (!running || paused) return;

    const d = digitFromPrice(price);
    if (d === null) return;

    if (priceEl) {
      priceEl.textContent =
        Number(price).toFixed(decimalsForSymbol(symbol));
    }

    if (lastDigitEl) {
      lastDigitEl.textContent = d;
    }

    tickBuffer.push({
      price,
      digit: d
    });

    if (captureNextTick) {
      settlementDigit = d;
      captureNextTick = false;
    }

    // Ignore all tick-based triggers while any trade stage is active.
    // This prevents duplicate proposals during rapid ticks.
    if (waitingProposal || tradeInFlight || activeContractId) {
      prevDigit = null;
      return;
    }

    if (phase === "scan") {
      if (
        prevDigit !== null &&
        prevDigit === d &&
        isAllowedChainDigit(d)
      ) {
        firstPairDigit = d;
        secondPairDigit = null;
        phase = "waiting";
        prevDigit = null;

        appendLogLine(
          `Starter [${d},${d}] → waiting for an adjacent different pair`,
          "#64748b"
        );

        return;
      }

      prevDigit = isAllowedChainDigit(d) ? d : null;

    } else if (phase === "waiting") {
      if (secondPairDigit === null) {
        if (
          !isAllowedChainDigit(d) ||
          d === firstPairDigit
        ) {
          appendLogLine(
            `[${firstPairDigit},${firstPairDigit},${d}] invalidates chain — Scanning...`,
            "#64748b"
          );

          phase = "scan";
          firstPairDigit = null;
          secondPairDigit = null;
          prevDigit = isAllowedChainDigit(d) ? d : null;
          return;
        }

        secondPairDigit = d;
        return;
      }

      if (d === secondPairDigit) {
        phase = "armed";
        prevDigit = null;

        appendLogLine(
          `Starter [${firstPairDigit},${firstPairDigit},${secondPairDigit},${secondPairDigit}] Armed | watching for an allowed pair followed by a different allowed digit`,
          "#f59e0b"
        );

        return;
      }

      appendLogLine(
        `[${secondPairDigit},${d}] invalidates chain — Scanning...`,
        "#64748b"
      );

      phase = "scan";
      firstPairDigit = null;
      secondPairDigit = null;
      prevDigit = isAllowedChainDigit(d) ? d : null;

    } else if (
      phase === "armed" ||
      phase === "recovery"
    ) {
      if (triggerPairDigit === null) {
        if (
          prevDigit !== null &&
          prevDigit === d &&
          isAllowedChainDigit(d)
        ) {
          triggerPairDigit = d;
          prevDigit = null;
          return;
        }

        prevDigit = isAllowedChainDigit(d) ? d : null;
        return;
      }

      if (
        isAllowedChainDigit(d) &&
        d !== triggerPairDigit
      ) {
        appendLogLine(
          phase === "recovery"
            ? `Recovery pair [${triggerPairDigit},${triggerPairDigit}] → ${d} → DIGITDIFF ${d} (martingale)`
            : `Pair [${triggerPairDigit},${triggerPairDigit}] → ${d} → DIGITDIFF ${d}`,
          "lime"
        );

        triggerPairDigit = null;
        prevDigit = null;
        placeTrade(d);
        return;
      }

      appendLogLine(
        `[${triggerPairDigit},${d}] invalidates trade trigger — continuing to scan`,
        "#64748b"
      );

      triggerPairDigit = null;

      // Consume the invalidating tick so an overlapping triple such as
      // 5,5,5 cannot be reused as a new pair.
      prevDigit = null;
    }
  }

  async function connect() {
    if (
      (waitingProposal || tradeInFlight || activeContractId) &&
      phase !== "scan"
    ) {
      recoveryLoss += currentStake > 0 ? currentStake : 0;
      ladder += 1;
    }

    resetToScan();

    if (ws) {
      ws.close();
    }

    const accountId = ACCOUNTS[account];
    const inputToken = tokenInput?.value.trim();
    const storedToken = localStorage.getItem("access_token");
    const accessToken = inputToken || storedToken;

    if (!accessToken) {
      appendLogLine(
        "Missing access_token. Paste it in the Access Token field.",
        "red"
      );
      return;
    }

    if (inputToken) {
      localStorage.setItem("access_token", accessToken);
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
        appendLogLine(
          `OTP request failed ${response.status}.`,
          "red"
        );

        appendLogLine(text, "red");

        if (!manualStop && running) {
          scheduleReconnect();
        }

        return;
      }

      let data;

      try {
        data = JSON.parse(text);
      } catch {
        appendLogLine("OTP response is not JSON.", "red");
        appendLogLine(text, "red");

        if (!manualStop && running) {
          scheduleReconnect();
        }

        return;
      }

      if (!data?.data?.url) {
        appendLogLine("OTP response missing data.url.", "red");
        appendLogLine(JSON.stringify(data), "red");

        if (!manualStop && running) {
          scheduleReconnect();
        }

        return;
      }

      ws = new WebSocket(data.data.url);

      ws.onopen = () => {
        appendLogLine("WS connected.", "lime");

        reconnectAttempts = 0;
        cancelReconnect();
        startHeartbeat();
        startTickFlush();

        sendMessage({
          active_symbols: "brief"
        });

        sendMessage({
          ticks: symbol,
          subscribe: 1
        });

        sendMessage({
          balance: 1
        });
      };

      ws.onmessage = e => {
        let payload;

        try {
          payload = JSON.parse(e.data);
        } catch {
          return;
        }

        if (payload.error) {
          const message =
            payload.error.message ||
            JSON.stringify(payload.error);

          appendLogLine(`Error: ${message}`, "red");

          if (!handleValidationError(message)) {
            tradeInFlight = false;
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
              const wanted = new Set(
                MARKETS.map(m => m.symbol)
              );

              list.forEach(entry => {
                if (!entry || !wanted.has(entry.symbol)) {
                  return;
                }

                const pip = Number(entry.pip);

                if (!pip || Number.isNaN(pip)) {
                  return;
                }

                const dec = Math.round(-Math.log10(pip));

                if (dec >= 0 && dec <= 6) {
                  symbolDecimals[entry.symbol] = dec;
                }
              });
            }

            break;
          }

          case "proposal":
            if (!waitingProposal) {
              break;
            }

            waitingProposal = false;
            proposalVariants = null;
            proposalAttempt = 0;

            if (!payload.proposal) {
              appendLogLine(
                "Proposal response missing payload.",
                "red"
              );

              tradeInFlight = false;
              break;
            }

            currentStake = Number(
              payload.proposal.ask_price || 0
            );

            if (
              payload.proposal.payout &&
              currentStake > 0
            ) {
              lastPayoutRatio =
                Number(payload.proposal.payout) / currentStake;
            }

            sendMessage({
              buy: payload.proposal.id,
              price: payload.proposal.ask_price
            });

            break;

          case "buy":
            activeContractId =
              payload.buy?.contract_id || null;

            if (!activeContractId) {
              tradeInFlight = false;
              break;
            }

            settlementDigit = null;
            captureNextTick = true;

            sendMessage({
              proposal_open_contract: 1,
              contract_id: activeContractId,
              subscribe: 1
            });

            break;

          case "proposal_open_contract": {
            const contract =
              payload.proposal_open_contract;

            if (!contract) {
              return;
            }

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

              if (profitEl) {
                profitEl.textContent =
                  totalProfit.toFixed(2);
              }

              const exitPrice =
                contract.exit_tick ||
                contract.exit_tick_display_value;

              const exitDigit =
                exitPrice !== undefined
                  ? digitFromPrice(exitPrice)
                  : null;

              const resultDigit =
                settlementDigit !== null
                  ? settlementDigit
                  : exitDigit;

              if (pnl >= 0) {
                recoveryLoss = 0;
                currentStake = 0;
                ladder = 0;

                appendLogLine(
                  `WIN +${pnl.toFixed(2)}` +
                    (resultDigit !== null
                      ? ` (digit=${resultDigit})`
                      : ""),
                  "lime"
                );

                resetToScan();

              } else {
                recoveryLoss += Math.abs(pnl);
                ladder += 1;

                const nextStake = stake();

                // Continue recovery after every loss while preserving
                // the same chain. Level 3 is the maximum ladder level.
                if (
                  phase === "armed" ||
                  phase === "recovery"
                ) {
                  phase = "recovery";
                  prevDigit = null;
                  clearContractState();

                  appendLogLine(
                    `LOSS ${pnl.toFixed(2)} | ladder=${ladder}` +
                      (resultDigit !== null
                        ? ` (digit=${resultDigit})`
                        : "") +
                      ` → recovery level=${Math.min(
                        ladder + 1,
                        3
                      )}: watch an allowed pair followed by a ` +
                      `different allowed digit ` +
                      `stake=${nextStake.toFixed(2)}`,
                    "red"
                  );

                } else {
                  appendLogLine(
                    `LOSS ${pnl.toFixed(2)} | ladder=${ladder}` +
                      (resultDigit !== null
                        ? ` (digit=${resultDigit})`
                        : "") +
                      ` | next stake=${nextStake.toFixed(2)}`,
                    "red"
                  );

                  resetToScan();
                }
              }

              if (levelEl) {
                levelEl.textContent = ladder;
              }

              if (
                ws &&
                ws.readyState === WebSocket.OPEN
              ) {
                sendMessage({
                  balance: 1
                });
              }
            }

            break;
          }

          default:
            break;
        }
      };

      ws.onclose = () => {
        stopTickFlush();
        stopHeartbeat();

        if (!manualStop && running) {
          scheduleReconnect();
        }
      };

      ws.onerror = ev => {
        console.error("WebSocket error:", ev);
      };

    } catch (err) {
      appendLogLine(
        `OTP fetch failed: ${String(err)}`,
        "red"
      );

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
    startTickFlush();

    appendLogLine("BOT STARTED", "lime");
  };

  pauseBtn.onclick = () => {
    paused = !paused;
    appendLogLine(
      paused ? "PAUSED" : "RUNNING",
      "yellow"
    );
  };

  stopBtn.onclick = () => {
    running = false;
    manualStop = true;

    cancelReconnect();
    stopHeartbeat();

    if (ws) {
      ws.close();
    }

    stopTickFlush();
    appendLogLine("STOPPED", "red");
  };

  resetBtn.onclick = () => {
    fullReset();

    if (profitEl) {
      profitEl.textContent = "0.00";
    }

    if (levelEl) {
      levelEl.textContent = "0";
    }

    if (balanceEl) {
      balanceEl.textContent = "-";
    }

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

    if (ws) {
      ws.close();
    }

    stopTickFlush();
  });
});
