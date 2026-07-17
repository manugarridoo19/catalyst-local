CREATE TABLE "ticker_fundamentals" (
	"symbol" text PRIMARY KEY NOT NULL,
	"market_cap" bigint,
	"pe" text,
	"beta" text,
	"sector" text,
	"industry" text,
	"year_high" text,
	"year_low" text,
	"ceo" text,
	"peers" text[] DEFAULT '{}' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticker_fundamentals" ADD CONSTRAINT "ticker_fundamentals_symbol_tickers_symbol_fk" FOREIGN KEY ("symbol") REFERENCES "public"."tickers"("symbol") ON DELETE cascade ON UPDATE no action;