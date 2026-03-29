'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode
} from 'react';
import { useClerk, useUser } from '@clerk/nextjs';

interface UserData {
  id: string;
  email: string;
  name: string;
  role: string;
  accountId: string;
}

interface AccountData {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  brandName: string | null;
  primaryColor: string | null;
  plan: string;
  onboardingComplete: boolean;
}

interface AuthContextType {
  user: UserData | null;
  account: AccountData | null;
  isLoading: boolean;
  token: string | null;
  setToken: (token: string | null) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  account: null,
  isLoading: true,
  token: null,
  setToken: () => {},
  logout: () => {}
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserData | null>(null);
  const [account, setAccount] = useState<AccountData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [token, setTokenState] = useState<string | null>(null);
  const { isSignedIn, isLoaded: clerkLoaded } = useUser();

  // Try loading JWT token from localStorage
  useEffect(() => {
    const stored =
      typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (stored) {
      setTokenState(stored);
    }
  }, []);

  // Fetch user data — try JWT first, then fall back to Clerk session cookies
  useEffect(() => {
    if (!clerkLoaded) return;

    async function fetchMe() {
      try {
        // If we have a JWT token, try that first
        if (token) {
          const res = await fetch('/api/auth/me', {
            headers: { Authorization: `Bearer ${token}` },
            credentials: 'include'
          });
          if (res.ok) {
            const data = await res.json();
            setUser(data.user);
            setAccount(data.account);
            setIsLoading(false);
            return;
          }
          // JWT invalid — clear it
          localStorage.removeItem('token');
          setTokenState(null);
        }

        // Fall back to Clerk session-based auth (cookies)
        if (isSignedIn) {
          const res = await fetch('/api/auth/me', {
            credentials: 'include'
          });
          if (res.ok) {
            const data = await res.json();
            setUser(data.user);
            setAccount(data.account);
            setIsLoading(false);
            return;
          }
        }

        // No auth available
        setUser(null);
        setAccount(null);
      } catch {
        // Network error
      } finally {
        setIsLoading(false);
      }
    }

    fetchMe();
  }, [token, isSignedIn, clerkLoaded]);

  function setToken(newToken: string | null) {
    if (newToken) {
      localStorage.setItem('token', newToken);
    } else {
      localStorage.removeItem('token');
    }
    setTokenState(newToken);
  }

  const clerk = useClerk();

  function logout() {
    setToken(null);
    setUser(null);
    setAccount(null);
    clerk.signOut({ redirectUrl: '/' });
  }

  return (
    <AuthContext.Provider
      value={{ user, account, isLoading, token, setToken, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
