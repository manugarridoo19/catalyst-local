ALTER TABLE "position_trades" ADD COLUMN "horizon" text;--> statement-breakpoint
ALTER TABLE "position_trades" ADD COLUMN "thesis" text;--> statement-breakpoint
ALTER TABLE "position_trades" ADD COLUMN "annotated_later" boolean DEFAULT false NOT NULL;