import { createClient } from '@supabase/supabase-js';

// Эта заглушка нужна, чтобы приложение не падало, если какие-то старые компоненты 
// все еще пытаются импортировать supabase. 
// Все реальные запросы теперь идут через localDb или dataService.
export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    signInWithPassword: async () => ({ data: null, error: { message: 'Cloud auth disabled' } }),
    signUp: async () => ({ data: null, error: { message: 'Cloud auth disabled' } }),
    signOut: async () => ({ error: null }),
  },
  from: () => ({
    select: () => ({ data: [], error: { message: 'Use localDb instead' } }),
    insert: () => ({ data: [], error: { message: 'Use localDb instead' } }),
    update: () => ({ data: [], error: { message: 'Use localDb instead' } }),
    delete: () => ({ data: [], error: { message: 'Use localDb instead' } }),
    eq: () => ({ data: [], error: { message: 'Use localDb instead' } }),
    in: () => ({ data: [], error: { message: 'Use localDb instead' } }),
    maybeSingle: () => ({ data: null, error: { message: 'Use localDb instead' } }),
    limit: () => ({ data: [], error: { message: 'Use localDb instead' } }),
    order: () => ({ data: [], error: { message: 'Use localDb instead' } }),
    is: () => ({ data: [], error: { message: 'Use localDb instead' } }),
  }),
  rpc: async () => {
    return { data: null, error: { message: 'Cloud RPC disabled' } };
  },
  channel: () => ({
    on: () => ({
      subscribe: () => ({ removeChannel: async () => {} }),
    }),
    removeChannel: async () => {},
  }),
};
