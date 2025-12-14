-- ========================
-- Smiles in Route Tables
-- ========================

-- Deliveries table
CREATE TABLE IF NOT EXISTS deliveries (
  id SERIAL PRIMARY KEY,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  pickup_address TEXT NOT NULL,
  delivery_address TEXT NOT NULL,
  delivery_date DATE NOT NULL,
  delivery_time TIME NOT NULL,
  distance_miles NUMERIC(10,2) DEFAULT 0,
  base_rate NUMERIC(10,2) DEFAULT 0,
  priority BOOLEAN DEFAULT FALSE,
  time_sensitive BOOLEAN DEFAULT FALSE,
  fragile BOOLEAN DEFAULT FALSE,
  weekend BOOLEAN DEFAULT FALSE,
  holiday BOOLEAN DEFAULT FALSE,
  after_hours BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'New',
  per_mile_rate NUMERIC(10,2) DEFAULT 0,
  priority_fee NUMERIC(10,2) DEFAULT 0,
  fragile_fee NUMERIC(10,2) DEFAULT 0,
  weekend_fee NUMERIC(10,2) DEFAULT 0,
  holiday_fee NUMERIC(10,2) DEFAULT 0,
  after_hours_fee NUMERIC(10,2) DEFAULT 0,
  total_cost NUMERIC(10,2) DEFAULT 0,
  delivery_photo_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  bulk_order_id INT NULL
);

-- Notary appointments table
CREATE TABLE IF NOT EXISTS notary_appointments (
  id SERIAL PRIMARY KEY,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  appointment_address TEXT NOT NULL,
  appointment_date DATE NOT NULL,
  appointment_time TIME NOT NULL,
  document_type TEXT NOT NULL,
  notary_fee NUMERIC(10,2) DEFAULT 0,
  extra_signatures INT DEFAULT 0,
  extra_documents INT DEFAULT 0,
  per_signature_fee NUMERIC(10,2) DEFAULT 0,
  per_document_fee NUMERIC(10,2) DEFAULT 0,
  travel_miles NUMERIC(10,2) DEFAULT 0,
  travel_per_mile NUMERIC(10,2) DEFAULT 0,
  travel_fee NUMERIC(10,2) DEFAULT 0,
  extra_fee NUMERIC(10,2) DEFAULT 0,
  total_notary_cost NUMERIC(10,2) DEFAULT 0,
  status TEXT DEFAULT 'Scheduled',
  notary_photo_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  bulk_order_id INT NULL
);

-- Contracts table
CREATE TABLE IF NOT EXISTS contracts (
  id SERIAL PRIMARY KEY,
  client_name TEXT NOT NULL,
  contract_start DATE NOT NULL,
  contract_end DATE NOT NULL,
  service_type TEXT NOT NULL,
  terms TEXT,
  fee NUMERIC(10,2) DEFAULT 0,
  status TEXT DEFAULT 'Active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Bulk orders table
CREATE TABLE IF NOT EXISTS bulk_orders (
  id SERIAL PRIMARY KEY,
  client_name TEXT NOT NULL,
  order_date DATE NOT NULL,
  total_items INT DEFAULT 0,
  total_cost NUMERIC(10,2) DEFAULT 0,
  status TEXT DEFAULT 'Pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver locations table
CREATE TABLE IF NOT EXISTS driver_locations (
  driver_id INT NOT NULL,
  order_id INT NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  latitude NUMERIC(10,6) NOT NULL,
  longitude NUMERIC(10,6) NOT NULL
);
