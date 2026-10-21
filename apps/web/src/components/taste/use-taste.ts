'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth/auth-context';
import { getTasteProfile, type ProfileSaved, type TasteProfile } from '@/lib/taste/api';

/**
 * The reader's taste profile, kept current after each save: the save returns
 * the new version and rated count, so the progress updates without asking
 * again. The first save also ends onboarding (D-018), so the reader is
 * reloaded then.
 */
export function useTasteProfile() {
  const { user, reloadUser } = useAuth();
  const [profile, setProfile] = useState<TasteProfile | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getTasteProfile().then(
      (p) => !cancelled && setProfile(p),
      (e: unknown) => !cancelled && setError(e),
    );
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  const saved = useCallback(
    (result: ProfileSaved) => {
      setProfile((p) =>
        p ? { ...p, version: result.tasteProfileVersion, ratedCount: result.ratedCount } : p,
      );
      if (user?.onboardingState === 'pending') void reloadUser().catch(() => undefined);
    },
    [user, reloadUser],
  );

  return {
    profile,
    setProfile,
    error,
    reload: () => setReloads((n) => n + 1),
    saved,
  };
}
