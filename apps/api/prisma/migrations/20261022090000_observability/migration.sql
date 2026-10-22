-- BE-11 (D-026): one row per language-model request and per live rating-source
-- answer of an analysis, for cost, latency and source-outcome measurement (H4).

-- CreateTable
CREATE TABLE "llm_calls" (
    "id" UUID NOT NULL,
    "analysis_id" UUID,
    "edition_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "waited_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_calls" (
    "id" UUID NOT NULL,
    "analysis_id" UUID,
    "edition_id" UUID NOT NULL,
    "source_key" TEXT NOT NULL,
    "outcome" "source_outcome" NOT NULL,
    "detail" TEXT,
    "cached" BOOLEAN NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_calls_created_at_idx" ON "llm_calls"("created_at");

-- CreateIndex
CREATE INDEX "llm_calls_analysis_id_idx" ON "llm_calls"("analysis_id");

-- CreateIndex
CREATE INDEX "source_calls_created_at_idx" ON "source_calls"("created_at");

-- CreateIndex
CREATE INDEX "source_calls_analysis_id_idx" ON "source_calls"("analysis_id");

-- AddForeignKey
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_calls" ADD CONSTRAINT "source_calls_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

