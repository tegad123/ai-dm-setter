'use client';
import React from 'react';
import { ActiveThemeProvider } from '../themes/active-theme';
import { AuthProvider } from '@/hooks/use-auth';

export default function Providers({
  activeThemeValue,
  children
}: {
  activeThemeValue: string;
  children: React.ReactNode;
}) {
  return (
    <ActiveThemeProvider initialTheme={activeThemeValue}>
      <AuthProvider>{children}</AuthProvider>
    </ActiveThemeProvider>
  );
}
