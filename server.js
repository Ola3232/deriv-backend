import express from "express";
import cors from "cors";
import axios from "axios";
import WebSocket from "ws";
import { initDB, addAlert, getAlerts, deleteAlert, saveToken, getTokens } from "./database.js";

const app = express();
app.use(cors());
app.use(express.json());

// Symboles actuellement abonnés (évite les doublons)
const subscribedSymbols = new Set();
// Alertes déjà déclenchées (évite le spam)
const firedAlerts = new Set();

let ws;

function connectDeriv() {
  ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

  ws.on("open", () => {
    console.log("✅ Connecté à Deriv");
    // Réabonner aux symboles existants au reconnect
    subscribedSymbols.forEach(symbol => {
      ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    });
  });

  ws.on("message", async (data) => {
    const msg = JSON.parse(data);
    if (!msg.tick) return;

    const price = msg.tick.quote;
    const symbol = msg.tick.symbol;

    const alerts = await getAlerts("%");

    for (const alert of alerts) {
      if (alert.asset !== symbol) continue;
      if (firedAlerts.has(alert.id)) continue; // déjà déclenché

      const triggered =
        (alert.condition === "over" && price >= alert.price) ||
        (alert.condition === "under" && price <= alert.price);

      if (triggered) {
        firedAlerts.add(alert.id);
        const dir = alert.condition === "over" ? "au dessus" : "en dessous";
        const message = `${symbol} ${dir} de ${alert.price} (actuel: ${price})`;
        await sendPush(message);
        console.log("🔔 Alerte déclenchée :", message);
      }
    }
  });

  ws.on("close", () => {
    console.log("🔄 Deriv déconnecté, reconnexion dans 5s...");
    setTimeout(connectDeriv, 5000);
  });

  ws.on("error", (err) => {
    console.error("❌ Erreur WS Deriv :", err.message);
  });
}

async function subscribeSymbol(symbol) {
  if (subscribedSymbols.has(symbol)) return;
  subscribedSymbols.add(symbol);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    console.log(`📡 Abonné à ${symbol}`);
  }
}

async function sendPush(message) {
  const tokens = await getTokens();
  for (const { token } of tokens) {
    try {
      await axios.post("https://exp.host/--/api/v2/push/send", {
        to: token,
        sound: "default",
        title: "📈 Deriv Alert",
        body: message,
      });
    } catch (err) {
      console.error("Erreur push :", err.message);
    }
  }
}

// Routes
app.get("/alerts", async (req, res) => {
  const data = await getAlerts("%");
  res.json(data);
});

app.post("/alerts", async (req, res) => {
  const { asset, condition, price } = req.body;
  if (!asset || !condition || price == null)
    return res.status(400).json({ error: "Champs manquants" });

  await addAlert({ user: "default", asset, condition, price: Number(price) });
  await subscribeSymbol(asset);
  res.json({ success: true });
});

app.delete("/alerts/:id", async (req, res) => {
  const id = Number(req.params.id);
  await deleteAlert(id);
  firedAlerts.delete(id); // Réinitialiser si supprimé
  res.json({ deleted: true });
});

app.post("/save-token", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token manquant" });
  await saveToken("default", token);
  res.json({ saved: true });
});

// Init
async function start() {
  await initDB();

  // Réabonner aux alertes existantes au démarrage
  const existing = await getAlerts("%");
  existing.forEach(a => subscribedSymbols.add(a.asset));

  connectDeriv();

  const PORT = process.env.PORT || 3000;

app.listen(PORT,()=>{
  console.log("Serveur lancé sur port", PORT);
});

}

start();