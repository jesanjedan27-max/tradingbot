// Deriv DigitDiff bot — ABA sequence strategy (e.g. 303, 909, 434…)
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

  // ── ABA Sequence Strategy ────────────────────────────────────────────────
  //
  // Valid sequences: all [A, B, A] where A ∈ {1..9} and B ∈ {0..A-1},
  // excluding 101, 212, 323, 434, 545, 656, 767, 878, and 989 (36 total)
  //
  // Phase 1 — SCANNING:
  //   Track ALL valid ABA sequences in parallel via seqCounts.
  //   On 1st occurrence of any ABA: capture the very next digit as X
  //   (stored in seqXMap[key]). Window resets so occurrences never overlap.
  //   On 2nd occurrence of the SAME ABA: fire DIGITDIFF X immediately.
  //
  // Phase 2 — RECOVERY (loss only):
  //   Stay armed on the same ABA + X, martingale applied.
  //   Watch for [A, B, A] again — fire DIGITDIFF X on detection.
  //
  // On WIN  → full reset, back to scanning.
  // On LOSS → stay armed, same X, martingale, watch for A,B,A again.
  //
  // ─────────────────────────────────────────────────────────────────────────

  let scanWindow = [];  // rolling 2-digit window (for phase-1 scan)
  let seqCounts = {};   // key: "A-B" → how many times ABA appeared while scanning
  let armedSeq = null;  // [A, B, A] — set when a sequence appears twice
  let armedStep = 0;       // 0 = waiting for A, 1 = got A waiting for B, 2 = got A,B waiting for A
  let armedX    = null;    // X digit for the currently armed/recovery sequence
  let seqXMap   = {};      // key: 'A-B' → X digit captured after 1st occurrence
  let captureXForKey = null; // non-null for exactly one tick: captures X into seqXMap[key]
  const EXCLUDED_ABA_KEYS = new Set([
    "1-0", "2-1", "3-2", "4-3", "5-4",
    "6-5", "7-6", "8-7", "9-8"
  ]);
  const DIGITDIFF_DURATION_TICKS = 1;

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

  function flushTicksNow() {
    if (!tickBuffer.length) return;
    const fragment = document.createDocumentFragment();
    tickBuffer.splice(0).forEach(({ price, digit }) => {
      const row = document.createElement("div");
      row.style.color = "#7dd3fc";
      // tick display suppressed
    });
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
        // tick display suppressed
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

    if (recoveryMode && armedSeq) {
      // Loss recovery — stay armed on the same sequence + X, reset step to 0
      armedStep = 0;
      appendLogLine(
        `Recovery → [${armedSeq[0]},${armedSeq[1]},${armedSeq[0]}] DIGITDIFF ${armedX} (martingale)`,
        "#f97316"
      );
    } else {
      // Full reset — back to scanning
      armedSeq = null;
      armedStep = 0;
      armedX = null;
      captureXForKey = null;
      seqXMap = {};
      scanWindow = [];
      seqCounts = {};
      appendLogLine("Scanning...", "#a78bfa");
    }
  }

  function fullReset() {
    armedSeq = null;
    armedStep = 0;
    armedX = null;
    captureXForKey = null;
    seqXMap = {};
    scanWindow = [];
    seqCounts = {};
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

    armedSeq = null;
    armedStep = 0;
    armedX = null;
    captureXForKey = null;
    seqXMap = {};
    scanWindow = [];
    seqCounts = {};
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

    appendLogLine(`Market → ${marketMeta ? marketMeta.label : symbol}`, "#f59e0b");
    if (wasRunning) appendLogLine("Scanning...", "#a78bfa");
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
    sendMessage(payload);
  }

  function placeTrade(barrier) {
    if (waitingProposal) {
      appendLogLine("Already waiting for a proposal.", "orange");
      return;
    }

    lastTradePair = armedSeq ? [...armedSeq] : null;

    proposalVariants = buildProposalVariants(barrier);
    proposalAttempt = 0;
    waitingProposal = true;
    appendLogLine(`TRADE barrier=${barrier} stake=${proposalVariants[0].amount}`, "lime");
    sendNextProposalVariant();
  }

  function onTick(price) {
    if (!running || paused) return;
    const d = digitFromPrice(price);
    if (d === null) return;

    if (priceEl) priceEl.textContent = Number(price).toFixed(decimalsForSymbol(symbol));
    if (lastDigitEl) lastDigitEl.textContent = d;

    if (captureNextTick) {
      settlementDigit = d;
      captureNextTick = false;
    }

    // Capture X — the digit immediately after a 1st ABA occurrence
    if (captureXForKey !== null) {
      seqXMap[captureXForKey] = d;
      appendLogLine(`[${captureXForKey.replace('-', ',')},...] 1st — X=${d} | watching for 2nd...`, "#64748b");
      captureXForKey = null;
      return; // X tick consumed
    }

    if (waitingProposal || activeContractId) return;

    // ── RECOVERY (armed after loss): watch for [A,B,A] → fire DIGITDIFF X ─
    if (armedSeq) {
      const [A, B] = armedSeq;

      if (armedStep === 0) {
        if (d === A) armedStep = 1;
      } else if (armedStep === 1) {
        if (d === B) {
          armedStep = 2;
        } else {
          armedStep = 0;
          if (d === A) armedStep = 1;
        }
      } else if (armedStep === 2) {
        if (d === A) {
          const barrier = String(armedX);
          appendLogLine(`[${A},${B},${A}] → DIGITDIFF ${barrier} (recovery)`, "lime");
          seqA = A; seqB = B;
          armedStep = 0;
          placeTrade(barrier);
        } else {
          armedStep = 0;
          if (d === A) armedStep = 1;
        }
      }
      return;
    }

    // ── SCANNING: track all ABA sequences; 1st→capture X, 2nd→fire ────────
    if (scanWindow.length === 2) {
      const [w0, w1] = scanWindow;
      if (
        d === w0 &&
        w1 < w0 &&
        w0 >= 1 &&
        !EXCLUDED_ABA_KEYS.has(`${w0}-${w1}`)
      ) {
        const key = `${w0}-${w1}`;
        seqCounts[key] = (seqCounts[key] || 0) + 1;
        const count = seqCounts[key];

        if (count === 1) {
          // 1st occurrence — capture next digit as X, keep scanning all sequences
          captureXForKey = key;
          scanWindow = []; // non-overlapping
          return; // this tick consumed as end of 1st occurrence
        } else if (count === 2) {
          // 2nd occurrence — fire DIGITDIFF X immediately
          const X = seqXMap[key];
          if (X === undefined) {
            // X not captured yet (edge case) — reset and rescan
            seqCounts = {}; scanWindow = [];
            return;
          }
          armedSeq = [w0, w1, w0];
          armedX = X;
          seqCounts = {};
          seqXMap = {};
          scanWindow = [];
          const barrier = String(X);
          appendLogLine(`[${w0},${w1},${w0}] 2nd → DIGITDIFF ${barrier}`, "lime");
          seqA = w0; seqB = w1;
          placeTrade(barrier);
          return;
        }
      }
    }
    scanWindow.push(d);
    if (scanWindow.length > 2) scanWindow.shift();
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

    if (inputToken) localStorage.setItem("access_token", accessToken);

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
        if (!manualStop && running) {
          scheduleReconnect();
        }
        return;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
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
        fetchActiveSymbols();
        sendMessage({ ticks: symbol, subscribe: 1 });
        sendMessage({ balance: 1 });
      };

      ws.onmessage = e => {
        let payload;
        try {
          payload = JSON.parse(e.data);
        } catch (err) {
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
              // pip precision loaded (silent)
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
                // WIN — full reset, back to scanning
                recoveryMode = false;
                recoveryPair = null;
                lastTradePair = null;
                recoveryLoss = 0;
                currentStake = 0;
                ladder = 0;
                appendLogLine(
                  `WIN +${pnl.toFixed(2)}` +
                  (resultDigit !== null ? ` (digit=${resultDigit})` : ""),
                  "lime"
                );
              } else {
                // LOSS — stay armed, martingale next trade
                recoveryMode = true;
                recoveryPair = null;
                recoveryLoss += Math.abs(pnl);
                ladder += 1;
                const nextStake = stake();
                appendLogLine(
                  `LOSS ${pnl.toFixed(2)} | next stake=${nextStake.toFixed(2)}`,
                  "red"
                );
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
