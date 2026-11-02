import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/app-shell';
import { Section } from '@/components/app/admin-ui';
import { useAuth, type Staff } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';

export default function AdminSettings() {
  const { staff, updateStaff } = useAuth();
  const [profile, setProfile] = useState({ name: staff?.name ?? '', phone: staff?.phone ?? '', email: staff?.email ?? '' });
  const [savingProfile, setSavingProfile] = useState(false);
  const [pw, setPw] = useState({ current_password: '', new_password: '', confirm: '' });
  const [savingPw, setSavingPw] = useState(false);

  // Pull the latest profile (email isn't in the cached login payload).
  useEffect(() => {
    api
      .get<{ data: Staff }>('/api/auth/me')
      .then((r) => setProfile({ name: r.data.name, phone: r.data.phone, email: r.data.email ?? '' }))
      .catch(() => {});
  }, []);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const r = await api.patch<{ data: Staff; token: string }>('/api/auth/me', profile);
      updateStaff({ ...(staff as Staff), ...r.data }, r.token);
      toast.success('Profile updated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update profile');
    } finally {
      setSavingProfile(false);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (pw.new_password !== pw.confirm) {
      toast.error('New passwords do not match');
      return;
    }
    setSavingPw(true);
    try {
      await api.post('/api/auth/change-password', { current_password: pw.current_password, new_password: pw.new_password });
      setPw({ current_password: '', new_password: '', confirm: '' });
      toast.success('Password changed');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to change password');
    } finally {
      setSavingPw(false);
    }
  }

  return (
    <AppShell title="Settings" description="Your Super Admin profile and password.">
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Profile">
          <form onSubmit={saveProfile} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" required value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">Phone (your login)</Label>
              <Input id="phone" required value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
              <p className="text-xs text-muted-foreground">Changing this changes the number you sign in with.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} placeholder="Optional" />
            </div>
            <Button type="submit" disabled={savingProfile}>
              {savingProfile ? 'Saving…' : 'Save profile'}
            </Button>
          </form>
        </Section>

        <Section title="Change password">
          <form onSubmit={changePassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cur">Current password</Label>
              <Input id="cur" type="password" required autoComplete="current-password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new">New password</Label>
              <Input id="new" type="password" required minLength={10} autoComplete="new-password" value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} />
              <p className="text-xs text-muted-foreground">At least 10 characters.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm new password</Label>
              <Input id="confirm" type="password" required minLength={10} autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
            </div>
            <Button type="submit" disabled={savingPw}>
              {savingPw ? 'Changing…' : 'Change password'}
            </Button>
          </form>
        </Section>
      </div>
    </AppShell>
  );
}
