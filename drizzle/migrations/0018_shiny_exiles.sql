CREATE TABLE "earnings_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"accession" text NOT NULL,
	"filing_date" text NOT NULL,
	"report_date" text,
	"exhibit_url" text NOT NULL,
	"headline" text,
	"summary" text NOT NULL,
	"read_between_lines" text,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "earnings_reports_symbol_accession_unique" ON "earnings_reports" USING btree ("symbol","accession");--> statement-breakpoint
CREATE INDEX "earnings_reports_symbol_filed_idx" ON "earnings_reports" USING btree ("symbol","filing_date");