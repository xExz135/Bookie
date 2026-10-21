import { Compare } from '@/components/compare/compare';

export const metadata = { title: 'Compare' };

type Query = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) || null;

/** Two analyses side by side (FE-8), chosen on the reading list: `/compare?a=&b=`. */
export default async function ComparePage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const a = one(query.a);
  const b = one(query.b);
  // A new pair starts from a clean screen rather than showing the previous one.
  return <Compare key={`${a}:${b}`} a={a} b={b} />;
}
