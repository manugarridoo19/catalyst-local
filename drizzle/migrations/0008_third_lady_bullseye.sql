CREATE TABLE "earnings_events" (
	"symbol" text NOT NULL,
	"date" text NOT NULL,
	"hour" text,
	"quarter" integer,
	"year" integer,
	"eps_estimate" text,
	"revenue_estimate" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "earnings_events_symbol_date_pk" PRIMARY KEY("symbol","date")
);
--> statement-breakpoint
ALTER TABLE "earnings_events" ADD CONSTRAINT "earnings_events_symbol_tickers_symbol_fk" FOREIGN KEY ("symbol") REFERENCES "public"."tickers"("symbol") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "earnings_events_date_idx" ON "earnings_events" USING btree ("date");