ALTER TABLE "earnings_reports" ADD COLUMN "revenue_actual" double precision;--> statement-breakpoint
ALTER TABLE "earnings_reports" ADD COLUMN "revenue_basis" text;--> statement-breakpoint
ALTER TABLE "earnings_reports" ADD COLUMN "eps_actual" double precision;--> statement-breakpoint
ALTER TABLE "earnings_reports" ADD COLUMN "eps_basis" text;