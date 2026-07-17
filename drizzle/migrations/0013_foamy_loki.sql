CREATE TABLE "article_extracts" (
	"news_id" integer PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"text" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ai_summary" text,
	"ai_take" text,
	"ai_model" text,
	"ai_generated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "article_extracts" ADD CONSTRAINT "article_extracts_news_id_news_id_fk" FOREIGN KEY ("news_id") REFERENCES "public"."news"("id") ON DELETE cascade ON UPDATE no action;