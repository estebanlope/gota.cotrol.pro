/**
 * Envía notificaciones al Worker de Cloudflare para Telegram
 * @param {string} type - 'NEW_LOAN', 'NEW_PAYMENT' o 'NEW_EXPENSE'
 * @param {Object} payload - Los datos requeridos para el mensaje
 */
export async function sendNotification(type, payload) {
  // Cambia esta URL por la de tu Worker real
  const WORKER_URL =
    "https://bot-moneymovement-telegram-report.eslopezra.workers.dev/";

  try {
    // No usamos 'await' necesariamente si no queremos bloquear la UI
    // esperando a que Telegram responda
    fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });
  } catch (e) {
    console.error("Error enviando notificación a Telegram:", e);
  }
}
