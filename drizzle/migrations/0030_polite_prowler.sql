ALTER TABLE "watchlist" ADD COLUMN "frame_madurez" text;--> statement-breakpoint
ALTER TABLE "watchlist" ADD COLUMN "frame_capital" text;--> statement-breakpoint
ALTER TABLE "watchlist" ADD COLUMN "frame_ciclo" text;--> statement-breakpoint
-- Backfill de la etiqueta única a los tres ejes. Va EN ESTA MISMA migración
-- y no en un script aparte: entre añadir las columnas y rellenarlas no puede
-- existir un estado en el que las posiciones estén clasificadas en `frame`
-- pero ilegibles por los ejes — `parseAxes` exige los tres y devolvería null,
-- así que el coach se quedaría mudo sobre toda la cartera sin decir por qué.
UPDATE "watchlist" SET
  "frame_madurez" = CASE "frame"
    WHEN 'power_play' THEN 'construyendo'
    WHEN 'turnaround' THEN 'recuperandose'
    ELSE 'cosechando' END,
  "frame_capital" = CASE "frame"
    WHEN 'power_play' THEN 'alto'
    ELSE 'bajo' END,
  "frame_ciclo" = CASE "frame"
    WHEN 'ciclica' THEN 'exogeno'
    ELSE 'secular' END
WHERE "frame" IS NOT NULL;
