-- BE-3 (D-001): access tokens carry this number. A password reset increments
-- it, so every access token issued before the reset stops working at once.
ALTER TABLE "users" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD CONSTRAINT "users_token_version_not_negative" CHECK ("token_version" >= 0);
