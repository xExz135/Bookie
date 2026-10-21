import { Wordmark } from '@/components/wordmark';

/** Sign-in pages: one centred card, mobile first. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="px-4 py-5 sm:px-8">
        <Wordmark />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-6 sm:pt-16">
        <div className="w-full max-w-md rounded-lg border border-outline-variant/60 bg-surface-container-lowest p-6 sm:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
