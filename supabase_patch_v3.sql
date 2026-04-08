-- ================================================================
-- GOTA CONTROL — SQL Patch v3
-- Ejecuta en Supabase → SQL Editor (además del schema principal)
-- ================================================================

-- ── 1. Foto de cliente (base64 comprimida) ───────────────────────
ALTER TABLE clients ADD COLUMN IF NOT EXISTS photo TEXT; -- base64 JPEG comprimido

-- ── 2. Préstamos de admin visibles para todos ───────────────────
-- La lógica se maneja en get_loans: si el creador es admin, visible para todos

-- ── 3. Función update_client (solo admin) ───────────────────────
CREATE OR REPLACE FUNCTION update_client(
  p_token      TEXT,
  p_client_id  UUID,
  p_full_name  TEXT,
  p_id_number  TEXT,
  p_phone      TEXT,
  p_address    TEXT,
  p_notes      TEXT,
  p_photo      TEXT   -- base64 JPEG comprimido, puede ser NULL
)
RETURNS TABLE(id UUID, full_name TEXT, id_number TEXT, phone TEXT,
              address TEXT, notes TEXT, photo TEXT, created_by UUID)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_role TEXT;
BEGIN
  SELECT u.role INTO v_role
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = p_token AND s.expires_at > now()
    AND u.is_active = TRUE AND u.role = 'admin';
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;

  RETURN QUERY
  UPDATE clients SET
    full_name  = COALESCE(p_full_name,  full_name),
    id_number  = COALESCE(p_id_number,  id_number),
    phone      = COALESCE(p_phone,      phone),
    address    = COALESCE(p_address,    address),
    notes      = COALESCE(p_notes,      notes),
    photo      = p_photo   -- puede ser NULL para limpiar
  WHERE id = p_client_id
  RETURNING clients.id, clients.full_name, clients.id_number, clients.phone,
            clients.address, clients.notes, clients.photo, clients.created_by;
END;
$$;

-- ── 4. get_loans actualizado: préstamos de admin visibles para todos
CREATE OR REPLACE FUNCTION get_loans(p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id UUID; v_role TEXT; v_result JSONB;
BEGIN
  SELECT u.id, u.role INTO v_user_id, v_role
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = p_token AND s.expires_at > now() AND u.is_active = TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;

  IF v_role = 'admin' THEN
    -- Admin ve todos los préstamos
    SELECT jsonb_agg(jsonb_build_object(
      'id',l.id,'client_id',l.client_id,'amount',l.amount,'interest_rate',l.interest_rate,
      'collection_mode',l.collection_mode,'weeks',l.weeks,'start_date',l.start_date,
      'status',l.status,'notes',l.notes,'created_by',l.created_by,'created_at',l.created_at,
      'client',(SELECT jsonb_build_object('id',c.id,'full_name',c.full_name,'id_number',c.id_number,'phone',c.phone,'photo',c.photo) FROM clients c WHERE c.id=l.client_id),
      'payments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'loan_id',p.loan_id,'amount',p.amount,'payment_date',p.payment_date,'registered_by',p.registered_by,'created_at',p.created_at) ORDER BY p.created_at) FROM payments p WHERE p.loan_id=l.id),'[]'::jsonb)
    ) ORDER BY l.created_at DESC) INTO v_result FROM loans l;
  ELSE
    -- Cobrador ve: sus propios préstamos + los creados por cualquier admin
    SELECT jsonb_agg(jsonb_build_object(
      'id',l.id,'client_id',l.client_id,'amount',l.amount,'interest_rate',l.interest_rate,
      'collection_mode',l.collection_mode,'weeks',l.weeks,'start_date',l.start_date,
      'status',l.status,'notes',l.notes,'created_by',l.created_by,'created_at',l.created_at,
      'client',(SELECT jsonb_build_object('id',c.id,'full_name',c.full_name,'id_number',c.id_number,'phone',c.phone,'photo',c.photo) FROM clients c WHERE c.id=l.client_id),
      'payments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'loan_id',p.loan_id,'amount',p.amount,'payment_date',p.payment_date,'registered_by',p.registered_by,'created_at',p.created_at) ORDER BY p.created_at) FROM payments p WHERE p.loan_id=l.id),'[]'::jsonb)
    ) ORDER BY l.created_at DESC) INTO v_result
    FROM loans l
    WHERE l.created_by = v_user_id
       OR EXISTS (SELECT 1 FROM users u2 WHERE u2.id = l.created_by AND u2.role = 'admin');
  END IF;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- ── 5. get_clients actualizado: incluir photo ───────────────────
CREATE OR REPLACE FUNCTION get_clients(p_token TEXT)
RETURNS TABLE(id UUID, full_name TEXT, id_number TEXT, phone TEXT,
              address TEXT, notes TEXT, photo TEXT, created_by UUID, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id UUID; v_role TEXT;
BEGIN
  SELECT u.id, u.role INTO v_user_id, v_role
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = p_token AND s.expires_at > now() AND u.is_active = TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;

  IF v_role = 'admin' THEN
    RETURN QUERY SELECT c.id,c.full_name,c.id_number,c.phone,c.address,c.notes,c.photo,c.created_by,c.created_at
                 FROM clients c WHERE c.is_active=TRUE ORDER BY c.full_name;
  ELSE
    -- Cobrador ve clientes propios + clientes cuyos préstamos vienen de admin
    RETURN QUERY
    SELECT DISTINCT c.id,c.full_name,c.id_number,c.phone,c.address,c.notes,c.photo,c.created_by,c.created_at
    FROM clients c
    WHERE c.is_active = TRUE
      AND (
        c.created_by = v_user_id
        OR EXISTS (
          SELECT 1 FROM loans l
          JOIN users u2 ON u2.id = l.created_by
          WHERE l.client_id = c.id AND u2.role = 'admin'
        )
      )
    ORDER BY c.full_name;
  END IF;
END;
$$;

-- ── 6. Función para resumen por rango de fechas ─────────────────
CREATE OR REPLACE FUNCTION get_summary_by_range(
  p_token    TEXT,
  p_date_from DATE,
  p_date_to   DATE
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id  UUID;
  v_role     TEXT;
  v_result   JSONB;
BEGIN
  SELECT u.id, u.role INTO v_user_id, v_role
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = p_token AND s.expires_at > now() AND u.is_active = TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  IF v_role != 'admin' THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;

  SELECT jsonb_build_object(
    -- Préstamos creados en el rango
    'loans_count',      (SELECT COUNT(*) FROM loans l WHERE l.start_date BETWEEN p_date_from AND p_date_to),
    'loans_capital',    (SELECT COALESCE(SUM(l.amount),0) FROM loans l WHERE l.start_date BETWEEN p_date_from AND p_date_to),
    'loans_interest',   (SELECT COALESCE(SUM(l.amount * l.interest_rate / 100),0) FROM loans l WHERE l.start_date BETWEEN p_date_from AND p_date_to),
    'loans_total',      (SELECT COALESCE(SUM(l.amount * (1 + l.interest_rate/100)),0) FROM loans l WHERE l.start_date BETWEEN p_date_from AND p_date_to),
    -- Pagos recibidos en el rango
    'payments_count',   (SELECT COUNT(*) FROM payments p WHERE p.payment_date BETWEEN p_date_from AND p_date_to),
    'payments_total',   (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.payment_date BETWEEN p_date_from AND p_date_to),
    -- Gastos en el rango
    'expenses_total',   (SELECT COALESCE(SUM(e.amount),0) FROM expenses e WHERE e.expense_date BETWEEN p_date_from AND p_date_to),
    -- Clientes nuevos en el rango
    'clients_new',      (SELECT COUNT(*) FROM clients c WHERE c.created_at::date BETWEEN p_date_from AND p_date_to),
    -- Préstamos pagados en el rango
    'loans_paid',       (SELECT COUNT(*) FROM loans l WHERE l.status = 'paid' AND l.start_date BETWEEN p_date_from AND p_date_to),
    -- Pagos por día (para gráfica)
    'payments_by_day',  (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('date', pay_day, 'amount', day_total) ORDER BY pay_day), '[]'::jsonb)
      FROM (
        SELECT p.payment_date AS pay_day, SUM(p.amount) AS day_total
        FROM payments p
        WHERE p.payment_date BETWEEN p_date_from AND p_date_to
        GROUP BY p.payment_date
      ) daily
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- Grants para las nuevas funciones
GRANT EXECUTE ON FUNCTION update_client(TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO anon;
GRANT EXECUTE ON FUNCTION get_summary_by_range(TEXT,DATE,DATE)                   TO anon;
