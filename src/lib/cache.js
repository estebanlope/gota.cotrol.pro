/**
 * cache.js
 * ─────────────────────────────────────────────────────────────
 * Manejo de caché local con IndexedDB.
 * - Almacena loans, payments, clients, expenses para acceso offline
 * - Mantiene una cola de operaciones pendientes de sincronización
 * ─────────────────────────────────────────────────────────────
 */

const DB_NAME    = 'gota_control'
const DB_VERSION = 2

const STORES = {
  LOANS:    'loans',
  PAYMENTS: 'payments',
  CLIENTS:  'clients',
  EXPENSES: 'expenses',
  QUEUE:    'sync_queue'
}

let _db = null

/** Abre (o inicializa) la base de datos IndexedDB */
export function openDB() {
  if (_db) return Promise.resolve(_db)

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORES.LOANS))
        db.createObjectStore(STORES.LOANS,    { keyPath: 'id' })
      if (!db.objectStoreNames.contains(STORES.PAYMENTS))
        db.createObjectStore(STORES.PAYMENTS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(STORES.CLIENTS))
        db.createObjectStore(STORES.CLIENTS,  { keyPath: 'id' })
      if (!db.objectStoreNames.contains(STORES.EXPENSES))
        db.createObjectStore(STORES.EXPENSES, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(STORES.QUEUE))
        db.createObjectStore(STORES.QUEUE,    { keyPath: 'qid', autoIncrement: true })
    }

    req.onsuccess = (e) => { _db = e.target.result; resolve(_db) }
    req.onerror   = (e) => reject(e.target.error)
  })
}

/** Obtiene todos los registros de un store */
export async function getAll(storeName) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readonly')
    const req = tx.objectStore(storeName).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror   = () => reject(req.error)
  })
}

/** Guarda un array de registros en un store (upsert) */
export async function putAll(storeName, items) {
  if (!items?.length) return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const os = tx.objectStore(storeName)
    items.forEach(item => os.put(item))
    tx.oncomplete = resolve
    tx.onerror    = () => reject(tx.error)
  })
}

/** Guarda un registro individual */
export async function putOne(storeName, item) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).put(item)
    tx.oncomplete = resolve
    tx.onerror    = () => reject(tx.error)
  })
}

/** Elimina un registro por clave */
export async function deleteOne(storeName, key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).delete(key)
    tx.oncomplete = resolve
    tx.onerror    = () => reject(tx.error)
  })
}

/** Limpia un store completo y lo reemplaza con nuevos datos */
export async function replaceAll(storeName, items) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const os = tx.objectStore(storeName)
    os.clear()
    items.forEach(item => os.put(item))
    tx.oncomplete = resolve
    tx.onerror    = () => reject(tx.error)
  })
}

// ── SYNC QUEUE ──────────────────────────────────────────────

/**
 * Agrega una operación a la cola de sincronización offline.
 * @param {{ type, payload, userId, localId }} op
 */
export async function queueAdd(op) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.QUEUE, 'readwrite')
    const req = tx.objectStore(STORES.QUEUE).add({ ...op, createdAt: Date.now() })
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

/** Obtiene toda la cola pendiente */
export async function queueGetAll() {
  return getAll(STORES.QUEUE)
}

/** Elimina una operación de la cola por su qid */
export async function queueDelete(qid) {
  return deleteOne(STORES.QUEUE, qid)
}

/** Limpia toda la cola (tras sync exitoso) */
export async function queueClear() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.QUEUE, 'readwrite')
    tx.objectStore(STORES.QUEUE).clear()
    tx.oncomplete = resolve
    tx.onerror    = () => reject(tx.error)
  })
}

export { STORES }
