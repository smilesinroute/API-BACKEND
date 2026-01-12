"use strict";

const { createClient } = require("@supabase/supabase-js");

function getSupabaseAdmin() {
  const url = String(process.env.SUPABASE_URL || "").trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!url) throw new Error("Missing SUPABASE_URL");
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY (service role; server-only)");

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

function getBucket(nameFallback) {
  return String(process.env.SUPABASE_STORAGE_BUCKET || nameFallback || "").trim();
}

/**
 * Upload buffer to Supabase Storage. Returns a public URL ONLY if bucket is public.
 * If bucket is private (recommended), return storage path and use signed URLs later.
 */
async function uploadToStorage({ bucket, path, buffer, contentType }) {
  const supabase = getSupabaseAdmin();
  const b = bucket || getBucket("driver-selfies");

  const { error } = await supabase.storage.from(b).upload(path, buffer, {
    contentType: contentType || "application/octet-stream",
    upsert: false,
  });

  if (error) throw new Error(`Supabase upload failed: ${error.message}`);

  // If your bucket is PUBLIC you can use getPublicUrl:
  const { data } = supabase.storage.from(b).getPublicUrl(path);
  const publicUrl = data?.publicUrl || null;

  return { bucket: b, path, publicUrl };
}

module.exports = { uploadToStorage };
