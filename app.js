// Deriv DigitDiff bot
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

  const APP_ID = "33wZZKTFZrmsZgFaAH53Z";
  const REDIRECT_URI = "https://jesanjedan27-max.github.io/tradingbot/";
  const OAUTH_EXCHANGE_URL = "https://oauthexchange23.vercel.app/api/oauth-exchange";
  const OAUTH_URL =
    `https://oauth.deriv.com/oauth2/authorize?app_id=${APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    "&response_type=code&scope=read%20trade";
  const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

  const savedToken = localStorage.getItem("access_token");
  if (tokenInput && savedToken) {
    tokenInput.value = savedToken;
  }

  let ws = null;
  let running = false;
  let paused = false;
  let lastPayoutRatio = null;
  let recoveryLoss = 0;
  let currentStake = 0;
  let ladder = 0;
  let totalProfit = 0;
  let waitingProposal = false;
  let proposalVariants = null;
  let proposalAttempt = 0;
  let activeContractId = null;

  let targetPair = null;
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

  function nextPairFromResultDigit(digit) {
    if (digit === 9) return [0, 1];
    if (digit >= 0 && digit <= 8) return [digit, digit + 1];
    return null;
  }

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
      appendLogLine(`Next scan: looking for pair [${nextTarget[0]},${nextTarget[1]}]`, "#a78bfa");
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
    ladder = 0;
    tickBuffer.length = 0;
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

    appendLogLine(`TRADE → DIGITDIFF barrier=${barrier} stake=${proposalVariants[0].amount}`, "lime");
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
          seqA = (d >= 0 && d <= 8) ? d : null;
          return;
        }

        seqB = d;
        phase = "scan_x";
        appendLogLine(`Pair [${seqA},${seqB}] found → waiting for x`, "#38bdf8");
      } else {
        if (targetPair) {
          seqA = (d === targetPair[0]) ? d : null;
        } else {
          seqA = (d >= 0 && d <= 8) ? d : null;
        }
      }
      return;
    }

    if (phase === "scan_x") {
      if (d === 9) {
        appendLogLine("x=9 is invalid; restarting pair scan.", "red");
        resetSequence(targetPair);
        return;
      }

      const x = d;
      const barrier = x + 1;
      appendLogLine(`Pattern [${seqA},${seqB},${x}] → BUY DIGITDIFF barrier=${barrier}`, "#22c55e");
      placeTrade(barrier);
    }
  }

  function saveToken(token) {
    if (!token) return;
    localStorage.setItem("access_token", token);
    if (tokenInput) tokenInput.value = token;
  }

  function clearOAuthCodeFromUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    window.history.replaceState({}, "", url.toString());
  }

  function generateCodeVerifier() {
    const array = new Uint8Array(64);
    crypto.getRandomValues(array);
    return btoa(String.fromCharCode(...array))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  async function generateCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  async function exchangeCodeForToken(code) {
    const codeVerifier = localStorage.getItem("deriv_code_verifier");

    const res = await fetch(OAUTH_EXCHANGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Deriv-App-ID": APP_ID
      },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        client_id: APP_ID,
        redirect_uri: REDIRECT_URI
      })
    });

    const data = await res.json();
    if (!res.ok || !data.access_token) {
      throw new Error(data.error || data.error_description || "Token exchange failed.");
    }

    return data.access_token;
  }

  async function ensureAccessToken() {
    const inputToken = tokenInput?.value?.trim();
    if (inputToken) {
      saveToken(inputToken);
      return inputToken;
    }

    const storedToken = localStorage.getItem("access_token");
    if (storedToken) {
      return storedToken;
    }

    const code = new URLSearchParams(window.location.search).get("code");
    if (code) {
      appendLogLine("OAuth code received. Exchanging for access token...", "yellow");
      try {
        const token = await exchangeCodeForToken(code);
        saveToken(token);
        clearOAuthCodeFromUrl();
        appendLogLine("Token received successfully.", "lime");
        return token;
      } catch (err) {
        appendLogLine(`Token exchange failed: ${err.message}`, "red");
        return null;
      }
    }

    appendLogLine("No token found. Opening Deriv OAuth login...", "yellow");

    const verifier = generateCodeVerifier();
    localStorage.setItem("deriv_code_verifier", verifier);

    const challenge = await generateCodeChallenge(verifier);
    localStorage.setItem("deriv_code_challenge", challenge);

    const oauthUrl =
      `https://oauth.deriv.com/oauth2/authorize?app_id=${APP_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      "&response_type=code&scope=read%20trade" +
      `&code_challenge=${challenge}` +
      "&code_challenge_method=S256";

    window.location.href = oauthUrl;
    return null;
  }

  async function connect() {
    resetSequence(null);

    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }

    const accessToken = await ensureAccessToken();
    if (!accessToken) return;

    try {
      appendLogLine("Connecting to Deriv WebSocket...", "yellow");

      ws = new WebSocket(WS_URL);

      const handshakeTimeout = setTimeout(() => {
        if (ws && ws.readyState !== WebSocket.OPEN) {
          appendLogLine("WS handshake timed out. Check your numeric Deriv App ID and redirect URI.", "red");
          if (ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        }
      }, 8000);

      ws.onopen = () => {
        clearTimeout(handshakeTimeout);
        appendLogLine("WS connected.", "lime");
        sendMessage({ authorize: accessToken });
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
          case "authorize":
            if (payload.authorize?.error) {
              appendLogLine(`Authorization failed: ${payload.authorize.error.message}`, "red");
              return;
            }
            appendLogLine("Deriv authorized successfully.", "lime");
            sendMessage({ ticks: SYMBOL, subscribe: 1 });
            sendMessage({ balance: 1 });
            break;

          case "tick":
            onTick(payload.tick?.quote);
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
              appendLogLine(`Payout ratio set to ${lastPayoutRatio.toFixed(2)}`, "#38bdf8");
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

              const exitPrice = contract.exit_tick || contract.exit_tick_display_value;
              const exitDigit = exitPrice !== undefined ? digitFromPrice(exitPrice) : null;
              const resultDigit = settlementDigit !== null ? settlementDigit : exitDigit;
              const nextTarget = resultDigit !== null ? nextPairFromResultDigit(resultDigit) : null;

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
                appendLogLine(
                  `LOSS ${pnl.toFixed(2)}; recoveryLoss=${recoveryLoss.toFixed(2)}` +
                  (resultDigit !== null ? ` (digit=${resultDigit})` : "") +
                  (nextTarget ? ` → next pair [${nextTarget[0]},${nextTarget[1]}]` : ""),
                  "red"
                );
              }

              if (levelEl) levelEl.textContent = ladder;

              if (ws && ws.readyState === WebSocket.OPEN) {
                sendMessage({ balance: 1 });
              }

              resetSequence(nextTarget);
            }
            break;
          }

          default:
            break;
        }
      };

      ws.onclose = ev => {
        clearTimeout(handshakeTimeout);
        appendLogLine(`WS closed (code ${ev.code}).`, "orange");
        stopTickFlush();
      };

      ws.onerror = ev => {
        clearTimeout(handshakeTimeout);
        appendLogLine("WS error. Check your numeric Deriv App ID and HTTPS access.", "red");
        console.error("WebSocket error:", ev);
      };
    } catch (err) {
      appendLogLine(`Connection failed: ${String(err)}`, "red");
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
    fullReset();
    if (profitEl) profitEl.textContent = "0.00";
    if (levelEl) levelEl.textContent = "0";
    if (balanceEl) balanceEl.textContent = "-";
    appendLogLine("RESET DONE", "orange");
  };

  demoBtn.onclick = () => {
    appendLogLine("DEMO MODE", "blue");
    const mi = $("modeIndicator");
    if (mi) {
      mi.textContent = "JESAN 💲 MODE - DEMO";
      mi.classList.add("demo");
      mi.classList.remove("live");
    }
  };

  liveBtn.onclick = () => {
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
