-- BE-12 (D-006, D-015): fix embedding vectors at 768 dimensions and add a
-- cosine-distance HNSW index for similarity search. Hand-written: Prisma does
-- not see changes to Unsupported("vector(...)") columns.

ALTER TABLE "book_embeddings" ALTER COLUMN "embedding" TYPE vector(768);
ALTER TABLE "taste_vectors" ALTER COLUMN "embedding" TYPE vector(768);

CREATE INDEX "book_embeddings_embedding_hnsw" ON "book_embeddings"
  USING hnsw ("embedding" vector_cosine_ops);
