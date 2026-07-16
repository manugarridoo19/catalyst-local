CREATE TABLE "author_briefs" (
	"id" serial PRIMARY KEY NOT NULL,
	"author" text NOT NULL,
	"content" text NOT NULL,
	"model" text NOT NULL,
	"tweet_count" integer NOT NULL,
	"covered_date" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "author_tweets" (
	"tweet_id" text PRIMARY KEY NOT NULL,
	"author" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"url" text,
	"is_retweet" smallint DEFAULT 0 NOT NULL,
	"tickers" text[] DEFAULT '{}' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "author_tweets_author_created_idx" ON "author_tweets" USING btree ("author","created_at");