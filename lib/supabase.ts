import { createClient } from '@supabase/supabase-js';

// Это публичные значения: доступ к данным ограничен защитой на уровне строк (RLS).
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://tcbxtklhkrfvqfiswrdi.supabase.co';
export const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_vrj5SNoEJCtiU5rtVyXuPg_5sAnYrex';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
