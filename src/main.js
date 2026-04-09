/**
 * main.js — Punto de entrada principal
 * Orquesta auth, navegación, sincronización y renderizado de screens.
 */

import {
  loginUser,
  verifySession,
  logoutUser,
  syncOfflineQueue,
} from "./lib/supabase.js";
import { getLoans, createLoan, deleteLoan } from "./lib/supabase.js";
import {
  getClients,
  addNewClient,
  updateClient,
  deleteClient,
} from "./lib/supabase.js";
import { createPayment, updatePayment, deletePayment } from "./lib/supabase.js";
import { getExpenses, createExpense, deleteExpense } from "./lib/supabase.js";
import {
  getUsers,
  createUser,
  deactivateUser as deactivateUserApi,
} from "./lib/supabase.js";
import { getSummaryByRange, getConfig, setConfig } from "./lib/supabase.js";
import {
  openDB,
  getAll,
  putAll,
  replaceAll,
  putOne,
  queueAdd,
  queueGetAll,
  queueDelete,
  STORES,
} from "./lib/cache.js";
import {
  state,
  setState,
  saveSession,
  loadSession,
  clearSession,
} from "./lib/state.js";
import {
  fmt,
  fmtS,
  today,
  uid,
  ncuotas,
  modeLabel,
  statusOf,
  STATUS_LABEL,
  STATUS_CLASS,
  EXP_CATEGORY,
} from "./lib/utils.js";

// ══════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════
async function init() {
  await openDB();
  setupConnectivity();
  setupNav();

  // Intentar restaurar sesión
  const saved = loadSession();
  if (saved) {
    // Verificar con el servidor si hay internet
    if (navigator.onLine) {
      const valid = await verifySession(saved.token);
      if (valid) {
        await startApp(saved.user, saved.token);
        return;
      } else {
        clearSession();
      }
    } else {
      // Sin internet: confiar en la sesión local guardada
      await startApp(saved.user, saved.token, true);
      return;
    }
  }
  // Mostrar login
  document.getElementById("login-screen").style.display = "flex";
}

async function startApp(user, token, offlineMode = false) {
  setState({ user, token });
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").classList.remove("hidden");

  // Role badge
  const rb = document.getElementById("role-badge");
  rb.textContent = user.role === "admin" ? "Admin" : "Cobrador";
  rb.className =
    "role-badge " + (user.role === "admin" ? "r-admin" : "r-collector");

  // Mostrar tabs de admin (solo usuarios)
  if (user.role === "admin") {
    document
      .querySelectorAll(".admin-only")
      .forEach((el) => el.classList.remove("hide"));
  }

  await loadAllData(offlineMode);
  renderScreen("dashboard");
  if (!offlineMode) syncQueue();
}

// ══════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════
async function login() {
  const username = document.getElementById("l-user").value.trim();
  const pin = document.getElementById("l-pin").value.trim();
  const btn = document.getElementById("l-btn");
  const err = document.getElementById("l-err");

  err.textContent = "";
  if (!username) {
    err.textContent = "Ingresa tu usuario";
    return;
  }
  if (!/^\d{4}$/.test(pin)) {
    err.textContent = "El PIN debe ser 4 dígitos";
    return;
  }

  btn.textContent = "Verificando...";
  btn.disabled = true;

  const result = await loginUser(username, pin);
  if (result.error) {
    err.textContent = result.error;
    btn.textContent = "Ingresar";
    btn.disabled = false;
    return;
  }

  saveSession(result.user, result.token);
  await startApp(result.user, result.token);
}

async function logout() {
  if (state.token) await logoutUser(state.token);
  clearSession();
  location.reload();
}

function togglePin() {
  const inp = document.getElementById("l-pin");
  inp.type = inp.type === "password" ? "text" : "password";
}

// ══════════════════════════════════════════════════════════
// DATA LOADING
// ══════════════════════════════════════════════════════════
async function loadAllData(offlineOnly = false) {
  // Siempre cargar caché primero
  const [cachedLoans, cachedPayments, cachedClients, cachedExpenses] =
    await Promise.all([
      getAll(STORES.LOANS),
      getAll(STORES.PAYMENTS),
      getAll(STORES.CLIENTS),
      getAll(STORES.EXPENSES),
    ]);
  setState({
    loans: cachedLoans,
    payments: cachedPayments,
    clients: cachedClients,
    expenses: cachedExpenses,
  });
  renderCurrentScreen();

  // Always try to restore capitalBase from localStorage first
  const savedBase = localStorage.getItem("gtg_capital_base");
  if (savedBase) setState({ capitalBase: parseFloat(savedBase) });

  if (offlineOnly || !navigator.onLine) return;

  // Cargar desde Supabase
  const [loansRes, clientsRes, expensesRes, configRes] = await Promise.all([
    getLoans(state.token),
    getClients(state.token),
    getExpenses(state.token),
    getConfig("capital_base", state.token),
  ]);

  // Extraer pagos de los préstamos (ya vienen en join)
  const allPayments = (loansRes.data || []).flatMap((l) =>
    (l.payments || []).map((p) => ({ ...p, loan_id: l.id })),
  );
  const cleanLoans = (loansRes.data || []).map(({ payments, ...l }) => l);

  setState({
    loans: cleanLoans,
    payments: allPayments,
    clients: clientsRes.data || [],
    expenses: expensesRes.data || [],
  });
  if (configRes?.data) {
    const base = parseFloat(configRes.data);
    setState({ capitalBase: base });
    localStorage.setItem("gtg_capital_base", base);
  }

  await Promise.all([
    replaceAll(STORES.LOANS, cleanLoans),
    replaceAll(STORES.PAYMENTS, allPayments),
    replaceAll(STORES.CLIENTS, clientsRes.data || []),
    replaceAll(STORES.EXPENSES, expensesRes.data || []),
  ]);
  renderCurrentScreen();
}

// ══════════════════════════════════════════════════════════
// OFFLINE SYNC
// ══════════════════════════════════════════════════════════
async function syncQueue() {
  if (!navigator.onLine || !state.user) return;
  const queue = await queueGetAll();
  if (!queue.length) return;

  updateSyncPill("syncing");
  const { succeeded, failed } = await syncOfflineQueue(queue, state.token);
  if (succeeded > 0) {
    // Limpiar ops exitosas
    for (const op of queue) await queueDelete(op.qid);
    await loadAllData();
    showToast(
      `${succeeded} operación${succeeded > 1 ? "es" : ""} sincronizada${succeeded > 1 ? "s" : ""} ✓`,
    );
  }
  if (failed > 0)
    showToast(`⚠️ ${failed} operación${failed > 1 ? "es" : ""} fallaron`);
  updateSyncPill();
}

function setupConnectivity() {
  window.addEventListener("online", () => {
    setState({ isOnline: true });
    updateSyncPill();
    syncQueue();
  });
  window.addEventListener("offline", () => {
    setState({ isOnline: false });
    updateSyncPill();
  });
  updateSyncPill();
}

function updateSyncPill(state_) {
  const el = document.getElementById("sync-pill");
  if (!el) return;
  if (state_ === "syncing") {
    el.textContent = "⟳ Sincronizando";
    el.className = "sync-pill sync-ing";
    return;
  }
  if (!navigator.onLine) {
    el.textContent = "● Sin conexión";
    el.className = "sync-pill sync-off";
    return;
  }
  el.textContent = "● En línea";
  el.className = "sync-pill sync-ok";
}

// ══════════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════════
let currentScreen = "dashboard";

function setupNav() {
  document.querySelectorAll(".nav-btn[data-screen]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".nav-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderScreen(btn.dataset.screen);
    });
  });
}

function renderScreen(name) {
  currentScreen = name;
  document
    .querySelectorAll(".screen")
    .forEach((s) => s.classList.remove("active"));
  document.getElementById("screen-" + name).classList.add("active");

  const renderers = {
    dashboard: renderDashboard,
    clients: renderClients,
    nuevo: renderNuevo,
    expenses: renderExpenses,
    resumen: renderResumen,
    usuarios: renderUsuarios,
  };
  renderers[name]?.();
}

function renderCurrentScreen() {
  renderScreen(currentScreen);
}

// ══════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════
function renderDashboard() {
  const { loans, payments, expenses } = state;
  let totalDebe = 0,
    rec = 0,
    mora = 0,
    paid = 0,
    act = 0,
    pen = 0,
    ov = 0;

  loans.forEach((l) => {
    const td = parseFloat(l.amount) * (1 + parseFloat(l.interest_rate) / 100);
    const tr = payments
      .filter((p) => p.loan_id === l.id)
      .reduce((s, p) => s + parseFloat(p.amount), 0);
    totalDebe += td;
    rec += tr;
    const st = statusOf(l, payments);
    if (st === "paid") paid++;
    else if (st === "active") act++;
    else if (st === "pending") pen++;
    else {
      ov++;
      mora++;
    }
  });

  const totalExpenses = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
  const pct = totalDebe > 0 ? Math.round((rec / totalDebe) * 100) : 0;

  const weeks = [0, 0, 0, 0];
  loans.forEach((l) => {
    const td = parseFloat(l.amount) * (1 + parseFloat(l.interest_rate) / 100);
    const w = parseInt(l.weeks) || 4;
    const cs =
      l.collection_mode === "daily"
        ? td / w
        : l.collection_mode === "weekly"
          ? td / w
          : td / Math.ceil(w / 2);
    for (let i = 0; i < 4 && i < w; i++) weeks[i] += cs;
  });

  document.getElementById("screen-dashboard").innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-lbl">CARTERA TOTAL</div><div class="kpi-val c-green">${fmtS(totalDebe)}</div></div>
      <div class="kpi"><div class="kpi-lbl">RECAUDADO</div>   <div class="kpi-val c-blue">${fmtS(rec)}</div></div>
      <div class="kpi"><div class="kpi-lbl">PENDIENTE</div>   <div class="kpi-val c-orange">${fmtS(totalDebe - rec)}</div></div>
      <div class="kpi"><div class="kpi-lbl">GASTOS</div>      <div class="kpi-val c-red">${fmtS(totalExpenses)}</div></div>
    </div>
    <div class="card">
      <div class="card-title">Progreso de cobranza</div>
      <div class="progress-lbl"><span>Recaudado</span><span>${pct}%</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="card">
      <div class="card-title">Estado de cartera</div>
      <div class="sum-row"><span class="sl">✅ Pagados</span>    <span class="sv c-green">${paid}</span></div>
      <div class="sum-row"><span class="sl">🔄 En curso</span>   <span class="sv">${act}</span></div>
      <div class="sum-row"><span class="sl">⏳ Sin iniciar</span><span class="sv">${pen}</span></div>
      <div class="sum-row"><span class="sl">⚠️ En mora</span>    <span class="sv c-red">${ov}</span></div>
    </div>
    <div class="card">
      <div class="card-title">Flujo semanal esperado</div>
      <div class="week-grid">${weeks
        .map(
          (w, i) => `
        <div class="week-card"><div class="wn">SEM ${i + 1}</div><div class="wv">${fmtS(w)}</div></div>`,
        )
        .join("")}
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════
// CLIENTS / DEUDORES
// ══════════════════════════════════════════════════════════
let clientFilter = "all";

function renderClients() {
  const { loans, payments, clients } = state;
  const isAdmin = state.user?.role === "admin";
  const q = (
    document.getElementById("client-search")?.value || ""
  ).toLowerCase();

  const filtered = clients.filter((c) => {
    const match =
      c.full_name.toLowerCase().includes(q) || (c.id_number || "").includes(q);
    if (!match) return false;
    if (clientFilter === "all") return true;
    const clientLoans = loans.filter((l) => l.client_id === c.id);
    if (!clientLoans.length) return clientFilter === "pending";
    return clientLoans.some((l) => statusOf(l, payments) === clientFilter);
  });

  // Keep search + filters OUTSIDE the scrollable area via position:sticky
  document.getElementById("screen-clients").innerHTML = `
    <div class="clients-sticky">
      <div class="search-wrap">
        <svg class="search-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="text" id="client-search" placeholder="Buscar cliente..." oninput="window._app.renderClients()" value="${q}">
      </div>
      <div class="filter-row">
        ${["all", "pending", "active", "paid", "overdue"]
          .map(
            (f) => `
          <div class="chip ${clientFilter === f ? "active" : ""}" onclick="window._app.setClientFilter('${f}',this)">
            ${f === "all" ? "Todos" : STATUS_LABEL[f]}
          </div>`,
          )
          .join("")}
      </div>
    </div>
    <div class="clients-list-wrap">
      ${
        !filtered.length
          ? `<div class="empty"><div class="ei">📋</div><p>No hay clientes.<br>Crea uno desde <b>Nuevo</b>.</p></div>`
          : filtered
              .map((c) => {
                const cLoans = loans.filter((l) => l.client_id === c.id);
                const totalDebe = cLoans.reduce(
                  (s, l) =>
                    s +
                    parseFloat(l.amount) *
                      (1 + parseFloat(l.interest_rate) / 100),
                  0,
                );
                const totalRec = cLoans.reduce(
                  (s, l) =>
                    s +
                    payments
                      .filter((p) => p.loan_id === l.id)
                      .reduce((ss, p) => ss + parseFloat(p.amount), 0),
                  0,
                );
                const pct =
                  totalDebe > 0
                    ? Math.min(100, Math.round((totalRec / totalDebe) * 100))
                    : 0;
                const st = cLoans.length
                  ? statusOf(cLoans[0], payments)
                  : "pending";
                const color = {
                  paid: "#00e5a0",
                  overdue: "#ff4444",
                  active: "#0099ff",
                  pending: "#ffb347",
                }[st];
                const photoHtml = c.photo
                  ? `<img src="${c.photo}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid var(--border)">`
                  : `<div style="width:40px;height:40px;border-radius:50%;background:var(--s2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">👤</div>`;
                return `
          <div class="dc">
            <div class="dc-top" onclick="window._app.openClientDetail('${c.id}')">
              <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
                ${photoHtml}
                <div style="min-width:0">
                  <div class="dc-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.full_name}</div>
                  <div class="dc-sub">${c.id_number || "Sin cédula"} · ${cLoans.length} préstamo${cLoans.length !== 1 ? "s" : ""}</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                <div class="badge ${STATUS_CLASS[st]}">${STATUS_LABEL[st]}</div>
                ${isAdmin ? `<button onclick="event.stopPropagation();window._app.delClient('${c.id}')" style="background:rgba(255,68,68,.1);color:var(--red);border:none;border-radius:6px;padding:4px 7px;font-size:11px;cursor:pointer">🗑</button>` : ""}
              </div>
            </div>
            <div class="mini-bar" onclick="window._app.openClientDetail('${c.id}')"><div class="mini-fill" style="width:${pct}%;background:${color}"></div></div>
            <div class="dc-row" onclick="window._app.openClientDetail('${c.id}')"><span>Recaudado: <b>${fmt(totalRec)}</b></span><span>Saldo: <b>${fmt(totalDebe - totalRec)}</b></span></div>
          </div>`;
              })
              .join("")
      }
    </div>
  `;
}

function setClientFilter(f) {
  clientFilter = f;
  renderClients();
}

async function delClient(clientId) {
  const client = state.clients.find((c) => c.id === clientId);
  if (
    !confirm(
      `¿Eliminar a "${client?.full_name}"? Se conservarán sus préstamos en el historial.`,
    )
  )
    return;
  const { error } = await deleteClient(clientId, state.token);
  if (error) {
    showToast("Error al eliminar cliente");
    return;
  }
  setState({ clients: state.clients.filter((c) => c.id !== clientId) });
  renderClients();
  renderDashboard();
  showToast("Cliente eliminado");
}

// ══════════════════════════════════════════════════════════
// CLIENT DETAIL MODAL
// ══════════════════════════════════════════════════════════
function openClientDetail(clientId) {
  const { clients, loans, payments } = state;
  const client = clients.find((c) => c.id === clientId);
  if (!client) return;

  const clientLoans = loans.filter((l) => l.client_id === clientId);
  const isAdmin = state.user.role === "admin";

  const loansHtml = clientLoans.length
    ? clientLoans
        .map((l) => {
          const total =
            parseFloat(l.amount) * (1 + parseFloat(l.interest_rate) / 100);
          const pays = payments.filter((p) => p.loan_id === l.id);
          const rec = pays.reduce((s, p) => s + parseFloat(p.amount), 0);
          const saldo = total - rec;
          const nc = ncuotas(l.collection_mode, l.weeks);
          const cuota = total / nc;
          const st = statusOf(l, payments);
          const pct = Math.min(100, Math.round((rec / total) * 100));
          const color = {
            paid: "#00e5a0",
            overdue: "#ff4444",
            active: "#0099ff",
            pending: "#ffb347",
          }[st];

          const paysHtml = pays.length
            ? pays
                .slice()
                .reverse()
                .map((p) => {
                  const methodLabel =
                    p.payment_method === "transfer"
                      ? "🏦 Transferencia"
                      : "💵 Efectivo";
                  const methodColor =
                    p.payment_method === "transfer"
                      ? "var(--blue)"
                      : "var(--accent)";
                  return `
      <div class="pay-item">
        <div>
          <div class="pamt">${fmt(p.amount)}</div>
          <div class="pdate">${p.payment_date} · <span style="color:${methodColor}">${methodLabel}</span></div>
        </div>
        ${
          isAdmin
            ? `<div class="pi-actions">
          <button class="btn-ep" onclick="window._app.editPayment('${p.id}',${p.amount},'${p.payment_method || "cash"}')">✏️</button>
          <button class="btn-dp" onclick="window._app.delPayment('${p.id}','${l.id}')">🗑</button>
        </div>`
            : ""
        }
      </div>`;
                })
                .join("")
            : '<p style="color:var(--muted);font-size:13px;padding:8px 0">Sin pagos aún.</p>';

          const amortRows = Array.from({ length: nc }, (_, i) => {
            const ca = cuota * (i + 1);
            const sf = Math.max(0, total - ca);
            const isPaid = rec >= ca;
            const isCur = !isPaid && rec >= cuota * i;
            return `<tr class="${isPaid ? "r-paid" : isCur ? "r-cur" : ""}">
        <td>${i + 1}</td><td>${fmt(cuota)}</td><td>${fmt(ca)}</td><td>${fmt(sf)}</td>
      </tr>`;
          }).join("");

          return `
    <div style="background:var(--s2);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div>
          <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:14px">${modeLabel(l.collection_mode)} · ${l.weeks} sem.</div>
          <div style="font-size:12px;color:var(--muted)">Desde ${l.start_date}</div>
        </div>
        <div class="badge ${STATUS_CLASS[st]}">${STATUS_LABEL[st]}</div>
      </div>
      <div style="height:4px;background:var(--border);border-radius:99px;overflow:hidden;margin-bottom:10px">
        <div style="height:100%;width:${pct}%;background:${color};border-radius:99px"></div>
      </div>
      <div class="m-kpis">
        <div class="m-kpi"><div class="m-kpi-val c-green">${fmt(rec)}</div><div class="m-kpi-lbl">RECAUDADO</div></div>
        <div class="m-kpi"><div class="m-kpi-val c-orange">${fmt(saldo)}</div><div class="m-kpi-lbl">SALDO</div></div>
        <div class="m-kpi"><div class="m-kpi-val c-blue">${fmt(cuota)}</div><div class="m-kpi-lbl">CUOTA</div></div>
      </div>
      <div class="sec-lbl">Registrar pago</div>
      <div class="pay-row">
        <input type="number" id="pay-${l.id}" placeholder="${Math.round(cuota)}" inputmode="numeric">
        <button class="btn-pay" onclick="window._app.addPayment('${l.id}')">Pagar</button>
      </div>
      <div style="display:flex;gap:12px;margin-bottom:12px">
        <label style="display:flex;align-items:center;gap:7px;font-size:13px;cursor:pointer;padding:8px 14px;background:var(--s2);border:1px solid var(--border);border-radius:10px;flex:1">
          <input type="radio" name="pay-method-${l.id}" value="cash" checked
            style="accent-color:var(--accent);width:16px;height:16px">
          💵 Efectivo
        </label>
        <label style="display:flex;align-items:center;gap:7px;font-size:13px;cursor:pointer;padding:8px 14px;background:var(--s2);border:1px solid var(--border);border-radius:10px;flex:1">
          <input type="radio" name="pay-method-${l.id}" value="transfer"
            style="accent-color:var(--blue);width:16px;height:16px">
          🏦 Transferencia
        </label>
      </div>
      <div class="quick-btns">
        <button class="qb" onclick="document.getElementById('pay-${l.id}').value=${Math.round(cuota)}">
          Cuota<b>${fmt(cuota)}</b>
        </button>
        <button class="qb" onclick="document.getElementById('pay-${l.id}').value=${Math.round(saldo)}">
          Saldo total<b>${fmt(saldo)}</b>
        </button>
      </div>
      <div class="sec-lbl">Historial de pagos</div>
      <div class="pay-log">${paysHtml}</div>
      <div class="sec-lbl">Tabla de amortización</div>
      <div class="amort-wrap">
        <table class="amort-table">
          <thead><tr><th>#</th><th>Cuota</th><th>Acumulado</th><th>Saldo</th></tr></thead>
          <tbody>${amortRows}</tbody>
        </table>
      </div>
      ${isAdmin ? `<div style="margin-top:14px"><button class="btn-d" onclick="window._app.delLoan('${l.id}')">🗑 Eliminar préstamo</button></div>` : ""}
    </div>`;
        })
        .join("")
    : '<p style="color:var(--muted);font-size:13px;padding:8px 0">Este cliente no tiene préstamos.</p>';

  // Photo section
  const photoHtml = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px">
      <div id="photo-preview" style="width:72px;height:72px;border-radius:50%;background:var(--s2);border:2px solid var(--border);overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:28px">
        ${client.photo ? `<img src="${client.photo}" style="width:100%;height:100%;object-fit:cover">` : "👤"}
      </div>
      ${
        isAdmin
          ? `<div style="display:flex;flex-direction:column;gap:6px">
        <label style="background:var(--s2);border:1px solid var(--border);border-radius:10px;padding:8px 14px;font-size:12px;cursor:pointer;color:var(--text)">
          📷 Cambiar foto
          <input type="file" accept="image/*" capture="environment" style="display:none" onchange="window._app.handlePhoto(event,'${clientId}')">
        </label>
        ${client.photo ? `<button onclick="window._app.removePhoto('${clientId}')" style="background:none;border:none;color:var(--muted);font-size:11px;cursor:pointer;text-align:left">Eliminar foto</button>` : ""}
      </div>`
          : ""
      }
    </div>`;

  // Edit form (admin only)
  const editFormHtml = isAdmin
    ? `
    <div style="background:var(--s2);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:14px">
      <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:11px;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:12px">Editar datos del cliente</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="fg"><label class="fl">Nombre completo</label>
          <input class="fi" id="edit-name" value="${client.full_name || ""}">
        </div>
        <div class="fg"><label class="fl">Cédula</label>
          <input class="fi" id="edit-id" value="${client.id_number || ""}" inputmode="numeric">
        </div>
        <div class="fg"><label class="fl">Teléfono</label>
          <input class="fi" id="edit-phone" value="${client.phone || ""}" inputmode="numeric">
        </div>
        <div class="fg"><label class="fl">Dirección</label>
          <input class="fi" id="edit-addr" value="${client.address || ""}">
        </div>
        <div class="fg"><label class="fl">Notas</label>
          <input class="fi" id="edit-notes" value="${client.notes || ""}">
        </div>
        <button class="btn-p" onclick="window._app.saveClientEdit('${clientId}')">💾 Guardar cambios</button>
      </div>
    </div>`
    : "";

  document.getElementById("modal-content").innerHTML = `
    <div class="modal-title">${client.full_name}</div>
    <div class="modal-sub">${client.id_number || "Sin cédula"} · ${client.phone || "Sin teléfono"}</div>
    ${photoHtml}
    ${editFormHtml}
    ${loansHtml}
    <button class="btn-p" style="margin-top:8px" onclick="window._app.goNewLoan('${clientId}')">＋ Nuevo préstamo para este cliente</button>
  `;
  openModal();
}

// ── Guardar edición de cliente ──────────────────────────────────
async function saveClientEdit(clientId) {
  const updates = {
    full_name: document.getElementById("edit-name")?.value.trim() || null,
    id_number: document.getElementById("edit-id")?.value.trim() || null,
    phone: document.getElementById("edit-phone")?.value.trim() || null,
    address: document.getElementById("edit-addr")?.value.trim() || null,
    notes: document.getElementById("edit-notes")?.value.trim() || null,
  };
  const { data, error } = await updateClient(clientId, updates, state.token);
  if (error) {
    showToast("Error al guardar: " + error);
    return;
  }
  // Actualizar estado local
  setState({
    clients: state.clients.map((c) =>
      c.id === clientId ? { ...c, ...data } : c,
    ),
  });
  await putOne(STORES.CLIENTS, {
    ...state.clients.find((c) => c.id === clientId),
    ...data,
  });
  showToast("Cliente actualizado ✓");
  openClientDetail(clientId);
}

// ── Foto: compresión y guardado ─────────────────────────────────
async function handlePhoto(event, clientId) {
  const file = event.target.files?.[0];
  if (!file) return;
  showToast("Comprimiendo imagen...");

  try {
    const compressed = await compressImage(file, 400, 400, 0.65);
    // Preview inmediato
    const preview = document.getElementById("photo-preview");
    if (preview)
      preview.innerHTML = `<img src="${compressed}" style="width:100%;height:100%;object-fit:cover">`;
    // Guardar en BD
    const { data, error } = await updateClient(
      clientId,
      { photo: compressed },
      state.token,
    );
    if (error) {
      showToast("Error al guardar foto");
      return;
    }
    setState({
      clients: state.clients.map((c) =>
        c.id === clientId ? { ...c, photo: compressed } : c,
      ),
    });
    await putOne(STORES.CLIENTS, {
      ...state.clients.find((c) => c.id === clientId),
      photo: compressed,
    });
    showToast("Foto guardada ✓");
  } catch (e) {
    showToast("Error al procesar imagen");
    console.error(e);
  }
}

async function removePhoto(clientId) {
  if (!confirm("¿Eliminar la foto del cliente?")) return;
  const { error } = await updateClient(clientId, { photo: null }, state.token);
  if (error) {
    showToast("Error al eliminar foto");
    return;
  }
  setState({
    clients: state.clients.map((c) =>
      c.id === clientId ? { ...c, photo: null } : c,
    ),
  });
  await putOne(STORES.CLIENTS, {
    ...state.clients.find((c) => c.id === clientId),
    photo: null,
  });
  showToast("Foto eliminada");
  openClientDetail(clientId);
}

/**
 * Comprime una imagen a máx WxH px y calidad JPEG dada.
 * Retorna string base64 data:image/jpeg;base64,...
 */
function compressImage(file, maxW, maxH, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        // Calcular nuevas dimensiones manteniendo proporción
        let w = img.width,
          h = img.height;
        if (w > maxW || h > maxH) {
          const ratio = Math.min(maxW / w, maxH / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ══════════════════════════════════════════════════════════
// NUEVO (cliente + préstamo)
// ══════════════════════════════════════════════════════════
let newLoanClientId = null;

function goNewLoan(clientId) {
  newLoanClientId = clientId;
  closeModal();
  renderScreen("nuevo");
  document.getElementById("nb-nuevo").classList.add("active");
  document.querySelectorAll(".nav-btn").forEach((b) => {
    if (b.id !== "nb-nuevo") b.classList.remove("active");
  });
  // Pre-fill client
  const client = state.clients.find((c) => c.id === clientId);
  if (client) {
    document.getElementById("f-name").value = client.full_name;
    document.getElementById("f-name").disabled = true;
    document.getElementById("f-id").value = client.id_number || "";
    document.getElementById("f-id").disabled = true;
    document.getElementById("f-tel").value = client.phone || "";
    document.getElementById("f-tel").disabled = true;
  }
}

function renderNuevo() {
  newLoanClientId = null;
  document.getElementById("screen-nuevo").innerHTML = `
    <div class="card form-sec">
      <div class="card-title">Datos del cliente</div>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:4px">
        <div id="new-photo-preview" style="width:64px;height:64px;border-radius:50%;background:var(--s2);border:2px solid var(--border);overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:24px">👤</div>
        <label style="background:var(--s2);border:1px solid var(--border);border-radius:10px;padding:9px 14px;font-size:13px;cursor:pointer;color:var(--text);flex:1;text-align:center">
          📷 Agregar foto
          <input type="file" accept="image/*" capture="environment" id="new-photo-input" style="display:none" onchange="window._app.handleNewPhoto(event)">
        </label>
      </div>
      <div class="fg"><label class="fl">Nombre completo</label><input class="fi" id="f-name" placeholder="Juan Pérez"></div>
      <div class="fg"><label class="fl">Cédula</label><input class="fi" id="f-id" placeholder="123456789" inputmode="numeric"></div>
      <div class="fg"><label class="fl">Teléfono</label><input class="fi" id="f-tel" placeholder="300 000 0000" inputmode="numeric"></div>
      <div class="fg"><label class="fl">Dirección (opcional)</label><input class="fi" id="f-addr" placeholder="Calle 1 # 2-3"></div>
      <div class="fg"><label class="fl">Notas del cliente</label><input class="fi" id="f-notes" placeholder="Observaciones adicionales..."></div>
    </div>
    <div class="card form-sec">
      <div class="card-title">Condiciones del préstamo</div>
      <div class="fg"><label class="fl">Monto ($)</label><input class="fi" id="f-amount" type="number" value="200000" oninput="window._app.updatePreview()"></div>
      <div class="fg">
        <label class="fl">Interés (%)</label>
        <div style="background:var(--s2);border:1px solid var(--border);border-radius:12px;padding:13px 14px;color:var(--muted);font-size:15px;display:flex;justify-content:space-between;align-items:center">
          <span style="color:var(--text)">20%</span>
          <span style="font-size:11px;letter-spacing:.5px">FIJO</span>
        </div>
      </div>
      <div class="fg">
        <label class="fl">Modalidad de cobro</label>
        <select class="fs" id="f-mode" onchange="window._app.updatePreview()">
          <option value="daily">Diario (Lunes–Sábado)</option>
          <option value="weekly">Semanal</option>
          <option value="biweekly">Bisemanal</option>
        </select>
      </div>
      <div class="fg"><label class="fl">Semanas de plazo</label><input class="fi" id="f-weeks" type="number" value="4" oninput="window._app.updatePreview()"></div>
      <div class="fg"><label class="fl">Fecha de inicio</label><input class="fi" id="f-date" type="date" value="${today()}"></div>
      <div class="fg"><label class="fl">Notas del préstamo</label><input class="fi" id="f-loan-notes" placeholder="Condiciones especiales, garantías..."></div>
    </div>
    <div class="card">
      <div class="card-title">Resumen del préstamo</div>
      <div class="preview-box" id="preview-box">
        <div class="pi"><div class="pl">TOTAL A PAGAR</div><div class="pv c-green" id="pv-total">$0</div></div>
        <div class="pi"><div class="pl">INTERÉS</div>      <div class="pv" id="pv-int">$0</div></div>
        <div class="pi"><div class="pl">CUOTA</div>        <div class="pv c-blue" id="pv-cuota">$0</div></div>
        <div class="pi"><div class="pl">N° CUOTAS</div>    <div class="pv" id="pv-n">0</div></div>
      </div>
    </div>
    <button class="btn-p" id="btn-crear" onclick="window._app.crearPrestamo()">＋ Crear préstamo</button>
  `;
  updatePreview();
}

// Buffer para la foto del nuevo cliente
let _newClientPhoto = null;

function handleNewPhoto(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  compressImage(file, 400, 400, 0.65)
    .then((compressed) => {
      _newClientPhoto = compressed;
      const preview = document.getElementById("new-photo-preview");
      if (preview)
        preview.innerHTML = `<img src="${compressed}" style="width:100%;height:100%;object-fit:cover">`;
    })
    .catch(() => showToast("Error al procesar imagen"));
}

function updatePreview() {
  const amount = parseFloat(document.getElementById("f-amount")?.value) || 0;
  const rate = 20; // fijo, no editable por el usuario
  const mode = document.getElementById("f-mode")?.value || "daily";
  const weeks = parseInt(document.getElementById("f-weeks")?.value) || 4;
  const intAmt = (amount * rate) / 100;
  const total = amount + intAmt;
  const nc = ncuotas(mode, weeks);
  const cuota = nc > 0 ? total / nc : 0;
  if (document.getElementById("pv-total")) {
    document.getElementById("pv-total").textContent = fmt(total);
    document.getElementById("pv-int").textContent = fmt(intAmt);
    document.getElementById("pv-cuota").textContent = fmt(cuota);
    document.getElementById("pv-n").textContent = nc;
  }
}

async function crearPrestamo() {
  const btn = document.getElementById("btn-crear");
  const name = document.getElementById("f-name").value.trim();
  const idNum = document.getElementById("f-id").value.trim();
  const phone = document.getElementById("f-tel").value.trim();
  const addr = document.getElementById("f-addr")?.value.trim() || "";
  const notes = document.getElementById("f-notes")?.value.trim() || "";
  const lnotes = document.getElementById("f-loan-notes")?.value.trim() || "";
  const amount = parseFloat(document.getElementById("f-amount").value);
  const rate = 20; // fijo al 20%, no modificable por el usuario
  const mode = document.getElementById("f-mode").value;
  const weeks = parseInt(document.getElementById("f-weeks").value);
  const date = document.getElementById("f-date").value;

  if (!name) {
    showToast("Ingresa el nombre del cliente");
    return;
  }
  if (!amount || amount <= 0) {
    showToast("Monto inválido");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Guardando...";

  const clientData = {
    full_name: name,
    id_number: idNum,
    phone,
    address: addr,
    notes,
    photo: _newClientPhoto || null,
  };
  const loanData = {
    amount,
    interest_rate: rate,
    collection_mode: mode,
    weeks,
    start_date: date,
    notes: lnotes,
  };

  if (navigator.onLine) {
    // Crear cliente si no existe
    let clientId = newLoanClientId;
    if (!clientId) {
      const { data: newClient, error } = await addNewClient(
        clientData,
        state.token,
      );
      if (error) {
        showToast("Error al crear cliente");
        btn.disabled = false;
        btn.textContent = "＋ Crear préstamo";
        return;
      }
      clientId = newClient.id;
      setState({ clients: [...state.clients, newClient] });
      await putOne(STORES.CLIENTS, newClient);
    }
    const { data: newLoan, error: lErr } = await createLoan(
      { ...loanData, client_id: clientId },
      state.token,
    );
    if (lErr) {
      showToast("Error al crear préstamo");
      btn.disabled = false;
      btn.textContent = "＋ Crear préstamo";
      return;
    }
    setState({ loans: [newLoan, ...state.loans] });
    await putOne(STORES.LOANS, newLoan);
  } else {
    // Offline: guardar localmente y encolar
    const localClientId = newLoanClientId || uid();
    if (!newLoanClientId) {
      const localClient = {
        id: localClientId,
        ...clientData,
        created_by: state.user.id,
        created_at: new Date().toISOString(),
        is_active: true,
      };
      setState({ clients: [...state.clients, localClient] });
      await putOne(STORES.CLIENTS, localClient);
      await queueAdd({
        type: "create_client",
        payload: clientData,
        userId: state.user.id,
        localId: localClientId,
      });
    }
    const localLoanId = uid();
    const localLoan = {
      id: localLoanId,
      client_id: localClientId,
      ...loanData,
      created_by: state.user.id,
      created_at: new Date().toISOString(),
      status: "active",
    };
    setState({ loans: [localLoan, ...state.loans] });
    await putOne(STORES.LOANS, localLoan);
    await queueAdd({
      type: "create_loan",
      payload: { ...loanData, client_id: localClientId },
      userId: state.user.id,
    });
    showToast("Guardado offline — se sincronizará al conectarse");
  }

  _newClientPhoto = null;
  renderNuevo();
  renderDashboard();
  btn.disabled = false;
  btn.textContent = "＋ Crear préstamo";
  showToast("Préstamo creado ✓");
}

// ══════════════════════════════════════════════════════════
// PAYMENTS
// ══════════════════════════════════════════════════════════
async function addPayment(loanId) {
  const input = document.getElementById("pay-" + loanId);
  const amount = parseFloat(input?.value);
  if (!amount || amount <= 0) {
    showToast("Ingresa un monto válido");
    return;
  }

  // Read payment method radio
  const methodEl = document.querySelector(
    `input[name="pay-method-${loanId}"]:checked`,
  );
  const method = methodEl?.value || "cash";

  const payData = {
    loan_id: loanId,
    amount,
    payment_date: today(),
    payment_method: method,
  };

  if (navigator.onLine) {
    const { data, error } = await createPayment(payData, state.token);
    if (error) {
      showToast("Error al registrar pago");
      return;
    }
    const newPay = { ...data, loan_id: loanId };
    setState({ payments: [...state.payments, newPay] });
    await putOne(STORES.PAYMENTS, newPay);
  } else {
    const localPay = {
      id: uid(),
      ...payData,
      registered_by: state.user.id,
      created_at: new Date().toISOString(),
    };
    setState({ payments: [...state.payments, localPay] });
    await putOne(STORES.PAYMENTS, localPay);
    await queueAdd({
      type: "create_payment",
      payload: payData,
      userId: state.user.id,
    });
    showToast("Pago guardado offline");
  }

  const clientId = state.loans.find((l) => l.id === loanId)?.client_id;
  if (clientId) openClientDetail(clientId);
  renderDashboard();
  showToast("Pago registrado ✓");
}

async function editPayment(payId, currentAmount, currentMethod) {
  const newAmt = prompt(`Nuevo monto (actual: ${fmt(currentAmount)}):`);
  if (!newAmt || isNaN(parseFloat(newAmt))) return;
  const methods = ["cash", "transfer"];
  const methodLbl = ["💵 Efectivo", "🏦 Transferencia"];
  const curIdx = methods.indexOf(currentMethod || "cash");
  const choice = confirm(
    `¿Cambiar método de pago?\nActual: ${methodLbl[curIdx]}\nAceptar = Transferencia | Cancelar = Efectivo`,
  );
  const newMethod = choice ? "transfer" : "cash";

  const { error } = await updatePayment(
    payId,
    { amount: parseFloat(newAmt), payment_method: newMethod },
    state.token,
  );
  if (error) {
    showToast("Error al actualizar pago");
    return;
  }
  setState({
    payments: state.payments.map((p) =>
      p.id === payId
        ? { ...p, amount: parseFloat(newAmt), payment_method: newMethod }
        : p,
    ),
  });
  await putOne(STORES.PAYMENTS, {
    ...state.payments.find((p) => p.id === payId),
    amount: parseFloat(newAmt),
    payment_method: newMethod,
  });
  const loanId = state.payments.find((p) => p.id === payId)?.loan_id;
  const clientId = state.loans.find((l) => l.id === loanId)?.client_id;
  if (clientId) openClientDetail(clientId);
  showToast("Pago actualizado ✓");
}

async function delPayment(payId, loanId) {
  if (!confirm("¿Eliminar este pago?")) return;
  const { error } = await deletePayment(payId, state.token);
  setState({ payments: state.payments.filter((p) => p.id !== payId) });
  const clientId = state.loans.find((l) => l.id === loanId)?.client_id;
  if (clientId) openClientDetail(clientId);
  renderDashboard();
  showToast("Pago eliminado");
}

async function delLoan(loanId) {
  if (!confirm("¿Eliminar este préstamo y todos sus pagos?")) return;
  const { error } = await deleteLoan(loanId, state.token);
  if (error) {
    showToast("Error al eliminar préstamo");
    return;
  }
  setState({
    loans: state.loans.filter((l) => l.id !== loanId),
    payments: state.payments.filter((p) => p.loan_id !== loanId),
  });
  closeModal();
  renderDashboard();
  renderClients();
  showToast("Préstamo eliminado");
}

// ══════════════════════════════════════════════════════════
// EXPENSES
// ══════════════════════════════════════════════════════════
function renderExpenses() {
  const { expenses } = state;
  const totalExp = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
  const isAdmin = state.user.role === "admin";

  const byCategory = {};
  expenses.forEach((e) => {
    byCategory[e.category] =
      (byCategory[e.category] || 0) + parseFloat(e.amount);
  });

  const expList = expenses.length
    ? expenses
        .map(
          (e) => `
    <div class="exp-card">
      <div class="ec-left">
        <div class="ec-desc">${EXP_CATEGORY[e.category] || e.category} — ${e.description}</div>
        <div class="ec-meta">${e.expense_date}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <div class="ec-amt">${fmt(e.amount)}</div>
        ${isAdmin ? `<button class="ec-del" onclick="window._app.delExpense('${e.id}')">🗑</button>` : ""}
      </div>
    </div>`,
        )
        .join("")
    : '<div class="empty"><div class="ei">💸</div><p>Sin gastos registrados.</p></div>';

  document.getElementById("screen-expenses").innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-lbl">TOTAL GASTOS</div><div class="kpi-val c-red">${fmtS(totalExp)}</div></div>
      <div class="kpi"><div class="kpi-lbl">ESTE MES</div>
        <div class="kpi-val c-orange">${fmtS(expenses.filter((e) => e.expense_date?.startsWith(today().slice(0, 7))).reduce((s, e) => s + parseFloat(e.amount), 0))}</div>
      </div>
    </div>
    <div class="card form-sec">
      <div class="card-title">Registrar gasto</div>
      <div class="fg">
        <label class="fl">Categoría</label>
        <select class="fs" id="exp-cat">
          <option value="fuel">⛽ Gasolina</option>
          <option value="transport">🚌 Transporte</option>
          <option value="other">📦 Otro</option>
        </select>
      </div>
      <div class="fg"><label class="fl">Descripción</label><input class="fi" id="exp-desc" placeholder="Ej: Gasolina cobros zona norte"></div>
      <div class="fg"><label class="fl">Monto ($)</label><input class="fi" id="exp-amt" type="number" placeholder="50000" inputmode="numeric"></div>
      <div class="fg"><label class="fl">Fecha</label><input class="fi" id="exp-date" type="date" value="${today()}"></div>
      <button class="btn-p" onclick="window._app.addExpense()">＋ Registrar gasto</button>
    </div>
    <div class="card">
      <div class="card-title">Por categoría</div>
      ${
        Object.entries(byCategory)
          .map(
            ([k, v]) => `
        <div class="sum-row"><span class="sl">${EXP_CATEGORY[k] || k}</span><span class="sv c-red">${fmt(v)}</span></div>`,
          )
          .join("") ||
        '<p style="color:var(--muted);font-size:13px">Sin datos</p>'
      }
    </div>
    <div class="card">
      <div class="card-title">Historial de gastos</div>
      <div style="display:flex;flex-direction:column;gap:8px">${expList}</div>
    </div>
  `;
}

async function addExpense() {
  const cat = document.getElementById("exp-cat").value;
  const desc = document.getElementById("exp-desc").value.trim();
  const amt = parseFloat(document.getElementById("exp-amt").value);
  const date = document.getElementById("exp-date").value;
  if (!desc) {
    showToast("Agrega una descripción");
    return;
  }
  if (!amt || amt <= 0) {
    showToast("Monto inválido");
    return;
  }

  const expData = {
    category: cat,
    description: desc,
    amount: amt,
    expense_date: date,
  };

  if (navigator.onLine) {
    const { data, error } = await createExpense(expData, state.token);
    if (error) {
      showToast("Error al guardar gasto");
      return;
    }
    setState({ expenses: [data, ...state.expenses] });
    await putOne(STORES.EXPENSES, data);
  } else {
    const local = {
      id: uid(),
      ...expData,
      registered_by: state.user.id,
      created_at: new Date().toISOString(),
    };
    setState({ expenses: [local, ...state.expenses] });
    await putOne(STORES.EXPENSES, local);
    await queueAdd({
      type: "create_expense",
      payload: expData,
      userId: state.user.id,
    });
    showToast("Gasto guardado offline");
  }

  renderExpenses();
  renderDashboard();
  showToast("Gasto registrado ✓");
}

async function delExpense(id) {
  if (!confirm("¿Eliminar este gasto?")) return;
  const { error } = await deleteExpense(id, state.token);
  if (error) {
    showToast("Error al eliminar gasto");
    return;
  }
  setState({ expenses: state.expenses.filter((e) => e.id !== id) });
  renderExpenses();
  renderDashboard();
  showToast("Gasto eliminado");
}

// ══════════════════════════════════════════════════════════
// RESUMEN — disponible para todos los roles
// ══════════════════════════════════════════════════════════
let _rangeData = null;

function renderResumen() {
  const { loans, payments, expenses, capitalBase } = state;
  const isAdmin = state.user?.role === "admin";
  let cap = 0,
    ints = 0,
    totalDebe = 0,
    rec = 0,
    recCash = 0,
    recTransfer = 0;
  let capitalActivo = 0; // capital prestado que aún no ha regresado
  const byMode = {
    daily: { c: 0, t: 0 },
    weekly: { c: 0, t: 0 },
    biweekly: { c: 0, t: 0 },
  };

  loans.forEach((l) => {
    const principal = parseFloat(l.amount);
    const interest = (principal * parseFloat(l.interest_rate)) / 100;
    const td = principal + interest;
    const loanPays = payments.filter((p) => p.loan_id === l.id);
    const tr = loanPays.reduce((s, p) => s + parseFloat(p.amount), 0);

    cap += principal;
    ints += interest;
    totalDebe += td;
    rec += tr;

    // Cobros por método
    loanPays.forEach((p) => {
      if (p.payment_method === "transfer") recTransfer += parseFloat(p.amount);
      else recCash += parseFloat(p.amount);
    });

    // Capital activo: solo la porción del principal que aún no ha regresado.
    // A medida que el cliente paga, los primeros pagos se imputan al capital.
    // Una vez recuperado el capital, el resto son intereses.
    const capitalRecuperado = Math.min(tr, principal); // cuánto del principal ya regresó
    capitalActivo += principal - capitalRecuperado;

    if (byMode[l.collection_mode]) {
      byMode[l.collection_mode].c++;
      byMode[l.collection_mode].t += td;
    }
  });

  const totalExp = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
  const base = parseFloat(capitalBase) || 20_000_000;
  // Capital disponible = base - capital aún afuera + cobros de intereses - gastos
  const interesRecuperado = Math.max(0, rec - (cap - capitalActivo));
  const capitalDisponible = base - capitalActivo + interesRecuperado - totalExp;

  const firstOfMonth = today().slice(0, 7) + "-01";
  const todayStr = today();

  const adminSection = isAdmin
    ? `
    <div class="card">
      <div class="card-title">Cartera por modalidad</div>
      ${Object.entries(byMode)
        .map(
          ([k, v]) => `
        <div class="sum-row"><span class="sl">${modeLabel(k)}</span><span class="sv">${v.c} préstamos · ${fmt(v.t)}</span></div>`,
        )
        .join("")}
    </div>
    <div class="card">
      <div class="card-title">Provisión de cartera (5%)</div>
      <div class="sum-row"><span class="sl">Reserva recomendada</span><span class="sv c-red">${fmt(totalDebe * 0.05)}</span></div>
      <p style="font-size:11px;color:var(--muted);margin-top:6px;line-height:1.5">Reserva del 5% del total para cubrir posibles pérdidas por deudores incobrables.</p>
    </div>`
    : "";

  const capitalSection = isAdmin
    ? `
    <div class="card">
      <div class="card-title">💰 Capital base y posición actual</div>
      <div class="sum-row"><span class="sl">Capital base inicial</span>        <span class="sv c-blue">${fmt(base)}</span></div>
      <div class="sum-row"><span class="sl">− Capital activo (en la calle)</span><span class="sv c-orange">−${fmt(capitalActivo)}</span></div>
      <div class="sum-row"><span class="sl">+ Intereses recuperados</span>       <span class="sv c-green">+${fmt(interesRecuperado)}</span></div>
      <div class="sum-row"><span class="sl">− Gastos operativos</span>           <span class="sv c-red">−${fmt(totalExp)}</span></div>
      <div class="sum-row" style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px">
        <span class="sl" style="font-weight:700;color:var(--text)">= Capital disponible ahora</span>
        <span class="sv ${capitalDisponible >= 0 ? "c-green" : "c-red"}" style="font-size:17px;font-weight:700">${fmt(capitalDisponible)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
        <label class="fl" style="white-space:nowrap">Capital base ($):</label>
        <input class="fi" id="capital-base-inp" type="number" value="${base}" style="flex:1;padding:8px 12px;font-size:14px">
        <button onclick="window._app.saveCapitalBase()" style="background:var(--accent);color:#000;border:none;border-radius:10px;padding:9px 14px;font-family:'Syne',sans-serif;font-weight:700;font-size:12px;cursor:pointer;white-space:nowrap">Guardar</button>
      </div>
    </div>`
    : "";

  document.getElementById("screen-resumen").innerHTML = `
    ${capitalSection}

    <div class="card">
      <div class="card-title">Resumen financiero — Total acumulado</div>
      <div class="sum-row"><span class="sl">Capital total prestado</span>    <span class="sv">${fmt(cap)}</span></div>
      <div class="sum-row"><span class="sl">Capital activo (pendiente)</span> <span class="sv c-orange">${fmt(capitalActivo)}</span></div>
      <div class="sum-row"><span class="sl">Intereses esperados</span>        <span class="sv c-green">${fmt(ints)}</span></div>
      <div class="sum-row"><span class="sl">Total a recaudar</span>           <span class="sv">${fmt(totalDebe)}</span></div>
      <div class="sum-row"><span class="sl">💵 Recaudado efectivo</span>      <span class="sv c-green">${fmt(recCash)}</span></div>
      <div class="sum-row"><span class="sl">🏦 Recaudado transferencia</span> <span class="sv c-blue">${fmt(recTransfer)}</span></div>
      <div class="sum-row" style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">
        <span class="sl">Total recaudado</span>                              <span class="sv c-green">${fmt(rec)}</span>
      </div>
      <div class="sum-row"><span class="sl">Saldo pendiente</span>           <span class="sv c-orange">${fmt(totalDebe - rec)}</span></div>
      <div class="sum-row"><span class="sl">Total gastos</span>              <span class="sv c-red">−${fmt(totalExp)}</span></div>
      <div class="sum-row"><span class="sl" style="font-weight:700">Utilidad neta</span>
        <span class="sv c-green" style="font-size:16px">${fmt(rec - cap - totalExp)}</span>
      </div>
    </div>

    ${adminSection}

    <div class="card">
      <div class="card-title">📅 Resumen por rango de fechas</div>
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <div class="fg" style="flex:1;min-width:120px">
          <label class="fl">Desde</label>
          <input class="fi" type="date" id="range-from" value="${firstOfMonth}">
        </div>
        <div class="fg" style="flex:1;min-width:120px">
          <label class="fl">Hasta</label>
          <input class="fi" type="date" id="range-to" value="${todayStr}">
        </div>
      </div>
      <div class="filter-row" style="margin-bottom:14px">
        <button class="chip active" onclick="window._app.setQuickRange('month',this)">Este mes</button>
        <button class="chip" onclick="window._app.setQuickRange('week',this)">Esta semana</button>
        <button class="chip" onclick="window._app.setQuickRange('quarter',this)">Trimestre</button>
        <button class="chip" onclick="window._app.setQuickRange('year',this)">Este año</button>
      </div>
      <button class="btn-p" onclick="window._app.loadRangeSummary()">Consultar</button>
      <div id="range-results" style="margin-top:16px"></div>
    </div>
  `;
  loadRangeSummary();
}

async function saveCapitalBase() {
  const val = parseFloat(document.getElementById("capital-base-inp")?.value);
  if (!val || val <= 0) {
    showToast("Valor inválido");
    return;
  }
  const { error } = await setConfig("capital_base", val, state.token);
  if (error) {
    showToast("Error al guardar: " + error);
    return;
  }
  setState({ capitalBase: val });
  localStorage.setItem("gtg_capital_base", val);
  showToast("Capital base actualizado ✓");
  renderResumen();
}

function setQuickRange(preset, el) {
  document
    .querySelectorAll("#screen-resumen .chip")
    .forEach((c) => c.classList.remove("active"));
  el.classList.add("active");
  const t = new Date();
  let from,
    to = today();
  if (preset === "week") {
    const d = new Date(t);
    d.setDate(d.getDate() - d.getDay() + 1); // lunes
    from = d.toISOString().split("T")[0];
  } else if (preset === "month") {
    from = today().slice(0, 7) + "-01";
  } else if (preset === "quarter") {
    const qStart = new Date(
      t.getFullYear(),
      Math.floor(t.getMonth() / 3) * 3,
      1,
    );
    from = qStart.toISOString().split("T")[0];
  } else if (preset === "year") {
    from = t.getFullYear() + "-01-01";
  }
  document.getElementById("range-from").value = from;
  document.getElementById("range-to").value = to;
  loadRangeSummary();
}

async function loadRangeSummary() {
  const from = document.getElementById("range-from")?.value;
  const to = document.getElementById("range-to")?.value;
  const resultsEl = document.getElementById("range-results");
  if (!from || !to || !resultsEl) return;
  if (from > to) {
    resultsEl.innerHTML =
      '<p style="color:var(--red);font-size:13px">La fecha inicial debe ser anterior a la final.</p>';
    return;
  }

  resultsEl.innerHTML =
    '<div class="loading"><div class="spinner"></div>Calculando...</div>';

  const { data, error } = await getSummaryByRange(from, to, state.token);
  if (error || !data) {
    resultsEl.innerHTML =
      '<p style="color:var(--muted);font-size:13px">Error al cargar datos.</p>';
    return;
  }

  const d = typeof data === "string" ? JSON.parse(data) : data;
  const utilidad = parseFloat(d.payments_total) - parseFloat(d.expenses_total);

  // Build bar chart SVG from payments_by_day
  const chartHtml = buildPaymentsChart(d.payments_by_day || [], from, to);

  resultsEl.innerHTML = `
    <div class="kpi-grid" style="margin-bottom:12px">
      <div class="kpi"><div class="kpi-lbl">PRÉSTAMOS NUEVOS</div><div class="kpi-val c-blue">${d.loans_count}</div></div>
      <div class="kpi"><div class="kpi-lbl">CAPITAL PRESTADO</div><div class="kpi-val">${fmtS(d.loans_capital)}</div></div>
      <div class="kpi"><div class="kpi-lbl">COBROS RECIBIDOS</div><div class="kpi-val c-green">${fmtS(d.payments_total)}</div></div>
      <div class="kpi"><div class="kpi-lbl">GASTOS</div><div class="kpi-val c-red">${fmtS(d.expenses_total)}</div></div>
    </div>
    <div style="background:var(--s2);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:12px">
      <div class="sum-row"><span class="sl">Intereses generados</span>    <span class="sv c-green">${fmt(d.loans_interest)}</span></div>
      <div class="sum-row"><span class="sl">Total a cobrar (nuevos)</span> <span class="sv">${fmt(d.loans_total)}</span></div>
      <div class="sum-row"><span class="sl">Cobros realizados</span>       <span class="sv c-green">${fmt(d.payments_total)} (${d.payments_count} pagos)</span></div>
      <div class="sum-row"><span class="sl">Gastos del período</span>      <span class="sv c-red">−${fmt(d.expenses_total)}</span></div>
      <div class="sum-row"><span class="sl">Clientes nuevos</span>         <span class="sv">${d.clients_new}</span></div>
      <div class="sum-row"><span class="sl" style="font-weight:700">Utilidad del período</span>
        <span class="sv ${utilidad >= 0 ? "c-green" : "c-red"}" style="font-size:15px">${fmt(utilidad)}</span>
      </div>
    </div>
    ${chartHtml}
  `;
}

function buildPaymentsChart(paysByDay, from, to) {
  if (!paysByDay.length)
    return '<p style="color:var(--muted);font-size:12px;text-align:center;padding:16px 0">Sin cobros en este período.</p>';

  const maxVal = Math.max(...paysByDay.map((d) => parseFloat(d.amount)));
  const barW = Math.max(
    8,
    Math.min(28, Math.floor(280 / paysByDay.length) - 4),
  );
  const chartW = paysByDay.length * (barW + 4) + 20;
  const chartH = 100;

  const bars = paysByDay
    .map((d, i) => {
      const h = Math.round((parseFloat(d.amount) / maxVal) * chartH * 0.85);
      const x = 10 + i * (barW + 4);
      const y = chartH - h;
      const label = d.date.slice(5); // MM-DD
      return `
      <g>
        <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3"
              fill="url(#barGrad)" opacity="0.9"/>
        <title>${d.date}: ${fmt(d.amount)}</title>
      </g>`;
    })
    .join("");

  return `
    <div style="background:var(--s2);border:1px solid var(--border);border-radius:12px;padding:14px">
      <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:11px;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:10px">Cobros por día</div>
      <div style="overflow-x:auto">
        <svg viewBox="0 0 ${chartW} ${chartH + 20}" width="${chartW}" height="${chartH + 20}" style="display:block">
          <defs>
            <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#00e5a0"/>
              <stop offset="100%" stop-color="#0099ff"/>
            </linearGradient>
          </defs>
          ${bars}
          ${
            paysByDay.length <= 15
              ? paysByDay
                  .map((d, i) => {
                    const x = 10 + i * (barW + 4) + barW / 2;
                    return `<text x="${x}" y="${chartH + 14}" text-anchor="middle" fill="#7d8590" font-size="8">${d.date.slice(5)}</text>`;
                  })
                  .join("")
              : ""
          }
        </svg>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:4px">
        <span>${from}</span><span>${to}</span>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════
// USUARIOS (admin)
// ══════════════════════════════════════════════════════════
async function renderUsuarios() {
  const { data: users } = await getUsers(state.token);

  document.getElementById("screen-usuarios").innerHTML = `
    <div class="card form-sec">
      <div class="card-title">Crear usuario</div>
      <div class="fg"><label class="fl">Nombre completo</label><input class="fi" id="u-name" placeholder="Nombre completo"></div>
      <div class="fg"><label class="fl">Usuario</label><input class="fi" id="u-user" placeholder="cobrador1" autocapitalize="none"></div>
      <div class="fg">
        <label class="fl">PIN (4 dígitos)</label>
        <input class="fi" id="u-pin" type="password" inputmode="numeric" maxlength="4" placeholder="••••">
      </div>
      <div class="fg">
        <label class="fl">Rol</label>
        <select class="fs" id="u-role">
          <option value="collector">Cobrador</option>
          <option value="admin">Administrador</option>
        </select>
      </div>
      <button class="btn-p" id="btn-cu" onclick="window._app.crearUsuario()">＋ Crear usuario</button>
    </div>
    <div class="card">
      <div class="card-title">Usuarios registrados</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${
          !users.length
            ? '<p style="color:var(--muted);font-size:13px;padding:8px 0">Sin usuarios registrados.</p>'
            : users
                .map(
                  (u) => `
          <div class="user-card">
            <div>
              <div class="un">${u.full_name}</div>
              <div class="ue">@${u.username} · ${u.role === "admin" ? "🔑 Admin" : "📋 Cobrador"} · ${u.is_active ? "Activo" : "Inactivo"}</div>
            </div>
            ${u.is_active ? `<button class="btn-d" style="width:auto;padding:8px 12px;font-size:12px" onclick="window._app.desactivarUsuario('${u.id}')">Desactivar</button>` : '<span style="font-size:11px;color:var(--muted)">Inactivo</span>'}
          </div>`,
                )
                .join("")
        }
      </div>
    </div>
  `;
}

async function crearUsuario() {
  const btn = document.getElementById("btn-cu");
  const fullName = document.getElementById("u-name").value.trim();
  const username = document.getElementById("u-user").value.trim();
  const pin = document.getElementById("u-pin").value.trim();
  const role = document.getElementById("u-role").value;
  if (!fullName) {
    showToast("Ingresa el nombre");
    return;
  }
  if (!username) {
    showToast("Ingresa el usuario");
    return;
  }
  if (!/^\d{4}$/.test(pin)) {
    showToast("El PIN debe ser 4 dígitos");
    return;
  }
  btn.disabled = true;
  btn.textContent = "Creando...";
  const { data, error } = await createUser(
    { username, pin, full_name: fullName, role },
    state.token,
  );
  btn.disabled = false;
  btn.textContent = "＋ Crear usuario";
  if (error) {
    showToast("Error: " + error);
    return;
  }
  showToast(`${role === "admin" ? "Admin" : "Cobrador"} creado ✓`);
  renderUsuarios();
}

async function desactivarUsuario(userId) {
  if (!confirm("¿Desactivar este usuario?")) return;
  const { error } = await deactivateUserApi(userId, state.token);
  if (error) {
    showToast("Error al desactivar");
    return;
  }
  showToast("Usuario desactivado");
  renderUsuarios();
}

// ══════════════════════════════════════════════════════════
// MODAL
// ══════════════════════════════════════════════════════════
function openModal() {
  document.getElementById("overlay").classList.add("open");
  // Push a history state so the browser back button closes the modal
  history.pushState({ modal: true }, "");
}

function closeModal() {
  document.getElementById("overlay").classList.remove("open");
  document.getElementById("modal-content").innerHTML = "";
}

// Handle browser/Android back button
window.addEventListener("popstate", (e) => {
  if (document.getElementById("overlay").classList.contains("open")) {
    closeModal();
  }
});

// ══════════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════════
function showToast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

// ══════════════════════════════════════════════════════════
// EXPOSE TO HTML
// ══════════════════════════════════════════════════════════
window._app = {
  login,
  logout,
  togglePin,
  renderClients,
  setClientFilter,
  delClient,
  openClientDetail,
  goNewLoan,
  saveClientEdit,
  handlePhoto,
  removePhoto,
  handleNewPhoto,
  updatePreview,
  crearPrestamo,
  addPayment,
  editPayment,
  delPayment,
  delLoan,
  addExpense,
  delExpense,
  crearUsuario,
  desactivarUsuario,
  setQuickRange,
  loadRangeSummary,
  saveCapitalBase,
  closeModal,
};

// ── START ──
init();
