-- Service Territories: per-company zip code management
CREATE TABLE IF NOT EXISTS service_territories (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  zip        VARCHAR(10) NOT NULL,
  area       TEXT NOT NULL DEFAULT '',
  city       TEXT,
  state      TEXT,
  county     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, zip)
);

CREATE INDEX IF NOT EXISTS idx_service_territories_area
  ON service_territories(company_id, area);
