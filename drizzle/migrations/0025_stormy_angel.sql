CREATE TABLE "trade_outcomes" (
	"trade_id" integer NOT NULL,
	"horizon" smallint NOT NULL,
	"baseline_date" text NOT NULL,
	"target_date" text NOT NULL,
	"baseline_close" double precision NOT NULL,
	"target_close" double precision NOT NULL,
	"return_pct" double precision NOT NULL,
	"benchmark_return_pct" double precision,
	"filled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_outcomes_trade_id_horizon_pk" PRIMARY KEY("trade_id","horizon")
);
--> statement-breakpoint
ALTER TABLE "position_trades" ADD COLUMN "outcome_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "position_trades" ADD COLUMN "last_outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trade_outcomes" ADD CONSTRAINT "trade_outcomes_trade_id_position_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."position_trades"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trade_outcomes_filled_idx" ON "trade_outcomes" USING btree ("filled_at");