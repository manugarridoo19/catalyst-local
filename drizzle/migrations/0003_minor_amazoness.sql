CREATE INDEX "news_category_idx" ON "news" USING btree ("category");--> statement-breakpoint
CREATE INDEX "news_scores_impact_idx" ON "news_scores" USING btree ("impact");