import { create } from 'zustand';
import { authAPI, User } from '@/services/api/auth';
import { logger } from '@/utils/prodLogger';

// Ported from RapidTool-Fixture. Cookie-based auth shared across the RapidTool
// family on *.appliedadditive.com. Portal (RapidTool-Portal) owns sign-in/sign-up
// for the whole suite — see AuthGate, which redirects there instead of
// authenticating locally — so this store only tracks session state, it doesn't
// perform login/register itself. Set VITE_DISABLE_AUTH=true for local dev (mock
// user, no backend needed).

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  error: string | null;

  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  logout: () => Promise<void>;
  fetchCurrentUser: () => Promise<void>;
  clearError: () => void;
  verifyEmail: (token: string) => Promise<{ message: string }>;
  resendVerification: (email: string) => Promise<{ message: string }>;
  requestPasswordReset: (email: string) => Promise<{ message: string }>;
  resetPassword: (token: string, password: string) => Promise<{ message: string }>;
}

const isAuthDisabled = import.meta.env.VITE_DISABLE_AUTH === 'true';

const MOCK_USER: User = {
  id: 'mock-user-id',
  email: 'dev@example.com',
  name: 'Developer',
  role: 'admin',
  emailVerified: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

export const useAuthStore = create<AuthState>((set) => ({
  user: isAuthDisabled ? MOCK_USER : null,
  isLoading: isAuthDisabled ? false : true, // loading while we check cookies, unless auth is disabled
  isAuthenticated: isAuthDisabled,
  error: null,

  setUser: (user) => set({ user, isAuthenticated: !!user }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),

  logout: async () => {
    if (isAuthDisabled) return;
    try {
      set({ isLoading: true });
      await authAPI.logout();
      set({ user: null, isAuthenticated: false, isLoading: false, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Logout failed', isLoading: false });
      throw error;
    }
  },

  fetchCurrentUser: async () => {
    if (isAuthDisabled) {
      set({ user: MOCK_USER, isAuthenticated: true, isLoading: false });
      return;
    }
    try {
      const user = await authAPI.getCurrentUser();
      set({ user, isAuthenticated: true, isLoading: false });
      logger.debug('[AuthStore] Current user fetched');
    } catch {
      logger.debug('[AuthStore] No existing session');
      set({ user: null, isAuthenticated: false, isLoading: false, error: null });
    }
  },

  verifyEmail: async (token) => {
    set({ isLoading: true, error: null });
    try {
      const response = await authAPI.verifyEmail({ token });
      set({ isLoading: false });
      return response;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Verification failed', isLoading: false });
      throw error;
    }
  },

  resendVerification: async (email) => {
    set({ isLoading: true, error: null });
    try {
      const response = await authAPI.resendVerification({ email });
      set({ isLoading: false });
      return response;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to resend verification email', isLoading: false });
      throw error;
    }
  },

  requestPasswordReset: async (email) => {
    set({ isLoading: true, error: null });
    try {
      const response = await authAPI.requestPasswordReset({ email });
      set({ isLoading: false });
      return response;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to request password reset', isLoading: false });
      throw error;
    }
  },

  resetPassword: async (token, password) => {
    set({ isLoading: true, error: null });
    try {
      const response = await authAPI.resetPassword({ token, password });
      set({ isLoading: false });
      return response;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to reset password', isLoading: false });
      throw error;
    }
  },
}));

// Global logout (fired by the API client when refresh fails).
window.addEventListener('auth:logout', () => {
  useAuthStore.getState().setUser(null);
  useAuthStore.getState().setError('Session expired. Please login again.');
});
