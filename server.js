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
   SETUP EXPRESS
============================================================ */
const app = express();
app.use(cors());
app.use(express.json());

/* ============================================================
   ÉTAT EN MÉMOIRE
============================================================ */
const subscribedSymbols = new Set(); // symboles abonnés chez Deriv
const lastPrices = {};               // dernier prix connu par symbole

let ws = null;

/* ============================================================
   UTILITAIRE : ENVOI PUSH EXPO
============================================================ */
async function sendPush(title, body) {
  const tokens = await getTokens();
  if (!tokens.length) return;

  const messages = tokens.map((t) => ({
    to: t.token,
    sound: "default",
    title,
    body,
    priority: "high",
  }));

  try {
    await axios.post("https://exp.host/--/api/v2/push/send", messages, {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ Erreur push Expo :", err.message);
  }
}

/* ============================================================
   CONNEXION DERIV WEBSOCKET
============================================================ */
function connectDeriv() {
  console.log("🔌 Connexion à Deriv WebSocket...");
  ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

  ws.on("open", () => {
    console.log("✅ Connecté à Deriv");
    // Réabonner tous les symboles connus
    for (const symbol of subscribedSymbols) {
      ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
      console.log(`📡 Réabonné à ${symbol}`);
    }
  });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // On ne traite que les messages tick
    if (!msg.tick) return;

    const { quote: price, symbol } = msg.tick;
    lastPrices[symbol] = price;

    // Charger les alertes actives (non déclenchées)
    let alerts;
    try {
      alerts = await getAlerts("%");
    } catch (err) {
      console.error("❌ Erreur lecture alertes :", err.message);
      return;
    }

    for (const alert of alerts) {
      // Ignorer si pas le bon symbole ou déjà déclenchée
      if (alert.asset !== symbol) continue;
      if (alert.fired === 1) continue;

      const triggered =
        (alert.condition === "over" && price >= alert.price) ||
        (alert.condition === "under" && price <= alert.price);

      if (!triggered) continue;

      // Marquer en DB immédiatement pour éviter le doublon
      try {
        await markAlertFired(alert.id);
      } catch (err) {
        console.error("❌ Erreur markFired :", err.message);
        continue;
      }

      const dir = alert.condition === "over" ? "au-dessus" : "en-dessous";
      const pushBody = `${symbol} est passé ${dir} de ${alert.price}\nPrix actuel : ${price.toFixed(4)}`;
      console.log(`🔔 ALERTE DÉCLENCHÉE — ${pushBody}`);
      await sendPush("📈 Deriv Alert", pushBody);
    }
  });

  ws.on("close", (code) => {
    console.log(`🔄 WS fermé (code ${code}) — reconnexion dans 5s...`);
    ws = null;
    setTimeout(connectDeriv, 5000);
  });

  ws.on("error", (err) => {
    console.error("❌ WS erreur :", err.message);
    // Le close handler s'occupera de la reconnexion
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
   ROUTES API
============================================================ */

// Health check (utile pour Render keep-alive)
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    symbols: [...subscribedSymbols],
    prices: lastPrices,
  });
});

// GET /alerts — toutes les alertes
app.get("/alerts", async (req, res) => {
  try {
    const data = await getAlerts("%");
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur base de données" });
  }
});

// POST /alerts — créer une alerte
app.post("/alerts", async (req, res) => {
  const { asset, condition, price } = req.body;

  // Validation
  if (!asset || typeof asset !== "string")
    return res.status(400).json({ error: "Actif invalide" });
  if (!["over", "under"].includes(condition))
    return res.status(400).json({ error: "Condition invalide (over | under)" });
  if (price == null || isNaN(Number(price)) || Number(price) <= 0)
    return res.status(400).json({ error: "Prix invalide" });

  const numPrice = Number(price);

  // S'abonner au symbole si pas encore fait
  subscribeSymbol(asset);

  // Vérification : prix actuel déjà dans la condition ?
  const currentPrice = lastPrices[asset];
  if (currentPrice != null) {
    const alreadyTriggered =
      (condition === "over" && currentPrice >= numPrice) ||
      (condition === "under" && currentPrice <= numPrice);

    if (alreadyTriggered) {
      const dir = condition === "over" ? "au-dessus" : "en-dessous";
      return res.status(409).json({
        error: "already_triggered",
        message: `Le prix actuel de ${asset} (${currentPrice}) est déjà ${dir} de ${numPrice}. Modifie le niveau.`,
        currentPrice,
      });
    }
  }

  try {
    const newAlert = await addAlert({
      user: "default",
      asset,
      condition,
      price: numPrice,
    });
    console.log(`✅ Alerte créée :`, newAlert);
    res.status(201).json(newAlert);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur base de données" });
  }
});

// DELETE /alerts/:id — supprimer une alerte
app.delete("/alerts/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "ID invalide" });

  try {
    await deleteAlert(id);
    res.json({ deleted: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur base de données" });
  }
});

// POST /save-token — enregistrer token push
app.post("/save-token", async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== "string")
    return res.status(400).json({ error: "Token invalide" });

  try {
    await saveToken("default", token);
    res.json({ saved: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur base de données" });
  }
});

// GET /price/:symbol — prix actuel d'un symbole
app.get("/price/:symbol", (req, res) => {
  const { symbol } = req.params;
  const price = lastPrices[symbol];
  if (price == null)
    return res.status(404).json({ error: "Prix non encore reçu pour ce symbole" });
  res.json({ symbol, price });
});

/* ============================================================
   DÉMARRAGE
============================================================ */
async function start() {
  await initDB();

  // Récupérer les alertes existantes et s'y abonner
  const existing = await getAlerts("%");
  for (const a of existing) {
    if (a.fired !== 1) subscribedSymbols.add(a.asset);
  }
  console.log(`📋 ${existing.length} alerte(s) chargée(s) depuis la DB`);

  connectDeriv();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Serveur lancé sur le port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("❌ Erreur au démarrage :", err);
  process.exit(1);
});
