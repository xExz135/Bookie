/** Where the API runs. The default matches `pnpm --filter @bookie/api dev`. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(
  /\/$/,
  '',
);
