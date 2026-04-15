import WebSocket from "ws";
import { checkAlerts } from "./alerts.js";

const ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

ws.on("open", () => console.log("Connecté à Deriv"));

ws.on("message", (data) => {
  const tick = JSON.parse(data);
  if (!tick.tick) return;

  // Ici, tu peux stocker le tick pour vérifier les alertes en temps réel
  // Exemple : checkAlerts() pour chaque tick ou stocker dans une variable globale
});