import { getAlerts, getTokens } from "./database.js";
import axios from "axios";

export async function checkAlerts() {
  const alerts = await getAlerts("%"); // récupère toutes les alertes
  const tokens = await getTokens();

  for (let alert of alerts) {
    // Ici, tu devrais récupérer le prix actuel de l'actif depuis Deriv
    // Exemple simplifié :
    const price = Math.random() * 5000; // remplacer par vrai tick WebSocket

    let message = "";
    if (alert.condition === "over" && price >= alert.price) {
      message = `${alert.asset} au dessus de ${alert.price}`;
    }
    if (alert.condition === "under" && price <= alert.price) {
      message = `${alert.asset} en dessous de ${alert.price}`;
    }

    if (message) {
      tokens.forEach(async t => {
        if (t.user === alert.user) {
          await axios.post("https://exp.host/--/api/v2/push/send", {
            to: t.token,
            sound: "default",
            title: "Alerte prix",
            body: message
          });
        }
      });
    }
  }
}