import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth, type Staff } from '../context/AuthContext';

/**
 * /sso#token=… — "Open Sehat Saathi" from Loopdesk. Swaps the one-time
 * Loopdesk token for a normal dashboard session, so hospital staff never
 * need a second password. The token is in the URL fragment so it never
 * reaches server logs, and it is removed from the address bar at once.
 */
export default function HubSso() {
  const { updateStaff } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return; // React StrictMode runs effects twice; the token works only once
    done.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setError('This sign-in link is incomplete. Open Sehat Saathi again from your Loopdesk account.');
      return;
    }
    api
      .post<{ token: string; staff: Staff; next?: string }>('/api/hub/sso/exchange', { token })
      .then((res) => {
        updateStaff(res.staff, res.token);
        navigate(res.next && res.next.startsWith('/app') ? res.next : '/app', { replace: true });
      })
      .catch((e: Error) => setError(e.message || 'Sign-in failed. Open Sehat Saathi again from Loopdesk.'));
  }, [navigate, updateStaff]);

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md text-center">
        {error ? (
          <>
            <p className="text-lg font-semibold">Couldn&rsquo;t sign you in</p>
            <p className="mt-2 text-muted-foreground">{error}</p>
            <a className="mt-4 inline-block underline" href="/login">Sign in with phone and password instead</a>
          </>
        ) : (
          <p className="text-muted-foreground">Signing you in from Loopdesk…</p>
        )}
      </div>
    </div>
  );
}
