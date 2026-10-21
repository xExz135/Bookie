-- FE-10 (D-027): the user study of spec 9. A participant's held-out books with
-- their own rating, the shipped model's prediction from the other ratings and B0's.

-- CreateTable
CREATE TABLE "study_participants" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "taste_profile_version_id" UUID NOT NULL,
    "rated_count" INTEGER NOT NULL,
    "consented_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_predictions" (
    "id" UUID NOT NULL,
    "participant_id" UUID NOT NULL,
    "edition_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "actual_rating" SMALLINT NOT NULL,
    "model_version_id" UUID NOT NULL,
    "score" DECIMAL(3,2) NOT NULL,
    "confidence" "confidence_level" NOT NULL,
    "baseline_model_version_id" UUID NOT NULL,
    "baseline_score" DECIMAL(3,2) NOT NULL,

    CONSTRAINT "study_predictions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "study_participants_user_id_key" ON "study_participants"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "study_predictions_participant_id_edition_id_key" ON "study_predictions"("participant_id", "edition_id");

-- CreateIndex
CREATE UNIQUE INDEX "study_predictions_participant_id_position_key" ON "study_predictions"("participant_id", "position");

-- AddForeignKey
ALTER TABLE "study_participants" ADD CONSTRAINT "study_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_participants" ADD CONSTRAINT "study_participants_taste_profile_version_id_fkey" FOREIGN KEY ("taste_profile_version_id") REFERENCES "taste_profile_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_predictions" ADD CONSTRAINT "study_predictions_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "study_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_predictions" ADD CONSTRAINT "study_predictions_edition_id_fkey" FOREIGN KEY ("edition_id") REFERENCES "editions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_predictions" ADD CONSTRAINT "study_predictions_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "model_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_predictions" ADD CONSTRAINT "study_predictions_baseline_model_version_id_fkey" FOREIGN KEY ("baseline_model_version_id") REFERENCES "model_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

