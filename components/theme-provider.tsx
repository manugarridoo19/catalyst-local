"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

// Wrapper sobre next-themes. Mantiene `dark` como default — el muscle
// memory del usuario lleva sesiones largas en dark "Bloomberg-derelict".
// El toggle del header da el swap a "newsroom paper" cuando se quiere
// leer en luz natural (cafetería, biblioteca, etc.).
//
// `attribute="class"` añade/quita `dark` en <html>; el CSS de globals.css
// ya define ambos sets (:root = light, .dark = dark).
// `disableTransitionOnChange` evita un destello en el swap.
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
