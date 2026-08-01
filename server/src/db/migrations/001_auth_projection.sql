-- 001 — Session-bound identity projection.
--
-- ProjexCloud is the identity authority for LeadFlow. This table holds only the
-- local projection a session needs, plus the credential material the local auth
-- adapter uses until the ProjexCloud JWKS verifier takes over.

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

CREATE INDEX IF NOT EXISTS idx_users_email    ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
CREATE INDEX IF NOT EXISTS idx_users_role     ON users (role);
