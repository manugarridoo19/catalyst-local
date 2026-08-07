CREATE TABLE "earnings_estimate_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"event_date" text NOT NULL,
	"captured_on" text NOT NULL,
	"eps_estimate" text,
	"revenue_estimate" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "earnings_estimate_snapshots_unique" ON "earnings_estimate_snapshots" USING btree ("symbol","event_date","captured_on");--> statement-breakpoint
CREATE INDEX "earnings_estimate_snapshots_symbol_idx" ON "earnings_estimate_snapshots" USING btree ("symbol","event_date");