-- Taste model releases (BE-13, D-024): parameters per model version, the books the
-- population models know with their item offsets, and B3's positive similarities.

-- AlterTable
ALTER TABLE "model_versions" ADD COLUMN     "parameters" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "model_item_stats" (
    "model_version_id" UUID NOT NULL,
    "edition_id" UUID NOT NULL,
    "item_bias" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "model_item_stats_pkey" PRIMARY KEY ("model_version_id","edition_id")
);

-- CreateTable
CREATE TABLE "model_item_neighbours" (
    "model_version_id" UUID NOT NULL,
    "edition_id" UUID NOT NULL,
    "neighbour_id" UUID NOT NULL,
    "similarity" DOUBLE PRECISION NOT NULL CHECK ("similarity" > 0),

    CONSTRAINT "model_item_neighbours_pkey" PRIMARY KEY ("model_version_id","edition_id","neighbour_id")
);

-- AddForeignKey
ALTER TABLE "model_item_stats" ADD CONSTRAINT "model_item_stats_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "model_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_item_stats" ADD CONSTRAINT "model_item_stats_edition_id_fkey" FOREIGN KEY ("edition_id") REFERENCES "editions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_item_neighbours" ADD CONSTRAINT "model_item_neighbours_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "model_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_item_neighbours" ADD CONSTRAINT "model_item_neighbours_edition_id_fkey" FOREIGN KEY ("edition_id") REFERENCES "editions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_item_neighbours" ADD CONSTRAINT "model_item_neighbours_neighbour_id_fkey" FOREIGN KEY ("neighbour_id") REFERENCES "editions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
