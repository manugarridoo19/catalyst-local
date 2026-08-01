CREATE TABLE "provider_cooldowns" (
	"scope" text NOT NULL,
	"label" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"cooled_until" timestamp with time zone NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_cooldowns_scope_label_model_pk" PRIMARY KEY("scope","label","model")
);
--> statement-breakpoint
DROP INDEX "news_category_idx";--> statement-breakpoint
DROP INDEX "news_scores_impact_idx";--> statement-breakpoint
DROP INDEX "position_trades_session_symbol_idx";--> statement-breakpoint
ALTER TABLE "news_embeddings" ADD COLUMN "source_news_id" integer;--> statement-breakpoint
UPDATE "news_embeddings" SET "source_news_id" = "news_id" WHERE "news_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "provider_cooldowns_live" ON "provider_cooldowns" USING btree ("scope","cooled_until");--> statement-breakpoint
CREATE INDEX "fund_stakes_symbol_filed_idx" ON "fund_stakes" USING btree ("symbol","filed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "news_category_published_idx" ON "news" USING btree ("category","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "news_insider_pending_idx" ON "news" USING btree ("published_at" DESC NULLS LAST) WHERE source = 'sec-edgar' AND insider_parsed_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_embeddings_hnsw_idx" ON "news_embeddings" USING hnsw ("embedding" halfvec_cosine_ops);--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "news_embeddings_headline_trgm_idx" ON "news_embeddings" USING gin ("headline" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "news_embeddings_summary_trgm_idx" ON "news_embeddings" USING gin ("summary" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "position_trades_session_symbol_created_desc_idx" ON "position_trades" USING btree ("user_session","symbol","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "position_trades_session_created_idx" ON "position_trades" USING btree ("user_session","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);