CREATE TABLE "cusip_map" (
	"cusip" text PRIMARY KEY NOT NULL,
	"symbol" text,
	"name" text,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fund_holdings" (
	"id" serial PRIMARY KEY NOT NULL,
	"fund_cik" text NOT NULL,
	"fund_name" text NOT NULL,
	"period_of_report" text NOT NULL,
	"cusip" text NOT NULL,
	"symbol" text,
	"issuer_name" text NOT NULL,
	"value" bigint NOT NULL,
	"shares" bigint,
	"accession" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cusip_map_symbol_idx" ON "cusip_map" USING btree ("symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "fund_holdings_fund_period_cusip_unique" ON "fund_holdings" USING btree ("fund_cik","period_of_report","cusip");--> statement-breakpoint
CREATE INDEX "fund_holdings_symbol_idx" ON "fund_holdings" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "fund_holdings_period_idx" ON "fund_holdings" USING btree ("period_of_report");