CREATE TABLE "frame_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_session" text NOT NULL,
	"symbol" text NOT NULL,
	"from_madurez" text,
	"from_capital" text,
	"from_ciclo" text,
	"to_madurez" text,
	"to_capital" text,
	"to_ciclo" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "frame_changes_session_symbol_changed_desc_idx" ON "frame_changes" USING btree ("user_session","symbol","changed_at" DESC NULLS LAST);