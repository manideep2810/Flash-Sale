import type { ReactNode } from "react";
import { LoginBar } from "@/components/LoginBar";
import { AdmissionProvider } from "@/lib/admission";
import { SessionProvider } from "@/lib/session";
import "./globals.css";

export const metadata = {
  title: "Flash sale",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <AdmissionProvider>
            <LoginBar />
            <main>{children}</main>
          </AdmissionProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
