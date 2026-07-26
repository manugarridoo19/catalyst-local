import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Config de tests. Sólo cubre LÓGICA PURA (matemática de cartera, gate de
// evidencia, parseo): nada que toque la BD, la red ni un proveedor LLM.
//
// `DATABASE_URL` de mentira NO es un atajo sucio: `lib/db/index.ts` lanza al
// cargarse si la variable falta, y la cadena de imports de los módulos bajo
// prueba lo arrastra (portfolio-review → priors → signals/queries → db). Con
// una URL sintáctica el cliente se construye pero NUNCA conecta, porque el
// driver HTTP de Neon sólo hace fetch al ejecutar una query y estos tests no
// ejecutan ninguna. Si algún día un test intenta consultar, fallará con un
// error de red evidente en vez de tocar la base real — que es exactamente el
// comportamiento que se quiere.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
