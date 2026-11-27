import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/context/AuthContext';
import { PHONE_HINT, PHONE_PLACEHOLDER } from '@/lib/phone';

export default function Login() {
  const { staff, login } = useAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  if (staff) return <Navigate to="/app" replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(phone, password);
      navigate('/app');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      setShowHelp(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center">
          <img src="/brand/logo-full.png" alt="" className="w-40 max-w-full object-contain" />
          <h1 className="sr-only">Sehat Saathi</h1>
          <p className="mt-1 text-sm text-muted-foreground">Staff portal — sign in to continue</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-border bg-card p-8 shadow-card"
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="phone">Phone number</Label>
              <Input
                id="phone"
                type="tel"
                inputMode="tel"
                autoComplete="username"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder={PHONE_PLACEHOLDER}
                aria-describedby="phone-hint"
                required
              />
              <p id="phone-hint" className="text-xs text-muted-foreground">{PHONE_HINT}</p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <button
                  type="button"
                  onClick={() => setShowHelp((v) => !v)}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Forgot password?
                </button>
              </div>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            {error ? (
              <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}

            {/* Same message for an unknown number and a wrong password, on
                purpose — so say what to check and how to get a reset (bug list #9). */}
            {showHelp ? (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                <p className="font-medium text-foreground">Can't sign in?</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  <li>Use the same mobile number your hospital admin saved for you (Settings → Clinic staff).</li>
                  <li>Forgot your password? Ask your hospital admin to reset it: Settings → Clinic staff → Reset password.</li>
                  <li>Hospital on Loopdesk? Open Sehat Saathi from your Loopdesk account instead.</li>
                </ul>
              </div>
            ) : null}

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>
          </div>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Not a staff member?{' '}
          <Link to="/" className="font-medium text-primary hover:underline">
            Go to homepage
          </Link>
        </p>
      </div>
    </div>
  );
}
