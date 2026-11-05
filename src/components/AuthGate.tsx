/**
 * AuthGate — RapidTool cross-tool SSO entry guard.
 *
 * On mount it validates the shared .appliedadditive.com session cookie via
 * `fetchCurrentUser()`. While checking → splash. If no session → redirect to
 * Portal's canonical sign-in (Portal owns account creation for the whole
 * suite — see RapidTool-Portal's `/auth/login`/`/auth/register`), carrying a
 * `returnTo` back to this app so Portal sends the user right back here after
 * signing in. When VITE_DISABLE_AUTH is true (local dev) it's a transparent
 * pass-through using a mock user.
 */
import { useEffect, type ReactNode } from 'react';
import { LoadingOverlay } from '@rapidtool/cad-ui';
import { useAuthStore } from '../stores/authStore';

const AUTH_DISABLED = import.meta.env.VITE_DISABLE_AUTH === 'true';
const PORTAL_URL = import.meta.env.VITE_PORTAL_URL || 'https://portal.appliedadditive.com';

function FullScreenLoader({ message }: { message: string }) {
  return (
    <div className="fixed inset-0 z-50 bg-[hsl(var(--background))]">
      <LoadingOverlay isVisible message={message} positioning="absolute" type="import" />
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, fetchCurrentUser } = useAuthStore();

  useEffect(() => {
    fetchCurrentUser();
  }, [fetchCurrentUser]);

  useEffect(() => {
    if (AUTH_DISABLED || isLoading || isAuthenticated) return;
    const returnTo = encodeURIComponent(window.location.href);
    window.location.replace(`${PORTAL_URL}/auth/login?returnTo=${returnTo}`);
  }, [isLoading, isAuthenticated]);

  if (AUTH_DISABLED) return <>{children}</>;

  if (isLoading || !isAuthenticated) return <FullScreenLoader message="Redirecting to sign in…" />;

  return <>{children}</>;
}

export default AuthGate;
