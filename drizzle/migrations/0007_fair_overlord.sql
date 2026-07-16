CREATE TABLE "ai_picks" (
	"id" serial PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"model" text NOT NULL,
	"news_count" integer NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
