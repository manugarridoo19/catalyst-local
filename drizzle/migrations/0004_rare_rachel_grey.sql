CREATE TABLE "ai_briefs" (
	"id" serial PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"model" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
