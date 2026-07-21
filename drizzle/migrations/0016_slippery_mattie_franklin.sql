-- pgvector 0.8 viene disponible en Neon free (no instalado por defecto).
-- halfvec + HNSW sobre halfvec requieren >=0.7, así que esto es el gate de
-- toda la Fase 2.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "news_embeddings" (
	"id" serial PRIMARY KEY NOT NULL,
	"news_id" integer,
	"headline" text NOT NULL,
	"summary" text,
	"url" text NOT NULL,
	"source" text NOT NULL,
	"symbols" text[] DEFAULT '{}'::text[] NOT NULL,
	"impact" smallint NOT NULL,
	"sentiment" smallint NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"embedding" halfvec(768) NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "news_embeddings" ADD CONSTRAINT "news_embeddings_news_id_news_id_fk" FOREIGN KEY ("news_id") REFERENCES "public"."news"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "news_embeddings_news_unique" ON "news_embeddings" USING btree ("news_id");--> statement-breakpoint
CREATE INDEX "news_embeddings_published_idx" ON "news_embeddings" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "news_embeddings_symbols_idx" ON "news_embeddings" USING gin ("symbols");--> statement-breakpoint
-- Índice ANN. A mano y no en schema.ts porque drizzle-kit no sabe emitir
-- opclases (halfvec_cosine_ops) sobre tipos custom; como `generate` compara
-- contra su propio snapshot y no contra la BD, no lo verá ni intentará
-- borrarlo. HNSW es incremental: crearlo con la tabla vacía es instantáneo y
-- no hay que reconstruir nada después.
CREATE INDEX "news_embeddings_hnsw_idx" ON "news_embeddings" USING hnsw ("embedding" halfvec_cosine_ops);