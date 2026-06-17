/**
 * AccountSettings
 *
 * Account popup — ported from RapidTool-Fixture (src/components/AccountSettings.tsx)
 * for family parity, hand-rolled with the shared tokens (no shadcn dependency).
 * Opened from the account button at the bottom of the left toolbar.
 */

import React from 'react';
import { User, Mail, Calendar, Shield, LogOut, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';

interface AccountSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLogout: () => void;
}

const getInitials = (name?: string, email?: string) => {
  if (name) return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);
  if (email) return email.slice(0, 2).toUpperCase();
  return 'U';
};

const formatDate = (s?: string) =>
  s ? new Date(s).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A';

const Field: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <div className="space-y-2">
    <span className="flex items-center gap-2 text-sm font-medium text-[hsl(var(--foreground))]">{icon}{label}</span>
    <div className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] px-3 py-2 text-sm text-[hsl(var(--muted-foreground))]">
      {value || '—'}
    </div>
  </div>
);

export const AccountSettings: React.FC<AccountSettingsProps> = ({ open, onOpenChange, onLogout }) => {
  const user = useAuthStore((s) => s.user);

  // Only ever render real, signed-in account data (same contract as the Portal).
  if (!open || !user) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => onOpenChange(false)} />

      {/* Card */}
      <div className="relative z-10 w-full max-w-[500px] mx-4 rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-2xl p-6 max-h-[90vh] overflow-auto">
        <button onClick={() => onOpenChange(false)} title="Close"
          className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] tech-transition">
          <X className="w-4 h-4" />
        </button>

        <h2 className="text-2xl font-bold text-[hsl(var(--foreground))]">Account Settings</h2>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">Manage your account information and preferences</p>

        {/* Profile */}
        <div className="flex items-center gap-4 mt-6">
          <div className="w-20 h-20 rounded-full flex items-center justify-center text-xl font-semibold shrink-0"
            style={{ background: 'hsl(var(--primary) / 0.1)', color: 'hsl(var(--primary))' }}>
            {getInitials(user?.name, user?.email)}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold text-[hsl(var(--foreground))] truncate">{user?.name || 'User'}</h3>
            <p className="text-sm text-[hsl(var(--muted-foreground))] truncate">{user?.email}</p>
            <div className="mt-1">
              {user?.emailVerified ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 border border-green-600 rounded-full px-2 py-0.5">
                  <CheckCircle2 className="w-3 h-3" /> Verified
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 border border-amber-600 rounded-full px-2 py-0.5">
                  <AlertCircle className="w-3 h-3" /> Unverified
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="h-px bg-[hsl(var(--border))] my-6" />

        {/* Profile info */}
        <h4 className="text-sm font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Profile Information</h4>
        <div className="space-y-3 mt-4">
          <Field icon={<User className="w-4 h-4" />} label="Name" value={user?.name || ''} />
          <Field icon={<Mail className="w-4 h-4" />} label="Email" value={user?.email || ''} />
        </div>

        <div className="h-px bg-[hsl(var(--border))] my-6" />

        {/* Account details */}
        <h4 className="text-sm font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Account Details</h4>
        <div className="grid grid-cols-2 gap-4 text-sm mt-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[hsl(var(--muted-foreground))]"><Calendar className="w-4 h-4" /><span>Member Since</span></div>
            <p className="font-medium text-[hsl(var(--foreground))]">{formatDate(user?.createdAt)}</p>
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[hsl(var(--muted-foreground))]"><Shield className="w-4 h-4" /><span>Role</span></div>
            <p className="font-medium capitalize text-[hsl(var(--foreground))]">{user?.role || 'User'}</p>
          </div>
        </div>

        <div className="h-px bg-[hsl(var(--border))] my-6" />

        {/* Actions */}
        <button onClick={onLogout}
          className="w-full flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold text-white bg-[hsl(var(--destructive))] hover:opacity-90 tech-transition">
          <LogOut className="w-4 h-4" /> Logout
        </button>
      </div>
    </div>
  );
};

export default AccountSettings;
