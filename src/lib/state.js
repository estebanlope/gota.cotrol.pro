/**
 * state.js
 * Estado global reactivo de la aplicación.
 * Patrón simple de pub/sub para notificar cambios a los screens.
 */

export const state = {
  user: null,
  token: null,
  loans: [],
  payments: [],
  clients: [],
  expenses: [],
  capitalBase: 20_000_000,
  isOnline: navigator.onLine,
  isSyncing: false,
  pendingOps: 0,
};

const listeners = {};

export function on(event, fn) {
  if (!listeners[event]) listeners[event] = [];
  listeners[event].push(fn);
}

export function emit(event, data) {
  (listeners[event] || []).forEach((fn) => fn(data));
}

export function setState(patch) {
  Object.assign(state, patch);
  emit("stateChange", state);
}

// Persistir sesión en localStorage
const SESSION_KEY = "gtg_session";

export function saveSession(user, token) {
  setState({ user, token });
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ user, token, savedAt: Date.now() }),
  );
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { user, token, savedAt } = JSON.parse(raw);
    // Validar que no hayan pasado más de 12 horas localmente
    if (Date.now() - savedAt > 12 * 60 * 60 * 1000) {
      clearSession();
      return null;
    }
    return { user, token };
  } catch {
    return null;
  }
}

export function clearSession() {
  setState({ user: null, token: null });
  localStorage.removeItem(SESSION_KEY);
}
