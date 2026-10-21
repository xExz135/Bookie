-- BE-8 (RES-2): each step keeps its output, so a retry runs only the failed
-- steps and reuses what the done steps produced. Outputs hold IDs, numbers and
-- model-written text only; review text stays in the reviews table (D-004).
ALTER TABLE "analysis_steps" ADD COLUMN "output" JSONB;
