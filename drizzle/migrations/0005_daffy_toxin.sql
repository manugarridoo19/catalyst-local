CREATE TABLE "ticker_briefs" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"content" text NOT NULL,
	"model" text NOT NULL,
	"news_count" integer NOT NULL,
	"newest_news_at" timestamp with time zone,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticker_briefs" ADD CONSTRAINT "ticker_briefs_symbol_tickers_symbol_fk" FOREIGN KEY ("symbol") REFERENCES "public"."tickers"("symbol") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticker_briefs_symbol_generated_idx" ON "ticker_briefs" USING btree ("symbol","generated_at");