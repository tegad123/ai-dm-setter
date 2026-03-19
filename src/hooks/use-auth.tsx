'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode
} from 'react';

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

  useEffect(() => {
    const stored =
      typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (stored) {
      setTokenState(stored);
    } else {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!token) {
      setUser(null);
      setAccount(null);
      setIsLoading(false);
      return;
    }

    async function fetchMe() {
      try {
        const res = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
          setAccount(data.account);
        } else {
          // Token invalid
          localStorage.removeItem('token');
          setTokenState(null);
        }
      } catch {
        // Network error
      } finally {
        setIsLoading(false);
      }
    }

    fetchMe();
  }, [token]);

  function setToken(newToken: string | null) {
    if (newToken) {
      localStorage.setItem('token', newToken);
    } else {
      localStorage.removeItem('token');
    }
    setTokenState(newToken);
  }

  function logout() {
    setToken(null);
    setUser(null);
    setAccount(null);
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
