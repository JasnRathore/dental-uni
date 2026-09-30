import { supabase } from '../utils/supabase/client';

export async function reactivateIfNeeded(session: any): Promise<boolean> {
  if (!session?.user?.app_metadata?.accountDisabled) return true;
  if (!window.confirm('This account is deactivated. Reactivate it and continue signing in?')) {
    await supabase.auth.signOut();
    return false;
  }

  const response = await fetch('/make-server-2fad19e1/account/reactivate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Account reactivation failed (${response.status})`);
  return true;
}
