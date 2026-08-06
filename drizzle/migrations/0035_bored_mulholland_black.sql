CREATE TABLE "portfolio_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_session" text NOT NULL,
	"review_date" text NOT NULL,
	"verdict" text NOT NULL,
	"positions" text NOT NULL,
	"watch_next" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_reviews_session_date_unique" ON "portfolio_reviews" USING btree ("user_session","review_date");