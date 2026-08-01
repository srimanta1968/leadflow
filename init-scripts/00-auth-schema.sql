-- ============================================================
-- LeadFlow — Authentication Schema
-- Runs BEFORE 01-schema.sql on first `docker-compose up`.
-- Safe to re-run: every statement is IF NOT EXISTS guarded.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          VARCHAR(255) NOT NULL UNIQUE,
  username       VARCHAR(100) UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  first_name     VARCHAR(100),
  last_name      VARCHAR(100),
  phone          VARCHAR(40),
  role           VARCHAR(50)  NOT NULL DEFAULT 'user',
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  email_verified BOOLEAN      NOT NULL DEFAULT FALSE,
  last_login     TIMESTAMP WITH TIME ZONE,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE users IS 'LeadFlow application users. Authoritative identity is ProjexCloud; this table holds the local session-bound projection.';

CREATE INDEX IF NOT EXISTS idx_users_email    ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
CREATE INDEX IF NOT EXISTS idx_users_role     ON users (role);
