'use client';

import { Discover } from '@/components/discovery/discover';
import { Onboarding } from '@/components/taste/onboarding';
import { useAuth } from '@/lib/auth/auth-context';

/**
 * Home: onboarding until the reader has saved taste input or skipped (D-002,
 * FE-2), then discovery: typed search or cover scan, then confirmation (FE-4).
 */
export default function HomePage() {
  const { user } = useAuth();
  if (user?.onboardingState === 'pending') return <Onboarding />;
  return <Discover />;
}
