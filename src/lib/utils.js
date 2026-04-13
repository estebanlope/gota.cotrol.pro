/** Formatea número como moneda colombiana */
export const fmt  = n => '$' + Math.round(n || 0).toLocaleString('es-CO')
export const fmtS = n => {
  n = n || 0
  if (n >= 1e6)  return '$' + (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3)  return '$' + Math.round(n / 1e3) + 'k'
  return '$' + Math.round(n)
}

const now = new Date();
export const today = () => new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString().split("T")[0];
export const uid   = () => Date.now().toString(36) + Math.random().toString(36).slice(2)

export function ncuotas(mode, weeks) {
  weeks = parseInt(weeks) || 4
  if (mode === 'daily')    return Math.ceil(weeks * 7 / 5) * 5
  if (mode === 'weekly')   return weeks
  if (mode === 'biweekly') return Math.ceil(weeks / 2)
  return weeks
}

export function modeLabel(m) {
  return { daily: 'Diario', weekly: 'Semanal', biweekly: 'Bisemanal' }[m] || m
}

export function statusOf(loan, payments) {
  const pays = payments.filter(p => p.loan_id === loan.id)
  const total = parseFloat(loan.amount) * (1 + parseFloat(loan.interest_rate) / 100)
  const paid  = pays.reduce((s, p) => s + parseFloat(p.amount), 0)
  if (paid >= total - 0.01) return 'paid'
  if (paid === 0) return 'pending'
  const end = new Date(loan.start_date)
  end.setDate(end.getDate() + parseInt(loan.weeks) * 7)
  if (new Date() > end) return 'overdue'
  return 'active'
}

// Retorna un string ISO ajustado a la zona horaria de Colombia
export const getColombiaISO = () => {
  const now = new Date();
  // Ajustamos restando 5 horas
  const col = new Date(now.getTime() - (5 * 60 * 60 * 1000));
  return col.toISOString();
}

export const STATUS_LABEL = {
  paid: "✅ Pagado",
  active: "🔄 En curso",
  clientsActive: "✅ Activo",
  clientsInactive: "📁 Inactivo",
  pending: "⏳ Sin iniciar",
  overdue: "⚠️ Mora",
};

export const STATUS_CLASS = {
  paid:    'b-paid',
  active:  'b-active',
  pending: 'b-pending',
  overdue: 'b-overdue'
}

export const EXP_CATEGORY = {
  fuel:      '⛽ Gasolina',
  transport: '🚌 Transporte',
  other:     '📦 Otro'
}
