-- BE-9 (D-025): a reader's refresh request on an analysis, and one claim per edition
-- while its public reception is being built, so simultaneous requests share one build.

-- AlterTable
ALTER TABLE "analyses" ADD COLUMN     "refresh" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "public_analysis_builds" (
    "edition_id" UUID NOT NULL,
    "analysis_id" UUID NOT NULL,
    "claimed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_analysis_builds_pkey" PRIMARY KEY ("edition_id")
);

-- AddForeignKey
ALTER TABLE "public_analysis_builds" ADD CONSTRAINT "public_analysis_builds_edition_id_fkey" FOREIGN KEY ("edition_id") REFERENCES "editions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_analysis_builds" ADD CONSTRAINT "public_analysis_builds_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
