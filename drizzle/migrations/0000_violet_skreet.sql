CREATE TYPE "public"."extraction_method" AS ENUM('api', 'regex', 'dict');--> statement-breakpoint
CREATE TABLE "news" (
	"id" serial PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"hash" text NOT NULL,
	"headline" text NOT NULL,
	"source" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"body" text,
	"image_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_scores" (
	"news_id" integer PRIMARY KEY NOT NULL,
	"impact" smallint NOT NULL,
	"sentiment" smallint NOT NULL,
	"rationale" text,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_tickers" (
	"news_id" integer NOT NULL,
	"ticker" text NOT NULL,
	"extraction_method" "extraction_method" NOT NULL,
	CONSTRAINT "news_tickers_news_id_ticker_pk" PRIMARY KEY("news_id","ticker")
);
--> statement-breakpoint
CREATE TABLE "quotes_cache" (
	"symbol" text PRIMARY KEY NOT NULL,
	"last_price" text,
	"change_pct" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticker_aliases" (
	"alias" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickers" (
	"symbol" text PRIMARY KEY NOT NULL,
	"name" text,
	"sector" text,
	"industry" text,
	"market_cap" bigint,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enriched_at" timestamp with time zone,
	"source" text
);
--> statement-breakpoint
CREATE TABLE "watchlist" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"user_session" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "news_scores" ADD CONSTRAINT "news_scores_news_id_news_id_fk" FOREIGN KEY ("news_id") REFERENCES "public"."news"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_tickers" ADD CONSTRAINT "news_tickers_news_id_news_id_fk" FOREIGN KEY ("news_id") REFERENCES "public"."news"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_tickers" ADD CONSTRAINT "news_tickers_ticker_tickers_symbol_fk" FOREIGN KEY ("ticker") REFERENCES "public"."tickers"("symbol") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes_cache" ADD CONSTRAINT "quotes_cache_symbol_tickers_symbol_fk" FOREIGN KEY ("symbol") REFERENCES "public"."tickers"("symbol") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticker_aliases" ADD CONSTRAINT "ticker_aliases_symbol_tickers_symbol_fk" FOREIGN KEY ("symbol") REFERENCES "public"."tickers"("symbol") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_symbol_tickers_symbol_fk" FOREIGN KEY ("symbol") REFERENCES "public"."tickers"("symbol") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "news_url_unique" ON "news" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "news_hash_unique" ON "news" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "news_published_idx" ON "news" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "news_tickers_ticker_idx" ON "news_tickers" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "tickers_first_seen_idx" ON "tickers" USING btree ("first_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_session_symbol_unique" ON "watchlist" USING btree ("user_session","symbol");