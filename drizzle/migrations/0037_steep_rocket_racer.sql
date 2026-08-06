CREATE TABLE "research_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"stats_snapshot" text NOT NULL,
	"model" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
