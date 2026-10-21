import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import { type GeminiClient, LlmError } from '../llm/gemini.client';
import { BookSearchService } from './book-search.service';
import { CoverReadError, readCover } from './cover-reader';
import { type ScanResult, toCandidate } from './discovery.schemas';
import { checkImage } from './image-check';
import { decideScan, isPlausible } from './scan-decision';
import { ScanQuota } from './scan-quota';

export const COVER_VISION = Symbol('COVER_VISION');

/** The uploaded file, held in memory only (DISC-3). */
export interface UploadedImage {
  buffer: Buffer;
  size: number;
}

/**
 * Cover scan (spec 6). Order matters:
 * 1. Size is checked while uploading (UPLOAD_TOO_LARGE), type and structure
 *    here (UNSUPPORTED_TYPE, UNREADABLE_IMAGE): all before any processing (DISC-4).
 * 2. One scan is taken from the reader's quota.
 * 3. The vision model reads the cover. If the service fails on our side the
 *    scan is given back.
 * 4. The catalog (then Open Library) is searched with what the cover says,
 *    and code decides whether the scan is identified or uncertain (DISC-2).
 * The image is never written anywhere (DISC-3).
 */
@Injectable()
export class ScanService {
  private readonly logger = new Logger('Scan');

  constructor(
    private readonly quota: ScanQuota,
    private readonly search: BookSearchService,
    @Inject(COVER_VISION) private readonly vision: Pick<GeminiClient, 'generateJson'>,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async scan(userId: string, file: UploadedImage | undefined): Promise<ScanResult> {
    if (!file || file.size === 0) {
      throw new ApiError('VALIDATION_FAILED', { fields: { image: 'Attach a cover photo.' } });
    }
    const image = checkImage(file.buffer);
    if (!image.ok) {
      throw new ApiError(
        image.reason === 'unsupported_type' ? 'UNSUPPORTED_TYPE' : 'UNREADABLE_IMAGE',
      );
    }

    const usageId = await this.quota.reserve(userId);
    let reading;
    try {
      ({ reading } = await readCover(this.vision, this.config.GEMINI_VISION_MODEL, image));
    } catch (error) {
      throw await this.identificationFailed(error, usageId);
    }
    if (!reading.isBook) throw new ApiError('NOT_A_BOOK');
    if (!reading.readable) throw new ApiError('UNREADABLE_IMAGE');

    const thresholds = {
      minTitle: this.config.SCAN_MIN_CONFIDENCE,
      minAuthor: this.config.SCAN_AUTHOR_MIN_MATCH,
    };
    const firstAuthor = reading.authors[0] ?? null;
    const { hits, external } = await this.search.searchWithFallback(
      {
        query: [reading.title, firstAuthor].filter(Boolean).join(' '),
        // More than shown, so a second plausible book is noticed (never auto-select).
        limit: this.config.SEARCH_MAX_CANDIDATES * 2,
        cover: { title: reading.title, subtitle: reading.subtitle, author: firstAuthor },
      },
      (found) => found.some((h) => isPlausible(h, reading, thresholds)),
    );
    const { outcome, ordered } = decideScan(reading, hits, thresholds);
    this.logger.log(
      `Scan by user ${userId}: ${outcome}, certainty ${reading.certainty}, ${hits.length} matches`,
    );
    return {
      outcome,
      candidates: ordered.slice(0, this.config.SEARCH_MAX_CANDIDATES).map(toCandidate),
      recognized: {
        title: reading.title,
        subtitle: reading.subtitle || null,
        authors: reading.authors,
      },
      external,
    };
  }

  /** Maps a failed identification to the contract, giving the scan back when it was not the photo's fault. */
  private async identificationFailed(error: unknown, usageId: bigint): Promise<ApiError> {
    if (
      error instanceof LlmError &&
      (error.kind === 'blocked' || error.kind === 'invalid_request')
    ) {
      // The model refused or could not take this image: a problem with the photo.
      return new ApiError('UNREADABLE_IMAGE');
    }
    await this.quota.release(usageId);
    if (error instanceof LlmError) {
      if (error.kind === 'auth') this.logger.error('Vision model rejected the API key');
      else this.logger.warn(`Vision model unavailable (${error.kind}): ${error.message}`);
      return new ApiError('IDENTIFICATION_UNAVAILABLE', {
        retryAfterSeconds: error.kind === 'quota' ? error.retryAfterSeconds : undefined,
      });
    }
    if (error instanceof CoverReadError) {
      this.logger.warn('Vision model output was invalid twice');
      return new ApiError('IDENTIFICATION_UNAVAILABLE');
    }
    throw error;
  }
}
