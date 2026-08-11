CREATE TABLE "ticker_dilution" (
	"symbol" text PRIMARY KEY NOT NULL,
	"diluted_shares" double precision,
	"diluted_shares_year_ago" double precision,
	"dilution_pct" double precision,
	"sbc" double precision,
	"buybacks" double precision,
	"period_end" text,
	"period_form" text,
	"cadence" text,
	"taxonomy" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticker_dilution" ADD CONSTRAINT "ticker_dilution_symbol_tickers_symbol_fk" FOREIGN KEY ("symbol") REFERENCES "public"."tickers"("symbol") ON DELETE cascade ON UPDATE no action;