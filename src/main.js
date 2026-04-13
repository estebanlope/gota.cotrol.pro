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
const appTitle = document.querySelector("#topbar .logo");

if (appTitle) {
  appTitle.addEventListener("click", () => {
    // Recarga total de la página ignorando la caché
    window.location.reload(true);
  });
}

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
    loans: renderLoans,
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
// LOANS / PRESTAMOS
// ══════════════════════════════════════════════════════════
state.loanFilter = "pending";

function renderLoans() {
  const q = state.loanSearchQuery || "";
  const screen = document.getElementById("screen-loans");

  // 1. Solo creamos el buscador si NO existe en pantalla
  if (!document.querySelector(".loans-sticky")) {
    screen.innerHTML = `
      <div class="loans-sticky">
        <div class="search-wrap">
          <svg class="search-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="loan-search" placeholder="Buscar por cliente o monto..." 
                 oninput="window._app.handleLoanSearch(this.value)" value="${q}">
        </div>
        <div class="filter-row" id="loans-filter-container"></div>
      </div>
      <div id="loans-list-container" class="loans-list-wrap"></div>
    `;
    renderLoanChips(); // Dibujamos los filtros (Al día, Mora, etc.)
  }

  // 2. Siempre actualizamos la lista
  updateLoansList();
}

function handleLoanSearch(val) {
  state.loanSearchQuery = val; // Guardamos en el estado global
  updateLoansList(); // Refrescamos solo las cards
}

function renderLoanChips() {
  const container = document.getElementById("loans-filter-container");
  if (!container) return;

  const opts = [
    { id: "pending", label: "⏳ Pendientes" },
    { id: "active", label: "🔄 En curso" },
    { id: "paid", label: "✅ Pagado" },
    { id: "overdue", label: "⚠️ Mora" },
    { id: "all", label: "💰 Todos" },
  ];

  container.innerHTML = opts
    .map(
      (f) => `
    <div class="chip ${state.loanFilter === f.id ? "active" : ""}" 
         onclick="window._app.setLoanFilter('${f.id}')">
      ${f.label}
    </div>
  `,
    )
    .join("");
}

function updateLoansList() {
  const listContainer = document.getElementById("loans-list-container");
  if (!listContainer) return;

  const q = (state.loanSearchQuery || "").toLowerCase();
  const { loans, clients, payments, loanFilter } = state;

  const filtered = loans.filter((l) => {
    const client = clients.find((c) => c.id === l.client_id);
    const clientName = (client?.full_name || "").toLowerCase();
    const matchesSearch =
      clientName.includes(q) || l.amount.toString().includes(q);

    const st = statusOf(l, payments);
    if (loanFilter === "active") return matchesSearch && st === "active";
    if (loanFilter === "overdue") return matchesSearch && st === "overdue";
    if (loanFilter === "paid") return matchesSearch && st === "paid";
    if (loanFilter === "pending") return matchesSearch && st === "pending";
    return matchesSearch;
  });

  if (!filtered.length) {
    listContainer.innerHTML = `<div class="empty"><div class="ei">💸</div><p>No hay préstamos.</p></div>`;
    return;
  }

  // --- LLAMADO CORREGIDO AQUÍ ---
  listContainer.innerHTML = filtered
    .map((l) => {
      const client = clients.find((c) => c.id === l.client_id);
      const st = statusOf(l, payments);

      // Cálculo de valores para la tarjeta
      const lPayments = payments.filter((p) => p.loan_id === l.id);
      const totalRecau = lPayments.reduce((sum, p) => sum + p.amount, 0);
      const totalConInteres = l.amount + l.amount * (l.interest_rate / 100);
      const saldo = totalConInteres - totalRecau;
      const pct = Math.min(
        Math.round((totalRecau / totalConInteres) * 100),
        100,
      );

      // Enviamos los parámetros en el orden que tu función los recibe
      return renderLoanCard(l, client, st, totalRecau, saldo, pct);
    })
    .join("");
}

function renderLoanCard(loan, client, st, totalRec, saldo, pct) {

  const total = parseFloat(loan.amount) * (1 + parseFloat(loan.interest_rate) / 100);
  const nc = ncuotas(loan.collection_mode, loan.weeks);
  const cuota = total / nc;
  const color = {
    paid: "#00e5a0",
    overdue: "#ff4444",
    active: "#0099ff",
    pending: "#ffb347",
  }[st];

  return `
    <div class="dc" style="border-left: 4px solid ${color}">
      <div class="dc-top" onclick="window._app.openLoanDetail('${loan.id}')" style="cursor:pointer">
        <div style="flex:1">
          <div style="font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:1px">Préstamo #${loan.id.slice(0, 5)}</div>
          <div class="dc-name">${client.full_name}</div>
          <div style="font-size:12px; color:var(--text)">Vence: <b>${new Date(loan.due_date).toLocaleDateString()}</b></div>
        </div>
        <div style="text-align:right">
          <div class="badge ${STATUS_CLASS[st]}">${STATUS_LABEL[st]}</div>
          <div style="font-size:16px; font-weight:bold; margin-top:5px; color:var(--p1)">${fmt(saldo)}</div>
        </div>
      </div>

      <div style="margin: 10px 0 5px 0; background: var(--s2); height: 6px; border-radius: 3px; overflow: hidden;">
        <div style="width: ${pct}%; background: ${color}; height: 100%; transition: width 0.3s ease;"></div>
      </div>

      <div class="dc-row" style="font-size:11px">
        <span>Cuotas: ${nc}</span>
        <span>Cuota: ${fmt(cuota)}</span>
        <span>Interés: ${loan.interest_rate}%</span>
        <span>Capital: ${fmt(loan.amount)}</span>
      </div>

      <div style="display:flex; gap:8px; margin-top:12px">
        <button class="btn-p" style="flex:2; padding:8px" onclick="window._app.openAddPayment('${loan.id}')">
          💵 Registrar Abono
        </button>
        <button class="btn-s" style="flex:1; background:none; border:1px solid var(--border)" onclick="window._app.openClientDetail('${client.id}')">
          👤 Perfil
        </button>
      </div>
    </div>
  `;
}

function setLoanFilter(f) {
  state.loanFilter = f;
  renderLoanChips();
  updateLoansList();
  renderLoans();
}

function openLoanDetail(loanId) {
  // 1. Obtener datos del préstamo y sus pagos
  const loan = state.loans.find(l => l.id === loanId);
  if (!loan) return;

  const loanPayments = state.payments.filter(p => p.loan_id === loanId);
  
  // 2. Cálculos financieros
  const totalDebe = parseFloat(loan.amount) * (1 + parseFloat(loan.interest_rate) / 100);
  const totalRec = loanPayments.reduce((acc, p) => acc + parseFloat(p.amount), 0);
  const saldo = totalDebe - totalRec;
  const pct = Math.min(Math.round((totalRec / totalDebe) * 100), 100);
  const st = statusOf(loan, state.payments);

  // 3. Construir el HTML del Modal
  document.getElementById("modal-content").innerHTML = `
    <div class="modal-title">Detalle del Préstamo</div>
    <div class="modal-sub">ID: ${loan.id.slice(0, 8).toUpperCase()}</div>

    <div style="background:var(--s2); border-radius:20px; padding:20px; margin-top:20px; border:1px solid var(--border)">
      <div style="text-align:center; margin-bottom:20px">
        <div style="font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:1px">Saldo Pendiente</div>
        <div style="font-size:32px; font-weight:800; color:var(--p1)">${fmt(saldo)}</div>
        <div class="badge ${STATUS_CLASS[st]}" style="margin-top:8px">${STATUS_LABEL[st]}</div>
      </div>

      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px; border-top:1px solid var(--border); padding-top:15px">
        <div>
          <label style="font-size:10px; color:var(--muted); text-transform:uppercase">Capital Inicial</label>
          <div style="font-weight:bold; font-size:15px">${fmt(loan.amount)}</div>
        </div>
        <div>
          <label style="font-size:10px; color:var(--muted); text-transform:uppercase">Interés (${loan.interest_rate}%)</label>
          <div style="font-weight:bold; font-size:15px">${fmt(totalDebe - loan.amount)}</div>
        </div>
        <div>
          <label style="font-size:10px; color:var(--muted); text-transform:uppercase">Total a Pagar</label>
          <div style="font-weight:bold; font-size:15px">${fmt(totalDebe)}</div>
        </div>
        <div>
          <label style="font-size:10px; color:var(--muted); text-transform:uppercase">Fecha Vence</label>
          <div style="font-weight:bold; font-size:15px">${loan.due_date ? new Date(loan.due_date + "T12:00:00").toLocaleDateString() : "N/A"}</div>
        </div>
      </div>

      <div style="margin-top:20px">
        <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:5px">
          <span style="color:var(--muted)">Progreso de recaudación</span>
          <span style="font-weight:bold">${pct}%</span>
        </div>
        <div style="background:var(--s1); height:8px; border-radius:4px; overflow:hidden">
          <div style="width:${pct}%; background:var(--p1); height:100%; transition: width 0.5s ease"></div>
        </div>
      </div>
    </div>

    <div class="sec-lbl" style="margin:25px 0 12px 0; display:flex; justify-content:space-between; align-items:center">
      <span>Historial de Abonos</span>
      <span style="font-size:11px; color:var(--muted)">${loanPayments.length} pagos</span>
    </div>

    <div style="display:flex; flex-direction:column; gap:10px; max-height:250px; overflow-y:auto; padding-right:5px">
      ${
        loanPayments.length === 0
          ? `<div style="text-align:center; padding:20px; color:var(--muted); font-size:13px; background:var(--s1); border-radius:12px; border:1px dashed var(--border)">No hay abonos registrados todavía.</div>`
          : loanPayments
              .map(
                (p) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 15px; background:var(--s1); border-radius:12px; border:1px solid var(--border)">
              <div>
                <div style="font-weight:700; font-size:14px; color:var(--text)">${fmt(p.amount)}</div>
                <div style="font-size:11px; color:var(--muted)">${new Date(p.created_at).toLocaleDateString()}</div>
              </div>
              <div style="text-align:right">
                <div style="font-size:10px; color:var(--muted); text-transform:uppercase">Método</div>
                <div style="font-size:11px; font-weight:600">${p.payment_method || "Efectivo"}</div>
              </div>
            </div>
          `,
              )
              .join("")
      }
    </div>
    
    <button class="btn-s" style="width:100%; margin-top:20px; background:none; border:1px solid var(--border)" onclick="window._app.closeModal()">
      Cerrar Detalle
    </button>
  `;

  openModal();
}

function openAddPayment(loanId) {
  const loan = state.loans.find((l) => l.id === loanId);
  const client = state.clients.find((c) => c.id === loan.client_id);

  // 1. Cálculos de estado actual
  const loanPayments = state.payments.filter((p) => p.loan_id === loanId);
  const totalDebe =
    parseFloat(loan.amount) * (1 + parseFloat(loan.interest_rate) / 100);
  const totalRec = loanPayments.reduce(
    (acc, p) => acc + parseFloat(p.amount),
    0,
  );
  const saldoActual = totalDebe - totalRec;
  const pct = Math.min(Math.round((totalRec / totalDebe) * 100), 100);
  const st = statusOf(loan, state.payments);
  const color = {
    paid: "#00e5a0",
    overdue: "#ff4444",
    active: "#0099ff",
    pending: "#ffb347",
  }[st];

  document.getElementById("modal-content").innerHTML = `
    <div class="modal-title">Registrar Abono</div>
    <div class="modal-sub">Cliente: ${client.full_name}</div>

    <div style="background:var(--s2); border-radius:16px; padding:16px; margin-top:15px; border:1px solid var(--border)">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px">
        <div>
          <div style="font-size:10px; color:var(--muted); text-transform:uppercase">Deuda Total</div>
          <div style="font-size:18px; font-weight:bold; color:var(--text)">${fmt(totalDebe)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px; color:var(--muted); text-transform:uppercase">Saldo Restante</div>
          <div style="font-size:18px; font-weight:bold; color:var(--p1)">${fmt(saldoActual)}</div>
        </div>
      </div>

      <div style="background:var(--s1); height:6px; border-radius:3px; overflow:hidden; margin-bottom:12px">
        <div style="width:${pct}%; background:${color}; height:100%"></div>
      </div>

      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; font-size:11px; color:var(--muted)">
        <span>Capital: <b>${fmt(loan.amount)}</b></span>
        <span style="text-align:right">Interés: <b>${loan.interest_rate}%</b></span>
      </div>
    </div>

    <div style="margin-top:20px">
      <div class="fg">
        <label class="fl">Monto del Abono</label>
        <input type="number" id="pay-amount" class="fi" 
               placeholder="¿Cuánto paga hoy?" 
               style="font-size:24px; font-weight:800; height:60px; text-align:center; color:var(--p1)">
      </div>

      <div class="fg" style="margin-top:15px">
        <label class="fl">Fecha de Recaudo</label>
        <input type="date" id="pay-date" class="fi" 
               value="${new Date().toISOString().split("T")[0]}">
      </div>

      <div class="fg" style="margin-top:15px">
        <label class="fl">Método de Pago</label>
        <select id="pay-method" class="fi">
          <option value="cash">Efectivo</option>
          <option value="transfer">Transferencia / Nequi</option>
        </select>
      </div>
    </div>

    <div style="margin-top:25px; display:flex; gap:10px">
      <button class="btn-p" style="flex:2; height:52px; font-size:16px; font-weight:bold" onclick="window._app.savePayment('${loan.id}')">
        Confirmar Pago
      </button>
      <button class="btn-s" style="flex:1; background:none; border:1px solid var(--border)" onclick="window._app.closeModal()">
        Cancelar
      </button>
    </div>
  `;

  openModal();
  // Foco automático en el monto para agilizar el cobro
  setTimeout(() => document.getElementById("pay-amount").focus(), 300);
}

// ══════════════════════════════════════════════════════════
// CLIENTS / DEUDORES
// ══════════════════════════════════════════════════════════
let clientsFilter = "all";

function renderClientChips() {
  const container = document.getElementById("clients-filter-container");
  if (!container) return;

  const filters = [
    { id: "all", label: "👥 Todos" },
    { id: "clientsActive", label: "✅ Activos" },
    { id: "clientsInactive", label: "⏳ Inactivos" },
  ];

  container.innerHTML = filters
    .map(
      (f) => `
    <div class="chip ${clientsFilter === f.id ? "active" : ""}" 
         onclick="window._app.setClientFilter('${f.id}')">
      ${f.label}
    </div>
  `,
    )
    .join("");
}

function updateClientsList() {
  const listContainer = document.getElementById("clients-list-container");
  if (!listContainer) return;

  const q = (state.searchQuery || "").toLowerCase();
  const { clients, loans, payments, isAdmin, users } = state;

  // Lógica de Filtrado
  const filtered = clients.filter((c) => {
    const matchesSearch =
      c.full_name.toLowerCase().includes(q) ||
      (c.id_number && c.id_number.includes(q));

    // Calcular deuda activa para el filtro
    const cLoans = loans.filter((l) => l.client_id === c.id);
    const hasLiveDebt = cLoans.some((l) => {
      const st = statusOf(l, payments);
      return st === "active" || st === "overdue" || st === "pending";
    });

    if (clientsFilter === "clientsActive") return matchesSearch && hasLiveDebt;
    if (clientsFilter === "clientsInactive")
      return matchesSearch && !hasLiveDebt;
    return matchesSearch;
  });

  if (!filtered.length) {
    listContainer.innerHTML = `<div class="empty"><div class="ei">📋</div><p>No hay clientes.<br>Crea uno desde <b>Nuevo</b>.</p></div>`;
    return;
  }

  // Renderizado de Cards
  listContainer.innerHTML = filtered
    .map((c) => {
      const cLoans = loans.filter((l) => l.client_id === c.id);
      const hasLiveDebt = cLoans.some((l) => {
        const st = statusOf(l, payments);
        return st === "active" || st === "overdue" || st === "pending";
      });

      const statusText = hasLiveDebt ? "ACTIVO" : "INACTIVO";
      const statusClass = hasLiveDebt ? "b-paid" : "b-active";

      // Lógica de foto
      const photoHtml = c.photo
        ? `<img src="${c.photo}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid var(--border)">`
        : `<div style="width:40px;height:40px;border-radius:50%;background:var(--s2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">👤</div>`;

      return `
      <div class="dc">
        <div class="dc-top" onclick="window._app.openClientDetail('${c.id}')" style="display: flex; align-items: center; justify-content: space-between;">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
            ${photoHtml}
            <div style="min-width:0">
              <div class="dc-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.full_name}</div>
              <div class="dc-sub">
                ID: ${c.id_number || "Sin cédula"} • ${cLoans.length} préstamos
              </div>
            </div>
          </div>
          <div class="badge ${statusClass}" style="font-size:10px;">${statusText}</div>
        </div>
      </div>`;
    })
    .join("");
}

function renderClients() {
  const q = (
    document.getElementById("client-search")?.value || ""
  ).toLowerCase();

  // 1. Si el contenedor está vacío o no tiene el buscador, dibujamos la estructura base una sola vez
  if (!document.querySelector(".clients-sticky")) {
    document.getElementById("screen-clients").innerHTML = `
      <div class="clients-sticky">
        <div class="search-wrap">
          <svg class="search-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="client-search" placeholder="Buscar cliente..." oninput="window._app.handleClientSearch(this.value)" value="${q}">
        </div>
        <div class="filter-row" id="clients-filter-container">
          </div>
      </div>
      <div id="clients-list-container" class="clients-list-wrap">
        </div>
    `;
    renderClientChips(); // Dibujar los filtros por primera vez
  }

  // 2. Llamamos a la función que solo actualiza las cards
  updateClientsList();
}

function handleClientSearch(val) {
  state.searchQuery = val;
  updateClientsList(); // Solo actualiza las cards, el input ni se entera
}

function setClientFilter(f) {
  clientsFilter = f;
  renderClientChips();
  updateClientsList();
}

async function delClient(clientId) {
  const client = state.clients.find((c) => c.id === clientId);

  // 2. Filtrar préstamos asociados que NO estén pagados
  // Consideramos 'active', 'overdue' o 'pending' como impedimentos
  const pendingLoans = state.loans.filter(
    (l) => l.client_id === clientId && l.status !== "paid",
  );

  // 3. Validación de Bloqueo
  if (pendingLoans.length > 0) {
    showToast(
      `⚠️ No se puede eliminar a ${client?.full_name || "este cliente"}. Tiene ${pendingLoans.length} préstamo(s) pendiente(s) o activo(s).`,
    );
    return;
  }

  if (
    !confirm(
      `¿Eliminar a "${client?.full_name}"? Se conservarán sus préstamos en el historial.`,
    )
  )
    return;
  const { error } = await deleteClient(clientId, state.token);
  if (error) {
    showToast("❌ Error al eliminar cliente");
    return;
  }
  setState({ clients: state.clients.filter((c) => c.id !== clientId) });
  closeModal();
  renderClients();
  renderDashboard();
  showToast("✅ Cliente eliminado correctamente");
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

  // --- ORDENAR PRÉSTAMOS ---
  // 1. Los no pagados arriba. 2. Por fecha de inicio descendente.
  const sortedLoans = clientLoans.sort((a, b) => {
    const isAPending = a.status !== "paid" && a.status !== "canceled";
    const isBPending = b.status !== "paid" && b.status !== "canceled";
    if (isAPending && !isBPending) return -1;
    if (!isAPending && isBPending) return 1;
    return new Date(b.start_date) - new Date(a.start_date);
  });

  // Reutilizamos tu lógica de renderLoanCard pero sin el margen exterior para que encaje en el details
  const renderLoanCard = (l) => {
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
            const methodColor =
              p.payment_method === "transfer" ? "var(--blue)" : "var(--accent)";
            return `
            <div class="pay-item">
              <div>
                <div class="pamt">${fmt(p.amount)}</div>
                <div class="pdate">${p.payment_date} · <span style="color:${methodColor}">${p.payment_method === "transfer" ? "🏦" : "💵"}</span></div>
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
      const isPaid = rec >= ca - 0.1; // margen de error decimal
      return `<tr class="${isPaid ? "r-paid" : ""}"><td>${i + 1}</td><td>${fmt(cuota)}</td><td>${fmt(ca)}</td><td>${fmt(Math.max(0, total - ca))}</td></tr>`;
    }).join("");

    return `
      <div class="loan-detail-inner" style="padding-top:10px">
        <div style="height:4px;background:var(--border);border-radius:99px;overflow:hidden;margin-bottom:12px">
          <div style="height:100%;width:${pct}%;background:${color}"></div>
        </div>
        <div class="m-kpis" style="margin-bottom:15px">
          <div class="m-kpi"><div class="m-kpi-val c-green">${fmt(rec)}</div><div class="m-kpi-lbl">RECAUDADO</div></div>
          <div class="m-kpi"><div class="m-kpi-val c-orange">${fmt(saldo)}</div><div class="m-kpi-lbl">SALDO</div></div>
          <div class="m-kpi"><div class="m-kpi-val c-blue">${fmt(cuota)}</div><div class="m-kpi-lbl">CUOTA</div></div>
        </div>
        <div class="sec-lbl">Historial de pagos</div>
        <div class="pay-log">${paysHtml}</div>
        <div class="sec-lbl">Amortización (${modeLabel(l.collection_mode)})</div>
        <div class="amort-wrap"><table class="amort-table"><tbody>${amortRows}</tbody></table></div>
        ${isAdmin ? `<button class="btn-d" style="margin-top:15px; width:100%" onclick="window._app.delLoan('${l.id}')">🗑 Eliminar préstamo</button>` : ""}
      </div>`;
  };

  // --- GENERAR LISTA DE ACORDEONES ---
  const loansHtml = sortedLoans
    .map((l, index) => {
      const total =
        parseFloat(l.amount) * (1 + parseFloat(l.interest_rate) / 100);
      const st = statusOf(l, payments);

      return `
      <details class="history-item" style="margin-bottom:10px; border:1px solid var(--border); border-radius:12px; overflow:hidden; background:var(--s1)">
        <summary style="padding:12px; cursor:pointer; list-style:none; display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; flex-direction:column; gap:2px">
            <div style="font-weight:700; font-size:14px; color:var(--text)">
              ${fmt(l.amount)} <span style="color:var(--muted); font-weight:400; font-size:12px">→ ${fmt(total)}</span>
            </div>
            <div style="font-size:11px; color:var(--muted)">Inició: ${l.start_date}</div>
          </div>
          <div style="display:flex; align-items:center; gap:8px">
            <span class="badge ${STATUS_CLASS[st]}" style="font-size:10px; padding:2px 8px">${STATUS_LABEL[st].toUpperCase()}</span>
            <span class="arrow" style="font-size:14px; color:var(--muted)">▾</span>
          </div>
        </summary>
        <div style="padding:0 12px 12px 12px; border-top:1px solid var(--border); background:var(--s2)">
          ${renderLoanCard(l)}
        </div>
      </details>`;
    })
    .join("");

  // Foto y Formulario (manteniendo tu lógica)
  const photoHtml = client.photo
    ? `<img src="${client.photo}" 
            class="profile-photo"
            style="width:80px;height:80px;border-radius:50%;object-fit:cover;flex-shrink:0;border:2px solid var(--border);cursor: pointer"
            onclick="window._app.viewPhoto('${client.photo}', '${client.full_name}')">`
    : `<div style="width:40px;height:40px;border-radius:50%;background:var(--s2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">👤</div>`;

  // Edit form (admin only)
  const editFormHtml = isAdmin
    ? `
    <div id="edit-client-section" style="display:none;background:var(--s2);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:14px">
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
        <div style="display: flex; gap: 10px; margin-top: 15px;">
          <button class="btn-p" style="flex: 2;" onclick="window._app.saveClientEdit('${clientId}')">
            💾 Guardar cambios
          </button>
          <button class="btn-s" style="flex: 1; background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--text);" 
                  onclick="document.getElementById('edit-client-section').style.display='none'; document.getElementById('btn-show-client-edit').style.display='block'">
            Cancelar
          </button>
      </div>
    </div>`
    : "";

  document.getElementById("modal-content").innerHTML = `
    <div class="modal-title">${client.full_name}</div>
    <div class="modal-sub">ID: ${client.id_number || "Sin cédula"} · Celular: ${client.phone || "Sin teléfono"}</div>
    
    <div style="margin-top:16px">
       ${photoHtml}
    </div>

    <div style="margin-top:16px">
       ${editFormHtml}
    </div>


    <div class="sec-lbl" style="margin-top:20px">Historial de Préstamos</div>
    ${loansHtml || '<p style="color:var(--muted);font-size:13px;padding:10px">No tiene préstamos registrados.</p>'}

    <button class="btn-p" style="margin-top:20px" onclick="window._app.goNewLoan('${clientId}')">＋ Nuevo préstamo</button>
    ${
      isAdmin
        ? `
        <button id="btn-show-client-edit" class="btn-s" style="margin-top:8px; background:none; border:1px solid var(--border)" onclick="window._app.showEditClientForm()">✏️ Editar Datos Del Cliente</button>
        <button class="btn-d" 
                style="margin-top:12px; background:rgba(255,68,68,0.1); color:var(--red); border:1px solid rgba(255,68,68,0.2)" 
                onclick="window._app.delClient('${client.id}')">
          🗑 Eliminar Cliente por completo
        </button>
      `
        : ""
    }
  `;
  openModal();
}

function showEditClientForm() {
  const section = document.getElementById("edit-client-section");
  const btnEditar = document.getElementById("btn-show-client-edit");
  if (section) {
    // Si está oculto lo muestra, si está visible lo oculta
    const isHidden = section.style.display === "none";
    section.style.display = isHidden ? "block" : "none";

    // Opcional: Hacer scroll suave hacia el formulario
    if (isHidden) {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    if(btnEditar) {
      btnEditar.style.display = "none";
    }

    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }
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
  renderClients();
  openClientDetail(clientId);
}

// ── Foto: compresión y guardado ─────────────────────────────────
async function handlePhoto(event, clientId) {
  const file = event.target.files?.[0];
  if (!file) return;
  showToast("Comprimiendo imagen...");

  try {
    const compressed = await compressImage(file, 400, 400, 0.7);
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

function viewPhoto(url, name) {
  const viewer = document.createElement("div");
  viewer.style = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.9); z-index: 10000;
    display: flex; align-items: center; justify-content: center;
    cursor: zoom-out;
  `;
  viewer.onclick = () => viewer.remove();

  viewer.innerHTML = `
    <div style="position: relative; width: 90%; max-width: 500px;">
      <img src="${url}" style="width: 100%; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
      <div style="color: white; text-align: center; margin-top: 15px; font-family: 'Syne', sans-serif;">
        ${name}
      </div>
    </div>
  `;
  document.body.appendChild(viewer);
}


// ══════════════════════════════════════════════════════════
// NUEVO (cliente + préstamo)
// ══════════════════════════════════════════════════════════
let newLoanClientId = null;

async function goNewLoan(clientId) {
  // 1. Verify if the client already has an active loan
  const { loans, payments, clients } = state;
  const clientLoans = loans.filter((l) => l.client_id === clientId && l.status === "active");

  if (clientLoans.length > 0) {
    alert(
      "This client already has an active loan. It must be closed before opening a new one.",
    );
    return;
  }

  // 2. If no active loan exists, open the form passing the fixed clientId
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
  newLoanClientId = newLoanClientId ?? null;
  document.getElementById("screen-nuevo").innerHTML = `
    <div class="card form-sec">
      <div class="card-title">Datos del cliente</div>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:4px">
        <div id="new-photo-preview" style="width:64px;height:64px;border-radius:50%;background:var(--s2);border:2px solid var(--border);overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:24px">👤</div>
        <label style="background:var(--s2);border:1px solid var(--border);border-radius:10px;padding:9px 14px;font-size:13px;cursor:pointer;color:var(--text);flex:1;text-align:center">
          📷 Agregar foto
          <input type="file" accept="image/*" capture="environment" id="new-photo-input" style="display:none" onchange="window._app.handleNewPhoto(event)" required>
        </label>
      </div>
      <div class="fg"><label class="fl">Nombre completo *</label><input class="fi" id="f-name" placeholder="Juan Pérez" required></div>
      <div class="fg"><label class="fl">Cédula *</label><input class="fi" id="f-id" placeholder="123456789" inputmode="numeric" required></div>
      <div class="fg"><label class="fl">Teléfono *</label><input class="fi" id="f-tel" placeholder="300 000 0000" inputmode="numeric" required></div>
      <div class="fg"><label class="fl">Dirección *</label><input class="fi" id="f-addr" placeholder="Calle 1 # 2-3" required></div>
      <div class="fg"><label class="fl">Notas del cliente</label><input class="fi" id="f-notes" placeholder="Observaciones adicionales..."></div>
    </div>
    <div class="card form-sec">
      <div class="card-title">Condiciones del préstamo</div>
      <div class="fg"><label class="fl">Monto ($)</label><input class="fi" id="f-amount" type="number" value="200000" oninput="window._app.updatePreview()" required></div>
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
  const weeks = parseInt(document.getElementById("f-weeks").value) || 0;
  const startDateValue = document.getElementById("f-date").value;
  const startDate = new Date(startDateValue + "T12:00:00");
  const dueDateObj = new Date(startDate);
  dueDateObj.setDate(startDate.getDate() + weeks * 7);
  const dueDateValue = dueDateObj.toISOString().split("T")[0];

  if (!name || !idNum || !phone || !addr) {
    showToast("⚠️ Todos los campos con asterisco son obligatorios.");
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
    start_date: startDateValue,
    due_date: dueDateValue,
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
async function savePayment(loanId) {
  // 1. Capturar elementos del nuevo modal
  const amountInput = document.getElementById("pay-amount");
  const dateInput = document.getElementById("pay-date");
  const methodInput = document.getElementById("pay-method");

  const amount = parseFloat(amountInput?.value);
  const paymentDate = dateInput?.value || today();
  const method = methodInput?.value || "Efectivo";

  // 2. Validación básica
  if (!amount || amount <= 0) {
    showToast("Ingresa un monto válido");
    return;
  }

  const payData = {
    loan_id: loanId,
    amount,
    payment_date: paymentDate,
    payment_method: method,
  };

  // 3. Lógica de guardado (Online / Offline)
  if (navigator.onLine) {
    const { data, error } = await createPayment(payData, state.token);
    if (error) {
      showToast("Error al registrar pago");
      return;
    }
    // Aseguramos que el loan_id esté presente en el objeto para el estado local
    const newPay = { ...data, loan_id: loanId };
    setState({ payments: [...state.payments, newPay] });
    await putOne(STORES.PAYMENTS, newPay);
  } else {
    // Modo Offline
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

  // 4. Finalización y Feedback
  showToast("Pago registrado ✓");

  // Cerramos el modal
  closeModal();

  // 5. Refrescar Vistas
  // Si estamos en la pestaña de préstamos, refrescamos los préstamos
  if (state.view === "loans") {
    renderLoans();
  } else {
    // Si veníamos desde el detalle del cliente, lo refrescamos
    const clientId = state.loans.find((l) => l.id === loanId)?.client_id;
    if (clientId) openClientDetail(clientId);
    renderDashboard();
  }
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
      <div class="sum-row" style="margin-top:4px;padding-top:4px">
        <span class="sl" style="font-weight:700;color:var(--text)">= Capital disponible ahora</span>
        <span class="sv ${capitalDisponible >= 0 ? "c-green" : "c-red"}" style="font-size:17px;font-weight:700">${fmt(capitalDisponible)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:10px;">
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
      <div class="sum-row" style="padding-top:8px;margin-top:4px;">
        <span class="sl" style="color:var(--text)">Total recaudado</span>                              <span class="sv c-green">${fmt(rec)}</span>
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
  renderLoans,
  renderLoanCard,
  setLoanFilter,
  openLoanDetail,
  openAddPayment,
  renderClients,
  handleClientSearch,
  updateClientsList,
  renderClientChips,
  setClientFilter,
  delClient,
  openClientDetail,
  goNewLoan,
  showEditClientForm,
  saveClientEdit,
  handlePhoto,
  removePhoto,
  handleNewPhoto,
  viewPhoto,
  updatePreview,
  crearPrestamo,
  savePayment,
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
