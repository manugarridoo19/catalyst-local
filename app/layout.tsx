import type { Metadata } from "next";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { CommandPalette } from "@/components/search/command-palette";
import { ThemeProvider } from "@/components/theme-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Editorial serif para headlines de noticias — da peso de "FT/Reuters" en
// vez de look genérico de dashboard SaaS.
const newsreader = Newsreader({
  variable: "--font-editorial",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Catalyst — Realtime market news",
  description:
    "Realtime feed of financial news with sentiment + impact scoring across the entire market.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      // `suppressHydrationWarning` es REQUERIDO por next-themes: el provider
      // muta `class` en <html> en el cliente antes de hydrate y sin esto
      // React loggea un mismatch warning.
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${newsreader.variable} h-full antialiased`}
    >
      <body className="ambient-bg min-h-full flex flex-col bg-background text-foreground">
        {/* El bundler de @opennextjs/cloudflare (esbuild con keepNames)
            inyecta llamadas a su helper `__name` DENTRO de la función que
            next-themes serializa con toString() para su script inline: en el
            navegador `__name` no existe y el script anti-flash del tema
            muere con ReferenceError (solo en el Worker; `next start` local
            no pasa por esbuild). El shim tiene que ir ANTES del
            ThemeProvider para ejecutarse primero. */}
        <script
          dangerouslySetInnerHTML={{
            __html: "self.__name=self.__name||function(f){return f}",
          }}
        />
        <ThemeProvider>
          <div aria-hidden className="ambient-grid" />
          {children}
          <CommandPalette />
          <Toaster richColors position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
