CREATE TABLE "fund_stakes" (
	"id" serial PRIMARY KEY NOT NULL,
	"news_id" integer,
	"symbol" text NOT NULL,
	"filing_url" text NOT NULL,
	"form_type" text NOT NULL,
	"filer_name" text,
	"percent_of_class" double precision,
	"filed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insider_digests" (
	"id" serial PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"model" text NOT NULL,
	"trade_count" integer NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insider_trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"news_id" integer,
	"symbol" text NOT NULL,
	"filing_url" text NOT NULL,
	"seq" smallint NOT NULL,
	"owner_name" text NOT NULL,
	"owner_title" text,
	"is_director" smallint DEFAULT 0 NOT NULL,
	"is_officer" smallint DEFAULT 0 NOT NULL,
	"is_ten_percent" smallint DEFAULT 0 NOT NULL,
	"tx_code" text NOT NULL,
	"shares" double precision NOT NULL,
	"price" double precision,
	"value" double precision,
	"tx_date" text,
	"shares_after" double precision,
	"filed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "news" ADD COLUMN "insider_parsed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fund_stakes" ADD CONSTRAINT "fund_stakes_news_id_news_id_fk" FOREIGN KEY ("news_id") REFERENCES "public"."news"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_stakes" ADD CONSTRAINT "fund_stakes_symbol_tickers_symbol_fk" FOREIGN KEY ("symbol") REFERENCES "public"."tickers"("symbol") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insider_trades" ADD CONSTRAINT "insider_trades_news_id_news_id_fk" FOREIGN KEY ("news_id") REFERENCES "public"."news"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insider_trades" ADD CONSTRAINT "insider_trades_symbol_tickers_symbol_fk" FOREIGN KEY ("symbol") REFERENCES "public"."tickers"("symbol") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fund_stakes_filing_unique" ON "fund_stakes" USING btree ("filing_url");--> statement-breakpoint
CREATE INDEX "fund_stakes_filed_idx" ON "fund_stakes" USING btree ("filed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "insider_trades_filing_seq_unique" ON "insider_trades" USING btree ("filing_url","seq");--> statement-breakpoint
CREATE INDEX "insider_trades_symbol_filed_idx" ON "insider_trades" USING btree ("symbol","filed_at");--> statement-breakpoint
CREATE INDEX "insider_trades_filed_idx" ON "insider_trades" USING btree ("filed_at");