import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { AdmissionProvider } from "@/lib/admission";
import { SessionProvider } from "@/lib/session";
import "./globals.css";

export const metadata = {
  title: "Flash sale",
  description: "Tickets that sell out in minutes, and a fair line to get them.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <AdmissionProvider>
            <Header />
            <main className="site-main">{children}</main>
            <footer className="site-footer">
              <p>A demo. The events are made up, no ticket is real and no card is ever charged.</p>
            </footer>
          </AdmissionProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
