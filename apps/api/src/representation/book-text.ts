import type { SelectedReview } from './evidence-selection';

/**
 * The text a book is embedded from (spec 7: "a sentence-embedding of the
 * description and selected review text"). Changing this recipe changes every
 * vector, so it carries a version that is part of the stored model key.
 */
export const EMBEDDING_TEXT_VERSION = 'text-v1';

export interface BookForEmbedding {
  title: string;
  authors: string[];
  genres: string[];
  description: string | null;
}

/** Removes HTML tags and collapses whitespace (Goodreads descriptions may contain markup). */
export function plainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildEmbeddingText(
  book: BookForEmbedding,
  reviews: SelectedReview[],
  options: { maxReviews: number; maxChars: number },
): string {
  const lines = [`Title: ${book.title}`];
  if (book.authors.length > 0) lines.push(`Authors: ${book.authors.join(', ')}`);
  if (book.genres.length > 0) lines.push(`Genres: ${book.genres.join('; ')}`);
  if (book.description) lines.push(`Description: ${plainText(book.description)}`);
  const used = reviews.slice(0, options.maxReviews);
  if (used.length > 0) {
    lines.push('Reader reviews:');
    for (const review of used) lines.push(`- ${plainText(review.text)}`);
  }
  const text = lines.join('\n');
  return text.length <= options.maxChars ? text : text.slice(0, options.maxChars);
}
