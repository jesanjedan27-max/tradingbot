const WebSocket = require("ws");

const APP_ID = "33uJq820h9LseRDAZ80iZ";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(), body: "" };
  }

  try {
    const { barrier, stake, token } = JSON.parse(event.body || "{}");

    if (!barrier || !stake || !token) {
      return respond(400, { error: "Missing required parameters: barrier, stake, token" });
    }

    const result = await executeTrade(token, String(barrier), Number(stake));
    return respond(200, result);

  } catch (err) {
    return respond(500, { error: err.message });
  }
};

function executeTrade(token, barrier, stake) {
  return new Promise((resolve) => {
    const ws  = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
    let step  = "authorize";

    // Safety timeout — close after 20s if Deriv never responds
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ error: "Trade timed out after 20 seconds" });
    }, 20000);

    ws.on("open", () => {
      // Step 1: Must authorize before any trading action
      ws.send(JSON.stringify({ authorize: token }));
    });

    ws.on("message", (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }

      // Any API-level error — stop immediately
      if (data.error) {
        clearTimeout(timer);
        ws.terminate();
        resolve({ error: data.error.message, code: data.error.code });
        return;
      }

      // Step 2: Authorized — send proposal request
      if (step === "authorize" && data.msg_type === "authorize") {
        step = "proposal";
        ws.send(JSON.stringify({
          proposal:      1,
          amount:        stake,
          basis:         "stake",
          contract_type: "DIGITDIFF",
          currency:      "USD",
          duration:      1,
          duration_unit: "t",
          barrier,
          symbol:        "R_100"
        }));
        return;
      }

      // Step 3: Proposal received — buy it
      if (step === "proposal" && data.msg_type === "proposal") {
        step = "buy";
        ws.send(JSON.stringify({
          buy:   data.proposal.id,
          price: stake
        }));
        return;
      }

      // Step 4: Buy confirmed — done
      if (step === "buy" && data.msg_type === "buy") {
        clearTimeout(timer);
        ws.terminate();
        resolve({
          status:      "TRADE_EXECUTED",
          contract_id: data.buy.contract_id,
          buy_price:   data.buy.buy_price
        });
        return;
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      ws.terminate();
      resolve({ error: "WebSocket error: " + err.message });
    });

    ws.on("close", () => clearTimeout(timer));
  });
}

function corsHeaders() {
  return {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function respond(statusCode, data) {
  return {
    statusCode,
    headers: corsHeaders(),
    body:    JSON.stringify(data)
  };
}