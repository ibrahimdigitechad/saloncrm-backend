-- CRM & Booking SaaS — Full Database Schema (PostgreSQL 15+)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── TENANTS ─────────────────────────────────────────────────────────────────
CREATE TABLE tenants (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                  TEXT NOT NULL,
  slug                  TEXT NOT NULL UNIQUE,
  email                 TEXT NOT NULL,
  phone                 TEXT,
  plan                  TEXT NOT NULL DEFAULT 'free',
  is_active             BOOLEAN NOT NULL DEFAULT true,
  wa_phone_number_id    TEXT,
  wa_access_token_enc   TEXT,
  email_provider        TEXT,
  email_api_key_enc     TEXT,
  from_email            TEXT,
  notifications_wa      BOOLEAN NOT NULL DEFAULT false,
  notifications_email   BOOLEAN NOT NULL DEFAULT false,
  working_hours         JSONB NOT NULL DEFAULT '{"mon":{"open":"09:00","close":"18:00","off":false},"tue":{"open":"09:00","close":"18:00","off":false},"wed":{"open":"09:00","close":"18:00","off":false},"thu":{"open":"09:00","close":"18:00","off":false},"fri":{"open":"09:00","close":"18:00","off":false},"sat":{"open":"09:00","close":"14:00","off":false},"sun":{"open":"09:00","close":"14:00","off":true}}',
  timezone              TEXT NOT NULL DEFAULT 'Asia/Muscat',
  currency              TEXT NOT NULL DEFAULT 'OMR',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── USERS ───────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'staff',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT role_check CHECK (role IN ('owner','staff','super_admin'))
);
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_email ON users(email);

-- ─── STAFF ───────────────────────────────────────────────────────────────────
CREATE TABLE staff (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  phone           TEXT,
  email           TEXT,
  avatar_url      TEXT,
  working_hours   JSONB,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_staff_tenant ON staff(tenant_id);

-- ─── SERVICES ────────────────────────────────────────────────────────────────
CREATE TABLE services (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  duration_minutes  INTEGER NOT NULL DEFAULT 30,
  price             NUMERIC(10,3) NOT NULL DEFAULT 0,
  color             TEXT DEFAULT '#0B5ED7',
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT duration_positive CHECK (duration_minutes > 0),
  CONSTRAINT price_non_negative CHECK (price >= 0)
);
CREATE INDEX idx_services_tenant ON services(tenant_id);

-- ─── STAFF_SERVICES ──────────────────────────────────────────────────────────
CREATE TABLE staff_services (
  staff_id    UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  service_id  UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);

-- ─── CUSTOMERS ───────────────────────────────────────────────────────────────
CREATE TABLE customers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT,
  tag             TEXT,
  notes           TEXT,
  is_blocked      BOOLEAN NOT NULL DEFAULT false,
  visit_count     INTEGER NOT NULL DEFAULT 0,
  last_visit_at   TIMESTAMPTZ,
  total_spent     NUMERIC(10,3) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, phone)
);
CREATE INDEX idx_customers_tenant ON customers(tenant_id);
CREATE INDEX idx_customers_search ON customers USING GIN (
  to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(phone,'') || ' ' || coalesce(email,''))
);

-- ─── BOOKINGS ────────────────────────────────────────────────────────────────
CREATE TABLE bookings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  staff_id        UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  service_id      UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  start_time      TIMESTAMPTZ NOT NULL,
  end_time        TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  price_charged   NUMERIC(10,3),
  notes           TEXT,
  source          TEXT DEFAULT 'dashboard',
  wa_confirmed    BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT status_check CHECK (status IN ('pending','confirmed','completed','cancelled','no_show')),
  CONSTRAINT time_order CHECK (end_time > start_time)
);
CREATE INDEX idx_bookings_tenant ON bookings(tenant_id);
CREATE INDEX idx_bookings_start ON bookings(tenant_id, start_time);
CREATE INDEX idx_bookings_staff ON bookings(staff_id, start_time) WHERE status NOT IN ('cancelled','no_show');
CREATE INDEX idx_bookings_customer ON bookings(customer_id);

-- Overlap prevention trigger
CREATE OR REPLACE FUNCTION check_booking_overlap() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM bookings
    WHERE staff_id = NEW.staff_id AND id != NEW.id
      AND status NOT IN ('cancelled','no_show')
      AND tstzrange(start_time, end_time) && tstzrange(NEW.start_time, NEW.end_time)
  ) THEN
    RAISE EXCEPTION 'Staff member is already booked during this time slot';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_booking_overlap
  BEFORE INSERT OR UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION check_booking_overlap();

-- Customer stats trigger
CREATE OR REPLACE FUNCTION update_customer_stats() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status != 'completed' THEN
    UPDATE customers SET
      visit_count = visit_count + 1,
      last_visit_at = NEW.end_time,
      total_spent = total_spent + COALESCE(NEW.price_charged, 0),
      updated_at = NOW()
    WHERE id = NEW.customer_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_customer_stats
  AFTER UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION update_customer_stats();

-- ─── WA_MESSAGES ─────────────────────────────────────────────────────────────
CREATE TABLE wa_messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id      UUID REFERENCES bookings(id) ON DELETE SET NULL,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  direction       TEXT NOT NULL,
  message_type    TEXT NOT NULL DEFAULT 'text',
  body            TEXT,
  wa_message_id   TEXT,
  status          TEXT DEFAULT 'sent',
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT direction_check CHECK (direction IN ('inbound','outbound'))
);
CREATE INDEX idx_wa_messages_tenant ON wa_messages(tenant_id);

-- ─── REFRESH_TOKENS ──────────────────────────────────────────────────────────
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ─── UPDATED_AT ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON staff FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
