import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || '';
const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
  '';

let cached: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

export function getSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (!cached) {
    cached = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  return cached;
}
