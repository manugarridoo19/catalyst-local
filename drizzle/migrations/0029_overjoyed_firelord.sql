CREATE TABLE "thesis_falsifiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_session" text NOT NULL,
	"symbol" text NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"tripped_at" timestamp with time zone,
	"tripped_evidence" text,
	"checked_accession" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "thesis_falsifiers_session_symbol_idx" ON "thesis_falsifiers" USING btree ("user_session","symbol");