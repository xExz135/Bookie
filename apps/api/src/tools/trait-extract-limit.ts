/**
 * The number of books `traits:extract` may cover (D-023). The batch uses the
 * same model and daily quota as live analyses and the BE-11 benchmark, so it
 * stops at the offline evaluation set unless the cap is raised on purpose.
 */
export function traitExtractLimit(requested: number, max: number): number {
  if (requested > max) {
    throw new Error(
      `--limit ${requested} is above TRAITS_EXTRACT_MAX_BOOKS (${max}), the offline evaluation set. ` +
        'Trait extraction shares the daily model quota with live analyses; raise TRAITS_EXTRACT_MAX_BOOKS in .env only when a larger evaluation set is decided (D-023).',
    );
  }
  return requested;
}
