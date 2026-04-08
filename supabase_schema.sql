-- ================================================================
-- GOTA CONTROL — Supabase Schema v2 (CORREGIDO)
-- Ejecuta este script COMPLETO en Supabase → SQL Editor
-- ================================================================

-- ── PASO 0: Extensiones (SIEMPRE primero) ────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── PASO 1: TABLAS ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  pin_hash    TEXT NOT NULL,
  full_name   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'collector')),
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  created_by  UUID REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS clients (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  full_name     TEXT NOT NULL,
  id_number     TEXT,
  phone         TEXT,
  address       TEXT,
  notes         TEXT,
  created_by    UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT now(),
  is_active     BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS loans (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  amount          NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  interest_rate   NUMERIC(5,2)  NOT NULL CHECK (interest_rate >= 0),
  collection_mode TEXT NOT NULL CHECK (collection_mode IN ('daily','weekly','biweekly')),
  weeks           INTEGER NOT NULL CHECK (weeks > 0),
  start_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid','cancelled')),
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  loan_id         UUID NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  amount          NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  payment_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  notes           TEXT,
  registered_by   UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  updated_by      UUID REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS expenses (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  category      TEXT NOT NULL CHECK (category IN ('fuel','transport','other')),
  description   TEXT NOT NULL,
  amount        NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  expense_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  registered_by UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '12 hours'),
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ── PASO 2: ÍNDICES ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_clients_created_by ON clients(created_by);
CREATE INDEX IF NOT EXISTS idx_loans_client_id    ON loans(client_id);
CREATE INDEX IF NOT EXISTS idx_loans_created_by   ON loans(created_by);
CREATE INDEX IF NOT EXISTS idx_payments_loan_id   ON payments(loan_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token     ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date      ON expenses(expense_date);

-- ── PASO 3: FUNCIONES DE AUTH ────────────────────────────────────
-- Todas usan SECURITY DEFINER para correr con permisos de postgres,
-- no del rol anon. Así el cliente nunca toca las tablas directamente.

-- Login: verifica PIN y crea sesión en un solo RPC
CREATE OR REPLACE FUNCTION login(p_username TEXT, p_pin TEXT)
RETURNS TABLE(
  user_id    UUID,
  username   TEXT,
  full_name  TEXT,
  role       TEXT,
  token      TEXT,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user     users%ROWTYPE;
  v_token    TEXT;
  v_expires  TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_user
  FROM users u
  WHERE u.username = lower(trim(p_username))
    AND u.is_active = TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USUARIO_NO_ENCONTRADO';
  END IF;

  IF NOT (v_user.pin_hash = crypt(p_pin, v_user.pin_hash)) THEN
    RAISE EXCEPTION 'PIN_INCORRECTO';
  END IF;

  -- Limpiar sesiones expiradas
  DELETE FROM sessions WHERE sessions.user_id = v_user.id AND sessions.expires_at < now();

  v_expires := now() + INTERVAL '12 hours';

  INSERT INTO sessions (user_id, expires_at)
  VALUES (v_user.id, v_expires)
  RETURNING sessions.token INTO v_token;

  RETURN QUERY
  SELECT v_user.id, v_user.username, v_user.full_name, v_user.role, v_token, v_expires;
END;
$$;

-- Verificar sesión
CREATE OR REPLACE FUNCTION verify_session(p_token TEXT)
RETURNS TABLE(user_id UUID, username TEXT, full_name TEXT, role TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM sessions WHERE expires_at < now();
  RETURN QUERY
  SELECT u.id, u.username, u.full_name, u.role
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token = p_token AND s.expires_at > now() AND u.is_active = TRUE;
END;
$$;

-- Logout
CREATE OR REPLACE FUNCTION logout(p_token TEXT)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM sessions WHERE token = p_token;
$$;

-- Crear usuario (admin o collector) — solo admins autenticados
CREATE OR REPLACE FUNCTION create_user(
  p_token TEXT, p_username TEXT, p_pin TEXT, p_full_name TEXT, p_role TEXT
)
RETURNS TABLE(id UUID, username TEXT, full_name TEXT, role TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_caller_id UUID;
  v_new_id    UUID;
BEGIN
  SELECT u.id INTO v_caller_id
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = p_token AND s.expires_at > now()
    AND u.is_active = TRUE AND u.role = 'admin';

  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  IF p_role NOT IN ('admin','collector') THEN RAISE EXCEPTION 'ROL_INVALIDO'; END IF;
  IF length(p_pin) != 4 OR p_pin !~ '^\d{4}$' THEN RAISE EXCEPTION 'PIN_INVALIDO'; END IF;

  INSERT INTO users (username, pin_hash, full_name, role, created_by)
  VALUES (lower(trim(p_username)), crypt(p_pin, gen_salt('bf',10)), trim(p_full_name), p_role, v_caller_id)
  RETURNING users.id INTO v_new_id;

  RETURN QUERY SELECT u.id, u.username, u.full_name, u.role FROM users u WHERE u.id = v_new_id;
END;
$$;

-- Desactivar usuario
CREATE OR REPLACE FUNCTION deactivate_user(p_token TEXT, p_user_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=p_token AND s.expires_at>now() AND u.is_active=TRUE AND u.role='admin')
  THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  UPDATE users SET is_active = FALSE WHERE id = p_user_id;
END;
$$;

-- ── PASO 4: FUNCIONES DE DATOS ───────────────────────────────────

CREATE OR REPLACE FUNCTION get_clients(p_token TEXT)
RETURNS TABLE(id UUID, full_name TEXT, id_number TEXT, phone TEXT,
              address TEXT, notes TEXT, created_by UUID, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id UUID; v_role TEXT;
BEGIN
  SELECT u.id, u.role INTO v_user_id, v_role
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = p_token AND s.expires_at > now() AND u.is_active = TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;

  IF v_role = 'admin' THEN
    RETURN QUERY SELECT c.id,c.full_name,c.id_number,c.phone,c.address,c.notes,c.created_by,c.created_at
                 FROM clients c WHERE c.is_active=TRUE ORDER BY c.full_name;
  ELSE
    RETURN QUERY SELECT c.id,c.full_name,c.id_number,c.phone,c.address,c.notes,c.created_by,c.created_at
                 FROM clients c WHERE c.is_active=TRUE AND c.created_by=v_user_id ORDER BY c.full_name;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION get_loans(p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id UUID; v_role TEXT; v_result JSONB;
BEGIN
  SELECT u.id, u.role INTO v_user_id, v_role
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = p_token AND s.expires_at > now() AND u.is_active = TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;

  IF v_role = 'admin' THEN
    SELECT jsonb_agg(jsonb_build_object(
      'id',l.id,'client_id',l.client_id,'amount',l.amount,'interest_rate',l.interest_rate,
      'collection_mode',l.collection_mode,'weeks',l.weeks,'start_date',l.start_date,
      'status',l.status,'notes',l.notes,'created_by',l.created_by,'created_at',l.created_at,
      'client',(SELECT jsonb_build_object('id',c.id,'full_name',c.full_name,'id_number',c.id_number,'phone',c.phone) FROM clients c WHERE c.id=l.client_id),
      'payments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'loan_id',p.loan_id,'amount',p.amount,'payment_date',p.payment_date,'registered_by',p.registered_by,'created_at',p.created_at) ORDER BY p.created_at) FROM payments p WHERE p.loan_id=l.id),'[]'::jsonb)
    ) ORDER BY l.created_at DESC) INTO v_result FROM loans l;
  ELSE
    SELECT jsonb_agg(jsonb_build_object(
      'id',l.id,'client_id',l.client_id,'amount',l.amount,'interest_rate',l.interest_rate,
      'collection_mode',l.collection_mode,'weeks',l.weeks,'start_date',l.start_date,
      'status',l.status,'notes',l.notes,'created_by',l.created_by,'created_at',l.created_at,
      'client',(SELECT jsonb_build_object('id',c.id,'full_name',c.full_name,'id_number',c.id_number,'phone',c.phone) FROM clients c WHERE c.id=l.client_id),
      'payments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'loan_id',p.loan_id,'amount',p.amount,'payment_date',p.payment_date,'registered_by',p.registered_by,'created_at',p.created_at) ORDER BY p.created_at) FROM payments p WHERE p.loan_id=l.id),'[]'::jsonb)
    ) ORDER BY l.created_at DESC) INTO v_result FROM loans l WHERE l.created_by=v_user_id;
  END IF;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION create_client(
  p_token TEXT, p_full_name TEXT, p_id_number TEXT, p_phone TEXT, p_address TEXT, p_notes TEXT
)
RETURNS TABLE(id UUID, full_name TEXT, id_number TEXT, phone TEXT, address TEXT, created_by UUID, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id UUID;
BEGIN
  SELECT u.id INTO v_user_id FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.token=p_token AND s.expires_at>now() AND u.is_active=TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  RETURN QUERY INSERT INTO clients(full_name,id_number,phone,address,notes,created_by)
  VALUES(p_full_name,p_id_number,p_phone,p_address,p_notes,v_user_id)
  RETURNING clients.id,clients.full_name,clients.id_number,clients.phone,clients.address,clients.created_by,clients.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION create_loan(
  p_token TEXT, p_client_id UUID, p_amount NUMERIC, p_interest_rate NUMERIC,
  p_collection_mode TEXT, p_weeks INTEGER, p_start_date DATE, p_notes TEXT
)
RETURNS TABLE(id UUID, client_id UUID, amount NUMERIC, interest_rate NUMERIC,
              collection_mode TEXT, weeks INTEGER, start_date DATE, status TEXT,
              created_by UUID, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id UUID;
BEGIN
  SELECT u.id INTO v_user_id FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.token=p_token AND s.expires_at>now() AND u.is_active=TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  RETURN QUERY INSERT INTO loans(client_id,amount,interest_rate,collection_mode,weeks,start_date,notes,created_by)
  VALUES(p_client_id,p_amount,p_interest_rate,p_collection_mode,p_weeks,p_start_date,p_notes,v_user_id)
  RETURNING loans.id,loans.client_id,loans.amount,loans.interest_rate,loans.collection_mode,
            loans.weeks,loans.start_date,loans.status,loans.created_by,loans.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION create_payment(
  p_token TEXT, p_loan_id UUID, p_amount NUMERIC, p_payment_date DATE, p_notes TEXT
)
RETURNS TABLE(id UUID, loan_id UUID, amount NUMERIC, payment_date DATE,
              registered_by UUID, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id UUID;
BEGIN
  SELECT u.id INTO v_user_id FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.token=p_token AND s.expires_at>now() AND u.is_active=TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  RETURN QUERY INSERT INTO payments(loan_id,amount,payment_date,notes,registered_by)
  VALUES(p_loan_id,p_amount,p_payment_date,p_notes,v_user_id)
  RETURNING payments.id,payments.loan_id,payments.amount,payments.payment_date,
            payments.registered_by,payments.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION update_payment(p_token TEXT, p_payment_id UUID, p_amount NUMERIC, p_notes TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=p_token AND s.expires_at>now() AND u.is_active=TRUE AND u.role='admin')
  THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  UPDATE payments SET amount=p_amount, notes=p_notes, updated_at=now() WHERE id=p_payment_id;
END;
$$;

CREATE OR REPLACE FUNCTION delete_payment(p_token TEXT, p_payment_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=p_token AND s.expires_at>now() AND u.is_active=TRUE AND u.role='admin')
  THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  DELETE FROM payments WHERE id=p_payment_id;
END;
$$;

CREATE OR REPLACE FUNCTION delete_loan(p_token TEXT, p_loan_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=p_token AND s.expires_at>now() AND u.is_active=TRUE AND u.role='admin')
  THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  DELETE FROM loans WHERE id=p_loan_id;
END;
$$;

CREATE OR REPLACE FUNCTION get_expenses(p_token TEXT)
RETURNS TABLE(id UUID, category TEXT, description TEXT, amount NUMERIC,
              expense_date DATE, registered_by UUID, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id UUID; v_role TEXT;
BEGIN
  SELECT u.id, u.role INTO v_user_id, v_role FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.token=p_token AND s.expires_at>now() AND u.is_active=TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  IF v_role='admin' THEN
    RETURN QUERY SELECT e.id,e.category,e.description,e.amount,e.expense_date,e.registered_by,e.created_at
                 FROM expenses e ORDER BY e.expense_date DESC;
  ELSE
    RETURN QUERY SELECT e.id,e.category,e.description,e.amount,e.expense_date,e.registered_by,e.created_at
                 FROM expenses e WHERE e.registered_by=v_user_id ORDER BY e.expense_date DESC;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION create_expense(
  p_token TEXT, p_category TEXT, p_description TEXT, p_amount NUMERIC, p_expense_date DATE
)
RETURNS TABLE(id UUID, category TEXT, description TEXT, amount NUMERIC,
              expense_date DATE, registered_by UUID, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id UUID;
BEGIN
  SELECT u.id INTO v_user_id FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.token=p_token AND s.expires_at>now() AND u.is_active=TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  RETURN QUERY INSERT INTO expenses(category,description,amount,expense_date,registered_by)
  VALUES(p_category,p_description,p_amount,p_expense_date,v_user_id)
  RETURNING expenses.id,expenses.category,expenses.description,expenses.amount,
            expenses.expense_date,expenses.registered_by,expenses.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION delete_expense(p_token TEXT, p_expense_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=p_token AND s.expires_at>now() AND u.is_active=TRUE AND u.role='admin')
  THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  DELETE FROM expenses WHERE id=p_expense_id;
END;
$$;

CREATE OR REPLACE FUNCTION get_users(p_token TEXT)
RETURNS TABLE(id UUID, username TEXT, full_name TEXT, role TEXT, is_active BOOLEAN, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=p_token AND s.expires_at>now() AND u.is_active=TRUE AND u.role='admin')
  THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  RETURN QUERY SELECT u.id,u.username,u.full_name,u.role,u.is_active,u.created_at
               FROM users u WHERE u.username != 'admin' ORDER BY u.created_at DESC;
END;
$$;

-- ── PASO 5: RLS — bloquear acceso directo desde anon ─────────────
ALTER TABLE users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients  ENABLE ROW LEVEL SECURITY;
ALTER TABLE loans    ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "block_anon_users"    ON users;
DROP POLICY IF EXISTS "block_anon_clients"  ON clients;
DROP POLICY IF EXISTS "block_anon_loans"    ON loans;
DROP POLICY IF EXISTS "block_anon_payments" ON payments;
DROP POLICY IF EXISTS "block_anon_expenses" ON expenses;
DROP POLICY IF EXISTS "block_anon_sessions" ON sessions;

CREATE POLICY "block_anon_users"    ON users    FOR ALL TO anon USING (false);
CREATE POLICY "block_anon_clients"  ON clients  FOR ALL TO anon USING (false);
CREATE POLICY "block_anon_loans"    ON loans    FOR ALL TO anon USING (false);
CREATE POLICY "block_anon_payments" ON payments FOR ALL TO anon USING (false);
CREATE POLICY "block_anon_expenses" ON expenses FOR ALL TO anon USING (false);
CREATE POLICY "block_anon_sessions" ON sessions FOR ALL TO anon USING (false);

-- ── PASO 6: GRANTS para las funciones RPC ───────────────────────
GRANT EXECUTE ON FUNCTION login(TEXT, TEXT)                                              TO anon;
GRANT EXECUTE ON FUNCTION verify_session(TEXT)                                           TO anon;
GRANT EXECUTE ON FUNCTION logout(TEXT)                                                   TO anon;
GRANT EXECUTE ON FUNCTION create_user(TEXT, TEXT, TEXT, TEXT, TEXT)                     TO anon;
GRANT EXECUTE ON FUNCTION deactivate_user(TEXT, UUID)                                   TO anon;
GRANT EXECUTE ON FUNCTION get_clients(TEXT)                                              TO anon;
GRANT EXECUTE ON FUNCTION get_loans(TEXT)                                                TO anon;
GRANT EXECUTE ON FUNCTION get_expenses(TEXT)                                             TO anon;
GRANT EXECUTE ON FUNCTION get_users(TEXT)                                                TO anon;
GRANT EXECUTE ON FUNCTION create_client(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)             TO anon;
GRANT EXECUTE ON FUNCTION create_loan(TEXT, UUID, NUMERIC, NUMERIC, TEXT, INTEGER, DATE, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION create_payment(TEXT, UUID, NUMERIC, DATE, TEXT)               TO anon;
GRANT EXECUTE ON FUNCTION update_payment(TEXT, UUID, NUMERIC, TEXT)                     TO anon;
GRANT EXECUTE ON FUNCTION delete_payment(TEXT, UUID)                                    TO anon;
GRANT EXECUTE ON FUNCTION delete_loan(TEXT, UUID)                                       TO anon;
GRANT EXECUTE ON FUNCTION create_expense(TEXT, TEXT, TEXT, NUMERIC, DATE)               TO anon;
GRANT EXECUTE ON FUNCTION delete_expense(TEXT, UUID)                                    TO anon;

-- ── PASO 7: ADMIN INICIAL ────────────────────────────────────────
-- PIN: 1221, hash generado con pgcrypto (ya activo desde el paso 0)
INSERT INTO users (username, pin_hash, full_name, role)
VALUES (
  'admin',
  crypt('1221', gen_salt('bf', 10)),
  'Administrador',
  'admin'
)
ON CONFLICT (username) DO UPDATE
  SET pin_hash  = crypt('1221', gen_salt('bf', 10)),
      is_active = TRUE;

-- ── VERIFICACIÓN FINAL ───────────────────────────────────────────
-- Ejecuta esto para confirmar que el admin quedó bien:
-- SELECT username, role, is_active, (pin_hash = crypt('1221', pin_hash)) AS pin_ok FROM users WHERE username = 'admin';
-- Debe retornar: admin | admin | true | true
