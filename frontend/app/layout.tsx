import "./globals.css";
import type { Metadata } from "next";
import { Providers } from "@/components/Providers";

export const metadata: Metadata = {
  title: "Papertrader",
  description: "LightPool paper synthetic perpetuals",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
