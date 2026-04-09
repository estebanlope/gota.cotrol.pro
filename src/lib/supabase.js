/**
 * supabase.js
 * ─────────────────────────────────────────────────────────────
 * Conector entre el frontend (Netlify/Vite) y el backend (Supabase).
 *
 * ARQUITECTURA DE SEGURIDAD:
 * El cliente nunca accede a las tablas directamente.
 * Todo va por funciones RPC con SECURITY DEFINER en Supabase,
 * que verifican el token de sesión antes de ejecutar cualquier acción.
 * El token se pasa como parámetro a cada función.
 * ─────────────────────────────────────────────────────────────
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error(
    "Faltan VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en .env.local",
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ── Helper para manejar errores de RPC ──────────────────────────
function parseRpcError(error) {
  if (!error) return null;
  const msg = error.message || "";
  if (msg.includes("USUARIO_NO_ENCONTRADO")) return "Usuario no encontrado";
  if (msg.includes("PIN_INCORRECTO")) return "PIN incorrecto";
  if (msg.includes("NO_AUTORIZADO")) return "No autorizado";
  if (msg.includes("ROL_INVALIDO")) return "Rol inválido";
  if (msg.includes("PIN_INVALIDO"))
    return "El PIN debe ser 4 dígitos numéricos";
  if (msg.includes("duplicate key")) return "El usuario ya existe";
  return "Error inesperado: " + msg;
}

// ════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════

/**
 * Login con username + PIN de 4 dígitos.
 * Llama al RPC login() que verifica el PIN con pgcrypto
 * y crea la sesión en un solo paso.
 */
export async function loginUser(username, pin) {
  const { data, error } = await supabase.rpc("login", {
    p_username: username.toLowerCase().trim(),
    p_pin: pin,
  });

  if (error) return { error: parseRpcError(error) };
  if (!data?.length) return { error: "Error al iniciar sesión" };

  const row = data[0];
  return {
    user: {
      id: row.user_id,
      username: row.username,
      full_name: row.full_name,
      role: row.role,
    },
    token: row.token,
    expiresAt: row.expires_at,
  };
}

/**
 * Verifica si un token de sesión sigue activo.
 */
export async function verifySession(token) {
  const { data, error } = await supabase.rpc("verify_session", {
    p_token: token,
  });
  if (error || !data?.length) return null;
  const row = data[0];
  return {
    user: {
      id: row.user_id,
      username: row.username,
      full_name: row.full_name,
      role: row.role,
    },
  };
}

/**
 * Cierra sesión eliminando el token.
 */
export async function logoutUser(token) {
  await supabase.rpc("logout", { p_token: token });
}

// ════════════════════════════════════════════════════════════
// USERS
// ════════════════════════════════════════════════════════════

/**
 * Obtiene todos los usuarios (admin y cobradores).
 * Solo accesible para admins.
 */
export async function getUsers(token) {
  const { data, error } = await supabase.rpc("get_users", { p_token: token });
  return { data: data || [], error: error ? parseRpcError(error) : null };
}

/**
 * Crea un nuevo usuario (admin o cobrador).
 * Solo admins pueden crear usuarios.
 * @param {{ username, pin, full_name, role }} params  — role: 'admin' | 'collector'
 */
export async function createUser({ username, pin, full_name, role }, token) {
  const { data, error } = await supabase.rpc("create_user", {
    p_token: token,
    p_username: username,
    p_pin: pin,
    p_full_name: full_name,
    p_role: role,
  });
  return {
    data: data?.[0] || null,
    error: error ? parseRpcError(error) : null,
  };
}

/**
 * Desactiva un usuario (soft delete).
 */
export async function deactivateUser(userId, token) {
  const { error } = await supabase.rpc("deactivate_user", {
    p_token: token,
    p_user_id: userId,
  });
  return { error: error ? parseRpcError(error) : null };
}

// ════════════════════════════════════════════════════════════
// CLIENTS
// ════════════════════════════════════════════════════════════

/**
 * Obtiene clientes según el rol del token:
 * - Admin → todos los clientes
 * - Cobrador → solo los que creó
 */
export async function getClients(token) {
  const { data, error } = await supabase.rpc("get_clients", { p_token: token });
  return { data: data || [], error: error ? parseRpcError(error) : null };
}

/**
 * Crea un nuevo cliente.
 */
export async function addNewClient(
  { full_name, id_number, phone, address, notes, photo },
  token,
) {
  const { data, error } = await supabase.rpc("create_client", {
    p_token: token,
    p_full_name: full_name,
    p_id_number: id_number || null,
    p_phone: phone || null,
    p_address: address || null,
    p_notes: notes || null,
    p_photo: photo || null,
  });
  return {
    data: data?.[0] || null,
    error: error ? parseRpcError(error) : null,
  };
}

/**
 * Actualiza datos de un cliente incluyendo foto comprimida. Solo admin.
 * @param {string} clientId
 * @param {{ full_name, id_number, phone, address, notes, photo }} updates — photo es base64 JPEG
 * @param {string} token
 */
export async function updateClient(clientId, updates, token) {
  const { data, error } = await supabase.rpc("update_client", {
    p_token: token,
    p_client_id: clientId,
    p_full_name: updates.full_name || null,
    p_id_number: updates.id_number || null,
    p_phone: updates.phone || null,
    p_address: updates.address || null,
    p_notes: updates.notes || null,
    p_photo: updates.photo ?? null,
  });
  return {
    data: data?.[0] || null,
    error: error ? parseRpcError(error) : null,
  };
}

/**
 * Obtiene resumen financiero filtrado por rango de fechas.
 * Admin ve todo, cobrador ve solo sus datos.
 */
export async function getSummaryByRange(dateFrom, dateTo, token) {
  const { data, error } = await supabase.rpc("get_summary_by_range", {
    p_token: token,
    p_date_from: dateFrom,
    p_date_to: dateTo,
  });
  return { data: data || null, error: error ? parseRpcError(error) : null };
}

/**
 * Elimina (soft delete) un cliente. Solo admin.
 */
export async function deleteClient(clientId, token) {
  const { error } = await supabase.rpc("delete_client", {
    p_token: token,
    p_client_id: clientId,
  });
  return { error: error ? parseRpcError(error) : null };
}

// ════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════

/** Lee un valor de configuración global (todos los autenticados). */
export async function getConfig(key, token) {
  const { data, error } = await supabase.rpc("get_config", {
    p_token: token,
    p_key: key,
  });
  return { data: data ?? null, error: error ? parseRpcError(error) : null };
}

/** Actualiza un valor de configuración. Solo admin. */
export async function setConfig(key, value, token) {
  const { error } = await supabase.rpc("set_config", {
    p_token: token,
    p_key: key,
    p_value: String(value),
  });
  return { error: error ? parseRpcError(error) : null };
}

/**
 * Obtiene préstamos con datos del cliente y pagos embebidos.
 * Admin → todos. Cobrador → solo los suyos.
 */
export async function getLoans(token) {
  const { data, error } = await supabase.rpc("get_loans", { p_token: token });
  if (error) return { data: [], error: parseRpcError(error) };
  // data es un JSONB array
  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  return { data: parsed || [], error: null };
}

/**
 * Crea un préstamo nuevo.
 */
export async function createLoan(
  {
    client_id,
    amount,
    interest_rate,
    collection_mode,
    weeks,
    start_date,
    notes,
  },
  token,
) {
  const { data, error } = await supabase.rpc("create_loan", {
    p_token: token,
    p_client_id: client_id,
    p_amount: amount,
    p_interest_rate: interest_rate,
    p_collection_mode: collection_mode,
    p_weeks: weeks,
    p_start_date: start_date,
    p_notes: notes || null,
  });
  return {
    data: data?.[0] || null,
    error: error ? parseRpcError(error) : null,
  };
}

/**
 * Elimina un préstamo y sus pagos. Solo admin.
 */
export async function deleteLoan(loanId, token) {
  const { error } = await supabase.rpc("delete_loan", {
    p_token: token,
    p_loan_id: loanId,
  });
  return { error: error ? parseRpcError(error) : null };
}

// ════════════════════════════════════════════════════════════
// PAYMENTS
// ════════════════════════════════════════════════════════════

/**
 * Registra un pago con método (cash | transfer).
 */
export async function createPayment(
  { loan_id, amount, payment_date, notes, payment_method },
  token,
) {
  const { data, error } = await supabase.rpc("create_payment", {
    p_token: token,
    p_loan_id: loan_id,
    p_amount: amount,
    p_payment_date: payment_date,
    p_notes: notes || null,
    p_payment_method: payment_method || "cash",
  });
  return {
    data: data?.[0] || null,
    error: error ? parseRpcError(error) : null,
  };
}

/**
 * Actualiza un pago (monto, notas, método). Solo admin.
 */
export async function updatePayment(
  paymentId,
  { amount, notes, payment_method },
  token,
) {
  const { error } = await supabase.rpc("update_payment", {
    p_token: token,
    p_payment_id: paymentId,
    p_amount: amount,
    p_notes: notes || null,
    p_payment_method: payment_method || null,
  });
  return { error: error ? parseRpcError(error) : null };
}

/**
 * Elimina un pago. Solo admin.
 */
export async function deletePayment(paymentId, token) {
  const { error } = await supabase.rpc("delete_payment", {
    p_token: token,
    p_payment_id: paymentId,
  });
  return { error: error ? parseRpcError(error) : null };
}

// ════════════════════════════════════════════════════════════
// EXPENSES
// ════════════════════════════════════════════════════════════

/**
 * Obtiene gastos. Admin → todos. Cobrador → solo los suyos.
 */
export async function getExpenses(token) {
  const { data, error } = await supabase.rpc("get_expenses", {
    p_token: token,
  });
  return { data: data || [], error: error ? parseRpcError(error) : null };
}

/**
 * Registra un gasto.
 */
export async function createExpense(
  { category, description, amount, expense_date },
  token,
) {
  const { data, error } = await supabase.rpc("create_expense", {
    p_token: token,
    p_category: category,
    p_description: description,
    p_amount: amount,
    p_expense_date: expense_date,
  });
  return {
    data: data?.[0] || null,
    error: error ? parseRpcError(error) : null,
  };
}

/**
 * Elimina un gasto. Solo admin.
 */
export async function deleteExpense(expenseId, token) {
  const { error } = await supabase.rpc("delete_expense", {
    p_token: token,
    p_expense_id: expenseId,
  });
  return { error: error ? parseRpcError(error) : null };
}

// ════════════════════════════════════════════════════════════
// SYNC — Aplica cola offline
// ════════════════════════════════════════════════════════════

/**
 * Sincroniza operaciones pendientes cuando hay conexión.
 */
export async function syncOfflineQueue(queue, token) {
  let succeeded = 0,
    failed = 0;

  for (const op of queue) {
    try {
      switch (op.type) {
        case "create_client":
          await addNewClient(op.payload, token);
          break;
        case "create_loan":
          await createLoan(op.payload, token);
          break;
        case "create_payment":
          await createPayment(op.payload, token);
          break;
        case "create_expense":
          await createExpense(op.payload, token);
          break;
        default:
          console.warn("Op desconocida:", op.type);
      }
      succeeded++;
    } catch (e) {
      console.error("Sync failed:", op, e);
      failed++;
    }
  }

  return { succeeded, failed };
}
