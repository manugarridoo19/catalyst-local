CREATE TABLE "short_interest" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"settlement_date" text NOT NULL,
	"current_short_qty" bigint NOT NULL,
	"previous_short_qty" bigint,
	"avg_daily_volume" bigint,
	"days_to_cover" double precision,
	"change_percent" double precision,
	"market_class" text,
	"issue_name" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "short_interest_symbol_settlement_unique" ON "short_interest" USING btree ("symbol","settlement_date");--> statement-breakpoint
CREATE INDEX "short_interest_settlement_idx" ON "short_interest" USING btree ("settlement_date");