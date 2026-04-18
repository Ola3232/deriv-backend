import express from "express";
import cors from "cors";
import axios from "axios";
import WebSocket from "ws";
import {
  initDB,
  addAlert,
  getAlerts,
  deleteAlert,
  markAlertFired,
  saveToken,
  getTokens,
} from "./database.js";

/* ============================================================
   SETUP
============================================================ */
const app = express();
app.use(cors());
app.use(express.json());

/* ============================================================
   ÉTAT EN MÉMOIRE
============================================================ */
const subscribedSymbols = new Set();
const lastPrices        = {};
let   activeSymbols     = [];   // liste complète des actifs Deriv
let   ws                = null;

/* ============================================================
   PUSH EXPO
============================================================ */
async function sendPush(title, body) {
  const tokens = await getTokens();
  if (!tokens.length) return;
  const messages = tokens.map((t) => ({
    to:       t.token,
    sound:    "default",
    title,
    body,
    priority: "high",
  }));
  try {
    await axios.post("https://exp.host/--/api/v2/push/send", messages, {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ Erreur push :", err.message);
  }
}

/* ============================================================
   DERIV WEBSOCKET — connexion principale (ticks + alertes)
============================================================ */
function connectDeriv() {
  console.log("🔌 Connexion Deriv WS...");
  ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

  ws.on("open", () => {
    console.log("✅ Connecté à Deriv");
    // Réabonner tous les symboles suivis
    for (const symbol of subscribedSymbols) {
      ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    }
    // Charger la liste des actifs actifs
    ws.send(JSON.stringify({ active_symbols: "brief", product_type: "basic" }));
  });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    /* ---- Liste des symboles actifs ---- */
    if (msg.active_symbols) {
      activeSymbols = msg.active_symbols.map((s) => ({
        symbol:       s.symbol,
        display_name: s.display_name,
        market:       s.market,
        market_name:  s.market_display_name,
        submarket:    s.submarket,
        submarket_name: s.submarket_display_name,
        is_open:      s.exchange_is_open === 1,
      }));
      console.log(`📊 ${activeSymbols.length} actifs chargés depuis Deriv`);
      return;
    }

    /* ---- Tick de prix ---- */
    if (!msg.tick) return;

    const { quote: price, symbol } = msg.tick;
    lastPrices[symbol] = price;

    let alerts;
    try { alerts = await getAlerts("%"); } catch { return; }

    for (const alert of alerts) {
      if (alert.asset !== symbol) continue;
      if (alert.fired === 1)      continue;

      const triggered =
        (alert.condition === "over"  && price >= alert.price) ||
        (alert.condition === "under" && price <= alert.price);

      if (!triggered) continue;

      try { await markAlertFired(alert.id); } catch { continue; }

      const dir      = alert.condition === "over" ? "au-dessus" : "en-dessous";
      const pushBody = `${symbol} est passé ${dir} de ${alert.price} — Prix actuel : ${price.toFixed(4)}`;
      console.log(`🔔 ${pushBody}`);
      await sendPush("📈 Deriv Alert", pushBody);
    }
  });

  ws.on("close", (code) => {
    console.log(`🔄 WS fermé (${code}) — reconnexion dans 5s...`);
    ws = null;
    setTimeout(connectDeriv, 5000);
  });

  ws.on("error", (err) => {
    console.error("❌ WS erreur :", err.message);
  });
}

/* ============================================================
   ABONNEMENT SYMBOLE
============================================================ */
function subscribeSymbol(symbol) {
  if (subscribedSymbols.has(symbol)) return;
  subscribedSymbols.add(symbol);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    console.log(`📡 Abonné à ${symbol}`);
  }
}

/* ============================================================
   ROUTES
============================================================ */

// Health check Render
app.get("/", (req, res) => {
  res.json({
    status:        "ok",
    uptime:        Math.floor(process.uptime()),
    symbols_count: activeSymbols.length,
    subscriptions: [...subscribedSymbols],
  });
});

// GET /symbols — liste complète des actifs Deriv, groupés par marché
app.get("/symbols", (req, res) => {
  if (!activeSymbols.length) {
    return res.status(503).json({ error: "Actifs pas encore chargés, réessaie dans quelques secondes." });
  }

  // Grouper par market_name
  const grouped = {};
  for (const s of activeSymbols) {
    if (!grouped[s.market_name]) grouped[s.market_name] = [];
    grouped[s.market_name].push(s);
  }

  res.json({ total: activeSymbols.length, markets: grouped });
});

// GET /alerts
app.get("/alerts", async (req, res) => {
  try {
    res.json(await getAlerts("%"));
  } catch {
    res.status(500).json({ error: "Erreur base de données" });
  }
});

// POST /alerts
app.post("/alerts", async (req, res) => {
  const { asset, condition, price } = req.body;

  if (!asset || typeof asset !== "string")
    return res.status(400).json({ error: "Actif invalide" });
  if (!["over", "under"].includes(condition))
    return res.status(400).json({ error: "Condition invalide" });
  if (price == null || isNaN(Number(price)) || Number(price) <= 0)
    return res.status(400).json({ error: "Prix invalide" });

  const numPrice = Number(price);
  subscribeSymbol(asset);

  const currentPrice = lastPrices[asset];
  if (currentPrice != null) {
    const already =
      (condition === "over"  && currentPrice >= numPrice) ||
      (condition === "under" && currentPrice <= numPrice);
    if (already) {
      const dir = condition === "over" ? "au-dessus" : "en-dessous";
      return res.status(409).json({
        error:        "already_triggered",
        message:      `Prix actuel de ${asset} (${currentPrice}) déjà ${dir} de ${numPrice}. Modifie le niveau.`,
        currentPrice,
      });
    }
  }

  try {
    const newAlert = await addAlert({ user: "default", asset, condition, price: numPrice });
    res.status(201).json(newAlert);
  } catch {
    res.status(500).json({ error: "Erreur base de données" });
  }
});

// DELETE /alerts/:id
app.delete("/alerts/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "ID invalide" });
  try {
    await deleteAlert(id);
    res.json({ deleted: true, id });
  } catch {
    res.status(500).json({ error: "Erreur base de données" });
  }
});

// POST /save-token
app.post("/save-token", async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== "string")
    return res.status(400).json({ error: "Token invalide" });
  try {
    await saveToken("default", token);
    res.json({ saved: true });
  } catch {
    res.status(500).json({ error: "Erreur base de données" });
  }
});

// GET /price/:symbol
app.get("/price/:symbol", (req, res) => {
  const price = lastPrices[req.params.symbol];
  if (price == null) return res.status(404).json({ error: "Prix non disponible" });
  res.json({ symbol: req.params.symbol, price });
});

/* ============================================================
   DÉMARRAGE
============================================================ */
async function start() {
  await initDB();

  const existing = await getAlerts("%");
  for (const a of existing) {
    if (a.fired !== 1) subscribedSymbols.add(a.asset);
  }
  console.log(`📋 ${existing.length} alerte(s) en DB`);

  connectDeriv();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Port ${PORT}`));
}

start().catch((err) => {
  console.error("❌ Erreur démarrage :", err);
  process.exit(1);
});
