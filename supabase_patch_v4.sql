-- ================================================================
-- GOTA CONTROL — SQL Patch v4
-- Ejecuta en Supabase → SQL Editor
-- ================================================================

-- ── 1. Tabla de configuración global (capital base, etc.) ────────
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by UUID REFERENCES users(id)
);

-- Capital base inicial: 20 millones
INSERT INTO config (key, value)
VALUES ('capital_base', '20000000')
ON CONFLICT (key) DO NOTHING;

-- ── 2. Funciones de config ───────────────────────────────────────

-- Leer un valor de config (disponible para todos los autenticados)
CREATE OR REPLACE FUNCTION get_config(p_token TEXT, p_key TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id UUID;
BEGIN
  SELECT u.id INTO v_user_id FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.token=p_token AND s.expires_at>now() AND u.is_active=TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  RETURN (SELECT value FROM config WHERE key = p_key);
END;
$$;

-- Actualizar un valor de config (solo admin)
CREATE OR REPLACE FUNCTION set_config(p_token TEXT, p_key TEXT, p_value TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id UUID;
BEGIN
  SELECT u.id INTO v_user_id FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.token=p_token AND s.expires_at>now() AND u.is_active=TRUE AND u.role='admin';
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  INSERT INTO config(key, value, updated_at, updated_by)
  VALUES(p_key, p_value, now(), v_user_id)
  ON CONFLICT(key) DO UPDATE SET value=p_value, updated_at=now(), updated_by=v_user_id;
END;
$$;

-- ── 3. Eliminar cliente (solo admin, soft delete) ────────────────
CREATE OR REPLACE FUNCTION delete_client(p_token TEXT, p_client_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=p_token AND s.expires_at>now() AND u.is_active=TRUE AND u.role='admin')
  THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  -- Soft delete: marcar inactivo (los préstamos/pagos se conservan)
  UPDATE clients SET is_active = FALSE WHERE id = p_client_id;
END;
$$;

-- ── 4. get_summary_by_range disponible para TODOS (no solo admin) ─
CREATE OR REPLACE FUNCTION get_summary_by_range(
  p_token     TEXT,
  p_date_from DATE,
  p_date_to   DATE
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_role    TEXT;
  v_result  JSONB;
BEGIN
  SELECT u.id, u.role INTO v_user_id, v_role
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = p_token AND s.expires_at > now() AND u.is_active = TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;

  IF v_role = 'admin' THEN
    -- Admin ve todo
    SELECT jsonb_build_object(
      'loans_count',    (SELECT COUNT(*)                   FROM loans l     WHERE l.start_date    BETWEEN p_date_from AND p_date_to),
      'loans_capital',  (SELECT COALESCE(SUM(l.amount),0)  FROM loans l     WHERE l.start_date    BETWEEN p_date_from AND p_date_to),
      'loans_interest', (SELECT COALESCE(SUM(l.amount*l.interest_rate/100),0) FROM loans l WHERE l.start_date BETWEEN p_date_from AND p_date_to),
      'loans_total',    (SELECT COALESCE(SUM(l.amount*(1+l.interest_rate/100)),0) FROM loans l WHERE l.start_date BETWEEN p_date_from AND p_date_to),
      'payments_count', (SELECT COUNT(*)                   FROM payments p  WHERE p.payment_date  BETWEEN p_date_from AND p_date_to),
      'payments_total', (SELECT COALESCE(SUM(p.amount),0)  FROM payments p  WHERE p.payment_date  BETWEEN p_date_from AND p_date_to),
      'expenses_total', (SELECT COALESCE(SUM(e.amount),0)  FROM expenses e  WHERE e.expense_date  BETWEEN p_date_from AND p_date_to),
      'clients_new',    (SELECT COUNT(*)                   FROM clients c   WHERE c.created_at::date BETWEEN p_date_from AND p_date_to),
      'payments_by_day',(SELECT COALESCE(jsonb_agg(jsonb_build_object('date',pay_day,'amount',day_total) ORDER BY pay_day),'[]'::jsonb)
                         FROM (SELECT p.payment_date AS pay_day, SUM(p.amount) AS day_total FROM payments p
                               WHERE p.payment_date BETWEEN p_date_from AND p_date_to GROUP BY p.payment_date) daily)
    ) INTO v_result;
  ELSE
    -- Cobrador ve solo sus datos
    SELECT jsonb_build_object(
      'loans_count',    (SELECT COUNT(*)                   FROM loans l     WHERE l.start_date    BETWEEN p_date_from AND p_date_to AND (l.created_by=v_user_id OR EXISTS(SELECT 1 FROM users u2 WHERE u2.id=l.created_by AND u2.role='admin'))),
      'loans_capital',  (SELECT COALESCE(SUM(l.amount),0)  FROM loans l     WHERE l.start_date    BETWEEN p_date_from AND p_date_to AND (l.created_by=v_user_id OR EXISTS(SELECT 1 FROM users u2 WHERE u2.id=l.created_by AND u2.role='admin'))),
      'loans_interest', (SELECT COALESCE(SUM(l.amount*l.interest_rate/100),0) FROM loans l WHERE l.start_date BETWEEN p_date_from AND p_date_to AND (l.created_by=v_user_id OR EXISTS(SELECT 1 FROM users u2 WHERE u2.id=l.created_by AND u2.role='admin'))),
      'loans_total',    (SELECT COALESCE(SUM(l.amount*(1+l.interest_rate/100)),0) FROM loans l WHERE l.start_date BETWEEN p_date_from AND p_date_to AND (l.created_by=v_user_id OR EXISTS(SELECT 1 FROM users u2 WHERE u2.id=l.created_by AND u2.role='admin'))),
      'payments_count', (SELECT COUNT(*)                   FROM payments p  JOIN loans l ON l.id=p.loan_id WHERE p.payment_date BETWEEN p_date_from AND p_date_to AND (l.created_by=v_user_id OR EXISTS(SELECT 1 FROM users u2 WHERE u2.id=l.created_by AND u2.role='admin'))),
      'payments_total', (SELECT COALESCE(SUM(p.amount),0)  FROM payments p  JOIN loans l ON l.id=p.loan_id WHERE p.payment_date BETWEEN p_date_from AND p_date_to AND (l.created_by=v_user_id OR EXISTS(SELECT 1 FROM users u2 WHERE u2.id=l.created_by AND u2.role='admin'))),
      'expenses_total', (SELECT COALESCE(SUM(e.amount),0)  FROM expenses e  WHERE e.expense_date  BETWEEN p_date_from AND p_date_to AND e.registered_by=v_user_id),
      'clients_new',    (SELECT COUNT(*)                   FROM clients c   WHERE c.created_at::date BETWEEN p_date_from AND p_date_to AND c.created_by=v_user_id),
      'payments_by_day',(SELECT COALESCE(jsonb_agg(jsonb_build_object('date',pay_day,'amount',day_total) ORDER BY pay_day),'[]'::jsonb)
                         FROM (SELECT p.payment_date AS pay_day, SUM(p.amount) AS day_total FROM payments p
                               JOIN loans l ON l.id=p.loan_id
                               WHERE p.payment_date BETWEEN p_date_from AND p_date_to
                                 AND (l.created_by=v_user_id OR EXISTS(SELECT 1 FROM users u2 WHERE u2.id=l.created_by AND u2.role='admin'))
                               GROUP BY p.payment_date) daily)
    ) INTO v_result;
  END IF;

  RETURN v_result;
END;
$$;

-- ── 5. RLS y grants ──────────────────────────────────────────────
ALTER TABLE config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "block_anon_config" ON config;
CREATE POLICY "block_anon_config" ON config FOR ALL TO anon USING (false);

GRANT EXECUTE ON FUNCTION get_config(TEXT, TEXT)          TO anon;
GRANT EXECUTE ON FUNCTION set_config(TEXT, TEXT, TEXT)    TO anon;
GRANT EXECUTE ON FUNCTION delete_client(TEXT, UUID)       TO anon;
GRANT EXECUTE ON FUNCTION get_summary_by_range(TEXT,DATE,DATE) TO anon;

-- ── 6. create_client actualizado con photo ───────────────────────
CREATE OR REPLACE FUNCTION create_client(
  p_token TEXT, p_full_name TEXT, p_id_number TEXT, p_phone TEXT,
  p_address TEXT, p_notes TEXT, p_photo TEXT DEFAULT NULL
)
RETURNS TABLE(id UUID, full_name TEXT, id_number TEXT, phone TEXT,
              address TEXT, notes TEXT, photo TEXT, created_by UUID, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id UUID;
BEGIN
  SELECT u.id INTO v_user_id FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.token=p_token AND s.expires_at>now() AND u.is_active=TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  RETURN QUERY INSERT INTO clients(full_name,id_number,phone,address,notes,photo,created_by)
  VALUES(p_full_name,p_id_number,p_phone,p_address,p_notes,p_photo,v_user_id)
  RETURNING clients.id,clients.full_name,clients.id_number,clients.phone,
            clients.address,clients.notes,clients.photo,clients.created_by,clients.created_at;
END;
$$;

GRANT EXECUTE ON FUNCTION create_client(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO anon;
