import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '../../src/database/prisma.service';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { TEST_DATABASE_URL } from './test-database';

/**
 * BE-2: the rules the database itself enforces, checked against a real
 * PostgreSQL built from the migrations. Every test makes its own rows.
 */
let prisma: PrismaClient;

beforeAll(() => {
  prisma = createPrismaClient(TEST_DATABASE_URL);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const future = () => new Date(Date.now() + 30 * 24 * 3600 * 1000);

async function makeUser() {
  return prisma.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      passwordHash: 'argon2id$hash',
      displayName: 'Reader',
    },
  });
}

async function makeEdition() {
  const work = await prisma.work.create({ data: { title: 'A Book' } });
  return prisma.edition.create({
    data: {
      workId: work.id,
      title: 'A Book',
      normalizedTitle: 'a book',
      normalizedAuthors: 'an author',
      metadataExpiresAt: future(),
    },
  });
}

async function makeVersion(
  userId: string,
  versionNo: number,
  ratings: Array<[string, number]> = [],
) {
  return prisma.tasteProfileVersion.create({
    data: {
      userId,
      versionNo,
      ratings: {
        create: ratings.map(([editionId, rating]) => ({ editionId, rating, origin: 'quick_rate' })),
      },
    },
  });
}

async function datasetSourceId(): Promise<number> {
  const source = await prisma.reviewSource.findUniqueOrThrow({
    where: { key: 'goodreads_dataset' },
  });
  return source.id;
}

async function makePublicAnalysis(editionId: string, reviewsVersion = 1) {
  const sourceId = await datasetSourceId();
  const review = await prisma.review.create({
    data: { editionId, sourceId, externalReviewId: randomUUID(), rating: 4, text: 'Loved it.' },
  });
  return prisma.publicAnalysis.create({
    data: {
      editionId,
      reviewsVersion,
      evidenceState: 'sufficient',
      confidence: 'medium',
      confidenceReasons: ['1 review from 1 source'],
      summary: 'Readers liked it.',
      expiresAt: future(),
      evidenceItems: { create: [{ position: 1, kind: 'review', reviewId: review.id }] },
    },
    include: { evidenceItems: true },
  });
}

async function makeModelVersion() {
  return prisma.modelVersion.create({ data: { modelId: 'B4', version: randomUUID() } });
}

describe('BE-2 schema: reference data', () => {
  it('seeds the ten dataset genres, the themes and the dataset source policy', async () => {
    expect(await prisma.genre.count()).toBe(10);
    expect(await prisma.theme.count()).toBe(4);
    const source = await prisma.reviewSource.findUniqueOrThrow({
      where: { key: 'goodreads_dataset' },
    });
    expect(source).toMatchObject({
      providesText: true,
      storageAllowed: true,
      displayAllowed: true,
    });
  });

  it('stores emails lowercased only', async () => {
    await expect(
      prisma.user.create({
        data: { email: `UPPER-${randomUUID()}@Example.test`, passwordHash: 'x', displayName: 'R' },
      }),
    ).rejects.toThrow();
  });
});

describe('ONB-4: taste-profile versions are immutable', () => {
  it('saves a version and its ratings together', async () => {
    const user = await makeUser();
    const edition = await makeEdition();
    const version = await makeVersion(user.id, 1, [[edition.id, 5]]);
    expect(await prisma.profileRating.count({ where: { tasteProfileVersionId: version.id } })).toBe(
      1,
    );
  });

  it('also accepts ratings written in the same interactive transaction', async () => {
    const user = await makeUser();
    const edition = await makeEdition();
    await prisma.$transaction(async (tx) => {
      const version = await tx.tasteProfileVersion.create({
        data: { userId: user.id, versionNo: 1 },
      });
      await tx.profileRating.create({
        data: {
          tasteProfileVersionId: version.id,
          editionId: edition.id,
          rating: 3,
          origin: 'imported',
        },
      });
    });
    expect(await prisma.profileRating.count({ where: { editionId: edition.id } })).toBe(1);
  });

  it('rejects changing a saved version', async () => {
    const user = await makeUser();
    const version = await makeVersion(user.id, 1);
    await expect(
      prisma.tasteProfileVersion.update({ where: { id: version.id }, data: { pace: 'fast' } }),
    ).rejects.toThrow(/immutable/);
  });

  it('rejects changing a saved rating', async () => {
    const user = await makeUser();
    const edition = await makeEdition();
    const version = await makeVersion(user.id, 1, [[edition.id, 2]]);
    await expect(
      prisma.profileRating.update({
        where: {
          tasteProfileVersionId_editionId: {
            tasteProfileVersionId: version.id,
            editionId: edition.id,
          },
        },
        data: { rating: 5 },
      }),
    ).rejects.toThrow(/immutable/);
  });

  it('rejects adding a rating to a version saved earlier', async () => {
    const user = await makeUser();
    const edition = await makeEdition();
    const version = await makeVersion(user.id, 1);
    await expect(
      prisma.profileRating.create({
        data: {
          tasteProfileVersionId: version.id,
          editionId: edition.id,
          rating: 4,
          origin: 'quick_rate',
        },
      }),
    ).rejects.toThrow(/transaction that created/);
  });

  it('rejects a second version with the same number', async () => {
    const user = await makeUser();
    await makeVersion(user.id, 1);
    await expect(makeVersion(user.id, 1)).rejects.toThrow();
  });

  it('rejects ratings outside 1 to 5', async () => {
    const user = await makeUser();
    const edition = await makeEdition();
    await expect(makeVersion(user.id, 1, [[edition.id, 6]])).rejects.toThrow();
    await expect(makeVersion(user.id, 2, [[edition.id, 0]])).rejects.toThrow();
  });
});

describe('Duplicate requests join the running analysis (spec 10)', () => {
  it('allows only one running analysis per reader, edition and profile version', async () => {
    const user = await makeUser();
    const edition = await makeEdition();
    const version = await makeVersion(user.id, 1);
    const data = { userId: user.id, editionId: edition.id, tasteProfileVersionId: version.id };

    const first = await prisma.analysis.create({ data });
    await expect(prisma.analysis.create({ data })).rejects.toThrow();

    // A different profile version is a different request.
    const version2 = await makeVersion(user.id, 2);
    await prisma.analysis.create({ data: { ...data, tasteProfileVersionId: version2.id } });

    // Once the first one finishes, the same request may run again.
    await prisma.analysis.update({
      where: { id: first.id },
      data: { status: 'complete', finishedAt: new Date() },
    });
    await prisma.analysis.create({ data });
  });

  it('also applies to readers with no profile version', async () => {
    const user = await makeUser();
    const edition = await makeEdition();
    const data = { userId: user.id, editionId: edition.id };
    await prisma.analysis.create({ data });
    await expect(prisma.analysis.create({ data })).rejects.toThrow();
  });

  it('requires finishedAt exactly when the analysis is no longer running', async () => {
    const user = await makeUser();
    const edition = await makeEdition();
    await expect(
      prisma.analysis.create({
        data: { userId: user.id, editionId: edition.id, status: 'complete' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.analysis.create({
        data: { userId: user.id, editionId: edition.id, status: 'running', finishedAt: new Date() },
      }),
    ).rejects.toThrow();
  });
});

describe('RES-5: every citation resolves to evidence of the same analysis', () => {
  it('accepts a claim citing its own evidence', async () => {
    const edition = await makeEdition();
    const analysis = await makePublicAnalysis(edition.id);
    const claim = await prisma.analysisClaim.create({
      data: {
        publicAnalysisId: analysis.id,
        kind: 'praise',
        text: 'Readers love the voice.',
        rank: 1,
      },
    });
    await prisma.claimEvidence.create({
      data: {
        claimId: claim.id,
        publicAnalysisId: analysis.id,
        evidenceItemId: analysis.evidenceItems[0]!.id,
      },
    });
  });

  it("rejects a claim citing another analysis's evidence", async () => {
    const edition = await makeEdition();
    const a = await makePublicAnalysis(edition.id, 1);
    const b = await makePublicAnalysis(edition.id, 2);
    const claim = await prisma.analysisClaim.create({
      data: { publicAnalysisId: b.id, kind: 'complaint', text: 'Slow middle.', rank: 1 },
    });
    // Claimed as analysis B, pointing at A's evidence item.
    await expect(
      prisma.claimEvidence.create({
        data: { claimId: claim.id, publicAnalysisId: b.id, evidenceItemId: a.evidenceItems[0]!.id },
      }),
    ).rejects.toThrow();
    // Claimed as analysis A, but the claim belongs to B.
    await expect(
      prisma.claimEvidence.create({
        data: { claimId: claim.id, publicAnalysisId: a.id, evidenceItemId: a.evidenceItems[0]!.id },
      }),
    ).rejects.toThrow();
  });

  it('rejects a citation to evidence that does not exist', async () => {
    const edition = await makeEdition();
    const analysis = await makePublicAnalysis(edition.id);
    const claim = await prisma.analysisClaim.create({
      data: { publicAnalysisId: analysis.id, kind: 'praise', text: 'x', rank: 1 },
    });
    await expect(
      prisma.claimEvidence.create({
        data: { claimId: claim.id, publicAnalysisId: analysis.id, evidenceItemId: randomUUID() },
      }),
    ).rejects.toThrow();
  });

  it('rejects an evidence item whose fields do not match its kind', async () => {
    const edition = await makeEdition();
    const analysis = await makePublicAnalysis(edition.id);
    await expect(
      prisma.evidenceItem.create({
        data: { publicAnalysisId: analysis.id, position: 2, kind: 'review' },
      }),
    ).rejects.toThrow();
  });
});

describe('RES-3: no written verdict without usable evidence', () => {
  it.each(['insufficient', 'unavailable'] as const)(
    'rejects a summary when evidence is %s',
    async (state) => {
      const edition = await makeEdition();
      await expect(
        prisma.publicAnalysis.create({
          data: {
            editionId: edition.id,
            reviewsVersion: 1,
            evidenceState: state,
            confidence: 'low',
            confidenceReasons: [],
            summary: 'Looks like a verdict.',
            expiresAt: future(),
          },
        }),
      ).rejects.toThrow();
    },
  );
});

describe('MODEL-3: personal results record their versions and never change', () => {
  async function setup() {
    const user = await makeUser();
    const edition = await makeEdition();
    const version = await makeVersion(user.id, 1, [[edition.id, 4]]);
    const model = await makeModelVersion();
    const analysis = await prisma.analysis.create({
      data: { userId: user.id, editionId: edition.id, tasteProfileVersionId: version.id },
    });
    return { user, edition, version, model, analysis };
  }

  it('saves a scored result with its versions and explanation together', async () => {
    const { user, edition, version, model, analysis } = await setup();
    const personal = await prisma.personalAnalysis.create({
      data: {
        analysisId: analysis.id,
        userId: user.id,
        editionId: edition.id,
        tasteProfileVersionId: version.id,
        modelVersionId: model.id,
        outcome: 'scored',
        score: 4.2,
        confidence: 'low',
        confidenceReasons: ['1 rated book'],
        notFactoredIn: ['themes'],
        similarBooks: { create: [{ rank: 1, editionId: edition.id, yourRating: 4 }] },
      },
    });
    expect(Number(personal.score)).toBe(4.2);
  });

  it('rejects a scored result without its model version', async () => {
    const { user, edition, version, analysis } = await setup();
    await expect(
      prisma.personalAnalysis.create({
        data: {
          analysisId: analysis.id,
          userId: user.id,
          editionId: edition.id,
          tasteProfileVersionId: version.id,
          outcome: 'scored',
          score: 3,
          confidence: 'low',
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects scores outside the 1 to 5 scale', async () => {
    const { user, edition, version, model, analysis } = await setup();
    await expect(
      prisma.personalAnalysis.create({
        data: {
          analysisId: analysis.id,
          userId: user.id,
          editionId: edition.id,
          tasteProfileVersionId: version.id,
          modelVersionId: model.id,
          outcome: 'scored',
          score: 5.5,
          confidence: 'high',
        },
      }),
    ).rejects.toThrow();
  });

  it('MODEL-4: rejects a score on a below-floor result', async () => {
    const { user, edition, version, analysis } = await setup();
    await expect(
      prisma.personalAnalysis.create({
        data: {
          analysisId: analysis.id,
          userId: user.id,
          editionId: edition.id,
          tasteProfileVersionId: version.id,
          outcome: 'below_floor',
          score: 3,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects changing a saved result or adding to its explanation later', async () => {
    const { user, edition, version, model, analysis } = await setup();
    const personal = await prisma.personalAnalysis.create({
      data: {
        analysisId: analysis.id,
        userId: user.id,
        editionId: edition.id,
        tasteProfileVersionId: version.id,
        modelVersionId: model.id,
        outcome: 'scored',
        score: 2.5,
        confidence: 'medium',
      },
    });
    await expect(
      prisma.personalAnalysis.update({ where: { id: personal.id }, data: { score: 4.9 } }),
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.personalSimilarBook.create({
        data: { personalAnalysisId: personal.id, rank: 1, editionId: edition.id, yourRating: 5 },
      }),
    ).rejects.toThrow(/transaction that created/);
  });
});

describe('FB-1: feedback', () => {
  it('stores personal feedback only with its versions, one value per target, changeable', async () => {
    const user = await makeUser();
    const edition = await makeEdition();
    const version = await makeVersion(user.id, 1);
    const model = await makeModelVersion();
    const analysis = await prisma.analysis.create({
      data: { userId: user.id, editionId: edition.id },
    });

    await expect(
      prisma.feedback.create({
        data: { userId: user.id, analysisId: analysis.id, target: 'personal', value: 'accurate' },
      }),
    ).rejects.toThrow();

    const key = {
      userId_analysisId_target: {
        userId: user.id,
        analysisId: analysis.id,
        target: 'personal' as const,
      },
    };
    const base = {
      userId: user.id,
      analysisId: analysis.id,
      target: 'personal' as const,
      tasteProfileVersionId: version.id,
      modelVersionId: model.id,
    };
    await prisma.feedback.upsert({
      where: key,
      create: { ...base, value: 'accurate' },
      update: {},
    });
    await prisma.feedback.upsert({
      where: key,
      create: { ...base, value: 'not_for_me' },
      update: { value: 'not_for_me' },
    });
    const rows = await prisma.feedback.findMany({ where: { analysisId: analysis.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe('not_for_me');
  });
});

describe('SEC-3: deleting a reader removes their rows and keeps shared data', () => {
  it('leaves no row referencing the reader and keeps the catalog and public analyses', async () => {
    const reader = await makeUser();
    const other = await makeUser();
    const edition = await makeEdition();
    const publicAnalysis = await makePublicAnalysis(edition.id);
    const model = await makeModelVersion();

    // A full set of the reader's own data.
    const version = await makeVersion(reader.id, 1, [[edition.id, 5]]);
    const analysis = await prisma.analysis.create({
      data: {
        userId: reader.id,
        editionId: edition.id,
        tasteProfileVersionId: version.id,
        publicAnalysisId: publicAnalysis.id,
      },
    });
    const personal = await prisma.personalAnalysis.create({
      data: {
        analysisId: analysis.id,
        userId: reader.id,
        editionId: edition.id,
        tasteProfileVersionId: version.id,
        modelVersionId: model.id,
        publicAnalysisId: publicAnalysis.id,
        outcome: 'scored',
        score: 4,
        confidence: 'low',
        similarBooks: { create: [{ rank: 1, editionId: edition.id, yourRating: 5 }] },
        traitFits: { create: [{ trait: 'pace', fit: 'unknown' }] },
      },
    });
    await prisma.analysisStep.create({
      data: { analysisId: analysis.id, step: 'resolve', status: 'done' },
    });
    await prisma.feedback.create({
      data: { userId: reader.id, analysisId: analysis.id, target: 'public', value: 'accurate' },
    });
    await prisma.readingListItem.create({ data: { userId: reader.id, editionId: edition.id } });
    await prisma.ratingImport.create({
      data: {
        userId: reader.id,
        status: 'needs_review',
        totalRows: 1,
        rows: { create: [{ rowIndex: 0, rawTitle: 'Unknown', rating: 3, status: 'unmatched' }] },
      },
    });
    await prisma.refreshToken.create({
      data: { userId: reader.id, tokenHash: randomUUID(), expiresAt: future() },
    });
    await prisma.passwordResetToken.create({
      data: { userId: reader.id, tokenHash: randomUUID(), expiresAt: future() },
    });
    await prisma.scanUsage.create({ data: { userId: reader.id } });
    await prisma.refreshRequest.create({ data: { userId: reader.id, editionId: edition.id } });

    // Another reader's data must survive.
    await makeVersion(other.id, 1, [[edition.id, 2]]);

    await prisma.user.delete({ where: { id: reader.id } });

    // Every table with a user_id column holds nothing for the deleted reader.
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'user_id'`;
    expect(tables.length).toBeGreaterThanOrEqual(10);
    for (const { table_name } of tables) {
      const [row] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM "${table_name}" WHERE user_id = $1::uuid`,
        reader.id,
      );
      expect({ table: table_name, rows: Number(row!.n) }).toEqual({ table: table_name, rows: 0 });
    }
    // Rows owned through a parent are gone too.
    expect(await prisma.profileRating.count({ where: { tasteProfileVersionId: version.id } })).toBe(
      0,
    );
    expect(
      await prisma.personalSimilarBook.count({ where: { personalAnalysisId: personal.id } }),
    ).toBe(0);
    expect(await prisma.analysisStep.count({ where: { analysisId: analysis.id } })).toBe(0);
    expect(await prisma.ratingImportRow.count({ where: { import: { userId: reader.id } } })).toBe(
      0,
    );

    // Shared data and the other reader are untouched.
    expect(await prisma.edition.count({ where: { id: edition.id } })).toBe(1);
    expect(await prisma.publicAnalysis.count({ where: { id: publicAnalysis.id } })).toBe(1);
    expect(await prisma.modelVersion.count({ where: { id: model.id } })).toBe(1);
    expect(await prisma.tasteProfileVersion.count({ where: { userId: other.id } })).toBe(1);
  });
});
