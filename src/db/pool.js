// apps/api/src/db/pool.js
// Lightweight DB layer - adapt to your DB (Postgres, Supabase direct, etc.)
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;

