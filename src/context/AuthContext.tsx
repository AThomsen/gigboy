/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { dataClient } from '../lib/dataClient';
import type { UserPreferences } from '../lib/userPreferences';
import type { AuthMethods } from '../lib/dataClient/types';

export interface User {
  id: string;
  email: string;
  username: string | null;
  avatar: string | null;
  fullName: string | null;
  role: 'member' | 'admin';
  /** Whether this user may create bands (server's ANYONE_CAN_CREATE_BANDS, or admin). Missing = true. */
  canCreateBands?: boolean;
  storageQuotaBytes: number;
  /** Optional so older payloads / fixtures without it still type-check; treat missing as {}. */
  preferences?: UserPreferences;
  /** False for accounts that sign in only by passkey or emailed code. */
  hasPassword?: boolean;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  authEnabled: boolean;
  authError: string | null;
  /** Sign-in methods this server offers. Loaded before `loading` turns false. */
  authMethods: AuthMethods;
  login: (email: string, password: string) => Promise<string | null>;
  setUser: (user: User | null) => void;
  completeUsername: (username: string) => Promise<string | null>;
  updateEmailAddress: (email: string) => Promise<string | null>;
  updateUsername: (username: string) => Promise<string | null>;
  updateFullName: (fullName: string) => Promise<string | null>;
  updatePassword: (currentPassword: string, newPassword: string) => Promise<string | null>;
  /** Saves a partial preferences update (merged with the stored ones). */
  updatePreferences: (preferences: UserPreferences) => Promise<string | null>;
  deleteAccount: () => Promise<string | null>;
  isDeletingAccount: boolean;
  logout: () => Promise<void>;
}

const DEFAULT_AUTH_METHODS: AuthMethods = { passwords: true, magicLinks: false, passkeys: false };

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [authMethods, setAuthMethods] = useState<AuthMethods | null>(null);
  const [sessionResolved, setSessionResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void dataClient.auth.getAuthMethods().then((methods) => {
      if (!cancelled) setAuthMethods(methods);
    });
    const unsubscribe = dataClient.auth.onAuthStateChanged((nextUser) => {
      setUser(nextUser);
      setSessionResolved(true);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (sessionResolved && authMethods) setLoading(false);
  }, [sessionResolved, authMethods]);

  const login = useCallback(async (email: string, password: string): Promise<string | null> => {
    const { user: loggedInUser, error } = await dataClient.auth.login(email, password);
    if (error) return error;

    if (loggedInUser) {
      setUser(loggedInUser);
    }
    return null;
  }, []);

  // Self-host accounts always get a username at creation time (invite acceptance requires
  // one), so this is only a defensive fallback for the rare account that predates that
  // guarantee. Just persists it the same way updateUsername does.
  const completeUsername = useCallback(async (username: string) => {
    const { user: updatedUser, error } = await dataClient.auth.updateUsername(username);
    if (updatedUser) setUser(updatedUser);
    return error;
  }, []);

  const updateEmailAddress = useCallback(async (email: string) => {
    const { user: updatedUser, error } = await dataClient.auth.updateEmail(email);
    if (updatedUser) setUser(updatedUser);
    return error;
  }, []);

  const updateUsernameValue = useCallback(async (username: string) => {
    const { user: updatedUser, error } = await dataClient.auth.updateUsername(username);
    if (updatedUser) setUser(updatedUser);
    return error;
  }, []);

  const updateFullNameValue = useCallback(async (fullName: string) => {
    const { user: updatedUser, error } = await dataClient.auth.updateFullName(fullName);
    if (updatedUser) setUser(updatedUser);
    return error;
  }, []);

  const updatePreferencesValue = useCallback(async (preferences: UserPreferences) => {
    const { user: updatedUser, error } = await dataClient.auth.updatePreferences(preferences);
    if (updatedUser) setUser(updatedUser);
    return error;
  }, []);

  const updatePasswordValue = useCallback(async (currentPassword: string, newPassword: string) => {
    const { error } = await dataClient.auth.updatePassword(currentPassword, newPassword);
    return error;
  }, []);

  const deleteAccountValue = useCallback(async (): Promise<string | null> => {
    try {
      setIsDeletingAccount(true);
      const { error } = await dataClient.auth.deleteAccount();
      if (error) {
        setIsDeletingAccount(false);
        return error;
      }
      setUser(null);
      return null;
    } catch (err: unknown) {
      setIsDeletingAccount(false);
      return err instanceof Error ? err.message : 'Failed to delete account.';
    }
  }, []);

  const logout = useCallback(async () => {
    await dataClient.auth.logout();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      authEnabled: true,
      authError: null,
      authMethods: authMethods ?? DEFAULT_AUTH_METHODS,
      login,
      setUser,
      completeUsername,
      updateEmailAddress,
      updateUsername: updateUsernameValue,
      updateFullName: updateFullNameValue,
      updatePassword: updatePasswordValue,
      updatePreferences: updatePreferencesValue,
      deleteAccount: deleteAccountValue,
      isDeletingAccount,
      logout,
    }),
    [
      user,
      loading,
      authMethods,
      login,
      completeUsername,
      updateEmailAddress,
      updateUsernameValue,
      updateFullNameValue,
      updatePasswordValue,
      updatePreferencesValue,
      deleteAccountValue,
      isDeletingAccount,
      logout,
    ]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
