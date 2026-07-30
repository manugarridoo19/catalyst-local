CREATE TABLE "position_trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_session" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"shares" double precision,
	"price" double precision,
	"realized_pnl" double precision,
	"shares_after" double precision,
	"avg_cost_after" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "position_trades_session_symbol_idx" ON "position_trades" USING btree ("user_session","symbol","created_at");