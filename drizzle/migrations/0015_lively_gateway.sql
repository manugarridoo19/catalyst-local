CREATE TABLE "signal_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"symbol" text NOT NULL,
	"ref_id" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"price_at_detection" double precision,
	"meta" text,
	"outcome_attempts" smallint DEFAULT 0 NOT NULL,
	"last_outcome_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_outcomes" (
	"event_id" integer NOT NULL,
	"horizon" smallint NOT NULL,
	"baseline_date" text NOT NULL,
	"target_date" text NOT NULL,
	"baseline_close" double precision NOT NULL,
	"target_close" double precision NOT NULL,
	"return_pct" double precision NOT NULL,
	"benchmark_return_pct" double precision,
	"filled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_outcomes_event_id_horizon_pk" PRIMARY KEY("event_id","horizon")
);
--> statement-breakpoint
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_symbol_tickers_symbol_fk" FOREIGN KEY ("symbol") REFERENCES "public"."tickers"("symbol") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD CONSTRAINT "signal_outcomes_event_id_signal_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."signal_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signal_events_kind_symbol_ref_unique" ON "signal_events" USING btree ("kind","symbol","ref_id");--> statement-breakpoint
CREATE INDEX "signal_events_kind_detected_idx" ON "signal_events" USING btree ("kind","detected_at");--> statement-breakpoint
CREATE INDEX "signal_events_detected_idx" ON "signal_events" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "signal_outcomes_filled_idx" ON "signal_outcomes" USING btree ("filled_at");